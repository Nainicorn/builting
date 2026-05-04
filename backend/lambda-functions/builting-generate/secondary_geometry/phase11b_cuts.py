"""
phase11b_cuts.py — Cut-solid builders for Phase 11B (rollback-safe visual fix).

Phase 11A relied on IfcOpeningElement + IfcRelVoidsElement against the tunnel
shell.  IFC viewers do NOT reliably honour boolean voids on IfcFacetedBrep /
IfcTriangulatedFaceSet shells, so the cuts existed in the data but the visual
shell stayed continuous.

Phase 11B fixes this by producing real manifold3d cut SOLIDS that can be
either:

  * DEBUG mode    — emitted as a bright-red translucent IfcBuildingElementProxy
                    overlay so a human can verify the opening sits on the bore
                    wall, points through the shell, and matches the room/portal
                    face.  No mesh modification.
  * REPLACE mode  — boolean-subtracted from the tunnel shell mesh, with the
                    result emitted as a fresh IfcTriangulatedFaceSet.  The
                    original IfcFacetedBrep wall is suppressed for that
                    segment.  Counts how many tunnel meshes were actually
                    rebuilt — Phase 11B fails the validator if that is 0 in
                    REPLACE mode.

This module owns geometry construction only.  Mode dispatch + emit lives in
clean_tunnel_export.py.
"""
from __future__ import annotations

from typing import Any, Dict, Sequence, Tuple

import numpy as np
from manifold3d import Manifold

from .csg import (
    Vec3,
    rect_solid,
    cylinder_solid,
    place,
    translate,
    csg_difference,
    is_empty,
    to_arrays,
    aabb,
)


# ──────────────────────────────────────────────────────────────────────────
# Visual style — DEBUG cut solids are bright red, half transparent.
# ──────────────────────────────────────────────────────────────────────────

DEBUG_OPENING_COLOR = (0.92, 0.18, 0.18)     # bright red
DEBUG_OPENING_TRANSPARENCY = 0.45             # ~ half transparent
DEBUG_SHAFT_COLOR = (0.18, 0.55, 0.92)        # bright blue
DEBUG_SHAFT_TRANSPARENCY = 0.45


# ──────────────────────────────────────────────────────────────────────────
# SPACE → tunnel opening cut solid
# ──────────────────────────────────────────────────────────────────────────

def build_opening_cut_solid(opening: Dict[str, Any],
                            shell_pierce_depth_m: float = 4.0) -> Manifold:
    """
    Build a rectangular cut solid that pierces the tunnel shell at the
    location described by `opening` (the descriptor stamped by Phase 11
    structural-integration on a SPACE element).  The solid is placed in
    WORLD coordinates and oriented so:

        +X = segment tangent  (along the tunnel axis)
        +Y = lateral toward the SPACE     (passes through the shell)
        +Z = vertical

    Dimensions in local frame:

        length (X) = opening.width      — opening width along the bore axis
        width  (Y) = shell_pierce_depth_m — large enough to cross both faces
                                            of any tunnel shell wall (default
                                            4 m so curved shells are pierced
                                            cleanly even at thickness 0.5 m)
        height (Z) = opening.height     — opening height (vertical)

    Returns a manifold3d.Manifold; raises ValueError if the descriptor is
    incomplete or yields a degenerate solid.
    """
    if not isinstance(opening, dict):
        raise ValueError(f'opening descriptor must be dict, got {type(opening)!r}')

    center = opening.get('center') or {}
    width  = float(opening.get('width')  or 0.0)
    height = float(opening.get('height') or 0.0)
    if width  <= 0.05: raise ValueError(f'opening width too small: {width}')
    if height <= 0.05: raise ValueError(f'opening height too small: {height}')
    if shell_pierce_depth_m <= 0.05:
        raise ValueError(f'shell_pierce_depth_m too small: {shell_pierce_depth_m}')

    cx = float(center.get('x', 0.0))
    cy = float(center.get('y', 0.0))
    cz = float(center.get('z', 0.0))

    axis = opening.get('axis')   or {'x': 1.0, 'y': 0.0, 'z': 0.0}
    norm = opening.get('normal') or {'x': 0.0, 'y': 1.0, 'z': 0.0}

    # rect_solid: length (X) × width (Y) × height (Z)
    # We want length along tangent, width along normal (through-shell),
    # height vertical.  `rect_solid(width, height, length)` per its signature
    # in csg.py: (Y, Z, X).
    local = rect_solid(width=shell_pierce_depth_m,
                       height=height,
                       length=width)
    # Place: axis_x = segment tangent, axis_z = world up
    # The local +Y after place() will follow rotation of axis_x within
    # XY plane → that's the lateral pointing toward the SPACE if normal is
    # consistent with the right-hand rule (axis_x × up).  When `normal`
    # points opposite to (axis_x × up), shift by +0 along Y stays correct
    # because the cut is symmetric in Y.  The center anchor itself is
    # already on the bore wall, so symmetric Y span (±2 m by default)
    # naturally crosses the shell from inside to outside.
    return place(local,
                 origin=(cx, cy, cz),
                 axis_x=(float(axis.get('x', 1.0)),
                         float(axis.get('y', 0.0)),
                         float(axis.get('z', 0.0))),
                 axis_z=(0.0, 0.0, 1.0))


