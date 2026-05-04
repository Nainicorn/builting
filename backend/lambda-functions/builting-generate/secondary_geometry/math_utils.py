"""Foundational vector / math primitives.

5A.10 — pure math helpers moved out of clean_tunnel_export.py with behavior
preserved exactly. No ifcopenshell, no domain constants, no dependency on
any other secondary_geometry module. Anything in here is safe to import
from validation, topology, geometry, or attachment.

Public helpers:
    _vec_sub(a, b)
    _vec_len(v)
    _vec_norm(v)
    _vec_cross(a, b)
    _vec_dot(a, b)
    _vec_neg(v)
    _project_along_dir_onto_plane(point, direction, plane_normal, plane_offset)

Helpers intentionally NOT moved here:
    _new_guid              — ifcopenshell.guid binding, not pure math.
    _round_endpoint        — uses JOINT_POS_TOL_M default arg; moving it
                             would require centralizing the constant.
"""

import math


def _vec_sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _vec_len(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def _vec_norm(v):
    L = _vec_len(v)
    if L < 1e-9:
        return None
    return (v[0] / L, v[1] / L, v[2] / L)


def _vec_cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _vec_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _vec_neg(v):
    return (-v[0], -v[1], -v[2])


def _project_along_dir_onto_plane(point, direction, plane_normal, plane_offset):
    """Project `point` along unit `direction` onto a plane defined by
    `plane_normal · X = plane_offset`. Returns the projected 3-tuple, or
    `point` unchanged if the direction is parallel to the plane.
    """
    denom = (plane_normal[0] * direction[0]
             + plane_normal[1] * direction[1]
             + plane_normal[2] * direction[2])
    if abs(denom) < 1e-9:
        return point
    pn_dot_p = (plane_normal[0] * point[0]
                + plane_normal[1] * point[1]
                + plane_normal[2] * point[2])
    t = (plane_offset - pn_dot_p) / denom
    return (point[0] + t * direction[0],
            point[1] + t * direction[1],
            point[2] + t * direction[2])
