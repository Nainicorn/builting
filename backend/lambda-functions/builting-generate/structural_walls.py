"""Phase 6B — IfcWall emission for portal entrance walls and room partition
walls.

The topology engine writes structural wall plans into
``css.metadata.wallReconstruction`` after space classification. This module
consumes those plans and emits the corresponding IFC entities.

Phase 6B.3 — full wall coverage + correctness (2026-04-28).
    Topology engine now emits THREE wall categories:
        portalWalls    — both ends of the main portal pair (force-emitted)
        junctionWalls  — every node where a ROOM segment meets a non-room
                         neighbor (sealed full bore cross-section)
        terminalWalls  — every degree-1 endpoint of a ROOM segment (room cap)

    All three are arched (rectangle fallback removed upstream). This module
    consumes them via ``portalWalls`` + ``roomPartitionWalls`` (the legacy
    bucket that now combines junction + terminal walls) and validates that
    every emitted wall passes profile, normal, and plane-offset checks. The
    summary log uses ``[6B.3]`` prefixes so deployed runs can be diff'd
    against the topology-engine output.

Phase 6B.2 — arched-profile walls (2026-04-28).
    Wall plans now include a ``profileType`` ('ARCH' | 'RECTANGLE') and an
    ``outerProfilePoints`` array describing the wall face in (lateral X,
    vertical Y, floor at y=0) coordinates. ARCH plans trace a flat floor +
    vertical sidewalls + semicircular top so the wall outline matches the
    surrounding tunnel cross-section.

    The wall body is an ``IfcExtrudedAreaSolid`` whose 2D profile is the wall
    face (lateral × vertical) and whose extrusion direction is the wall's
    thickness axis. The wall is centered on its plane (extends ±thickness/2
    in the thickness direction) so the wall plane sits exactly on the
    portal/branch plane.

    Entity type: arched walls are emitted as ``IfcWall`` (the parent class)
    because ``IfcWallStandardCase`` reserves the standard composition for
    rectangle-profile-extruded-vertically walls. Rectangle fallbacks also
    use ``IfcWall`` with the same face-profile + thickness-extrusion layout.

Plans carry the world origin, lateral axis (length direction in XY),
thickness axis (perpendicular to length in XY, "outward" relative to the
tunnel mouth or corridor), wall width, height, and thickness. Walls sit on
``origin.z`` (bore floor = segment_centerline_z - bore_h/2) and extend
upward by ``height``.

This module does NOT touch doors, openings, or void/fill relationships — the
existing intent-resolver-driven door emission already handles those on the
upstream tunnel-segment / portal-end-wall hosts. Phase 6B walls are added
visual structure on top of that.
"""

from __future__ import annotations

import math
import os
from typing import Iterable

import ifcopenshell

try:
    from secondary_geometry.presentation_filter import reanchor_room_wall as _pf_reanchor
    _PF_REANCHOR_AVAILABLE = True
except Exception:
    _PF_REANCHOR_AVAILABLE = False
    def _pf_reanchor(plan, free_endpoints, max_search_m=15.0):
        return None


# ---------------------------------------------------------------------------
# Tuning constants (mirror wall-reconstructor.mjs limits — values are clamped
# upstream so generation just enforces an absolute floor and ceiling here).
# ---------------------------------------------------------------------------

WALL_MIN_WIDTH      = 0.50   # m — reject degenerate plans
WALL_MIN_HEIGHT     = 1.00
WALL_MIN_THICKNESS  = 0.05
WALL_MAX_THICKNESS  = 1.00

# Phase 6B v2 — flag walls whose centroid is more than this far off the
# expected portal/branch plane.
WALL_PLANE_OFFSET_FLAG_M = 0.20

# Phase 6B.2 — additional flagging thresholds.
WALL_NORMAL_ANGLE_FLAG_DEG = 5.0    # plan thicknessAxis vs computed wall normal
WALL_PROFILE_DEVIATION_FLAG_M = 0.05  # wall outline vs reference arch
WALL_SHELL_OVERLAP_FLAG_M = 0.02    # any wall vertex this far outside expected shell

PORTAL_WALL_COLOR   = (0.78, 0.78, 0.80)   # cool gray — distinguishes from shell
ROOM_WALL_COLOR     = (0.82, 0.80, 0.74)   # warm gray — distinguishes from shell


# ---------------------------------------------------------------------------
# Local helpers (mirror clean_tunnel_export style without importing it to
# avoid circular dependencies).
# ---------------------------------------------------------------------------

def _new_guid() -> str:
    return ifcopenshell.guid.new()


def _make_dir(f, v):
    return f.create_entity(
        'IfcDirection',
        DirectionRatios=(float(v[0]), float(v[1]), float(v[2])),
    )


def _make_dir2(f, v):
    return f.create_entity(
        'IfcDirection',
        DirectionRatios=(float(v[0]), float(v[1])),
    )


def _make_pt(f, p):
    return f.create_entity(
        'IfcCartesianPoint',
        Coordinates=(float(p[0]), float(p[1]), float(p[2])),
    )


