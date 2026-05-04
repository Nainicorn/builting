"""Generic attachment stage.

5A.11 — first attachment helpers moved out of clean_tunnel_export.py with
behavior preserved exactly. No strict-enforcement changes; no new validation
behavior; no duct cleanup.

5B.4 — generic frame-plane projection helpers added so doors (or any hosted
panel) can be aligned to a frame face with bounds clamping.

Public helpers:
    _snap_origin_to_nearest_endpoint(origin, kept_endpoints, max_dist)
    _reconstruct_shaft_endpoints(elem)
    project_point_onto_frame(point, anchor, local_y, local_z)        — 5B.4
    in_frame_opening(uv, half_inner_w, half_inner_h)                 — 5B.4

Helpers intentionally NOT moved here:
    _snap_shaft_to_tunnel_arch  — uses SHAFT_SNAP_DIST as a default arg;
                                  moving requires either centralizing the
                                  constant or accepting it as a positional
                                  arg, both out of scope for 5A.11.
    Any _emit_*                 — emission, not attachment.
    Door host resolution        — currently inlined in _emit_door; extracting
                                  it would be new logic.
"""

import math

from secondary_geometry.validation import _safe_float, _safe_xyz


def _snap_origin_to_nearest_endpoint(origin, kept_endpoints, max_dist):
    """If `origin` (xyz) is within `max_dist` (xy) of any kept endpoint, return
    that endpoint. Otherwise return the original origin unchanged.
    Returns (snapped_origin, was_adjusted_bool, snap_distance_or_None).
    """
    if not kept_endpoints:
        return origin, False, None
    ox, oy = origin[0], origin[1]
    best_d2 = float('inf')
    best_pt = None
    for ep in kept_endpoints:
        d2 = (ox - ep[0]) ** 2 + (oy - ep[1]) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best_pt = ep
    if best_pt is None or best_d2 > max_dist * max_dist:
        return origin, False, None
    return best_pt, True, math.sqrt(best_d2)


def _reconstruct_shaft_endpoints(elem):
    """For a tagged vertical-shaft element missing startPoint/endPoint, try to
    construct (start, end) from alternative fields.

    Tries (in order):
        origin   <- placement.origin / properties.center / properties.location
        height   <- geometry.depth / properties.height_m / properties.height /
                    properties.shaftHeight

    Returns (start, end) or None if neither origin nor height is available.
    """
    props = elem.get('properties', {}) or {}
    placement = elem.get('placement', {}) or {}
    geom = elem.get('geometry', {}) or {}

    origin = _safe_xyz(placement.get('origin'))
    if origin is None:
        origin = _safe_xyz(props.get('center'))
    if origin is None:
        origin = _safe_xyz(props.get('location'))
    if origin is None:
        return None

    height = (_safe_float(geom.get('depth'))
              or _safe_float(props.get('height_m'))
              or _safe_float(props.get('height'))
              or _safe_float(props.get('shaftHeight')))
    if not height or height <= 0:
        return None

    return origin, (origin[0], origin[1], origin[2] + height)


def project_point_onto_frame(point, anchor, local_y, local_z):
    """Project a 3D `point` onto the frame plane defined at `anchor` by the
    in-plane axes (local_y, local_z). Frame normal is implied by local_y x
    local_z (the frame's outward direction).

    Returns (projected_point_xyz, uv) where uv = (u, v) are the in-plane
    coordinates with u along local_y and v along local_z. The frame plane is
    the set of points whose component along the frame normal equals zero.

    No tunnel/portal-specific logic. Pure linear algebra.
    """
    dx = point[0] - anchor[0]
    dy = point[1] - anchor[1]
    dz = point[2] - anchor[2]
    u = dx * local_y[0] + dy * local_y[1] + dz * local_y[2]
    v = dx * local_z[0] + dy * local_z[1] + dz * local_z[2]
    proj = (
        anchor[0] + u * local_y[0] + v * local_z[0],
        anchor[1] + u * local_y[1] + v * local_z[1],
        anchor[2] + u * local_y[2] + v * local_z[2],
    )
    return proj, (u, v)


def in_frame_opening(uv, half_inner_w, half_inner_h, panel_half_w=0.0,
                     panel_half_h=0.0):
    """True iff a panel of footprint (panel_half_w x panel_half_h) centered at
    `uv` (u along width, v along height) fits entirely inside an opening of
    half-extents (half_inner_w, half_inner_h).

    A point is "in the opening" if |u| + panel_half_w <= half_inner_w and
    |v| + panel_half_h <= half_inner_h.
    """
    u, v = uv
    return (abs(u) + panel_half_w <= half_inner_w
            and abs(v) + panel_half_h <= half_inner_h)


def clamp_panel_to_opening(uv, panel_w, panel_h, inner_w, inner_h):
    """Clamp a panel's (width, height) so it fits within (inner_w, inner_h)
    after centering at `uv` inside the opening. Returns the clamped
    (width, height). If the panel is already smaller and centered inside the
    opening, returns the input unchanged.

    Generic — no tunnel/door semantics. Caller decides what to do with the
    clamped result (apply to extrusion, fail, etc.).
    """
    u, v = uv
    max_w = max(0.0, 2.0 * (inner_w / 2.0 - abs(u)))
    max_h = max(0.0, 2.0 * (inner_h / 2.0 - abs(v)))
    return min(panel_w, max_w), min(panel_h, max_h)
