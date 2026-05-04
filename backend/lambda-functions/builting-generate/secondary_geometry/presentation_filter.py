"""
presentation_filter.py — PRESENTATION_SAFE_MODE spatial filter.

After all IFC geometry is emitted, this filter checks every non-primary
element against the actual tunnel segment centerlines. Elements that are
not confidently anchored to the tunnel frame are suppressed (removed from
spatial containment so they won't be visible).

The tunnel bbox used by the existing VQ gate is too coarse — it can't
distinguish an element that's offset due to a coordinate-frame mismatch
from one that's genuinely floating 40m away.  This module uses 3-D
point-to-segment-centerline distance so the filter is frame-aware.

Design rules (from presentation requirements):
  - Non-portal, non-room visible geometry within MAX_DIST_GENERIC m of
    tunnel shell.
  - Attached rooms and portal buildings within MAX_DIST_PORTAL m of
    nearest free endpoint.
  - Any element with height > MAX_SHAFT_HEIGHT suppressed (unless
    PRIMARY_TUNNEL).
  - Duct / pipe midpoint more than MAX_DIST_DUCT m from nearest
    segment centerline is suppressed.
  - Default/zero origins are always suppressed.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Thresholds
# ---------------------------------------------------------------------------

MAX_DIST_GENERIC    = 3.0    # m — non-portal, non-room non-tunnel element
MAX_DIST_PORTAL     = 10.0   # m — portal block from nearest free endpoint
MAX_DIST_ROOM_WALL  = 5.0    # m — room partition wall from any tunnel point
MAX_DIST_DUCT       = 5.0    # m — duct midpoint from segment centerline
MAX_SHAFT_HEIGHT    = 12.0   # m — suppress visible shafts taller than this
DEFAULT_ORIGIN_EPS  = 1e-3   # m — treat origin ~(0,0,0) as missing


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _pt3(pt) -> Optional[Tuple[float, float, float]]:
    """Coerce any 3-element sequence/dict to (x,y,z) or None."""
    if isinstance(pt, (list, tuple)) and len(pt) >= 3:
        try:
            return float(pt[0]), float(pt[1]), float(pt[2])
        except (TypeError, ValueError):
            return None
    if isinstance(pt, dict):
        try:
            return float(pt['x']), float(pt['y']), float(pt['z'])
        except (KeyError, TypeError, ValueError):
            return None
    return None


def _seg3_dist(p, a, b) -> float:
    """3-D distance from point p to the finite line segment a→b."""
    dx, dy, dz = b[0]-a[0], b[1]-a[1], b[2]-a[2]
    L2 = dx*dx + dy*dy + dz*dz
    if L2 < 1e-9:
        return math.sqrt((p[0]-a[0])**2 + (p[1]-a[1])**2 + (p[2]-a[2])**2)
    t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy + (p[2]-a[2])*dz) / L2
    t = max(0.0, min(1.0, t))
    cx, cy, cz = a[0]+t*dx, a[1]+t*dy, a[2]+t*dz
    return math.sqrt((p[0]-cx)**2 + (p[1]-cy)**2 + (p[2]-cz)**2)


def _ep_dist(p, endpoints) -> float:
    if not endpoints:
        return float('inf')
    return min(
        math.sqrt((p[0]-ep[0])**2 + (p[1]-ep[1])**2 + (p[2]-ep[2])**2)
        for ep in endpoints
    )


def _seg_dist(p, centerlines) -> float:
    if not centerlines:
        return float('inf')
    return min(_seg3_dist(p, cl[0], cl[1]) for cl in centerlines)


def _is_default_origin(o) -> bool:
    return abs(o[0]) < DEFAULT_ORIGIN_EPS and abs(o[1]) < DEFAULT_ORIGIN_EPS and abs(o[2]) < DEFAULT_ORIGIN_EPS


# ---------------------------------------------------------------------------
# Build centerlines from horizontal_candidates
# ---------------------------------------------------------------------------

def build_centerlines(
    horizontal_candidates: List[Dict],
    emitted_wall_indices,
) -> List[Tuple]:
    """Return list of (start_pt, end_pt, elem_id) for emitted tunnel segments."""
    result = []
    for i in emitted_wall_indices:
        c = horizontal_candidates[i]
        s = _pt3(c.get('start'))
        e = _pt3(c.get('end'))
        if s and e:
            result.append((s, e, c.get('elem_id', str(i))))
    return result


# ---------------------------------------------------------------------------
# IFC entity origin reader
# ---------------------------------------------------------------------------

def read_ifc_origin(ent) -> Optional[Tuple[float, float, float]]:
    """Read the local-placement origin from an IfcProduct."""
    try:
        lp  = ent.ObjectPlacement
        rp  = lp.RelativePlacement
        loc = rp.Location
        coords = loc.Coordinates
        return float(coords[0]), float(coords[1]), float(coords[2])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Classify a single element
# ---------------------------------------------------------------------------

def classify(
    origin: Tuple[float, float, float],
    ifc_class: str,
    obj_type: str,
    list_type: str,
    centerlines: List,
    free_endpoints: List,
    height: float = 0.0,
) -> Tuple[str, str]:
    """
    Returns (decision, reason).
    decision: 'VISIBLE' | 'SUPPRESS'
    """
    if _is_default_origin(origin):
        return 'SUPPRESS', 'default_origin'

    dist_seg = _seg_dist(origin, centerlines)
    dist_ep  = _ep_dist(origin, free_endpoints)
    dist_any = min(dist_seg, dist_ep)

    obj_upper = obj_type.upper()
    cls_upper = ifc_class.upper()

    # --- Shaft ---
    # Shafts are explicitly synthesized vertical structures rising from branch
    # rooms — their XY origin is over a room, not on the tunnel centerline, so
    # the 3 m proximity check would suppress every valid shaft.  Use a generous
    # 20 m radius (covers any branch-room offset) and only guard on height.
    is_shaft = (list_type == 'SHAFT'
                or 'SHAFT' in obj_upper
                or ifc_class == 'IfcColumn'
                or (list_type == 'P7' and 'SHAFT' in obj_upper))
    if is_shaft:
        # The generator clamps shaft height/radius before creating the IFC entity,
        # so the height seen here (from raw metadata) doesn't reflect the final
        # geometry.  Only suppress shafts that are genuinely disconnected from the
        # tunnel frame (> 20 m from any centerline or endpoint).
        if dist_any > 20.0:
            return 'SUPPRESS', f'shaft_float_{dist_any:.1f}m'
        return 'VISIBLE', 'shaft_ok'

    # --- Portal blocks / end walls ---
    if list_type == 'PORTAL' or (list_type == 'P7' and 'PORTAL' in obj_upper):
        if dist_ep > MAX_DIST_PORTAL:
            return 'SUPPRESS', f'portal_float_{dist_ep:.1f}m'
        return 'VISIBLE', 'portal_ok'

    # --- Ducts (IfcFlowSegment / IfcDuctSegment) ---
    # Use the spatial distance check: ducts whose midpoint is within
    # MAX_DIST_DUCT of the nearest tunnel segment centerline are inside the bore
    # and should be visible.  Fittings and MEP accessories are still suppressed
    # (they render as abstract topology nodes, not meaningful geometry).
    is_duct = list_type == 'DUCT' or ifc_class in (
        'IfcFlowSegment', 'IfcDuctSegment')
    if is_duct:
        if dist_seg > MAX_DIST_DUCT:
            return 'SUPPRESS', f'duct_float_{dist_seg:.1f}m'
        return 'VISIBLE', 'duct_ok'

    is_fitting = list_type == 'FITTING' or ifc_class in (
        'IfcDuctFitting', 'IfcFlowFitting', 'IfcFan', 'IfcAirTerminal')
    if is_fitting:
        return 'SUPPRESS', 'fitting_presentation_off'

    # --- Room partition walls ---
    # TERMINAL_WALL: arch caps at branch ends — they appear orphaned when the branch
    # tunnel body isn't prominently visible from the camera angle.  Only emit
    # JUNCTION_WALL (interior dividers) and PORTAL_WALL (major portal frames).
    if list_type == 'ROOM_WALL':
        if 'TERMINAL' in obj_upper:
            return 'SUPPRESS', 'terminal_wall_presentation_off'
        if dist_any > MAX_DIST_ROOM_WALL:
            return 'SUPPRESS', f'room_wall_float_{dist_any:.1f}m'
        return 'VISIBLE', 'room_wall_ok'

    # --- Phase 7 elements ---
    # Allow fans (key mechanical equipment) through — suppress the rest (lights,
    # cables, spaces, slabs) which render as visual noise in the viewer.
    if list_type == 'P7' and ifc_class == 'IfcFan':
        if dist_any > MAX_DIST_GENERIC:
            return 'SUPPRESS', f'fan_float_{dist_any:.1f}m'
        return 'VISIBLE', 'fan_ok'

    if list_type == 'P7' or ifc_class in ('IfcSpace', 'IfcSlab', 'IfcCovering'):
        return 'SUPPRESS', 'p7_presentation_off'

    # --- Default ---
    if dist_any > MAX_DIST_GENERIC:
        return 'SUPPRESS', f'float_{dist_any:.1f}m'
    return 'VISIBLE', 'ok'


# ---------------------------------------------------------------------------
# Filter a list of IFC entities
# ---------------------------------------------------------------------------

def filter_list(
    entity_list: List,
    list_type: str,
    centerlines: List,
    free_endpoints: List,
    entity_heights: Optional[Dict] = None,
    audit_rows: Optional[List] = None,
) -> Tuple[List, int]:
    """Filter IFC entities based on spatial attachment to tunnel frame.

    Returns (kept_list, suppressed_count).
    entity_heights: {id(ent): height_m} for shaft height checks.
    audit_rows: if provided, each classified element appends a dict row.
    """
    kept = []
    suppressed = 0
    entity_heights = entity_heights or {}
    if audit_rows is None:
        audit_rows = []

    for ent in entity_list:
        origin = read_ifc_origin(ent)
        if origin is None:
            # No placement readable — keep to avoid hiding valid geometry.
            kept.append(ent)
            continue

        ifc_class = ent.is_a()
        obj_type  = getattr(ent, 'ObjectType', None) or ''
        height    = entity_heights.get(id(ent), 0.0)

        decision, reason = classify(
            origin, ifc_class, obj_type, list_type,
            centerlines, free_endpoints, height,
        )

        audit_rows.append({
            'list_type':  list_type,
            'ifc_class':  ifc_class,
            'obj_type':   obj_type,
            'origin':     [round(v, 3) for v in origin],
            'height':     round(height, 2),
            'decision':   decision,
            'reason':     reason,
        })

        if decision == 'SUPPRESS':
            suppressed += 1
        else:
            kept.append(ent)

    return kept, suppressed


# ---------------------------------------------------------------------------
# Re-anchor a room wall plan to the nearest free endpoint
# ---------------------------------------------------------------------------

def reanchor_room_wall(
    plan: Dict,
    free_endpoints: List,
    max_search_m: float = 15.0,
) -> Optional[Dict]:
    """Try to re-anchor a room partition wall plan to the nearest free
    tunnel endpoint.

    If a free endpoint is found within max_search_m of the plan's origin,
    returns a copy of the plan with the origin replaced.  Returns None if
    no endpoint is close enough.
    """
    origin_d = (plan.get('origin') or {})
    try:
        ox = float(origin_d.get('x', 0))
        oy = float(origin_d.get('y', 0))
        oz = float(origin_d.get('z', 0))
    except (TypeError, ValueError):
        return None
    pt = (ox, oy, oz)

    best_ep   = None
    best_dist = float('inf')
    for ep in (free_endpoints or []):
        ep3 = _pt3(ep)
        if ep3 is None:
            continue
        d = math.sqrt((pt[0]-ep3[0])**2 + (pt[1]-ep3[1])**2 + (pt[2]-ep3[2])**2)
        if d < best_dist:
            best_dist = d
            best_ep   = ep3

    if best_ep is None or best_dist > max_search_m:
        return None

    reanchored = dict(plan)
    reanchored['origin'] = {'x': best_ep[0], 'y': best_ep[1], 'z': best_ep[2]}
    reanchored['_reanchored_from'] = {'x': ox, 'y': oy, 'z': oz}
    reanchored['_reanchor_dist_m'] = round(best_dist, 3)
    return reanchored