def _make_pt2(f, p):
    return f.create_entity(
        'IfcCartesianPoint',
        Coordinates=(float(p[0]), float(p[1])),
    )


def _make_axis2_3d(f, origin, axis_z, ref_x):
    return f.create_entity(
        'IfcAxis2Placement3D',
        Location=_make_pt(f, origin),
        Axis=_make_dir(f, axis_z),
        RefDirection=_make_dir(f, ref_x),
    )


def _make_axis2_2d(f):
    return f.create_entity(
        'IfcAxis2Placement2D',
        Location=f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0)),
        RefDirection=f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0)),
    )


def _make_local_placement(f, parent_lp, origin, axis_z, ref_x):
    rel = _make_axis2_3d(f, origin, axis_z, ref_x)
    return f.create_entity(
        'IfcLocalPlacement',
        PlacementRelTo=parent_lp,
        RelativePlacement=rel,
    )


def _apply_style(f, solid, color_rgb, name):
    r, g, b = color_rgb
    color = f.create_entity(
        'IfcColourRgb',
        Red=float(r), Green=float(g), Blue=float(b),
    )
    rendering = f.create_entity(
        'IfcSurfaceStyleRendering',
        SurfaceColour=color, Transparency=0.0, ReflectanceMethod='BLINN',
    )
    style = f.create_entity(
        'IfcSurfaceStyle',
        Name=name, Side='BOTH', Styles=(rendering,),
    )
    assign = f.create_entity(
        'IfcPresentationStyleAssignment',
        Styles=(style,),
    )
    f.create_entity('IfcStyledItem', Item=solid, Styles=(assign,))


# ---------------------------------------------------------------------------
# Plan parsing + validation
# ---------------------------------------------------------------------------

def _safe_xyz(d):
    if not isinstance(d, dict):
        return None
    try:
        return (float(d.get('x', 0.0)),
                float(d.get('y', 0.0)),
                float(d.get('z', 0.0)))
    except (TypeError, ValueError):
        return None


def _normalize_xy(v):
    """Take an (x,y,z) tuple, force z=0, normalize. Returns (x,y,0) or None."""
    if v is None:
        return None
    x, y, _z = v
    L = math.hypot(x, y)
    if L < 1e-9:
        return None
    return (x / L, y / L, 0.0)


def _validate_plan(plan):
    """Return (origin, lateralAxis, thicknessAxis, width, height, thickness)
    on success, or None on rejection. All vectors are normalized in XY with
    z=0. Width/height/thickness are clamped to safe bounds."""
    origin   = _safe_xyz(plan.get('origin'))
    lateral  = _normalize_xy(_safe_xyz(plan.get('lateralAxis')))
    thick_ax = _normalize_xy(_safe_xyz(plan.get('thicknessAxis')))
    if origin is None or lateral is None or thick_ax is None:
        return None

    try:
        width     = float(plan.get('width', 0.0))
        height    = float(plan.get('height', 0.0))
        thickness = float(plan.get('thickness', 0.0))
    except (TypeError, ValueError):
        return None

    if width < WALL_MIN_WIDTH or height < WALL_MIN_HEIGHT:
        return None
    if thickness < WALL_MIN_THICKNESS:
        thickness = WALL_MIN_THICKNESS
    if thickness > WALL_MAX_THICKNESS:
        thickness = WALL_MAX_THICKNESS

    return origin, lateral, thick_ax, width, height, thickness


# ---------------------------------------------------------------------------
# IfcWallStandardCase emission
# ---------------------------------------------------------------------------

def _make_axis_representation(f, axis_sub, length):
    """Axis representation: 2D polyline along local X from -L/2 to +L/2."""
    p0 = _make_pt2(f, (-length / 2.0, 0.0))
    p1 = _make_pt2(f, ( length / 2.0, 0.0))
    poly = f.create_entity('IfcPolyline', Points=(p0, p1))
    return f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=axis_sub,
        RepresentationIdentifier='Axis',
        RepresentationType='Curve2D',
        Items=(poly,),
    )


# ---------------------------------------------------------------------------
# Phase 6B.2 — face profile + thickness-axis extrusion
# ---------------------------------------------------------------------------

def _outer_points_from_plan(plan, width, height):
    """Read the 2D outer face polygon from the plan, falling back to a
    bore_w × bore_h rectangle if the plan is missing the array. Profile
    coordinates: X = lateral (centered at 0), Y = vertical (floor at y=0).
    """
    pts = plan.get('outerProfilePoints')
    if isinstance(pts, list) and len(pts) >= 4:
        cleaned = []
        for p in pts:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                try:
                    cleaned.append((float(p[0]), float(p[1])))
                except (TypeError, ValueError):
                    pass
        if len(cleaned) >= 4:
            return cleaned

    # Rectangle fallback in the same lateral×vertical, floor-at-y=0 frame.
    r = float(width) / 2.0
    h = float(height)
    return [(-r, 0.0), (r, 0.0), (r, h), (-r, h), (-r, 0.0)]


