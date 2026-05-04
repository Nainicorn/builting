"""
csg.py — Manifold3d CSG primitives for Phase 6D true geometry integration.

Provides solid-mesh primitives (rect/arched extrusions), world placement,
and boolean operations (union/difference/intersection). Output of every
function in this module is a `manifold3d.Manifold` so consumers can chain.

All inputs/outputs are in METRES. The Lambda's coordinate space mixes
millimetres (xy) with metres (z) at the topology layer; callers must
convert before invoking these helpers.

Triangulation density is parameterised — for tunnel arches we use 16 segments
to match the existing exporter's `ARCH_SEGMENTS` so vertex counts stay
predictable.
"""
from __future__ import annotations

import math
from typing import Iterable, List, Sequence, Tuple

import numpy as np
from manifold3d import Manifold, Mesh

Vec3 = Tuple[float, float, float]

DEFAULT_ARCH_SEGMENTS = 16


# ---------------------------------------------------------------------------
# Frame builders (mirror clean_tunnel_export placement conventions)
# ---------------------------------------------------------------------------

def _normalise(v: Sequence[float]) -> np.ndarray:
    a = np.asarray(v, dtype=np.float64)
    n = float(np.linalg.norm(a))
    if n < 1e-12:
        raise ValueError(f"zero-length direction: {v!r}")
    return a / n


def _frame_from_axis(axis_z: Sequence[float], ref_x: Sequence[float] | None = None) -> np.ndarray:
    """Right-handed frame whose third column is axis_z and first column is in
    the plane defined by ref_x (defaulted to world-x if absent)."""
    z = _normalise(axis_z)
    rx = np.asarray(ref_x if ref_x is not None else (1.0, 0.0, 0.0), dtype=np.float64)
    if abs(float(np.dot(rx, z))) > 0.999:
        # ref_x parallel to z — fall back to world-y
        rx = np.array([0.0, 1.0, 0.0])
    x = rx - np.dot(rx, z) * z
    x = x / np.linalg.norm(x)
    y = np.cross(z, x)
    return np.column_stack((x, y, z))  # 3x3


# ---------------------------------------------------------------------------
# Mesh -> Manifold helpers
# ---------------------------------------------------------------------------

def _mesh_from_arrays(verts: np.ndarray, tris: np.ndarray) -> Manifold:
    """Build a Manifold from float64 verts (Nx3) and int32 tri indices (Mx3)."""
    if verts.dtype != np.float32:
        verts = verts.astype(np.float32)
    if tris.dtype != np.int32:
        tris = tris.astype(np.int32)
    mesh = Mesh(vert_properties=verts, tri_verts=tris)
    return Manifold(mesh)


def _box_tris() -> np.ndarray:
    """Standard cube triangle indices for an 8-vertex (000..111) corner ordering."""
    return np.array([
        [0, 2, 1], [0, 3, 2],   # -z
        [4, 5, 6], [4, 6, 7],   # +z
        [0, 1, 5], [0, 5, 4],   # -y
        [2, 3, 7], [2, 7, 6],   # +y
        [1, 2, 6], [1, 6, 5],   # +x
        [0, 4, 7], [0, 7, 3],   # -x
    ], dtype=np.int32)


# ---------------------------------------------------------------------------
# Solid primitives in local space (centred at origin, axis along +X)
# ---------------------------------------------------------------------------

def rect_solid(width: float, height: float, length: float) -> Manifold:
    """Rectangular bar of (length × width × height), centred on origin,
    long axis along +X. Used for walls / branch bodies."""
    if width <= 0 or height <= 0 or length <= 0:
        raise ValueError(f"rect_solid needs positive dims, got {width=}, {height=}, {length=}")
    hx, hy, hz = length / 2.0, width / 2.0, height / 2.0
    verts = np.array([
        [-hx, -hy, -hz], [+hx, -hy, -hz], [+hx, +hy, -hz], [-hx, +hy, -hz],
        [-hx, -hy, +hz], [+hx, -hy, +hz], [+hx, +hy, +hz], [-hx, +hy, +hz],
    ], dtype=np.float32)
    return _mesh_from_arrays(verts, _box_tris())


