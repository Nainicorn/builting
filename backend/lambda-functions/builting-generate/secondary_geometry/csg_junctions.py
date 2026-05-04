"""
csg_junctions.py — Phase 6D.1 junction-filler builder.

Given a set of joints (2-way and 3+way) where existing chain/wall breps
butt-cut to leave seams, build a single carved hull per joint by:

  1. For each member segment ending at the joint, build a SOLID stub
     (full outer cross-section, no bore) starting at the segment's
     butt-cut plane and extending into the joint zone.
  2. Boolean-union all member stubs → outer hull.
  3. Build the corresponding INNER stubs (just the bore cross-section)
     and union them → inner hull.
  4. Carved hull = outer_hull − inner_hull. This produces a hollow
     shell at the joint with all bores connected internally — replaces
     the visible seams of separate per-segment breps.

Output: list of (joint_id, Manifold) hulls. Caller emits each as an
IfcTriangulatedFaceSet via csg_ifc.emit_triangulated_face_set.

Inputs are normalised metres in WORLD coordinates. The clean_tunnel_export
existing convention has many fields in metres already (cand['d'] is unit,
profile values are metres) — but joint positions and segment endpoints
mix mm and m at the topology layer; the wiring layer is responsible for
converting before invoking this module.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import csg
from .csg import Manifold

Vec3 = Tuple[float, float, float]


# ---------------------------------------------------------------------------
# Public input dataclasses
# ---------------------------------------------------------------------------

@dataclass
class JunctionMember:
    """One segment ending at a joint."""
    segment_id: str
    end_label: str                    # 'start' or 'end'
    profile_kind: str                 # 'ARCH' or 'RECT'
    bore_w: float                     # metres
    bore_h: float                     # metres
    shell_t: float                    # metres
    axis_x: Vec3                      # outward from joint (segment +X), unit
    axis_z: Vec3 = (0.0, 0.0, 1.0)    # local up
    butt_pos: Optional[Vec3] = None   # world position of butt-cut plane (optional)
    half_w_outer: Optional[float] = None  # convenience cache


@dataclass
class JunctionZone:
    """One physical joint where 2+ segment ends meet."""
    joint_id: str
    joint_pos: Vec3
    members: List[JunctionMember] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Stub builder
# ---------------------------------------------------------------------------

def _build_outer_solid(member: JunctionMember, length: float) -> Manifold:
    """Solid (no bore) representing the segment's full outer profile,
    extruded along its axis_x by `length`, centred at origin in local frame.

    Phase 6D.1 P3 — for ARCH segments, builds the true arched profile
    (vertical sidewalls + semicircular crown + flat floor). The earlier
    rect bbox left visible plates at the springline corners where the arch
    curves away. The arched solid is centred so its floor sits at z=0 of the
    member-local frame, matching the host shell's floor.
    """
    bw = float(member.bore_w)
    bh = float(member.bore_h)
    st = float(member.shell_t)
    outer_w = bw + 2 * st
    outer_h = bh + 2 * st
    if (member.profile_kind or '').upper() == 'ARCH':
        return csg.arched_outer_solid(outer_w, outer_h, length)
    return csg.rect_solid(outer_w, outer_h, length)


def _build_inner_solid(member: JunctionMember, length: float) -> Manifold:
    """Solid representing the segment's bore (inside clear opening).

    For ARCH members, the bore is also arched (matches the host's inner
    cavity); using a rect bore would leave the carved hull's bore-corners
    bent inward where they should be radiused.
    """
    bw = float(member.bore_w)
    bh = float(member.bore_h)
    if (member.profile_kind or '').upper() == 'ARCH':
        return csg.arched_outer_solid(bw, bh, length)
    return csg.rect_solid(bw, bh, length)


def _stub_local_origin(axis_x_local: Vec3, stub_length: float,
                       joint_radius: float) -> Vec3:
    """Local-frame origin (joint at origin) for a stub extending from past
    the joint centre outward along axis_x by enough that its outer face
    sits at distance stub_length-joint_radius from the joint centre."""
    out_distance = max(0.0, stub_length - joint_radius)
    mid_offset = (out_distance - joint_radius) / 2.0
    return (mid_offset * axis_x_local[0],
            mid_offset * axis_x_local[1],
            mid_offset * axis_x_local[2])


def build_zone_hull(zone: JunctionZone,
                    *,
                    stub_length_m: float = 0.6,
                    joint_radius_m: float = 0.5) -> Optional[Manifold]:
    """Build one carved hull for a single junction zone, in WORLD coordinates.

    Returns None if the zone has < 2 members (nothing to fill).

    All CSG ops happen in JOINT-LOCAL coordinates (joint at origin) to
    preserve float32 precision; the result is translated to the world joint
    position at the very end. This keeps vertex coords near the origin during
    boolean ops, where the 7 sig-fig precision of float32 gives ~10⁻⁵ m
    accuracy instead of ~5 cm at world-tunnel coordinates ~(44 km, 17 km).

    Stub geometry:
      - Each stub spans [butt_plane, joint_centre + joint_radius_m * inward].
      - stub_length_m default 0.6 m (Phase 6D.1 P4 — was 1.5 m before
        topology-level host-shell trim; with trim+stub aligned the stub
        only needs to cover the joint void, not extend deep into hosts).
      - joint_radius_m must exceed half of the largest member's outer profile
        so all stubs overlap inside the joint volume.
    """
    if len(zone.members) < 2:
        return None

    outer_solids: List[Manifold] = []
    inner_solids: List[Manifold] = []

    for m in zone.members:
        try:
            local_origin = _stub_local_origin(
                m.axis_x, stub_length_m, joint_radius_m)
            outer = _build_outer_solid(m, stub_length_m)
            inner = _build_inner_solid(m, stub_length_m)
            placed_outer = csg.place(outer, origin=local_origin,
                                     axis_x=m.axis_x, axis_z=m.axis_z)
            placed_inner = csg.place(inner, origin=local_origin,
                                     axis_x=m.axis_x, axis_z=m.axis_z)
            outer_solids.append(placed_outer)
            inner_solids.append(placed_inner)
        except Exception as ex:  # noqa: BLE001
            print(f"[CSG-FILLER] zone={zone.joint_id} member={m.segment_id} "
                  f"skip ({ex})")
            continue

    if not outer_solids:
        return None

    try:
        outer_hull = csg.csg_union(outer_solids)
        inner_hull = csg.csg_union(inner_solids) if inner_solids else None
        if inner_hull is not None:
            carved = csg.csg_difference(outer_hull, inner_hull)
        else:
            carved = outer_hull
        # Translate from joint-local back to world.
        return csg.translate(carved, zone.joint_pos)
    except Exception as ex:  # noqa: BLE001
        print(f"[CSG-FILLER] zone={zone.joint_id} csg failed ({ex})")
        return None


def build_all_zone_hulls(zones: Sequence[JunctionZone],
                         *,
                         stub_length_m: float = 0.6,
                         joint_radius_m: float = 0.5,
                         min_members: int = 2) -> List[Tuple[str, Manifold]]:
    """Build hulls for every zone with >= min_members. Skips silently on
    failure (logged) so a single bad zone never aborts the whole render."""
    out: List[Tuple[str, Manifold]] = []
    for z in zones:
        if len(z.members) < min_members:
            continue
        h = build_zone_hull(z, stub_length_m=stub_length_m,
                            joint_radius_m=joint_radius_m)
        if h is None or csg.is_empty(h):
            continue
        out.append((z.joint_id, h))
    return out


# ---------------------------------------------------------------------------
# Helpers used by the wiring layer (clean_tunnel_export.py)
# ---------------------------------------------------------------------------

def zones_from_joint_groups(horizontal_candidates: Sequence[dict],
                            joint_groups: Sequence[Sequence[tuple]],
                            min_members: int = 2) -> List[JunctionZone]:
    """Convert clean_tunnel_export joint groups into JunctionZone list.

    `joint_groups` is the value of `jstats['joint_groups']`: a list where each
    entry is the records of one joint, with each record being
    `(seg_idx, end_label, node_id, rounded_pos, raw_pos)`.
    """
    zones: List[JunctionZone] = []
    for gi, members in enumerate(joint_groups):
        if len(members) < min_members:
            continue
        # Joint position = average of raw endpoint positions (handles small
        # FP gaps between coincident-rounded endpoints).
        n = len(members)
        jx = sum(m[4][0] for m in members) / n
        jy = sum(m[4][1] for m in members) / n
        jz = sum(m[4][2] for m in members) / n
        joint_pos = (float(jx), float(jy), float(jz))
        zone_members: List[JunctionMember] = []
        for seg_idx, end_lbl, _node, _pos, _raw in members:
            cand = horizontal_candidates[seg_idx]
            seg_id = (cand.get('elem_id')
                      or cand.get('segment_id')
                      or f'seg_{seg_idx}')
            zone_members.append(
                member_from_candidate(cand, str(seg_id), str(end_lbl)))
        zones.append(JunctionZone(
            joint_id=f'csg_zone_{gi}',
            joint_pos=joint_pos,
            members=zone_members,
        ))
    return zones


def member_from_candidate(cand: dict, segment_id: str, end_label: str,
                          axis_z: Vec3 = (0.0, 0.0, 1.0)) -> JunctionMember:
    """Convert a `horizontal_candidate` dict into a JunctionMember.

    Conventions:
      cand['d']      : unit direction start->end  (Vec3, units don't matter — unit)
      cand['profile']: (bore_w, bore_h, shell_t)  in METRES
      cand['source_type'] : 'ARCH' or 'RECTANGLE'
      cand['half_w_outer']: convenience scalar (metres)

    The OUTWARD direction at this joint = +d if end_label == 'start' (the
    joint is at the start, so the rest of the segment points along +d
    away from the joint), else -d.
    """
    d = cand['d']
    if end_label == 'start':
        axis_x = (float(d[0]), float(d[1]), float(d[2]))
    else:
        axis_x = (-float(d[0]), -float(d[1]), -float(d[2]))
    bw, bh, st = cand['profile']
    src = cand.get('source_type', 'RECTANGLE')
    profile_kind = 'ARCH' if (src or '').upper() == 'ARCH' else 'RECT'
    butt = cand.get('start') if end_label == 'start' else cand.get('end')
    butt_pos = None
    if butt is not None:
        try:
            butt_pos = (float(butt[0]), float(butt[1]), float(butt[2]))
        except Exception:
            butt_pos = None
    return JunctionMember(
        segment_id=segment_id,
        end_label=end_label,
        profile_kind=profile_kind,
        bore_w=float(bw),
        bore_h=float(bh),
        shell_t=float(st),
        axis_x=axis_x,
        axis_z=tuple(float(v) for v in axis_z),
        butt_pos=butt_pos,
        half_w_outer=float(cand.get('half_w_outer', (bw + 2 * st) / 2.0)),
    )