# ──────────────────────────────────────────────────────────────────────────
# Shaft → tunnel ceiling cut solid
# ──────────────────────────────────────────────────────────────────────────

def build_shaft_cut_solid(shaft_cut: Dict[str, Any],
                          extra_depth_m: float = 1.0) -> Manifold:
    """Build a vertical cylinder cut solid that pierces the tunnel ceiling
    at the (shaft_cut.x, shaft_cut.y) location.  Spans from
    `baseZ - extra_depth_m` up to `ceilingZ + extra_depth_m` so the boolean
    clears the shell thickness comfortably.

    `shaft_cut` is the descriptor stamped on a SHAFT/SPACE-typed element by
    Phase 11 structural-integration.
    """
    if not isinstance(shaft_cut, dict):
        raise ValueError(f'shaft_cut descriptor must be dict, got {type(shaft_cut)!r}')
    radius = float(shaft_cut.get('radius') or 1.0)
    if radius <= 0.05:
        raise ValueError(f'shaft cut radius too small: {radius}')
    base_z    = float(shaft_cut.get('baseZ', 0.0))
    ceil_z    = float(shaft_cut.get('ceilingZ', base_z + 4.0))
    if ceil_z <= base_z:
        raise ValueError(f'shaft ceil_z={ceil_z} not above baseZ={base_z}')

    length = (ceil_z + extra_depth_m) - (base_z - extra_depth_m)
    cyl_local = cylinder_solid(radius=radius, length=length)
    # cylinder_solid is centred on origin with long axis = +X; we need the
    # long axis along +Z and centre at the midpoint of [base-extra, ceil+extra].
    mid_x = float(shaft_cut.get('x', 0.0))
    mid_y = float(shaft_cut.get('y', 0.0))
    mid_z = (base_z - extra_depth_m + ceil_z + extra_depth_m) / 2.0
    # axis_x (cylinder long axis) = world +Z; axis_z must be perpendicular —
    # use world +X as axis_z so the rotation lifts the cylinder upright.
    return place(cyl_local,
                 origin=(mid_x, mid_y, mid_z),
                 axis_x=(0.0, 0.0, 1.0),
                 axis_z=(1.0, 0.0, 0.0))


# ──────────────────────────────────────────────────────────────────────────
# Tunnel-shell-mesh boolean (REPLACE mode helper)
# ──────────────────────────────────────────────────────────────────────────

def subtract_cuts_from_shell_mesh(shell_verts: np.ndarray,
                                   shell_tris: np.ndarray,
                                   cuts: Sequence[Manifold]) -> Manifold:
    """Reconstruct a manifold from a tunnel-wall brep's vertex/tri arrays
    and subtract every cut solid in `cuts`.  Returns the resulting Manifold.
    Used in REPLACE mode by clean_tunnel_export to rebuild a single tunnel
    shell with all of its applicable openings cut out.
    """
    if shell_verts.shape[0] < 4 or shell_tris.shape[0] < 4:
        raise ValueError('shell mesh too small to be a valid solid')
    from .csg import _mesh_from_arrays  # internal helper
    shell = _mesh_from_arrays(shell_verts.astype(np.float32),
                              shell_tris.astype(np.int32))
    for c in cuts:
        if c is None or is_empty(c):
            continue
        shell = csg_difference(shell, c)
        if is_empty(shell):
            raise ValueError('shell became empty after cut — cut volume too large')
    return shell


def cut_aabb_overlaps(cut: Manifold, target_aabb: Tuple[Tuple[float, float, float],
                                                          Tuple[float, float, float]],
                      pad: float = 0.5) -> bool:
    """Return True iff `cut`'s world AABB intersects `target_aabb` with a
    `pad` margin.  Used to decide whether a cut applies to a given tunnel
    wall before the (expensive) boolean is run."""
    cmin, cmax = aabb(cut)
    (tmin, tmax) = target_aabb
    return all(cmin[i] - pad <= tmax[i] and cmax[i] + pad >= tmin[i]
               for i in range(3))