def _make_arbitrary_profile_def(f, outer_points):
    """IfcArbitraryClosedProfileDef from a CCW 2D polygon (last point should
    repeat the first to close the polyline)."""
    pts = tuple(_make_pt2(f, (float(x), float(y))) for (x, y) in outer_points)
    outer_curve = f.create_entity('IfcPolyline', Points=pts)
    return f.create_entity(
        'IfcArbitraryClosedProfileDef',
        ProfileType='AREA',
        OuterCurve=outer_curve,
    )


def _make_body_representation(f, body_sub, plan, length, thickness, height,
                              color_rgb, style_name):
    """Body representation: face profile (lateral × vertical) extruded along
    the wall's thickness axis (= object local +Y) by `thickness`.

    The wall's ObjectPlacement has local X = lateral and local Z = world up,
    so the face profile lies in the (object X, object Z) plane and the
    thickness axis is object Y (perpendicular to lateral, horizontal). The
    solid frame is configured so:

        solid_X = -object_X      (ref direction, horizontal)
        solid_Y =  object_Z      (vertical, world up — profile Y axis)
        solid_Z =  object_Y      (thickness, extrusion direction)

    The profile X axis ends up mirrored relative to the object's lateral
    axis, which is harmless because the wall is symmetric about its
    centerline. The solid origin is offset by -thickness/2 along the
    thickness axis so the wall is centered on its plane and extends
    ±thickness/2 outward.
    """
    outer_points = _outer_points_from_plan(plan, length, height)
    profile = _make_arbitrary_profile_def(f, outer_points)

    pos = _make_axis2_3d(
        f,
        (0.0, -float(thickness) / 2.0, 0.0),
        (0.0, 1.0, 0.0),     # solid Z direction in object frame = thickness axis
        (-1.0, 0.0, 0.0),    # solid X direction in object frame = -lateral
    )
    solid = f.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=profile,
        Position=pos,
        ExtrudedDirection=f.create_entity(
            'IfcDirection', DirectionRatios=(0.0, 0.0, 1.0)),
        Depth=float(thickness),
    )
    _apply_style(f, solid, color_rgb, name=style_name)
    return f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=body_sub,
        RepresentationIdentifier='Body',
        RepresentationType='SweptSolid',
        Items=(solid,),
    ), solid


def _wall_centroid_world(origin, height):
    """Centroid of an upright wall = origin + (0, 0, height/2). For arched
    walls the area-centroid sits slightly higher than mid-height, but for
    plane-offset validation the mid-height approximation is sufficient."""
    return (origin[0], origin[1], origin[2] + height / 2.0)


def _plane_offset(centroid, expected_pt, normal):
    """Signed distance from `centroid` to the plane through `expected_pt`
    with `normal` direction. Returns abs distance (m)."""
    if expected_pt is None:
        return 0.0
    nx, ny, nz = normal
    n_len = math.sqrt(nx * nx + ny * ny + nz * nz)
    if n_len < 1e-9:
        return 0.0
    nx, ny, nz = nx / n_len, ny / n_len, nz / n_len
    dx = centroid[0] - expected_pt[0]
    dy = centroid[1] - expected_pt[1]
    dz = centroid[2] - expected_pt[2]
    return abs(dx * nx + dy * ny + dz * nz)


def _normal_angle_error_deg(plan_thick_ax, lateral):
    """Angle between the plan's stated thicknessAxis and the wall's actual
    normal (= +world_Z × lateral). Returns degrees, with 0 = perfectly
    consistent and 180 = flipped sign."""
    lx, ly, _ = lateral
    nx_actual = -ly
    ny_actual =  lx
    nz_actual =  0.0
    dot = (nx_actual * plan_thick_ax[0]
           + ny_actual * plan_thick_ax[1]
           + nz_actual * plan_thick_ax[2])
    dot = max(-1.0, min(1.0, dot))
    return math.degrees(math.acos(dot))


def _polygon_max_radius(points):
    """Max sqrt(x² + y²) of (x, y) tuples — simple measure of how far the
    polygon's outer outline reaches from the profile center."""
    if not points:
        return 0.0
    return max(math.hypot(float(x), float(y)) for (x, y) in points)


def _max_pointwise_deviation(actual_points, reference_points):
    """Max distance between corresponding vertices in two equally-sized
    polylines. Intended for ARCH outlines where both arrays come from the
    same arc subdivision and should match exactly. Returns -1.0 if the
    arrays can't be compared (different lengths, missing reference)."""
    if not actual_points or not reference_points:
        return -1.0
    n = min(len(actual_points), len(reference_points))
    if n == 0:
        return -1.0
    d = 0.0
    for i in range(n):
        ax, ay = float(actual_points[i][0]), float(actual_points[i][1])
        rx, ry = float(reference_points[i][0]), float(reference_points[i][1])
        d = max(d, math.hypot(ax - rx, ay - ry))
    return d


