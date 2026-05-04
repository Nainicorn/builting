"""
visual_quality_gate.py — Per-element visual quality gate for IFC generation.

Before emitting visible geometry for any element, callers pass the element +
context through visual_gate(). The gate returns (decision, reason) so the
caller can choose to:
  VISIBLE      — emit full visible geometry
  METADATA_ONLY — emit IFC entity with placement but no Representation
  SUPPRESS      — skip entirely

An audit row is collected for every element so the run produces a structured
visual-audit report that explains every emit/suppress decision.

Emit modes
----------
VISUAL_SAFE  (default) — strict visual quality gate; suppresses aggressively.
                         Prefer fewer clean objects over complete cluttered model.
TUNNEL_ONLY             — only tunnel shell, validated ducts/fittings, high-conf equip
FULL                    — no gate, emit everything with geometry
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Thresholds — strict in VISUAL_SAFE mode
# ---------------------------------------------------------------------------

# XY distance from tunnel bbox edge.  Tight values prevent floating objects.
DIST_THRESHOLD_WALL     = 1.0    # m — portal walls must be close to tunnel endpoint
DIST_THRESHOLD_SHAFT    = 2.0    # m — shaft must overlap/attach to tunnel
DIST_THRESHOLD_EQUIP    = 2.0    # m — equipment must sit on duct or tunnel surface
DIST_THRESHOLD_MEP      = 5.0    # m — MEP must be near the tunnel network

# SPACE/SLAB/COVERING: suppressed entirely in VISUAL_SAFE (no room shells).
# These constants are kept for FULL mode only.
DIST_THRESHOLD_SPACE    = 5.0
DIST_THRESHOLD_SLAB     = 5.0
DIST_THRESHOLD_COVERING = 5.0

# MEP sanity bounds — diagonal stray rods fail these
MEP_MAX_SEGMENT_LENGTH  = 80.0   # m
MEP_MIN_SEGMENT_LENGTH  = 0.05   # m

# Elements placed exactly at (0,0,0) are almost always default/missing origins.
DEFAULT_ORIGIN_EPSILON = 1e-3   # m

# Shaft clamping — caps applied in VISUAL_SAFE mode unless authoritative.
SHAFT_MAX_RADIUS_DEFAULT = 0.6   # m — small neutral marker
SHAFT_MAX_HEIGHT_DEFAULT = 1.5   # m — small neutral marker

# FINAL_LIKE thresholds — stricter than VISUAL_SAFE.
# Shaft: clamp hard regardless of authoritative flag; only render when close.
SHAFT_FINAL_MAX_RADIUS     = 0.75   # m
SHAFT_FINAL_MAX_HEIGHT     = 6.0    # m
SHAFT_FINAL_MAX_DIST       = 3.0    # m from tunnel bbox to shaft origin

# Wall: only portals/junctions within this distance of tunnel bbox.
WALL_FINAL_MAX_DIST        = 2.5    # m

# Thin member: both path endpoints must be within this of tunnel bbox.
THIN_MEMBER_ANCHOR_MAX_DIST = 0.75  # m

# Any non-tunnel element more than this far from its declared host is suppressed.
ELEM_MAX_DIST_FROM_HOST    = 10.0   # m

# Equipment: same proximity as VISUAL_SAFE but turned to SUPPRESS (not metadata-only).
EQUIP_FINAL_MAX_DIST       = 2.0    # m

# High-confidence equipment semantic types that earn visible geometry.
EQUIPMENT_VISIBLE_SEMANTIC = frozenset({
    'IfcFan', 'IfcElectricGenerator', 'IfcUnitaryEquipment',
    'IfcAirTerminalBox', 'IfcAirHandler',
})
EQUIPMENT_VISIBLE_NAME_KEYS = (
    'generator', 'ahu', 'air handler', 'air-handler', '9500', '19000',
)

# Spatial flags that always suppress regardless of emit mode.
ALWAYS_SUPPRESS_FLAGS = frozenset({
    'FLOATING', 'ORPHAN_WALL', 'NOT_INTEGRATED',
    'DOOR_REJECTED', 'WALL_INSIDE_TUNNEL',
})


# ---------------------------------------------------------------------------
# Audit row
# ---------------------------------------------------------------------------

@dataclass
class VisualAuditRow:
    elem_id: str
    css_type: str
    intended_ifc_class: str
    origin: Optional[Tuple[float, float, float]]
    dimensions: Optional[Tuple[float, float, float]]
    distance_to_tunnel: Optional[float]
    spatial_flag: str
    confidence: float
    emit_decision: str   # 'VISIBLE' | 'METADATA_ONLY' | 'SUPPRESS'
    reason: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_float(v, default=None):
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _extract_origin(elem: Dict) -> Optional[Tuple[float, float, float]]:
    plc = elem.get('placement') or {}
    o = plc.get('origin')
    if not isinstance(o, dict):
        return None
    x = _safe_float(o.get('x'))
    y = _safe_float(o.get('y'))
    z = _safe_float(o.get('z'))
    if x is None or y is None or z is None:
        return None
    return (x, y, z)


def _is_default_origin(origin: Tuple[float, float, float]) -> bool:
    return (
        abs(origin[0]) < DEFAULT_ORIGIN_EPSILON
        and abs(origin[1]) < DEFAULT_ORIGIN_EPSILON
        and abs(origin[2]) < DEFAULT_ORIGIN_EPSILON
    )


def _extract_dimensions(elem: Dict) -> Optional[Tuple[float, float, float]]:
    geom = elem.get('geometry') or {}
    prof = geom.get('profile') or {}
    ptype = (prof.get('type') or '').upper()
    depth = _safe_float(geom.get('depth')) or _safe_float(geom.get('length'))
    if ptype == 'CIRCLE':
        r = _safe_float(prof.get('radius'))
        if r and r > 0:
            return (r * 2, r * 2, depth if depth else r * 2)
    if ptype in ('RECTANGLE', 'RECT'):
        w = _safe_float(prof.get('width'))
        h = _safe_float(prof.get('height'))
        if w and w > 0 and h and h > 0:
            return (w, h, depth if depth else h)
    return None


def _dist_to_tunnel_bbox(
    origin: Tuple[float, float, float],
    tunnel_bbox: Optional[Tuple[float, float, float, float]],
) -> Optional[float]:
    """XY distance from origin to nearest edge of the tunnel bounding box.

    Returns 0.0 if origin is inside the bbox.
    tunnel_bbox is (minX, maxX, minY, maxY).
    """
    if tunnel_bbox is None:
        return None
    try:
        min_x, max_x, min_y, max_y = (
            float(tunnel_bbox[0]), float(tunnel_bbox[1]),
            float(tunnel_bbox[2]), float(tunnel_bbox[3]),
        )
    except (TypeError, ValueError, IndexError):
        return None
    ox, oy = origin[0], origin[1]
    dx = max(min_x - ox, 0.0, ox - max_x)
    dy = max(min_y - oy, 0.0, oy - max_y)
    return math.sqrt(dx * dx + dy * dy)


def _is_high_confidence_equipment(elem: Dict) -> bool:
    sem = (elem.get('semanticType') or '').strip()
    if sem in EQUIPMENT_VISIBLE_SEMANTIC:
        return True
    name = (elem.get('name') or '').lower()
    return any(kw in name for kw in EQUIPMENT_VISIBLE_NAME_KEYS)


def _is_dimensions_authoritative(elem: Dict) -> bool:
    v = (elem.get('properties') or {}).get('dimensionsAuthoritative')
    return v is True or (isinstance(v, str) and v.lower() == 'true')


def _get_pt_coords(pt) -> Optional[Tuple[float, float, float]]:
    """Extract (x, y, z) from a path point (list/tuple or dict)."""
    if isinstance(pt, (list, tuple)) and len(pt) >= 3:
        x, y, z = _safe_float(pt[0]), _safe_float(pt[1]), _safe_float(pt[2])
        if x is not None and y is not None and z is not None:
            return (x, y, z)
    elif isinstance(pt, dict):
        x = _safe_float(pt.get('x'))
        y = _safe_float(pt.get('y'))
        z = _safe_float(pt.get('z'))
        if x is not None and y is not None and z is not None:
            return (x, y, z)
    return None


def _validate_thin_member_final_like(
    elem: Dict,
    tunnel_bbox: Optional[Tuple[float, float, float, float]],
) -> Tuple[bool, str]:
    """Check both path endpoints are anchored (within THIN_MEMBER_ANCHOR_MAX_DIST of tunnel bbox).

    Used in FINAL_LIKE mode for thin pipes/cables/rods to prevent stray members.
    """
    geom = elem.get('geometry') or {}
    path_pts = geom.get('pathPoints') or geom.get('path') or []
    if not isinstance(path_pts, list) or len(path_pts) < 2:
        return False, 'SUPPRESS_THIN_MEMBER_UNANCHORED:no_path_endpoints'
    p0 = _get_pt_coords(path_pts[0])
    p1 = _get_pt_coords(path_pts[-1])
    if p0 is None or p1 is None:
        return False, 'SUPPRESS_THIN_MEMBER_UNANCHORED:invalid_path_endpoints'
    d0 = _dist_to_tunnel_bbox(p0, tunnel_bbox)
    d1 = _dist_to_tunnel_bbox(p1, tunnel_bbox)
    if d0 is None or d1 is None:
        return False, 'SUPPRESS_THIN_MEMBER_UNANCHORED:no_tunnel_bbox'
    if d0 > THIN_MEMBER_ANCHOR_MAX_DIST:
        return False, f'SUPPRESS_THIN_MEMBER_UNANCHORED:start_unanchored:{d0:.2f}m'
    if d1 > THIN_MEMBER_ANCHOR_MAX_DIST:
        return False, f'SUPPRESS_THIN_MEMBER_UNANCHORED:end_unanchored:{d1:.2f}m'
    return True, 'ok'


def _validate_mep(
    elem: Dict,
    tunnel_bbox: Optional[Tuple[float, float, float, float]],
) -> Tuple[bool, str]:
    """Validate MEP element for visible emission in VISUAL_SAFE mode.

    Checks:
    - depth/length within sane bounds (rejects zero-length and stray rods)
    - path endpoint finiteness
    - path length within bounds (rejects diagonal stray lines)
    - distance to tunnel within DIST_THRESHOLD_MEP

    Returns (ok, reason).
    """
    geom = elem.get('geometry') or {}

    # Length check from explicit depth/length field
    depth = _safe_float(geom.get('depth')) or _safe_float(geom.get('length'))
    if depth is not None:
        if depth < MEP_MIN_SEGMENT_LENGTH:
            return False, f'mep_zero_length:{depth:.4f}m'
        if depth > MEP_MAX_SEGMENT_LENGTH:
            return False, f'mep_exceeds_max_length:{depth:.1f}m'

    # Path points check
    path_pts = geom.get('pathPoints') or geom.get('path') or []
    if isinstance(path_pts, list) and len(path_pts) >= 2:
        p0 = _get_pt_coords(path_pts[0])
        p1 = _get_pt_coords(path_pts[-1])
        if p0 is None or p1 is None:
            return False, 'mep_non_finite_path_endpoints'
        # Compute Euclidean path length for 2-point case
        if len(path_pts) == 2:
            path_len = math.sqrt(
                (p1[0] - p0[0]) ** 2 +
                (p1[1] - p0[1]) ** 2 +
                (p1[2] - p0[2]) ** 2
            )
            if path_len < MEP_MIN_SEGMENT_LENGTH:
                return False, f'mep_path_zero_length:{path_len:.4f}m'
            if path_len > MEP_MAX_SEGMENT_LENGTH:
                return False, f'mep_path_too_long:{path_len:.1f}m'

    # Distance to tunnel check — rejects elements not connected to tunnel network
    origin = _extract_origin(elem)
    if origin is not None and not _is_default_origin(origin):
        dist = _dist_to_tunnel_bbox(origin, tunnel_bbox)
        if dist is not None and dist > DIST_THRESHOLD_MEP:
            return False, f'mep_too_far_from_tunnel:{dist:.1f}m'
    elif tunnel_bbox is not None:
        # No usable origin — can't verify proximity, reject for safety
        return False, 'mep_no_origin_for_proximity_check'

    return True, 'ok'


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

def visual_gate(
    elem: Dict[str, Any],
    tunnel_bbox: Optional[Tuple[float, float, float, float]],
    emit_mode: str,
    connected_ids: Optional[frozenset] = None,
) -> Tuple[str, str]:
    """Determine whether an element should be emitted as visible geometry.

    Parameters
    ----------
    elem:          CSS element dict
    tunnel_bbox:   (minX, maxX, minY, maxY) of kept tunnel segments, or None
    emit_mode:     'FINAL_LIKE' | 'VISUAL_SAFE' | 'TUNNEL_ONLY' | 'FULL'
    connected_ids: optional frozenset of element IDs that are connected to the
                   tunnel network (used in FINAL_LIKE mode). If None, the
                   connected-component check is skipped.

    Returns
    -------
    (decision, reason)
      decision: 'VISIBLE' | 'METADATA_ONLY' | 'SUPPRESS'
    """
    etype = (elem.get('type') or '').upper()
    props = elem.get('properties') or {}
    spatial_flag = (props.get('spatialFlag') or '').upper()

    # Upstream spatial flags always respected regardless of mode.
    if spatial_flag in ALWAYS_SUPPRESS_FLAGS:
        return ('SUPPRESS', f'spatial_flag:{spatial_flag}')

    # ----------------------------------------------------------------
    # TUNNEL_ONLY: pass only tunnel-first geometry
    # ----------------------------------------------------------------
    if emit_mode == 'TUNNEL_ONLY':
        if etype == 'TUNNEL_SEGMENT':
            return ('VISIBLE', 'tunnel_only:tunnel_segment')
        if etype in ('DUCT', 'DUCT_FITTING', 'PIPE'):
            mep_ok, mep_reason = _validate_mep(elem, tunnel_bbox)
            if mep_ok:
                return ('VISIBLE', 'tunnel_only:mep_validated')
            return ('SUPPRESS', f'tunnel_only:mep_invalid:{mep_reason}')
        if etype == 'EQUIPMENT' and _is_high_confidence_equipment(elem):
            return ('VISIBLE', 'tunnel_only:high_confidence_equipment')
        return ('METADATA_ONLY', 'tunnel_only:non_core_type')

    # ----------------------------------------------------------------
    # FULL: no filtering
    # ----------------------------------------------------------------
    if emit_mode == 'FULL':
        return ('VISIBLE', 'full_mode:no_gate')

    # ----------------------------------------------------------------
    # FINAL_LIKE: strictest mode — tunnel shell + clean duct runs + doors.
    # Goal: render looks like final.ifc. Anything that creates visual
    # clutter (junction nodes, flat wall panels, shaft stubs, equipment
    # boxes) is suppressed. The tunnel shell pass already emits portal
    # end caps — Phase 7 must not add more geometry on top of them.
    # ----------------------------------------------------------------
    if emit_mode == 'FINAL_LIKE':
        # Upstream connected-component check (no-op when connected_ids is None).
        elem_id = elem.get('id', '')
        if connected_ids is not None and elem_id and elem_id not in connected_ids:
            return ('SUPPRESS', 'SUPPRESS_DISCONNECTED_COMPONENT')

        # Tunnel shell: pass unless this is a vertical shaft disguised as a
        # TUNNEL_SEGMENT (topology engine synthesizes vertical shafts with
        # type=TUNNEL_SEGMENT + properties.segmentType=VERTICAL_SHAFT).
        # Those must be suppressed — they have no clean bore and render as
        # an isolated cylinder with default geometry.
        if etype == 'TUNNEL_SEGMENT':
            seg_type_fl = (props.get('segmentType') or '').upper()
            if seg_type_fl == 'VERTICAL_SHAFT':
                return ('SUPPRESS', 'SUPPRESS_SHAFT_UNINTEGRATED:vertical_shaft_as_tunnel_segment')
            return ('VISIBLE', 'final_like:tunnel_segment')

        # Room-derived geometry: fully suppress.
        if etype in ('SPACE', 'SLAB', 'COVERING'):
            return ('SUPPRESS', f'SUPPRESS_ROOM_FRAGMENT:{etype}')

        # Proxy: suppress.
        if etype == 'PROXY':
            return ('SUPPRESS', 'SUPPRESS_UNHOSTED:proxy')

        # WALL: suppress ALL from Phase 7. The tunnel shell pass already
        # generates portal end caps and portal blocks cleanly. Additional
        # Phase 7B wall panels are flat planes that clutter the junction view.
        if etype == 'WALL':
            return ('SUPPRESS', 'SUPPRESS_WALL_NOT_ENCLOSURE:phase7_wall_suppressed')

        # SHAFT: suppress visual body — shafts without a machined bore opening
        # look like floating cylinders. Keep metadata so topology is preserved.
        if etype == 'SHAFT':
            return ('SUPPRESS', 'SUPPRESS_SHAFT_UNINTEGRATED:final_like_no_shaft_body')

        # DUCT_FITTING: emit IfcFlowFitting entity without visible geometry.
        # The synthesized junction box geometry rendered as visual clutter, but
        # the IFC schema needs the fitting entities for MEP topology completeness
        # (duct-to-duct connections, downstream BIM tools, validation gates).
        # Representation=None keeps the visual clean while the entity is present.
        if etype == 'DUCT_FITTING':
            return ('METADATA_ONLY', 'final_like:fitting_metadata_kept')

        # EQUIPMENT: suppress by default in FINAL_LIKE.
        # Exception: IfcFan elements that the topology engine mounted inside the
        # tunnel (container != level storey) are ceiling-hung inline fans and
        # should appear.  Room-contained fans (container='level-0' / 'level-1')
        # stay suppressed because their enclosing room shell is also suppressed.
        if etype == 'EQUIPMENT':
            sem = (elem.get('semanticType') or '').strip()
            container = (elem.get('container') or '')
            if sem == 'IfcFan' and container not in ('', 'level-0', 'level-1'):
                return ('VISIBLE', 'final_like:fan_tunnel_hosted')
            return ('SUPPRESS', 'SUPPRESS_UNHOSTED:equipment_body_suppressed')

        # PIPE / CABLE_TRAY: suppress — stray thin members with uncertain anchoring.
        if etype in ('PIPE', 'CABLE_TRAY'):
            return ('SUPPRESS', 'SUPPRESS_THIN_MEMBER_UNANCHORED:pipe_cable_suppressed')

        # DUCT / PIPE: suppress all Phase-7 MEP in FINAL_LIKE.
        # Validated duct elements (circular profile, near tunnel) still render
        # as stray cylinders and diagonal rods in the xeokit viewer because
        # their endpoint alignment with the bore wall is imprecise. The vent
        # duct reconstruction pass (Phase 5B.3) handles real ventilation when
        # not in FINAL_LIKE mode; here we want the cleanest possible bore.
        if etype == 'DUCT':
            return ('SUPPRESS', 'SUPPRESS_DISCONNECTED_COMPONENT:duct_p7_suppressed_final_like')

        # Door: only if it has a topology-assigned host wall.
        if etype == 'DOOR':
            host_wall = (
                (elem.get('metadata') or {}).get('hostWallKey')
                or props.get('hostWallId')
                or props.get('hostWallKey')
            )
            if not host_wall:
                return ('SUPPRESS', 'SUPPRESS_UNHOSTED:door_no_host')
            return ('VISIBLE', 'final_like:door_hosted')

        # All other types: suppress.
        return ('SUPPRESS', f'SUPPRESS_DISCONNECTED_COMPONENT:{etype}')

    # ----------------------------------------------------------------
    # VISUAL_SAFE (default): strict per-type quality gate
    # Prefer fewer clean objects over a complete but cluttered model.
    # ----------------------------------------------------------------

    # TUNNEL_SEGMENT always passes — it is the ground truth geometry.
    if etype == 'TUNNEL_SEGMENT':
        return ('VISIBLE', 'visual_safe:tunnel_segment')

    # MEP: visible only if topology is valid and element is near the tunnel.
    # Replaces the old "MEP always visible" rule that let stray rods through.
    if etype in ('DUCT', 'DUCT_FITTING', 'PIPE', 'CABLE_TRAY'):
        mep_ok, mep_reason = _validate_mep(elem, tunnel_bbox)
        if not mep_ok:
            return ('SUPPRESS', f'visual_safe:mep_invalid:{mep_reason}')
        return ('VISIBLE', 'visual_safe:mep_validated')

    # SPACE: metadata-only — no visual room bodies in VISUAL_SAFE.
    # Room shapes are not reliable enough given current extraction quality.
    if etype == 'SPACE':
        return ('METADATA_ONLY', 'visual_safe:no_room_shells')

    # SLAB: metadata-only — no floating floor plates in VISUAL_SAFE.
    if etype == 'SLAB':
        return ('METADATA_ONLY', 'visual_safe:no_room_slabs')

    # COVERING: metadata-only — no floating ceilings in VISUAL_SAFE.
    if etype == 'COVERING':
        return ('METADATA_ONLY', 'visual_safe:no_room_coverings')

    # For remaining types we need placement origin.
    origin = _extract_origin(elem)
    if origin is None:
        return ('METADATA_ONLY', 'no_placement_origin')

    if _is_default_origin(origin):
        return ('SUPPRESS', 'default_origin:(0,0,0)')

    dist = _dist_to_tunnel_bbox(origin, tunnel_bbox)

    # WALL: only portal-type walls that attach to tunnel endpoints.
    # Generic CSS WALL elements (room partitions) are suppressed.
    if etype == 'WALL':
        seg_type = (props.get('segmentType') or '').upper()
        if seg_type in ('PORTAL_BUILDING', 'PORTAL_END_WALL',
                        'JUNCTION_WALL', 'TERMINAL_WALL'):
            if dist is not None and dist > DIST_THRESHOLD_WALL + 0.5:
                return ('METADATA_ONLY',
                        f'visual_safe:portal_wall_too_far:{dist:.2f}m_cap_{DIST_THRESHOLD_WALL}m')
            return ('VISIBLE', f'visual_safe:portal_wall_attached:{seg_type}')
        # Non-portal wall: suppress — room partitions clutter the tunnel view.
        return ('SUPPRESS', 'visual_safe:room_wall_suppressed')

    # SHAFT: metadata-only unless source has authoritative dimensions and
    # the shaft is close enough to overlap the tunnel network.
    if etype == 'SHAFT':
        if not _is_dimensions_authoritative(elem):
            return ('METADATA_ONLY', 'visual_safe:shaft_not_authoritative')
        if dist is not None and dist > DIST_THRESHOLD_SHAFT:
            return ('METADATA_ONLY',
                    f'visual_safe:shaft_too_far:{dist:.2f}m_cap_{DIST_THRESHOLD_SHAFT}m')
        return ('VISIBLE', 'visual_safe:shaft_authoritative_close')

    # EQUIPMENT: only high-confidence type attached to duct/tunnel surface.
    if etype == 'EQUIPMENT':
        if not _is_high_confidence_equipment(elem):
            return ('METADATA_ONLY', 'visual_safe:equipment_low_confidence')
        if dist is not None and dist > DIST_THRESHOLD_EQUIP:
            return ('METADATA_ONLY',
                    f'visual_safe:equipment_too_far:{dist:.2f}m_cap_{DIST_THRESHOLD_EQUIP}m')
        return ('VISIBLE', 'visual_safe:equipment_high_conf_close')

    # DOOR: only if it has a valid host wall assigned by topology.
    if etype == 'DOOR':
        host_wall = (
            (elem.get('metadata') or {}).get('hostWallKey')
            or props.get('hostWallId')
            or props.get('hostWallKey')
        )
        if not host_wall:
            return ('METADATA_ONLY', 'visual_safe:door_no_host')
        return ('VISIBLE', 'visual_safe:door_hosted')

    # PROXY: metadata-only by default; real geometry carries real types.
    if etype == 'PROXY':
        return ('METADATA_ONLY', 'visual_safe:proxy_metadata_only')

    # Everything else (synthesized types, unknowns) is suppressed in VISUAL_SAFE.
    return ('SUPPRESS', f'visual_safe:type_suppressed:{etype}')


def shaft_clamped_dims(
    elem: Dict,
    max_radius: float = SHAFT_MAX_RADIUS_DEFAULT,
    max_height: float = SHAFT_MAX_HEIGHT_DEFAULT,
) -> Tuple[float, float, bool]:
    """Return (radius, height, was_clamped) after applying caps.

    Only clamps when dimensionsAuthoritative is not set.
    """
    authoritative = _is_dimensions_authoritative(elem)
    geom = elem.get('geometry') or {}
    prof = geom.get('profile') or {}
    props = elem.get('properties') or {}

    r = (_safe_float(prof.get('radius'))
         or (_safe_float(prof.get('diameter', 0)) / 2.0 if prof.get('diameter') else None)
         or 1.0)
    h = (_safe_float(geom.get('depth'))
         or _safe_float(geom.get('length'))
         or _safe_float(props.get('shaftHeight'))
         or _safe_float(props.get('height_m'))
         or _safe_float(props.get('height'))
         or 6.0)

    clamped = False
    if not authoritative:
        if r > max_radius:
            r = max_radius
            clamped = True
        if h > max_height:
            h = max_height
            clamped = True
    return (r, h, clamped)


def shaft_clamped_dims_final_like(elem: Dict) -> Tuple[float, float, bool]:
    """Return (radius, height, was_clamped) for FINAL_LIKE mode.

    Clamps to SHAFT_FINAL_MAX_RADIUS / SHAFT_FINAL_MAX_HEIGHT regardless of
    the dimensionsAuthoritative flag, so no shaft dominates the scene.
    """
    geom = elem.get('geometry') or {}
    prof = geom.get('profile') or {}
    props = elem.get('properties') or {}

    r = (_safe_float(prof.get('radius'))
         or (_safe_float(prof.get('diameter', 0)) / 2.0 if prof.get('diameter') else None)
         or 1.0)
    h = (_safe_float(geom.get('depth'))
         or _safe_float(geom.get('length'))
         or _safe_float(props.get('shaftHeight'))
         or _safe_float(props.get('height_m'))
         or _safe_float(props.get('height'))
         or 6.0)

    clamped = False
    if r > SHAFT_FINAL_MAX_RADIUS:
        r = SHAFT_FINAL_MAX_RADIUS
        clamped = True
    if h > SHAFT_FINAL_MAX_HEIGHT:
        h = SHAFT_FINAL_MAX_HEIGHT
        clamped = True
    return (r, h, clamped)


# ---------------------------------------------------------------------------
# Audit report builder
# ---------------------------------------------------------------------------

def build_audit_report(rows: List[VisualAuditRow]) -> Dict[str, Any]:
    visible   = [r for r in rows if r.emit_decision == 'VISIBLE']
    meta_only = [r for r in rows if r.emit_decision == 'METADATA_ONLY']
    suppressed = [r for r in rows if r.emit_decision == 'SUPPRESS']

    _DECISION_KEY = {'VISIBLE': 'visible', 'METADATA_ONLY': 'metadata_only', 'SUPPRESS': 'suppressed'}
    by_type: Dict[str, Dict[str, int]] = {}
    for r in rows:
        entry = by_type.setdefault(r.css_type, {'visible': 0, 'metadata_only': 0, 'suppressed': 0})
        key = _DECISION_KEY.get(r.emit_decision, r.emit_decision.lower())
        entry[key] = entry.get(key, 0) + 1

    # Suppression reason code counts — first token before ':' is the code.
    suppress_by_reason: Dict[str, int] = {}
    for r in suppressed:
        code = r.reason.split(':')[0] if ':' in r.reason else r.reason
        suppress_by_reason[code] = suppress_by_reason.get(code, 0) + 1

    return {
        'summary': {
            'total': len(rows),
            'visible': len(visible),
            'metadata_only': len(meta_only),
            'suppressed': len(suppressed),
        },
        'suppress_by_reason': suppress_by_reason,
        'by_type': by_type,
        'rows': [
            {
                'id':              r.elem_id,
                'type':            r.css_type,
                'ifc_class':       r.intended_ifc_class,
                'origin':          list(r.origin) if r.origin else None,
                'dimensions':      list(r.dimensions) if r.dimensions else None,
                'dist_tunnel_m':   round(r.distance_to_tunnel, 2) if r.distance_to_tunnel is not None else None,
                'spatial_flag':    r.spatial_flag or None,
                'confidence':      r.confidence,
                'decision':        r.emit_decision,
                'reason':          r.reason,
            }
            for r in rows
        ],
    }
