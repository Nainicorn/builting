"""
csg_clusters.py — Phase 6D.1 FIX 1 — junction cluster manifold builder.

Replaces the additive 'emit per-segment brep + emit CSG hull alongside'
junction model with a single CSG-merged manifold per connected cluster.

A *cluster* is a connected set of TUNNEL_SEGMENTs linked via shared joints
(>=2 members at the same node). The merged manifold is

    outer  = ⋃ (member outer extrusions + joint outer hulls)
    inner  = ⋃ (member inner extrusions + joint inner hulls)
    carved = outer - inner

Cluster member segments are SUPPRESSED in the chain / per-segment brep
loops in clean_tunnel_export.py — the cluster manifold is the sole shell
emission for those segments. Non-junction segments stay as IfcFacetedBrep.

The topology engine's trim pass (`trimSegmentsAtJunctions`) already
retracts every member endpoint at a multi-way junction by `trimRadiusM`
along its bearing. The member extrusion runs the *trimmed* length; the
joint stub bridges the trim void. With

    stub_length_m  = trim_radius_m + joint_radius_m
    joint_radius_m = ½ × max member outer profile

stub and member extrusions share an outward face plane at the trim line
(modulo float precision; the CSG union absorbs the seam).

Output is an `IfcTriangulatedFaceSet` per cluster, emitted via
`csg_ifc.emit_triangulated_face_set`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

from . import csg
from . import csg_junctions
from .csg import Manifold


Vec3 = Tuple[float, float, float]


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class ClusterMember:
    """One TUNNEL_SEGMENT belonging to a junction cluster."""
    seg_idx: int
    elem_id: str
    start: Vec3
    end: Vec3
    d: Vec3                              # unit direction start->end
    length: float                        # post-trim length
    profile_kind: str                    # 'ARCH' or 'RECT'
    bore_w: float
    bore_h: float
    shell_t: float
    outer_2d: List[Tuple[float, float]]  # CCW outer profile (y, z)
    inner_2d: List[Tuple[float, float]]  # CCW inner profile (y, z)


@dataclass
class JunctionCluster:
    """One connected cluster of TUNNEL_SEGMENTs joined at multi-way joints."""
    cluster_id: str
    members: List[ClusterMember] = field(default_factory=list)
    # joint-group indices that bind this cluster (>=2 members per joint)
    joint_indices: List[int] = field(default_factory=list)
    # members of each joint as zone records (rebuilt from horizontal_candidates)
    joint_zones: List["csg_junctions.JunctionZone"] = field(default_factory=list)
    # segment indices that belong to this cluster (filled by discover_clusters)
    member_seg_indices: Set[int] = field(default_factory=set)


# ---------------------------------------------------------------------------
# Cluster discovery
# ---------------------------------------------------------------------------

def discover_clusters(horizontal_candidates: Sequence[dict],
                      joint_groups: Sequence[Sequence[tuple]],
                      *,
                      min_members_per_joint: int = 2
                      ) -> Tuple[List[JunctionCluster], Set[int]]:
    """Build clusters via union-find on segments connected through shared
    joints. Returns (clusters, consumed_segment_indices).

    A cluster contains every segment that shares a joint (with >=2 members)
    with any other segment in the cluster. Joints with <2 members (free
    ends) do not bind segments together.

    `consumed_segment_indices` is the union of all segment indices belonging
    to any returned cluster — caller skips brep emission for these.
    """
    n_segs = len(horizontal_candidates)
    if n_segs == 0:
        return [], set()
    parent = list(range(n_segs))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x: int, y: int) -> None:
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    multi_joint_indices: List[int] = []
    for ji, members in enumerate(joint_groups):
        if len(members) < min_members_per_joint:
            continue
        seg_indices = [m[0] for m in members]
        if len(seg_indices) < 2:
            continue
        multi_joint_indices.append(ji)
        for k in range(1, len(seg_indices)):
            union(seg_indices[0], seg_indices[k])

    if not multi_joint_indices:
        return [], set()

    # Bucket segments and joints by cluster root
    cluster_seg: Dict[int, Set[int]] = {}
    cluster_joints: Dict[int, List[int]] = {}

    for ji in multi_joint_indices:
        members = joint_groups[ji]
        seg_indices = [m[0] for m in members]
        root = find(seg_indices[0])
        for s in seg_indices:
            cluster_seg.setdefault(root, set()).add(s)
        cluster_joints.setdefault(root, []).append(ji)

    # Pull in any segment whose union-find root matches (handles segments
    # connecting two different multi-joints)
    for s in range(n_segs):
        r = find(s)
        if r in cluster_seg:
            cluster_seg[r].add(s)

    out: List[JunctionCluster] = []
    consumed: Set[int] = set()
    for root in sorted(cluster_seg.keys()):
        seg_set = cluster_seg[root]
        joints = sorted(cluster_joints.get(root, []))
        out.append(JunctionCluster(
            cluster_id=f'csg_cluster_{root}',
            joint_indices=joints,
            members=[],
            joint_zones=[],
            member_seg_indices=set(seg_set),
        ))
        consumed.update(seg_set)
    return out, consumed


def attach_member(cluster: JunctionCluster, member: ClusterMember) -> None:
    cluster.members.append(member)


def attach_joint_zone(cluster: JunctionCluster,
                      zone: "csg_junctions.JunctionZone") -> None:
    cluster.joint_zones.append(zone)


# ---------------------------------------------------------------------------
# Per-segment manifold extrusion
# ---------------------------------------------------------------------------

def _segment_outer_solid(member: ClusterMember,
                         axis_z: Vec3 = (0.0, 0.0, 1.0)
                         ) -> Optional[Manifold]:
    """Extrude the member's OUTER profile (CCW, in member-local Y/Z) along
    its world bearing for `member.length`, centred on the segment midpoint.
    Returns None for degenerate inputs."""
    if member.length <= 0 or len(member.outer_2d) < 3:
        return None
    midpoint = (
        (member.start[0] + member.end[0]) / 2.0,
        (member.start[1] + member.end[1]) / 2.0,
        (member.start[2] + member.end[2]) / 2.0,
    )
    try:
        local = csg.profile_solid(member.outer_2d, member.length)
        return csg.place(local, origin=midpoint, axis_x=member.d, axis_z=axis_z)
    except Exception as ex:                                          # noqa: BLE001
        print(f"[CSG-CLUSTER] member={member.elem_id} outer build skip ({ex})")
        return None


def _segment_inner_solid(member: ClusterMember,
                         axis_z: Vec3 = (0.0, 0.0, 1.0)
                         ) -> Optional[Manifold]:
    """Same as outer but for the bore."""
    if member.length <= 0 or len(member.inner_2d) < 3:
        return None
    midpoint = (
        (member.start[0] + member.end[0]) / 2.0,
        (member.start[1] + member.end[1]) / 2.0,
        (member.start[2] + member.end[2]) / 2.0,
    )
    try:
        local = csg.profile_solid(member.inner_2d, member.length)
        return csg.place(local, origin=midpoint, axis_x=member.d, axis_z=axis_z)
    except Exception as ex:                                          # noqa: BLE001
        print(f"[CSG-CLUSTER] member={member.elem_id} inner build skip ({ex})")
        return None


# ---------------------------------------------------------------------------
# Cluster manifold builder
# ---------------------------------------------------------------------------

def build_cluster_manifold(cluster: JunctionCluster,
                           *,
                           stub_length_m: float = 1.0,
                           joint_radius_m: float = 0.5
                           ) -> Optional[Manifold]:
    """Build the merged manifold for one cluster.

    1. Build outer + inner extrusion solids per member at trimmed length.
    2. Build outer + inner stub solids for every joint zone in the cluster.
    3. outer_hull = ⋃ (members' outer + joints' outer)
       inner_hull = ⋃ (members' inner + joints' inner)
       carved = outer_hull - inner_hull
    4. Translate hulls back to world coordinates (joint zones are built in
       joint-local frame, then translated; member solids are already in
       world via place()).

    Returns the carved manifold, or None on failure. Caller emits as
    IfcTriangulatedFaceSet.
    """
    if not cluster.members:
        return None

    outer_pieces: List[Manifold] = []
    inner_pieces: List[Manifold] = []

    for m in cluster.members:
        outer_solid = _segment_outer_solid(m)
        if outer_solid is not None and not csg.is_empty(outer_solid):
            outer_pieces.append(outer_solid)
        inner_solid = _segment_inner_solid(m)
        if inner_solid is not None and not csg.is_empty(inner_solid):
            inner_pieces.append(inner_solid)

    # Joint stubs — build via existing csg_junctions logic, but in WORLD
    # coords (not joint-local). build_zone_hull already handles this.
    for zone in cluster.joint_zones:
        # Build OUTER hull and INNER hull separately by reusing the
        # primitives in csg_junctions but skipping the difference step.
        outer_hull, inner_hull = _build_zone_outer_inner(
            zone, stub_length_m=stub_length_m, joint_radius_m=joint_radius_m)
        if outer_hull is not None and not csg.is_empty(outer_hull):
            outer_pieces.append(outer_hull)
        if inner_hull is not None and not csg.is_empty(inner_hull):
            inner_pieces.append(inner_hull)

    if not outer_pieces:
        return None
    try:
        outer_full = csg.csg_union(outer_pieces)
        if inner_pieces:
            inner_full = csg.csg_union(inner_pieces)
            carved = csg.csg_difference(outer_full, inner_full)
        else:
            carved = outer_full
        return carved
    except Exception as ex:                                          # noqa: BLE001
        print(f"[CSG-CLUSTER] {cluster.cluster_id} CSG failed: {ex}")
        return None


def _build_zone_outer_inner(zone: "csg_junctions.JunctionZone",
                            *,
                            stub_length_m: float,
                            joint_radius_m: float
                            ) -> Tuple[Optional[Manifold], Optional[Manifold]]:
    """Variant of csg_junctions.build_zone_hull that returns (outer, inner)
    separately so the cluster builder can union them with member extrusions
    BEFORE the inner subtraction. World-coordinate output.
    """
    if len(zone.members) < 2:
        return None, None
    outer_solids: List[Manifold] = []
    inner_solids: List[Manifold] = []
    for m in zone.members:
        try:
            local_origin = csg_junctions._stub_local_origin(
                m.axis_x, stub_length_m, joint_radius_m)
            outer = csg_junctions._build_outer_solid(m, stub_length_m)
            inner = csg_junctions._build_inner_solid(m, stub_length_m)
            placed_outer = csg.place(outer, origin=local_origin,
                                     axis_x=m.axis_x, axis_z=m.axis_z)
            placed_inner = csg.place(inner, origin=local_origin,
                                     axis_x=m.axis_x, axis_z=m.axis_z)
            outer_solids.append(placed_outer)
            inner_solids.append(placed_inner)
        except Exception as ex:                                      # noqa: BLE001
            print(f"[CSG-CLUSTER] zone={zone.joint_id} member={m.segment_id} "
                  f"stub skip ({ex})")
            continue
    if not outer_solids:
        return None, None
    try:
        outer_hull = csg.csg_union(outer_solids)
        inner_hull = csg.csg_union(inner_solids) if inner_solids else None
        # Translate from joint-local to world
        outer_world = csg.translate(outer_hull, zone.joint_pos)
        inner_world = (csg.translate(inner_hull, zone.joint_pos)
                       if inner_hull is not None else None)
        return outer_world, inner_world
    except Exception as ex:                                          # noqa: BLE001
        print(f"[CSG-CLUSTER] zone={zone.joint_id} hull union failed ({ex})")
        return None, None


# ---------------------------------------------------------------------------
# Gap validator
# ---------------------------------------------------------------------------

def assert_no_cluster_gaps(cluster_manifolds: Sequence[Tuple[str, Manifold]],
                           brep_endpoint_pts: Sequence[Tuple[str, Vec3]],
                           *,
                           gap_tol_m: float = 0.05
                           ) -> List[str]:
    """For each remaining brep endpoint that belongs to a cluster boundary,
    verify the closest cluster manifold surface is within `gap_tol_m`.

    Returns a list of failure strings (empty on pass).
    """
    if not cluster_manifolds or not brep_endpoint_pts:
        return []
    import numpy as np
    tris_all: List[np.ndarray] = []
    for _, mesh in cluster_manifolds:
        v, t = csg.to_arrays(mesh)
        if t.shape[0] == 0:
            continue
        tris_all.append(v[t])
    if not tris_all:
        return []
    all_tris = np.concatenate(tris_all, axis=0)
    failures: List[str] = []
    from .csg_validators import _point_triangle_distance        # type: ignore
    for label, p in brep_endpoint_pts:
        d = _point_triangle_distance(np.asarray(p, dtype=np.float64), all_tris)
        if d > gap_tol_m:
            failures.append(f'{label}: nearest cluster face {d:.3f}m > {gap_tol_m:.3f}m')
    return failures