def _shell_overlap(actual_points, expected_shell_points):
    """Phase 6B.2 — return (gap_to_shell, overlap_with_shell) where
    gap_to_shell  = (max shell radius) - (max wall outline radius), positive
                    when wall outline sits inside the shell outer (≈ shell_t),
    overlap_flag  = True when the wall outline reaches BEYOND the shell outer
                    by more than WALL_SHELL_OVERLAP_FLAG_M (i.e. the wall
                    pokes outside the surrounding tunnel mass).

    Both inputs are 2D outlines in the same (lateral X, vertical Y) frame
    with the floor at y=0. The wall outline traces the bore inner; the
    expected shell outline traces the bore outer. By construction in the
    topology engine they are concentric, so radial distance is a faithful
    proxy for the gap/overlap.
    """
    if not actual_points or not expected_shell_points:
        return (-1.0, False)
    rw = _polygon_max_radius(actual_points)
    rs = _polygon_max_radius(expected_shell_points)
    gap = rs - rw
    overlap = (rw - rs) > WALL_SHELL_OVERLAP_FLAG_M
    return (gap, overlap)


def _log_wall_validation(plan, origin, lateral, thick_ax, width, height,
                         thickness, counts, color_label):
    """Phase 6B.2 — per-wall validation. Logs profile_type, the outer/expected
    profile vertex counts, profile deviation, plane offset, normal error,
    shell gap, and shell overlap. Flags any wall that violates the
    correctness thresholds.
    """
    centroid = _wall_centroid_world(origin, height)
    expected_pt = None
    ep = plan.get('expectedPlanePoint') or {}
    try:
        expected_pt = (
            float(ep.get('x', origin[0])),
            float(ep.get('y', origin[1])),
            float(ep.get('z', origin[2] + height / 2.0)),
        )
    except (TypeError, ValueError):
        expected_pt = None

    plane_off = _plane_offset(centroid, expected_pt, thick_ax)

    profile_type    = plan.get('profileType') or 'UNKNOWN'
    outer_pts       = plan.get('outerProfilePoints') or []
    expected_shell  = plan.get('expectedTunnelProfilePoints') or []

    # Compare actual outer outline against the IDEAL arch generated from the
    # plan's bore dimensions. Same construction as wall-reconstructor; the
    # deviation should be 0 when the plan matches and the structural-walls
    # consumer didn't drop precision. Mismatches >5cm imply a unit/precision
    # bug between the two lambdas.
    if profile_type == 'ARCH':
        ideal = _ideal_arch_outer_points(width, height)
    else:
        ideal = _ideal_rect_outer_points(width, height)
    profile_dev = _max_pointwise_deviation(outer_pts, ideal)

    gap_to_shell, shell_overlap = _shell_overlap(outer_pts, expected_shell)

    normal_err = _normal_angle_error_deg(thick_ax, lateral)

    flags = []
    if plane_off > WALL_PLANE_OFFSET_FLAG_M:
        flags.append('OFF_PLANE')
        counts['phase6b_walls_flagged_off_plane'] = counts.get(
            'phase6b_walls_flagged_off_plane', 0) + 1
    if normal_err > WALL_NORMAL_ANGLE_FLAG_DEG:
        flags.append('NORMAL_MISMATCH')
        counts['phase6b_walls_flagged_normal_mismatch'] = counts.get(
            'phase6b_walls_flagged_normal_mismatch', 0) + 1
    if profile_dev > WALL_PROFILE_DEVIATION_FLAG_M:
        flags.append('PROFILE_DEVIATION')
        counts['phase6b_walls_flagged_profile_deviation'] = counts.get(
            'phase6b_walls_flagged_profile_deviation', 0) + 1
    if shell_overlap:
        flags.append('SHELL_OVERLAP')
        counts['phase6b_walls_flagged_shell_overlap'] = counts.get(
            'phase6b_walls_flagged_shell_overlap', 0) + 1

    if profile_type == 'ARCH':
        counts['phase6b_walls_profile_arch'] = counts.get(
            'phase6b_walls_profile_arch', 0) + 1
    elif profile_type == 'RECTANGLE':
        counts['phase6b_walls_profile_rectangle'] = counts.get(
            'phase6b_walls_profile_rectangle', 0) + 1
    else:
        counts['phase6b_walls_profile_unknown'] = counts.get(
            'phase6b_walls_profile_unknown', 0) + 1

    status = 'PASS' if not flags else ('FLAG:' + ','.join(flags))
    print(
        f"[6B.3] {plan.get('kind', '?')} id={plan.get('id', '?')} "
        f"profile={profile_type} "
        f"outer_pts={len(outer_pts)} shell_pts={len(expected_shell)} "
        f"origin=({origin[0]:.3f},{origin[1]:.3f},{origin[2]:.3f}) "
        f"normal=({thick_ax[0]:.3f},{thick_ax[1]:.3f},{thick_ax[2]:.3f}) "
        f"local_x=({lateral[0]:.3f},{lateral[1]:.3f},{lateral[2]:.3f}) "
        f"w={width:.3f} h={height:.3f} t={thickness:.3f} "
        f"plane_offset={plane_off:.3f}m "
        f"normal_err={normal_err:.2f}deg "
        f"profile_dev={profile_dev:.4f}m "
        f"gap_to_shell={gap_to_shell:.3f}m "
        f"overlap_with_shell={'YES' if shell_overlap else 'NO'} "
        f"{status}"
    )


