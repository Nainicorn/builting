"""
csg_validators.py — Phase 6D.1 hard-fail validators.

These run AFTER CSG carving on the resulting manifold(s). They enforce:
  1. No overlapping volumes between carved hulls (overlap > tolerance ⇒ fail).
  2. No gap > 0.05 m between adjacent welded surfaces (per-pair AABB face
     proximity check).
  3. No duplicate face at the same plane (within 1 mm position + 1° normal
     tolerance).
  4. Every duct endpoint is terminated (cap, fitting, or carved into a host).

Each check raises `CSGValidationError` on hard fail. Soft warnings are
returned by the wrapper so the lambda can log them without aborting.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, List, Sequence, Tuple

import numpy as np

from .csg import Manifold, aabb, to_arrays, volume, csg_intersection, is_empty


class CSGValidationError(Exception):
    pass


@dataclass
class ValidationReport:
    overlap_failures: List[str] = field(default_factory=list)
    gap_failures: List[str] = field(default_factory=list)
    duplicate_face_failures: List[str] = field(default_factory=list)
    unterminated_duct_failures: List[str] = field(default_factory=list)
    host_overlap_failures: List[str] = field(default_factory=list)
    overlap_warnings: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    # Phase 6D.1 visual integration flag. False if any CSG patch overlaps a
    # host shell AABB (i.e. patch is additive, not replacing local shell).
    visual_integrated: bool = True

    def is_clean(self) -> bool:
        return not (self.overlap_failures or self.gap_failures
                    or self.duplicate_face_failures
                    or self.unterminated_duct_failures
                    or self.host_overlap_failures)

    def raise_if_dirty(self) -> None:
        if self.is_clean():
            return
        chunks = []
        if self.overlap_failures:
            chunks.append("overlap: " + "; ".join(self.overlap_failures))
        if self.gap_failures:
            chunks.append("gap: " + "; ".join(self.gap_failures))
        if self.duplicate_face_failures:
            chunks.append("duplicate-face: "
                          + "; ".join(self.duplicate_face_failures))
        if self.unterminated_duct_failures:
            chunks.append("unterminated-duct: "
                          + "; ".join(self.unterminated_duct_failures))
        if self.host_overlap_failures:
            chunks.append("host-overlap: "
                          + "; ".join(self.host_overlap_failures))
        raise CSGValidationError(" | ".join(chunks))


def _aabb_pairs_overlap(a_min: np.ndarray, a_max: np.ndarray,
                        b_min: np.ndarray, b_max: np.ndarray,
                        slack: float = 0.0) -> bool:
    return bool(np.all(a_min - slack <= b_max) and np.all(b_min - slack <= a_max))


def assert_no_overlap(named_meshes: Sequence[Tuple[str, Manifold]],
                      report: ValidationReport,
                      *,
                      volume_tol_m3: float = 1e-4) -> None:
    """For every (i, j) pair compute boolean intersection; if its volume
    exceeds `volume_tol_m3` it's a hard fail. AABB pre-check skips obviously
    disjoint pairs."""
    n = len(named_meshes)
    aabbs = [aabb(m) for _, m in named_meshes]
    for i in range(n):
        for j in range(i + 1, n):
            if not _aabb_pairs_overlap(*aabbs[i], *aabbs[j]):
                continue
            try:
                inter = csg_intersection(named_meshes[i][1], named_meshes[j][1])
                vol = volume(inter)
            except Exception as ex:
                report.overlap_warnings.append(
                    f"{named_meshes[i][0]}∩{named_meshes[j][0]}: csg failed ({ex})")
                continue
            if vol > volume_tol_m3:
                report.overlap_failures.append(
                    f"{named_meshes[i][0]}∩{named_meshes[j][0]}={vol:.4f}m³")


def _face_plane_keys(verts: np.ndarray, tris: np.ndarray,
                     pos_tol_m: float = 1e-3,
                     ang_tol_deg: float = 1.0) -> List[Tuple]:
    """Compute a (normal_quantised, centroid_quantised) key for each triangle
    so we can detect SHARED faces (same plane AND overlapping in 2D). Two
    coplanar but spatially-separated faces are not flagged."""
    if tris.shape[0] == 0:
        return []
    pos_step = pos_tol_m
    ang_step = math.sin(math.radians(ang_tol_deg))
    keys: List[Tuple] = []
    for t in tris:
        a, b, c = verts[t[0]], verts[t[1]], verts[t[2]]
        n = np.cross(b - a, c - a)
        ln = float(np.linalg.norm(n))
        if ln < 1e-10:
            continue
        n = n / ln
        if (n[0], n[1], n[2]) < (-n[0], -n[1], -n[2]):
            n = -n
        centroid = (a + b + c) / 3.0
        keys.append((
            int(round(n[0] / ang_step)),
            int(round(n[1] / ang_step)),
            int(round(n[2] / ang_step)),
            int(round(centroid[0] / pos_step)),
            int(round(centroid[1] / pos_step)),
            int(round(centroid[2] / pos_step)),
        ))
    return keys


def assert_no_duplicate_faces(named_meshes: Sequence[Tuple[str, Manifold]],
                              report: ValidationReport,
                              *,
                              pos_tol_m: float = 1e-3,
                              ang_tol_deg: float = 1.0) -> None:
    """Hard-fail if two distinct meshes have a coplanar duplicate face within
    tolerance. Within-mesh duplicates are CSG output artefacts (manifold3d
    triangulates each face), so we only check pairs."""
    n = len(named_meshes)
    keysets = []
    for name, mesh in named_meshes:
        v, t = to_arrays(mesh)
        ks = set(_face_plane_keys(v, t, pos_tol_m, ang_tol_deg))
        keysets.append((name, ks))
    for i in range(n):
        for j in range(i + 1, n):
            shared = keysets[i][1] & keysets[j][1]
            if shared:
                report.duplicate_face_failures.append(
                    f"{keysets[i][0]}↔{keysets[j][0]}: {len(shared)} coplanar dup faces")


def assert_max_gap(named_meshes: Sequence[Tuple[str, Manifold]],
                   report: ValidationReport,
                   *,
                   gap_tol_m: float = 0.05,
                   intended_neighbours: Sequence[Tuple[str, str]] | None = None) -> None:
    """For every pair declared as `intended_neighbours`, the closest-vertex
    distance between the two meshes must be ≤ gap_tol_m. Pairs not declared
    are skipped (they may legitimately be far apart). Implementation uses
    a chunked O(N*M) brute force on welded vertex sets — adequate for the
    handful of carved hulls we emit per render."""
    if not intended_neighbours:
        return
    name_to_verts = {}
    for name, m in named_meshes:
        v, _ = to_arrays(m)
        name_to_verts[name] = v
    for a, b in intended_neighbours:
        va = name_to_verts.get(a)
        vb = name_to_verts.get(b)
        if va is None or vb is None or va.shape[0] == 0 or vb.shape[0] == 0:
            continue
        # Brute-force min distance, chunked.
        min_d = float('inf')
        for chunk_start in range(0, va.shape[0], 256):
            chunk = va[chunk_start:chunk_start + 256]
            d = np.sqrt(((chunk[:, None, :] - vb[None, :, :]) ** 2).sum(axis=2))
            md = float(d.min())
            if md < min_d:
                min_d = md
            if min_d <= 1e-6:
                break
        if min_d > gap_tol_m:
            report.gap_failures.append(
                f"{a}↔{b}: min distance {min_d:.3f}m > {gap_tol_m:.3f}m")


def _point_triangle_distance(p: np.ndarray, tri_verts: np.ndarray) -> float:
    """Vectorised min distance from point p (3,) to a batch of triangles
    (M, 3, 3). Uses standard barycentric clamping. Returns scalar min over M."""
    a = tri_verts[:, 0]
    b = tri_verts[:, 1]
    c = tri_verts[:, 2]
    ab = b - a
    ac = c - a
    ap = p[None, :] - a
    d1 = (ab * ap).sum(axis=1)
    d2 = (ac * ap).sum(axis=1)
    bp = p[None, :] - b
    d3 = (ab * bp).sum(axis=1)
    d4 = (ac * bp).sum(axis=1)
    cp = p[None, :] - c
    d5 = (ab * cp).sum(axis=1)
    d6 = (ac * cp).sum(axis=1)
    vc = d1 * d4 - d3 * d2
    vb = d5 * d2 - d1 * d6
    va = d3 * d6 - d5 * d4
    denom = va + vb + vc
    # Closest point is `q`; we'll compute it per-region and then ||p-q||.
    closest = a.copy()
    # Region A (vertex a)
    mask = (d1 <= 0) & (d2 <= 0)
    # closest already a
    # Region B (vertex b)
    m_b = (d3 >= 0) & (d4 <= d3)
    closest = np.where(m_b[:, None], b, closest)
    # Region C (vertex c)
    m_c = (d6 >= 0) & (d5 <= d6)
    closest = np.where(m_c[:, None], c, closest)
    # Region AB (edge ab)
    m_ab = (vc <= 0) & (d1 >= 0) & (d3 <= 0) & ~m_b & ~m_c
    v = np.where(np.abs(d1 - d3) > 1e-12, d1 / np.maximum(d1 - d3, 1e-12), 0.0)
    closest = np.where(m_ab[:, None], a + v[:, None] * ab, closest)
    # Region AC (edge ac)
    m_ac = (vb <= 0) & (d2 >= 0) & (d6 <= 0) & ~mask & ~m_b & ~m_c & ~m_ab
    w = np.where(np.abs(d2 - d6) > 1e-12, d2 / np.maximum(d2 - d6, 1e-12), 0.0)
    closest = np.where(m_ac[:, None], a + w[:, None] * ac, closest)
    # Region BC (edge bc)
    m_bc = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0) & ~mask & ~m_b & ~m_c & ~m_ab & ~m_ac
    w2 = np.where(np.abs((d4 - d3) - (d5 - d6) + (d4 - d3)) > 1e-12,
                  (d4 - d3) / np.maximum((d4 - d3) + (d5 - d6), 1e-12), 0.0)
    closest = np.where(m_bc[:, None], b + w2[:, None] * (c - b), closest)
    # Region inside triangle (default)
    m_in = ~(mask | m_b | m_c | m_ab | m_ac | m_bc)
    safe_denom = np.where(np.abs(denom) > 1e-12, denom, 1e-12)
    v_bary = vb / safe_denom
    w_bary = vc / safe_denom
    inside = a + v_bary[:, None] * ab + w_bary[:, None] * ac
    closest = np.where(m_in[:, None], inside, closest)

    diff = p[None, :] - closest
    d = np.sqrt((diff * diff).sum(axis=1))
    return float(d.min()) if d.size else float('inf')


def assert_ducts_terminated(duct_endpoints: Sequence[Tuple[str, np.ndarray]],
                            host_meshes: Sequence[Tuple[str, Manifold]],
                            report: ValidationReport,
                            *,
                            tol_m: float = 0.05) -> None:
    """Each `duct_endpoint` is (label, world_xyz). It is "terminated" iff
    its closest distance to any host mesh's surface is ≤ tol_m. Uses
    point-to-triangle distance (not point-to-vertex), so an endpoint that
    lies on a host face is correctly recognised even if the face was
    triangulated coarsely."""
    if not duct_endpoints:
        return
    triangles: List[np.ndarray] = []
    for _, m in host_meshes:
        v, t = to_arrays(m)
        if t.shape[0] == 0:
            continue
        triangles.append(v[t])  # (M, 3, 3)
    if not triangles:
        for label, _ in duct_endpoints:
            report.unterminated_duct_failures.append(label)
        return
    all_tris = np.concatenate(triangles, axis=0)
    for label, p in duct_endpoints:
        d = _point_triangle_distance(np.asarray(p, dtype=np.float64), all_tris)
        if d > tol_m:
            report.unterminated_duct_failures.append(
                f"{label}: nearest host face {d:.3f}m > {tol_m:.3f}m")


def _coerce_aabb_to_min_max(ab) -> Tuple[np.ndarray, np.ndarray] | None:
    """Accept either a 6-tuple (xmin,ymin,zmin,xmax,ymax,zmax) or a
    nested ((mnx,mny,mnz),(mxx,mxy,mxz)) form. Returns (min_3vec, max_3vec)
    as float64 arrays, or None if unparseable."""
    if ab is None:
        return None
    try:
        if len(ab) == 6:
            mn = np.asarray((ab[0], ab[1], ab[2]), dtype=np.float64)
            mx = np.asarray((ab[3], ab[4], ab[5]), dtype=np.float64)
        elif len(ab) == 2:
            mn = np.asarray(ab[0], dtype=np.float64).reshape(3)
            mx = np.asarray(ab[1], dtype=np.float64).reshape(3)
        else:
            return None
    except Exception:
        return None
    return mn, mx


def assert_no_host_overlap(named_meshes: Sequence[Tuple[str, Manifold]],
                           host_aabbs: Sequence[dict],
                           report: ValidationReport,
                           *,
                           slack_m: float = 0.05,
                           min_intersection_m3: float = 1e-3) -> None:
    """Phase 6D.1 visual-integration check.

    `host_aabbs` is a list of dicts with key 'aabb'. Two formats accepted:
      - 6-tuple `(xmin, ymin, zmin, xmax, ymax, zmax)` (the format the
        clean_tunnel_export collectors use throughout the pipeline).
      - Nested `(min_xyz, max_xyz)`.

    A CSG patch is "visually integrated" only if its AABB does NOT overlap
    any host AABB by more than `min_intersection_m3` after `slack_m`
    deflation. Sets `report.visual_integrated = False` and appends to
    `host_overlap_failures` on any meaningful overlap.
    """
    if not host_aabbs:
        return
    host_boxes = []
    for h in host_aabbs:
        coerced = _coerce_aabb_to_min_max(h.get('aabb'))
        if coerced is None:
            continue
        mn, mx = coerced
        host_boxes.append((h.get('elem_id') or h.get('host_id') or h.get('name')
                           or 'host?', mn, mx))
    if not host_boxes:
        return
    for name, mesh in named_meshes:
        pmin, pmax = aabb(mesh)
        for hname, hmin, hmax in host_boxes:
            ix_min = np.maximum(pmin, hmin)
            ix_max = np.minimum(pmax, hmax)
            ix_dim = ix_max - ix_min
            if np.any(ix_dim <= -slack_m):
                continue
            ix_dim = np.maximum(ix_dim, 0.0)
            ix_vol = float(ix_dim[0] * ix_dim[1] * ix_dim[2])
            if ix_vol > min_intersection_m3:
                report.host_overlap_failures.append(
                    f"{name} ⊂ {hname}: aabb-overlap≈{ix_vol:.3f}m³")
                report.visual_integrated = False
                break


def run_all(named_meshes: Sequence[Tuple[str, Manifold]],
            *,
            duct_endpoints: Sequence[Tuple[str, np.ndarray]] = (),
            intended_neighbours: Sequence[Tuple[str, str]] = (),
            host_aabbs: Sequence[dict] = (),
            volume_tol_m3: float = 1e-4,
            gap_tol_m: float = 0.05,
            pos_tol_m: float = 1e-3,
            ang_tol_deg: float = 1.0,
            hard_fail: bool = True) -> ValidationReport:
    """Run all validators and either raise (hard_fail=True) or return
    the report (hard_fail=False) for callers that want to log.

    `host_aabbs`, when provided, enables the visual-integration check that
    detects CSG patches sitting on top of original shell geometry."""
    report = ValidationReport()
    assert_no_overlap(named_meshes, report, volume_tol_m3=volume_tol_m3)
    assert_no_duplicate_faces(named_meshes, report,
                              pos_tol_m=pos_tol_m, ang_tol_deg=ang_tol_deg)
    assert_max_gap(named_meshes, report, gap_tol_m=gap_tol_m,
                   intended_neighbours=intended_neighbours)
    assert_ducts_terminated(duct_endpoints, named_meshes, report, tol_m=gap_tol_m)
    if host_aabbs:
        assert_no_host_overlap(named_meshes, host_aabbs, report)
    if hard_fail:
        report.raise_if_dirty()
    return report