def arched_tunnel_solid(bore_w: float, bore_h: float, shell_t: float,
                        length: float, n_arch: int = DEFAULT_ARCH_SEGMENTS) -> Manifold:
    """Arched tunnel shell (vertical sidewalls + semicircular top + flat floor).

    `bore_w`/`bore_h` define the inner clear opening. `shell_t` is wall thickness.
    Solid spans [-length/2, +length/2] along +X. Output is the *shell only*
    (outer hull minus inner bore); the floor is included in the shell.
    """
    if min(bore_w, bore_h, shell_t, length) <= 0:
        raise ValueError("arched_tunnel_solid needs all positive dims")

    outer_w = bore_w + 2 * shell_t
    outer_h = bore_h + 2 * shell_t  # nominal — top is rounded, bottom is flat

    def _profile(y_half: float, h: float, ceil_radius: float) -> List[Tuple[float, float]]:
        # 2D profile in (y, z) centred on origin:
        #   floor at z = 0 (bottom of solid), span [-y_half, +y_half]
        #   sidewalls rise to z = h - ceil_radius
        #   semicircular top centred at (0, h - ceil_radius), radius = ceil_radius
        # Returns CCW polygon points for an outline.
        pts: List[Tuple[float, float]] = []
        pts.append((-y_half, 0.0))
        pts.append((+y_half, 0.0))
        pts.append((+y_half, h - ceil_radius))
        for k in range(1, n_arch):
            theta = (math.pi * k) / n_arch  # 0..π exclusive
            ay = +y_half - ceil_radius + ceil_radius * math.cos(theta)
            az = (h - ceil_radius) + ceil_radius * math.sin(theta)
            # cos(theta) goes 1->-1 as k goes 0..n; we want sweep from +y to -y
            pts.append((ay, az))
        pts.append((-y_half, h - ceil_radius))
        return pts

    outer_y_half = outer_w / 2.0
    inner_y_half = bore_w / 2.0
    outer_ceil_radius = outer_y_half  # canonical arched profile
    inner_ceil_radius = inner_y_half

    outer = _profile(outer_y_half, outer_h, outer_ceil_radius)
    inner = _profile(inner_y_half, bore_h, inner_ceil_radius)

    # Both profiles are CCW. Build outer extrusion - inner extrusion.
    outer_solid = _extrude_polygon(outer, length)
    inner_solid = _extrude_polygon(inner, length)
    # Lift inner so its floor sits on the shell floor (the inner bore starts
    # at z = 0; we want the bore to start at z = 0 + 0 since both share floor).
    return outer_solid - inner_solid


def arched_outer_solid(outer_w: float, outer_h: float,
                       length: float,
                       n_arch: int = DEFAULT_ARCH_SEGMENTS) -> Manifold:
    """Solid arched profile (vertical sidewalls + semicircular top + flat
    floor) extruded along +X by `length`. No inner bore.

    Profile is centred at origin in (Y, Z): floor at z = -outer_h/2, crown
    at z = +outer_h/2. This matches the centred convention used by
    `rect_solid` so an ARCH stub and a RECT stub at the same joint position
    align vertically.

    `outer_w` is the full outer width; the semicircle radius is `outer_w/2`.
    `outer_h` is overall height (must be ≥ outer_w/2). Solid spans
    [-length/2, +length/2] along +X.

    Used by the CSG junction filler so the carved hull at an ARCH junction
    follows the real arched outline instead of a rectangular bounding box.
    """
    if min(outer_w, outer_h, length) <= 0:
        raise ValueError("arched_outer_solid needs all positive dims")
    y_half = outer_w / 2.0
    ceil_radius = y_half
    floor_z = -outer_h / 2.0
    crown_z = +outer_h / 2.0
    arch_center_z = crown_z - ceil_radius
    pts: List[Tuple[float, float]] = []
    pts.append((-y_half, floor_z))
    pts.append((+y_half, floor_z))
    pts.append((+y_half, arch_center_z))
    for k in range(1, n_arch):
        theta = (math.pi * k) / n_arch
        ay = ceil_radius * math.cos(theta)
        az = arch_center_z + ceil_radius * math.sin(theta)
        pts.append((ay, az))
    pts.append((-y_half, arch_center_z))
    return _extrude_polygon(pts, length)


def cylinder_solid(radius: float, length: float, n: int = 24) -> Manifold:
    """Cylinder of given radius & length along +X, centred on origin.
    Used for circular ducts/pipes."""
    if radius <= 0 or length <= 0 or n < 6:
        raise ValueError("cylinder_solid args invalid")
    poly = [(radius * math.cos(2 * math.pi * k / n),
             radius * math.sin(2 * math.pi * k / n)) for k in range(n)]
    return _extrude_polygon(poly, length)


def profile_solid(poly_yz: Sequence[Tuple[float, float]], length: float) -> Manifold:
    """Extrude an arbitrary CCW polygon in (Y, Z) along +X by `length`,
    centred on origin (x ∈ [-length/2, +length/2]).

    Public alias for _extrude_polygon — used by csg_clusters.py to build
    member-segment manifolds with the SAME profile points the brep emitter
    uses, so cluster manifold and any fallback brep have identical
    vertex positions where they meet.
    """
    return _extrude_polygon(poly_yz, length)