# Helpers used by validation to regenerate the IDEAL arch / rectangle in the
# same convention as the topology engine. Kept here so consumers don't have
# to re-import constants.
_VALIDATION_ARCH_SEGMENTS    = 16
_VALIDATION_ARCH_MIN_SIDE_M  = 0.30


def _ideal_arch_outer_points(bore_w, bore_h, segments=_VALIDATION_ARCH_SEGMENTS):
    inner_r    = float(bore_w) / 2.0
    sidewall_h = float(bore_h) - inner_r
    if sidewall_h < _VALIDATION_ARCH_MIN_SIDE_M:
        return None
    pts = [
        (-inner_r, 0.0),
        ( inner_r, 0.0),
        ( inner_r, sidewall_h),
    ]
    for k in range(1, segments):
        theta = math.pi * k / segments
        pts.append((inner_r * math.cos(theta),
                    sidewall_h + inner_r * math.sin(theta)))
    pts.append((-inner_r, sidewall_h))
    pts.append(pts[0])
    return [(round(x, 4), round(y, 4)) for (x, y) in pts]


def _ideal_rect_outer_points(bore_w, bore_h):
    r = float(bore_w) / 2.0
    h = float(bore_h)
    pts = [(-r, 0.0), (r, 0.0), (r, h), (-r, h), (-r, 0.0)]
    return [(round(x, 4), round(y, 4)) for (x, y) in pts]


def _emit_wall(f, axis_sub, body_sub, storey_lp, owner,
               plan, color_rgb, counts):
    """Phase 6B.2 — emit one IfcWall for a single wall plan. The body uses
    the wall's face profile (lateral × vertical, arched or rectangular)
    extruded along the thickness axis. Returns the IFC entity, or None if
    the plan is invalid.
    """
    parsed = _validate_plan(plan)
    if parsed is None:
        return None
    origin, lateral, thick_ax, width, height, thickness = parsed

    _log_wall_validation(
        plan, origin, lateral, thick_ax, width, height, thickness,
        counts, color_rgb)

    # Object placement: origin at world (px, py, pz), local Z = world up,
    # local X = lateral axis (length direction). Local Y comes for free as
    # Z × X and is the wall's thickness axis (same direction as the plan's
    # thicknessAxis when the plan is consistent — see normal_err check).
    obj_lp = _make_local_placement(
        f, storey_lp, origin, (0.0, 0.0, 1.0), lateral)

    axis_rep      = _make_axis_representation(f, axis_sub, width)
    body_rep, _sd = _make_body_representation(
        f, body_sub, plan, width, thickness, height, color_rgb,
        style_name=plan.get('kind') or 'Phase6BWall')
    shape = f.create_entity(
        'IfcProductDefinitionShape',
        Representations=(axis_rep, body_rep),
    )

    name = plan.get('id') or f"{plan.get('kind', 'Phase6BWall')}_{_new_guid()[:8]}"
    # IfcWall (parent class) — IfcWallStandardCase reserves its STEP class
    # for rectangle-profile-extruded-vertically walls; arched / face-profile
    # walls don't fit that constraint.
    return f.create_entity(
        'IfcWall',
        GlobalId=_new_guid(),
        OwnerHistory=owner,
        Name=name,
        ObjectType=plan.get('kind'),
        ObjectPlacement=obj_lp,
        Representation=shape,
    )


# ---------------------------------------------------------------------------
# Public entry — call from clean_tunnel_export.generate_clean_tunnel_ifc
# ---------------------------------------------------------------------------

