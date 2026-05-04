"""Generic topology stage.

5A.9 — pure cycle-finder graph cluster moved out of clean_tunnel_export.py
with behavior preserved exactly. No tunnel-only assumptions; no external
constants; no dependency on clean_tunnel_export private symbols.

Public helpers:
    _chain_profile_signature(cand)
    _find_main_loop(node_segs, seg_nodes)
    _node_in_component(node, parent_node, root)
    _back_edge_cycle(node_a, node_b, back_seg, parent_node, parent_seg)
    has_parallel_continuation(cand, end_lbl, all_cands, ...)   — 5B.4

Helpers that remain in clean_tunnel_export.py for now (each pulls in
_vec_* or module-level constants — moving them here would force
duplication, which is out of scope until vec ops are unified):
    _round_endpoint
    _compute_joint_trims
    _chain_slerp3
    _detect_chains              (calls _find_main_loop / _chain_profile_signature
                                 from this module via import)
    _order_component_dfs
    _build_chain_sections
"""

import math


def has_parallel_continuation(cand, end_lbl, all_cands,
                              min_xy_gap=0.05,
                              max_xy_gap=3.0,
                              max_angle_deg=20.0):
    """Generic check: is this segment's `end_lbl` end actually continued by
    another segment that the joint solver missed?

    A "true free end" means there is no other host segment continuing the
    path past this end. Tight-coincident endpoints (xy_gap < min_xy_gap) are
    already merged by the joint solver — we look for the *almost*-coincident
    case: another endpoint sits within (min_xy_gap, max_xy_gap) of this one
    AND lies in the outward half-space, near-parallel to this segment's
    direction.

    Inputs:
        cand        — dict with 'start', 'end', 'd' (unit direction)
        end_lbl     — 'start' or 'end'
        all_cands   — iterable of candidate dicts (the same `cand` is skipped)
        min_xy_gap  — endpoints closer than this are joint-merged elsewhere
        max_xy_gap  — endpoints farther than this aren't continuations
        max_angle_deg — max angular deviation from `cand`'s outward direction

    Returns True iff at least one other candidate's endpoint qualifies as a
    parallel continuation past this end.
    """
    if end_lbl == 'start':
        anchor = cand['start']
        outward = (-cand['d'][0], -cand['d'][1], -cand['d'][2])
    else:
        anchor = cand['end']
        outward = cand['d']

    cos_thresh = math.cos(math.radians(max_angle_deg))
    min2 = min_xy_gap * min_xy_gap
    max2 = max_xy_gap * max_xy_gap
    for other in all_cands:
        if other is cand:
            continue
        for other_pt in (other['start'], other['end']):
            dx = other_pt[0] - anchor[0]
            dy = other_pt[1] - anchor[1]
            dxy2 = dx * dx + dy * dy
            if dxy2 < min2 or dxy2 > max2:
                continue
            dz = other_pt[2] - anchor[2]
            dl = math.sqrt(dxy2 + dz * dz)
            if dl < 1e-6:
                continue
            dot_dir = (dx * outward[0] + dy * outward[1] + dz * outward[2]) / dl
            if dot_dir > cos_thresh:
                return True
    return False


def _chain_profile_signature(cand):
    """Hashable shape signature — chain breaks on any mismatch."""
    bw, bh, st = cand['profile']
    return (cand.get('source_type', 'RECTANGLE'),
            round(bw, 2), round(bh, 2), round(st, 2))


def _find_main_loop(node_segs, seg_nodes):
    """Find segments forming the LARGEST cycle in the endpoint-node graph.

    The tunnel is modelled as: nodes = endpoint positions, edges = segments.
    A tunnel network is a "primary loop with occasional branches" — exactly
    the topology where treating every segment as part of one big chain
    produces tangled, self-intersecting geometry.

    Algorithm:
        1. Build node adjacency (one edge per segment) for the whole graph.
        2. BFS spanning forest. Tree edges form a forest, the rest are
           back edges. Each back edge defines a fundamental cycle:
           back edge + tree path between its endpoints.
        3. Return the segments of the longest cycle (by segment count) so
           branches are excluded.

    Returns set of seg indices in the main loop, or None if no cycle exists.
    """
    n_segs = len(seg_nodes)
    if n_segs == 0:
        return None

    node_adj = {}  # node -> list of (other_node, seg_idx)
    for seg_idx, ends in enumerate(seg_nodes):
        if len(ends) != 2:
            continue
        n0, _ = ends[0]
        n1, _ = ends[1]
        if n0 == n1:
            continue  # self-loop — degenerate
        node_adj.setdefault(n0, []).append((n1, seg_idx))
        node_adj.setdefault(n1, []).append((n0, seg_idx))

    if not node_adj:
        return None

    visited_nodes = set()
    parent_node = {}     # node -> parent_node
    parent_seg = {}      # node -> seg_idx connecting to parent
    cycles = []

    for start_node in list(node_adj.keys()):
        if start_node in visited_nodes:
            continue
        visited_nodes.add(start_node)
        parent_node[start_node] = None
        parent_seg[start_node] = None
        queue = [start_node]
        component_tree_segs = set()
        while queue:
            cur = queue.pop(0)
            for (other, seg_idx) in node_adj.get(cur, []):
                if other not in visited_nodes:
                    visited_nodes.add(other)
                    parent_node[other] = cur
                    parent_seg[other] = seg_idx
                    component_tree_segs.add(seg_idx)
                    queue.append(other)

        # Now scan all node_adj edges in this component for back edges.
        # Each back edge = one fundamental cycle.
        component_nodes = [n for n in visited_nodes if _node_in_component(n, parent_node, start_node)]
        seen_back_keys = set()
        for n in component_nodes:
            for (other, seg_idx) in node_adj.get(n, []):
                if seg_idx in component_tree_segs:
                    continue
                key = (min(seg_idx, n, other), max(seg_idx, n, other))
                # Use the segment id itself as the unique key — each segment
                # is a unique edge regardless of orientation.
                if seg_idx in seen_back_keys:
                    continue
                seen_back_keys.add(seg_idx)
                cycle_segs = _back_edge_cycle(n, other, seg_idx, parent_node, parent_seg)
                if cycle_segs and len(cycle_segs) >= 3:
                    cycles.append(cycle_segs)

    if not cycles:
        return None

    main = max(cycles, key=len)
    return set(main)


def _node_in_component(node, parent_node, root):
    """True iff `node` is in the BFS tree rooted at `root` (parent chain reaches root)."""
    cur = node
    while parent_node.get(cur) is not None:
        cur = parent_node[cur]
    return cur == root


def _back_edge_cycle(node_a, node_b, back_seg, parent_node, parent_seg):
    """Build the fundamental-cycle segment list for back edge between node_a and node_b.

    Tree path from node_a up to LCA, then tree path back down to node_b,
    plus the back-edge segment closes the loop.
    """
    def ancestors(x):
        anc = [x]
        while parent_node.get(x) is not None:
            x = parent_node[x]
            anc.append(x)
        return anc

    anc_a = ancestors(node_a)
    set_b = set(ancestors(node_b))
    lca = None
    for x in anc_a:
        if x in set_b:
            lca = x
            break
    if lca is None:
        return None

    cycle_segs = [back_seg]
    cur = node_a
    while cur != lca:
        seg = parent_seg.get(cur)
        if seg is None:
            return None
        cycle_segs.append(seg)
        cur = parent_node[cur]
    cur = node_b
    while cur != lca:
        seg = parent_seg.get(cur)
        if seg is None:
            return None
        cycle_segs.append(seg)
        cur = parent_node[cur]
    return cycle_segs
