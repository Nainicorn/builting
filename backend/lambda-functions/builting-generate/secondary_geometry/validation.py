"""Generic per-element validation stage.

5A.8 — pure data validators moved out of clean_tunnel_export.py with
behavior preserved exactly. No strict-enforcement changes.

Public helpers:
    _safe_float(x)
    _safe_xyz(d, default=None)
    _extract_endpoints(elem)
    _extract_horizontal_profile(elem)

Subsequent steps will add:
- distance-to-relevant-structure helpers (5A.8b, after the uncommitted vent
  region in clean_tunnel_export.py is committed or moved)
- floating-geometry guard (5A.12)
- bbox-vs-host checks (5A.12)

Note: this module deliberately defines its own SHELL_THICKNESS_DEFAULT to
avoid circular imports with clean_tunnel_export. The value matches the
module-level constant in clean_tunnel_export.py — keep them in sync until
5A.10 unifies via profile_config.
"""

# Fallback wall thickness used by _extract_horizontal_profile when neither
# geometry.profile.wallThickness nor properties.shellThickness_m is provided.
SHELL_THICKNESS_DEFAULT = 0.30  # m


def _safe_float(x):
    try:
        return float(x) if x is not None else None
    except (TypeError, ValueError):
        return None


def _safe_xyz(d, default=None):
    if not isinstance(d, dict):
        return default
    x = _safe_float(d.get('x', 0))
    y = _safe_float(d.get('y', 0))
    z = _safe_float(d.get('z', 0))
    if x is None or y is None or z is None:
        return default
    return (x, y, z)


def _extract_endpoints(elem):
    """Return (start, end) world points for a TUNNEL_SEGMENT, or None."""
    props = elem.get('properties', {}) or {}
    sp = _safe_xyz(props.get('startPoint'))
    ep = _safe_xyz(props.get('endPoint'))
    if sp and ep:
        return sp, ep
    geom = elem.get('geometry', {}) or {}
    path = geom.get('path')
    if isinstance(path, list) and len(path) >= 2:
        sp = _safe_xyz(path[0])
        ep = _safe_xyz(path[-1])
        if sp and ep:
            return sp, ep
    return None


def _extract_horizontal_profile(elem):
    """Profile for horizontal/sloped tunnel walls.

    Returns (bore_w, bore_h, shell_t, source_type) or None.

    source_type is the upstream CSS profile.type:
        'CIRCLE'     -> emit as circular hollow
        'ARCH'       -> emit as arched hollow (default arch shape)
        'RECTANGLE'  -> emit as arched hollow (Phase 3 default override)
        'ARBITRARY'  -> emit as arched hollow (best-guess default)
    """
    geom = elem.get('geometry', {}) or {}
    profile = geom.get('profile', {}) or {}
    p_type = (profile.get('type') or 'RECTANGLE').upper()

    if p_type == 'CIRCLE':
        r = _safe_float(profile.get('radius'))
        if not r or r <= 0:
            return None
        w = h = 2.0 * r
    elif p_type in ('RECTANGLE', 'ARCH', 'ARBITRARY'):
        w = _safe_float(profile.get('width'))
        h = _safe_float(profile.get('height'))
        if not w or not h or w <= 0 or h <= 0:
            return None
    else:
        return None

    t = _safe_float(profile.get('wallThickness'))
    if t is None:
        t = _safe_float((elem.get('properties') or {}).get('shellThickness_m'))
    if t is None or t <= 0:
        t = SHELL_THICKNESS_DEFAULT

    return w, h, t, p_type