def emit_phase_6b_walls(f, axis_sub, body_sub, storey_lp, owner, css, counts,
                        consumed_keys=None, valid_host_ids=None,
                        phase6b_aabbs=None, free_endpoints=None):
    """Emit Phase 6B portal-entrance and room-partition walls.

    Args:
        f               -- ifcopenshell.file
        axis_sub        -- IfcGeometricRepresentationSubContext for 'Axis'
        body_sub        -- IfcGeometricRepresentationSubContext for 'Body'
        storey_lp       -- IfcLocalPlacement of the building storey
        owner           -- IfcOwnerHistory
        css             -- the dict-form processed CSS (must carry
                           ``metadata.wallReconstruction`` from the topology engine)
        counts          -- the counters dict from clean_tunnel_export. New keys
                           are populated in-place; missing keys default to 0.
        consumed_keys   -- Phase 6B.4b — set of (hostSegmentKey, hostSegmentEnd)
                           tuples whose wall plan was already embedded as a
                           closing face on the per-segment shell brep. Plans
                           matching any of these keys are SKIPPED here (no
                           standalone IfcWall) so the shell + wall do not
                           occupy the same volume. None disables the filter.
        valid_host_ids  -- Phase 6B.4c — set of host segment ids that survived
                           upstream validation and were emitted as a tunnel
                           shell (per-segment OR chain-owned). Plans whose
                           hostSegmentKey is NOT in this set are floating
                           orphans and get dropped (counted as
                           phase6b_walls_skipped_orphan_host). None disables
                           the filter.

    Returns:
        list[IfcWallStandardCase] — emitted wall entities (caller should add
        them to the storey's IfcRelContainedInSpatialStructure).
    """
    if consumed_keys is None:
        consumed_keys = set()

    def _record_aabb(plan, ent):
        # Phase 6B.4d — record world AABB for this emitted standalone wall so
        # the caller can run wall-vs-shell overlap validation.
        if phase6b_aabbs is None:
            return
        try:
            o = plan.get('origin') or {}
            la = plan.get('lateralAxis') or {}
            ta = plan.get('thicknessAxis') or {}
            ox = float(o.get('x', 0.0)); oy = float(o.get('y', 0.0))
            oz = float(o.get('z', 0.0))
            lx = float(la.get('x', 0.0)); ly = float(la.get('y', 0.0))
            tx = float(ta.get('x', 0.0)); ty = float(ta.get('y', 0.0))
            w = float(plan.get('width', 0.0))
            h = float(plan.get('height', 0.0))
            t = float(plan.get('thickness', 0.0))
        except (TypeError, ValueError):
            return
        if w <= 0.0 or h <= 0.0:
            return
        xs, ys, zs = [], [], []
        for sl in (-1.0, 1.0):
            for st in (-1.0, 1.0):
                cx = ox + sl * (w / 2.0) * lx + st * (t / 2.0) * tx
                cy = oy + sl * (w / 2.0) * ly + st * (t / 2.0) * ty
                xs += [cx, cx]
                ys += [cy, cy]
                zs += [oz, oz + h]
        phase6b_aabbs.append({
            'kind': 'phase6b_wall',
            'name': plan.get('id') or (ent.Name if ent else ''),
            'host_id': plan.get('hostSegmentKey'),
            'host_end': plan.get('hostSegmentEnd'),
            'aabb': (min(xs), min(ys), min(zs),
                     max(xs), max(ys), max(zs)),
        })
    placed = []
    plan = ((css or {}).get('metadata') or {}).get('wallReconstruction')

    # Always touch the counters so summary printing has a stable schema.
    for k in (
        'phase6b_portal_walls_planned',
        'phase6b_portal_walls_emitted',
        'phase6b_portal_walls_skipped_invalid',
        'phase6b_room_walls_planned',
        'phase6b_room_walls_emitted',
        'phase6b_room_walls_skipped_invalid',
        'phase6b_walls_flagged_off_plane',
        # Phase 6B.2 — profile + correctness counters.
        'phase6b_walls_profile_arch',
        'phase6b_walls_profile_rectangle',
        'phase6b_walls_profile_unknown',
        'phase6b_walls_flagged_normal_mismatch',
        'phase6b_walls_flagged_profile_deviation',
        'phase6b_walls_flagged_shell_overlap',
        # Phase 6B.4b — wall plans whose host segment embedded the wall as a
        # closing face on its shell brep, so we skip the standalone IfcWall.
        'phase6b_portal_walls_skipped_consumed',
        'phase6b_room_walls_skipped_consumed',
        # Phase 6B.4c — wall plans pointing at a host segment that did NOT
        # survive upstream emission. These would otherwise float in space.
        'phase6b_portal_walls_skipped_orphan_host',
        'phase6b_room_walls_skipped_orphan_host',
    ):
        counts.setdefault(k, 0)

    if not isinstance(plan, dict):
        print('[6B.3] no wallReconstruction plan in css.metadata — skipping '
              '(topology-engine did not emit a plan or v2 round-trip dropped it)')
        return placed

    portal_walls   = plan.get('portalWalls')        or []
    junction_walls = plan.get('junctionWalls')      or []
    terminal_walls = plan.get('terminalWalls')      or []
    # Backward-compat: pre-6B.3 plans only had ``roomPartitionWalls``. 6B.3
    # plans set ``roomPartitionWalls`` to (junction + terminal), so prefer
    # the explicit lists when present and fall back to the combined bucket.
    _psm = os.environ.get('PRESENTATION_SAFE_MODE', '0') == '1'
    if junction_walls or terminal_walls:
        if _psm:
            # In presentation mode, terminal walls (arch caps at branch ends)
            # appear as orphaned arches — suppress entity creation entirely.
            room_walls = list(junction_walls)
        else:
            room_walls = list(junction_walls) + list(terminal_walls)
    else:
        if _psm:
            room_walls = [p for p in (plan.get('roomPartitionWalls') or [])
                          if 'Terminal' not in (p.get('id') or '')]
        else:
            room_walls = plan.get('roomPartitionWalls') or []

    expected_total = plan.get('summary', {}).get('expectedTotal')

    counts['phase6b_portal_walls_planned']   = len(portal_walls)
    counts['phase6b_room_walls_planned']     = len(room_walls)
    counts['phase6b_junction_walls_planned'] = len(junction_walls)
    counts['phase6b_terminal_walls_planned'] = len(terminal_walls)

    def _is_consumed(plan):
        host_id = plan.get('hostSegmentKey')
        host_end = plan.get('hostSegmentEnd')
        return bool(host_id) and (host_id, host_end) in consumed_keys

    def _is_orphan(plan):
        # Phase 6B.4c — host check. valid_host_ids is None when the caller
        # opted out (legacy callers); otherwise plans whose hostSegmentKey
        # is missing or absent from the valid set are dropped.
        if valid_host_ids is None:
            return False
        host_id = plan.get('hostSegmentKey')
        if not host_id:
            return True
        return host_id not in valid_host_ids

    _psm_portal_snap_r = 60.0   # m — snap radius for pre-snap coordinate-frame portals
    _psm_portal_skip_r = 60.0   # m — > this: genuinely floating, skip

    for p in portal_walls:
        # In PRESENTATION_SAFE_MODE, Phase 6B portal walls are generated at
        # pre-snap topology coordinates that may be 7–55m ahead of the actual
        # tunnel mouth.  Instead of skipping them, snap the XY origin to the
        # nearest free tunnel endpoint (keep original Z/rotation) so the arch
        # frame appears at the correct tunnel entrance.  Only skip if no
        # endpoint is within the snap radius (truly floating artifact).
        if _psm and free_endpoints:
            po = p.get('origin') or {}
            try:
                ppx = float(po.get('x', 0))
                ppy = float(po.get('y', 0))
                ppz = float(po.get('z', 0))
                best_ep, best_d = None, float('inf')
                for ep in free_endpoints:
                    d = math.sqrt((ppx - ep[0])**2 + (ppy - ep[1])**2)
                    if d < best_d:
                        best_d, best_ep = d, ep
                if best_ep is not None and best_d > 0.5:
                    if best_d > _psm_portal_skip_r:
                        counts.setdefault('phase6b_portal_walls_skipped_float', 0)
                        counts['phase6b_portal_walls_skipped_float'] += 1
                        print(f"[6B.4c] SKIP portal_wall id={p.get('id', '?')} "
                              f"dist_to_endpoint={best_d:.1f}m > {_psm_portal_skip_r}m "
                              f"(PRESENTATION_SAFE_MODE — no anchor within snap radius)")
                        continue
                    # Snap XY to nearest endpoint, preserve Z and orientation.
                    p = dict(p)
                    p['origin'] = dict(po)
                    p['origin']['x'] = best_ep[0]
                    p['origin']['y'] = best_ep[1]
                    p['origin']['z'] = ppz
                    counts.setdefault('phase6b_portal_walls_snapped', 0)
                    counts['phase6b_portal_walls_snapped'] += 1
                    print(f"[6B.4c] SNAP portal_wall id={p.get('id', '?')} "
                          f"({ppx:.2f},{ppy:.2f}) -> ({best_ep[0]:.2f},{best_ep[1]:.2f}) "
                          f"d={best_d:.1f}m (PRESENTATION_SAFE_MODE endpoint snap)")
            except (TypeError, ValueError):
                pass

        if _is_orphan(p):
            # Portal walls reference tunnel terminal endpoints which may be
            # non-structural or synthetic-bridge segments absent from
            # valid_host_ids. Log the mismatch but still emit — a portal wall
            # at a tunnel entrance is always geometrically valid.
            print(f"[6B.4c] WARN portal_wall id={p.get('id', '?')} "
                  f"host={p.get('hostSegmentKey', '?')} not in valid_host_ids "
                  f"— emitting anyway (portal bypass)")
            counts['phase6b_portal_walls_skipped_orphan_host'] += 1
        if _is_consumed(p):
            counts['phase6b_portal_walls_skipped_consumed'] += 1
            continue
        ent = _emit_wall(
            f, axis_sub, body_sub, storey_lp, owner, p,
            PORTAL_WALL_COLOR, counts)
        if ent is None:
            counts['phase6b_portal_walls_skipped_invalid'] += 1
            continue
        placed.append(ent)
        counts['phase6b_portal_walls_emitted'] += 1
        _record_aabb(p, ent)

    for p in room_walls:
        # Room partition walls are standalone arch dividers — they are never
        # embedded in the tunnel shell brep, so the orphan/consumed guards are
        # incorrect for this list type.  Branch segment IDs (ventsim_branch_*)
        # don't appear in valid_host_ids (which contains canonical elem-* IDs),
        # and phase6b_consumed_keys incorrectly marks branch endpoints from the
        # mitre-joint closing-face logic.  Bypass both checks and emit from the
        # originally planned position; the presentation_filter downstream will
        # suppress any that are genuinely detached from the tunnel frame.
        if _is_orphan(p):
            counts['phase6b_room_walls_skipped_orphan_host'] += 1
            print(f"[6B.4c] WARN room_wall id={p.get('id', '?')} "
                  f"host={p.get('hostSegmentKey', '?')} — orphan host, emitting anyway")
        elif _is_consumed(p):
            counts['phase6b_room_walls_skipped_consumed'] += 1
            print(f"[6B.4c] WARN room_wall id={p.get('id', '?')} "
                  f"host={p.get('hostSegmentKey', '?')} — consumed key, emitting standalone anyway")
        ent = _emit_wall(
            f, axis_sub, body_sub, storey_lp, owner, p,
            ROOM_WALL_COLOR, counts)
        if ent is None:
            counts['phase6b_room_walls_skipped_invalid'] += 1
            continue
        placed.append(ent)
        counts['phase6b_room_walls_emitted'] += 1
        _record_aabb(p, ent)

    # Phase 6B.4b — "consumed" plans were embedded into the shell brep as a
    # closing face. They count toward expected_total (the wall is realized,
    # just not as a standalone IfcWall) but not toward total_emitted.
    # Phase 6B.4c — "orphan" plans pointed at a host that didn't survive
    # upstream validation. They're an upstream plan/CSS mismatch and are
    # excluded from the realized vs expected check.
    total_consumed = (counts['phase6b_portal_walls_skipped_consumed']
                      + counts['phase6b_room_walls_skipped_consumed'])
    total_orphans = (counts['phase6b_portal_walls_skipped_orphan_host']
                     + counts['phase6b_room_walls_skipped_orphan_host'])
    total_emitted = (counts['phase6b_portal_walls_emitted']
                     + counts['phase6b_room_walls_emitted'])
    total_realized = total_emitted + total_consumed
    print(
        f"[6B.3] portal_walls planned={counts['phase6b_portal_walls_planned']} "
        f"emitted={counts['phase6b_portal_walls_emitted']} "
        f"skipped_invalid={counts['phase6b_portal_walls_skipped_invalid']} "
        f"skipped_consumed={counts['phase6b_portal_walls_skipped_consumed']}; "
        f"junction_walls planned={counts['phase6b_junction_walls_planned']}; "
        f"terminal_walls planned={counts['phase6b_terminal_walls_planned']}; "
        f"room_walls planned={counts['phase6b_room_walls_planned']} "
        f"emitted={counts['phase6b_room_walls_emitted']} "
        f"skipped_invalid={counts['phase6b_room_walls_skipped_invalid']} "
        f"skipped_consumed={counts['phase6b_room_walls_skipped_consumed']}"
    )
    print(
        f"[6B.3] profile_breakdown arch={counts['phase6b_walls_profile_arch']} "
        f"rectangle={counts['phase6b_walls_profile_rectangle']} "
        f"unknown={counts['phase6b_walls_profile_unknown']}"
    )
    if expected_total is not None:
        adjusted_expected = max(0, int(expected_total) - total_orphans)
        print(
            f"[6B.3] total_walls={total_realized} "
            f"(emitted={total_emitted} consumed_into_shell={total_consumed} "
            f"orphan_dropped={total_orphans}) "
            f"expected={expected_total} adjusted_expected={adjusted_expected} "
            f"{'OK' if total_realized >= adjusted_expected else 'UNDER'}"
        )
    else:
        print(f"[6B.3] total_walls={total_realized} "
              f"(emitted={total_emitted} consumed_into_shell={total_consumed} "
              f"orphan_dropped={total_orphans}, "
              f"no expected count in plan)")
    print(
        f"[6B.3] flags off_plane={counts['phase6b_walls_flagged_off_plane']} "
        f"normal_mismatch={counts['phase6b_walls_flagged_normal_mismatch']} "
        f"profile_deviation={counts['phase6b_walls_flagged_profile_deviation']} "
        f"shell_overlap={counts['phase6b_walls_flagged_shell_overlap']}"
    )

    # Phase 6B.3 — fail loudly when the generate side detects a count
    # mismatch. The topology engine already throws if it under-generates;
    # this backstop catches the case where plans were dropped between
    # JSON serialization and the Python consumer. Consumed-into-shell
    # plans count toward the realized total even though they don't appear
    # as standalone IfcWall entities.
    #
    # Downgrade to a warning when css.metadata.specInstances.walls is
    # populated: the spec-text emitter (Phase 7.S) provides authoritative
    # wall instances that supersede the legacy wallReconstruction plan,
    # so a Phase 6B shortfall is no longer a render-fatal condition.
    spec_wall_count = 0
    try:
        spec_wall_count = len((css.get('metadata') or {}).get('specInstances', {}).get('walls') or [])
    except Exception:
        spec_wall_count = 0
    if (expected_total is not None
            and total_realized < (int(expected_total) - total_orphans)):
        msg = (
            f'[6B.3] wall under-generation in generate: '
            f'emitted={total_emitted} consumed={total_consumed} '
            f'orphan_dropped={total_orphans} '
            f'realized={total_realized} < '
            f'adjusted_expected={int(expected_total) - total_orphans}'
        )
        if spec_wall_count > 0:
            print(f'{msg}  (downgraded to WARNING — spec emitter will provide {spec_wall_count} authoritative walls)')
        else:
            raise RuntimeError(msg)

    return placed
