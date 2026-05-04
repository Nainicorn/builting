"""Generic geometry stage.

5A.10 — first geometry helpers moved out of clean_tunnel_export.py with
behavior preserved exactly. These two are pure-math frame/profile builders
that depend only on math_utils — no ifcopenshell, no module constants, no
domain bias.

Public helpers:
    _build_frame_from_direction(d_unit)
    _profile_pt_to_world(pos, profile_xy, local_y, local_z)

Future steps will move:
- profile generators (_gen_arch_profile_brep_pts, _gen_rect_profile_brep_pts) —
  blocked by ARCH_SEGMENTS / ARCH_MIN_SIDEWALL_M / ARCH_MAX_SHELL_RATIO
  constants which need a config decision (centralize in profile_config or
  duplicate locally).
- IFC entity builders (_make_*, _apply_style, _make_shape_rep) — these take
  an ifcopenshell file handle `f`; they are emission helpers and stay near
  the emit_* call sites until the attachment stage (5A.11) is in place.
"""

from secondary_geometry.math_utils import (
    _vec_cross,
    _vec_dot,
    _vec_norm,
)


def _build_frame_from_direction(d_unit):
    """Frame for a horizontal/sloped wall given a unit centerline direction.

    Returns (local_x, local_y, local_z) or None if d_unit is collinear with
    world up (caller should treat as a vertical shaft instead).
    """
    local_x = d_unit
    world_up = (0.0, 0.0, 1.0)
    cz = _vec_dot(world_up, local_x)
    proj = (
        world_up[0] - cz * local_x[0],
        world_up[1] - cz * local_x[1],
        world_up[2] - cz * local_x[2],
    )
    local_z = _vec_norm(proj)
    if local_z is None:
        return None
    local_y = _vec_cross(local_z, local_x)
    return local_x, local_y, local_z


def _profile_pt_to_world(pos, profile_xy, local_y, local_z):
    """profile (px lateral, py vertical) -> 3D world relative to `pos`."""
    px, py = profile_xy
    return (pos[0] + px * local_y[0] + py * local_z[0],
            pos[1] + px * local_y[1] + py * local_z[1],
            pos[2] + px * local_y[2] + py * local_z[2])