def _extrude_polygon(poly_yz: Sequence[Tuple[float, float]], length: float) -> Manifold:
    """Extrude a CCW polygon in (y, z) plane along +X by `length`, centred on
    origin (so x ∈ [-length/2, +length/2]). Returns a closed Manifold."""
    n = len(poly_yz)
    if n < 3:
        raise ValueError("polygon needs >=3 points")
    hx = length / 2.0
    # Vertex layout: [start cap (n verts) ... end cap (n verts)]
    verts = np.zeros((2 * n, 3), dtype=np.float32)
    for k, (py, pz) in enumerate(poly_yz):
        verts[k] = (-hx, py, pz)
        verts[n + k] = (+hx, py, pz)
    tris: List[Tuple[int, int, int]] = []
    # Side quads (each as 2 tris). Outward winding: start ring is the -X cap,
    # so when viewed from -X the polygon should be CW. We accept whichever
    # winding the input gives; manifold3d handles it via merge.
    for k in range(n):
        kn = (k + 1) % n
        a, b = k, kn
        c, d = n + kn, n + k
        tris.append((a, b, c))
        tris.append((a, c, d))
    # End caps via fan triangulation (works for convex; non-convex callers
    # must pre-decompose).
    for k in range(1, n - 1):
        tris.append((0, k + 1, k))           # -X cap (reversed winding)
    for k in range(1, n - 1):
        tris.append((n, n + k, n + k + 1))   # +X cap
    return _mesh_from_arrays(verts, np.asarray(tris, dtype=np.int32))


# ---------------------------------------------------------------------------
# Placement
# ---------------------------------------------------------------------------

def place(mesh: Manifold, origin: Vec3,
          axis_x: Sequence[float] = (1.0, 0.0, 0.0),
          axis_z: Sequence[float] = (0.0, 0.0, 1.0)) -> Manifold:
    """Move a local-frame mesh into the world. axis_x is the segment direction
    (mesh's local +X), axis_z points "up" along the shell's vertical axis."""
    z = _normalise(axis_z)
    x = _normalise(axis_x)
    if abs(float(np.dot(x, z))) > 0.99:
        raise ValueError(f"axis_x parallel to axis_z: x={x.tolist()} z={z.tolist()}")
    x_perp = x - np.dot(x, z) * z
    x_perp = x_perp / np.linalg.norm(x_perp)
    y = np.cross(z, x_perp)
    rot = np.column_stack((x_perp, y, z))  # 3x3
    affine = np.zeros((3, 4), dtype=np.float64)
    affine[:, :3] = rot
    affine[:, 3] = np.asarray(origin, dtype=np.float64)
    return mesh.transform(affine)


def translate(mesh: Manifold, delta: Vec3) -> Manifold:
    affine = np.array([
        [1.0, 0.0, 0.0, delta[0]],
        [0.0, 1.0, 0.0, delta[1]],
        [0.0, 0.0, 1.0, delta[2]],
    ], dtype=np.float64)
    return mesh.transform(affine)


# ---------------------------------------------------------------------------
# Boolean operations
# ---------------------------------------------------------------------------

def csg_union(meshes: Iterable[Manifold]) -> Manifold:
    items = [m for m in meshes if m is not None]
    if not items:
        raise ValueError("csg_union: no meshes")
    out = items[0]
    for m in items[1:]:
        out = out + m
    return out


def csg_difference(a: Manifold, b: Manifold) -> Manifold:
    return a - b


def csg_intersection(a: Manifold, b: Manifold) -> Manifold:
    return a ^ b


def is_empty(mesh: Manifold) -> bool:
    try:
        return mesh.is_empty()
    except Exception:
        return False


def volume(mesh: Manifold) -> float:
    try:
        return float(mesh.volume())
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Mesh extraction (for IFC writer + validators)
# ---------------------------------------------------------------------------

def to_arrays(mesh: Manifold) -> Tuple[np.ndarray, np.ndarray]:
    """Return (vertices Nx3 float64, tris Mx3 int32). Empty mesh => (0,3) arrays."""
    if is_empty(mesh):
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int32)
    m = mesh.to_mesh()
    v = np.asarray(m.vert_properties, dtype=np.float64)
    if v.ndim != 2 or v.shape[1] < 3:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int32)
    if v.shape[1] > 3:
        v = v[:, :3]
    t = np.asarray(m.tri_verts, dtype=np.int32).reshape(-1, 3)
    return v, t


def aabb(mesh: Manifold) -> Tuple[np.ndarray, np.ndarray]:
    """World AABB (min, max) as length-3 arrays. Returns zeros if empty."""
    v, _ = to_arrays(mesh)
    if v.shape[0] == 0:
        z = np.zeros(3)
        return z, z
    return v.min(axis=0), v.max(axis=0)
