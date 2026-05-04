/**
 * connectivity-gap-report.mjs — Phase 6C diagnostics
 *
 * Pure read-only diagnostic. Produces connectivity_gap_report.json with six
 * sections describing where the model is *not* yet integrated:
 *
 *   A. Tunnel shell connectivity      — segment-to-segment endpoint, profile,
 *                                       elevation, gap, overlap status
 *   B. Branch / building connectivity — per-room shell touch + closure check
 *   C. Door semantic correctness      — accepted vs semantic plan delta
 *   D. Ventilation connectivity       — duct/pipe run gaps and missing fittings
 *   E. Missing equipment              — expected items vs found items
 *   F. Elevation handling             — portal floor_z mismatch + ramp need
 *
 * Inputs:  css (in-memory after pipeline mutations), spaceReport, doorPlan,
 *          wallReconReport (any may be null when classifier did not run).
 * Output:  a plain JSON-serialisable report object. The caller is responsible
 *          for writing it to S3.
 *
 * No element mutation. No new geometry. Diagnostics only.
 */

const REPORT_VERSION = 'connectivity-gap/v1';

// Tolerances kept loose so the report describes reality, not enforcement.
const ENDPOINT_GAP_CLEAN_M    = 0.05;   // ≤ 50mm   → clean
const ENDPOINT_GAP_GAP_M      = 0.50;   // > 50mm   → gap
const ENDPOINT_OVERLAP_M      = 0.05;   // > 50mm   → overlap
const PROFILE_DIM_TOL_M       = 0.10;   // > 100mm  diff in width/height → misaligned
const ELEVATION_MISMATCH_M    = 0.50;   // > 500mm  Z diff → elevation_mismatch
const DUCT_FITTING_ANGLE_DEG  = 10.0;   // bend ≥ this → expected elbow
const DUCT_ENDPOINT_TOL_M     = 0.30;   // ≤ this → connected, else floating
const PORTAL_ELEV_DELTA_M     = 0.50;   // > 500mm Z delta → ramp/stair needed

// ── helpers ──────────────────────────────────────────────────────────────────

const round = (n, d = 3) => Number.isFinite(n) ? Number(n.toFixed(d)) : null;

function dist3(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getSegmentEndpoints(elem) {
  const props = elem.properties || {};
  const s = props.startPoint;
  const e = props.endPoint;
  if (s && e && Number.isFinite(s.x) && Number.isFinite(e.x)) {
    return {
      s: { x: +s.x, y: +s.y, z: Number.isFinite(+s.z) ? +s.z : 0 },
      e: { x: +e.x, y: +e.y, z: Number.isFinite(+e.z) ? +e.z : 0 }
    };
  }
  // Fallback: derive from origin + axis + depth
  const o = (elem.placement || {}).origin;
  const ax = (elem.placement || {}).axis;
  const depth = (elem.geometry || {}).depth;
  if (!o || !ax || !depth) return null;
  const half = depth / 2;
  return {
    s: { x: o.x - ax.x * half, y: o.y - ax.y * half, z: o.z - ax.z * half },
    e: { x: o.x + ax.x * half, y: o.y + ax.y * half, z: o.z + ax.z * half }
  };
}

function getProfileSize(elem) {
  const p = (elem.geometry || {}).profile || {};
  const w = p.width  ?? (p.radius ? p.radius * 2 : null);
  const h = p.height ?? (p.radius ? p.radius * 2 : null);
  return { width: w, height: h, type: (p.type || '').toUpperCase() || null };
}

function classifyEndpointPair(distance, overlap) {
  if (overlap > ENDPOINT_OVERLAP_M) return 'overlap';
  if (distance <= ENDPOINT_GAP_CLEAN_M) return 'clean';
  return 'gap';
}

// Compute axial overlap between two collinear segments (positive = overlap).
function axialOverlap(epA, epB) {
  // Project both on the average axis
  const dxA = epA.e.x - epA.s.x, dyA = epA.e.y - epA.s.y, dzA = epA.e.z - epA.s.z;
  const lenA = Math.sqrt(dxA*dxA + dyA*dyA + dzA*dzA);
  if (lenA < 1e-6) return 0;
  const ax = dxA / lenA, ay = dyA / lenA, az = dzA / lenA;
  const projA = [
    (epA.s.x * ax + epA.s.y * ay + epA.s.z * az),
    (epA.e.x * ax + epA.e.y * ay + epA.e.z * az)
  ].sort((u, v) => u - v);
  const projB = [
    (epB.s.x * ax + epB.s.y * ay + epB.s.z * az),
    (epB.e.x * ax + epB.e.y * ay + epB.e.z * az)
  ].sort((u, v) => u - v);
  const overlap = Math.min(projA[1], projB[1]) - Math.max(projA[0], projB[0]);
  return overlap;
}

// ── A. Tunnel shell connectivity ─────────────────────────────────────────────

function analyzeShellConnectivity(css, spaceReport) {
  const segments = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT'
  );

  // Build shared-node lookup from spaceReport (segNodes) when available.
  // Falls back to endpoint proximity buckets.
  const segNodeMap = new Map(); // segKey → { nodeA, nodeB }
  if (spaceReport && Array.isArray(spaceReport.segmentZones)) {
    for (const sz of spaceReport.segmentZones) {
      segNodeMap.set(sz.key, { nodeA: sz.nodeA, nodeB: sz.nodeB });
    }
  }

  // Index segment by key for quick lookup.
  const segByKey = new Map();
  for (const s of segments) segByKey.set(s.element_key || s.id, s);

  // Index bridge segments by the pair they connect — used to mark a gap as
  // 'bridged' when a synthetic_bridge / BRIDGE_INFERRED segment is present.
  const bridgesByPair = new Map();    // "a|b" sorted key → bridge element
  for (const seg of segments) {
    const props = seg.properties || {};
    const meta  = seg.metadata   || {};
    const isBridge = props.synthetic_bridge || props._isBridgeSegment ||
                     props.decompositionMethod === 'BRIDGE_INFERRED' ||
                     props.decompositionMethod === 'SHELL_GAP_BRIDGE';
    if (!isBridge) continue;
    const a = meta.bridgeFromSegment || props.bridgeFromSegment;
    const b = meta.bridgeToSegment   || props.bridgeToSegment;
    if (!a || !b) continue;
    const k = [a, b].sort().join('|');
    bridgesByPair.set(k, seg.element_key || seg.id);
  }

  // Group segments by shared node.
  const nodeToSegs = new Map();
  if (segNodeMap.size > 0) {
    for (const [segKey, nn] of segNodeMap) {
      for (const nid of [nn.nodeA, nn.nodeB]) {
        if (!nid) continue;
        if (!nodeToSegs.has(nid)) nodeToSegs.set(nid, new Set());
        nodeToSegs.get(nid).add(segKey);
      }
    }
  } else {
    // Fallback: bucket by endpoint XYZ rounded to 1m grid.
    const bucket = (p) => `${Math.round(p.x)}_${Math.round(p.y)}_${Math.round(p.z)}`;
    for (const seg of segments) {
      const ep = getSegmentEndpoints(seg);
      if (!ep) continue;
      const key = seg.element_key || seg.id;
      for (const pt of [ep.s, ep.e]) {
        const b = bucket(pt);
        if (!nodeToSegs.has(b)) nodeToSegs.set(b, new Set());
        nodeToSegs.get(b).add(key);
      }
    }
  }

  // For each node with degree ≥ 2, emit a pair-wise connectivity row.
  const rows = [];
  const seenPairs = new Set();
  let cleanCount = 0, gapCount = 0, overlapCount = 0,
      misalignedCount = 0, elevationMismatchCount = 0;

  for (const [nodeId, segSet] of nodeToSegs) {
    if (segSet.size < 2) continue;
    const segKeys = [...segSet];
    for (let i = 0; i < segKeys.length; i++) {
      for (let j = i + 1; j < segKeys.length; j++) {
        const a = segKeys[i], b = segKeys[j];
        const pairKey = a < b ? `${a}|${b}|${nodeId}` : `${b}|${a}|${nodeId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const segA = segByKey.get(a);
        const segB = segByKey.get(b);
        if (!segA || !segB) continue;
        const epA = getSegmentEndpoints(segA);
        const epB = getSegmentEndpoints(segB);
        if (!epA || !epB) continue;

        // Closest endpoint pair across the four candidates.
        const candidates = [
          { p: epA.s, q: epB.s, endA: 'start', endB: 'start' },
          { p: epA.s, q: epB.e, endA: 'start', endB: 'end'   },
          { p: epA.e, q: epB.s, endA: 'end',   endB: 'start' },
          { p: epA.e, q: epB.e, endA: 'end',   endB: 'end'   }
        ];
        let best = candidates[0];
        let bestD = dist3(best.p, best.q);
        for (let k = 1; k < 4; k++) {
          const d = dist3(candidates[k].p, candidates[k].q);
          if (d < bestD) { bestD = d; best = candidates[k]; }
        }
        const overlap = axialOverlap(epA, epB);
        const elevDelta = Math.abs((best.p.z || 0) - (best.q.z || 0));

        const profA = getProfileSize(segA);
        const profB = getProfileSize(segB);
        const widthDiff  = (profA.width  != null && profB.width  != null) ? Math.abs(profA.width  - profB.width)  : null;
        const heightDiff = (profA.height != null && profB.height != null) ? Math.abs(profA.height - profB.height) : null;
        const profileMisaligned =
          (widthDiff  !== null && widthDiff  > PROFILE_DIM_TOL_M) ||
          (heightDiff !== null && heightDiff > PROFILE_DIM_TOL_M);

        // Bridge resolution: if a bridge segment links this pair, the
        // connection is satisfied even if the raw endpoint distance is large.
        const bridgePairKey = [a, b].sort().join('|');
        const bridgedBy = bridgesByPair.get(bridgePairKey) || null;

        // Status — first match wins.
        let status;
        if (bridgedBy)                                    status = 'bridged';
        else if (overlap > ENDPOINT_OVERLAP_M)            status = 'overlap';
        else if (elevDelta > ELEVATION_MISMATCH_M)        status = 'elevation_mismatch';
        else if (profileMisaligned)                       status = 'misaligned';
        else if (bestD <= ENDPOINT_GAP_CLEAN_M)           status = 'clean';
        else                                              status = 'gap';

        switch (status) {
          case 'overlap':            overlapCount++;            break;
          case 'elevation_mismatch': elevationMismatchCount++;  break;
          case 'misaligned':         misalignedCount++;         break;
          case 'clean':              cleanCount++;              break;
          case 'gap':                gapCount++;                break;
        }

        // Volume estimate: overlap × min(profile area)
        const minArea = (profA.width && profA.height && profB.width && profB.height)
          ? Math.min(profA.width * profA.height, profB.width * profB.height)
          : null;
        const overlapVolume = (overlap > 0 && minArea != null) ? overlap * minArea : 0;

        rows.push({
          segment_a:                a,
          segment_b:                b,
          expected_shared_node:     nodeId,
          actual_endpoint_distance: round(bestD, 4),
          profile_alignment_error:  {
            widthDiff:  round(widthDiff,  4),
            heightDiff: round(heightDiff, 4),
            misaligned: profileMisaligned
          },
          elevation_difference:     round(elevDelta, 4),
          gap_distance:             round(Math.max(0, bestD), 4),
          overlap_volume_estimate:  round(Math.max(0, overlapVolume), 4),
          endA: best.endA,
          endB: best.endB,
          status,
          bridged_by:               bridgedBy
        });
      }
    }
  }

  const bridgedCount = rows.filter(r => r.status === 'bridged').length;
  return {
    summary: {
      pairs:                rows.length,
      clean:                cleanCount,
      gap:                  gapCount,
      overlap:              overlapCount,
      misaligned:           misalignedCount,
      elevation_mismatch:   elevationMismatchCount,
      bridged:              bridgedCount
    },
    pairs: rows.sort((a, b) => (b.actual_endpoint_distance || 0) - (a.actual_endpoint_distance || 0))
                .slice(0, 200)  // keep report bounded
  };
}

// ── B. Branch / building connectivity ────────────────────────────────────────

function analyzeBranchConnectivity(css, spaceReport, wallReconReport) {
  if (!spaceReport || !Array.isArray(spaceReport.rooms)) {
    return { summary: { rooms: 0 }, rooms: [], reason: 'space_report_unavailable' };
  }

  const segNodeMap = new Map();
  for (const sz of spaceReport.segmentZones || []) segNodeMap.set(sz.key, sz);

  // Per-segment shell touch with main corridor: any node shared with a
  // MAIN_TUNNEL or PORTAL segment in spaceReport.
  const corridorNodes = new Set();
  for (const sz of spaceReport.segmentZones || []) {
    if (sz.zone === 'MAIN_TUNNEL' || sz.zone === 'PORTAL') {
      if (sz.nodeA) corridorNodes.add(sz.nodeA);
      if (sz.nodeB) corridorNodes.add(sz.nodeB);
    }
  }

  // Index every planned wall by roomId/segKey/junctionNodeId so we can
  // attribute closure to its target room. The wall-reconstructor plan is the
  // authoritative closure spec — Python generate emits IfcWallStandardCase
  // from these plans, so a planned wall counts as a closure even though there
  // is no corresponding JS-side WALL element yet.
  const planByRoom    = new Map();   // roomId → wall[]
  const planBySegKey  = new Map();   // hostSegmentKey → wall[]
  const planByNode    = new Map();   // junctionNodeId → wall[]
  const allPlannedWalls = [];
  if (wallReconReport) {
    for (const bucket of ['portalWalls', 'junctionWalls', 'terminalWalls', 'roomPartitionWalls']) {
      const arr = wallReconReport[bucket];
      if (!Array.isArray(arr)) continue;
      for (const w of arr) {
        allPlannedWalls.push({ ...w, _planBucket: bucket });
        if (w.roomId) {
          if (!planByRoom.has(w.roomId)) planByRoom.set(w.roomId, []);
          planByRoom.get(w.roomId).push(w);
        }
        if (w.hostSegmentKey) {
          if (!planBySegKey.has(w.hostSegmentKey)) planBySegKey.set(w.hostSegmentKey, []);
          planBySegKey.get(w.hostSegmentKey).push(w);
        }
        if (w.junctionNodeId) {
          if (!planByNode.has(w.junctionNodeId)) planByNode.set(w.junctionNodeId, []);
          planByNode.get(w.junctionNodeId).push(w);
        }
      }
    }
  }

  // Also index emitted WALL elements (PORTAL_END_WALL is JS-side; the rest
  // come from Python). When a JS-side wall caps a room segment we count it.
  const emittedPortalWalls = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'WALL' &&
    (e.properties || {}).segmentType === 'PORTAL_END_WALL'
  );
  const emittedBySegKey = new Map();
  for (const w of emittedPortalWalls) {
    const props = w.properties || {};
    const seg = props.parentSegment || props.capsSegmentKey || w.metadata?.parentSegment;
    if (!seg) continue;
    if (!emittedBySegKey.has(seg)) emittedBySegKey.set(seg, []);
    emittedBySegKey.get(seg).push(w);
  }

  const rooms = [];
  for (const room of spaceReport.rooms) {
    const branchSegments = room.segmentKeys || [];
    let junctionNode = null;
    let touchesMain = false;
    for (const segKey of branchSegments) {
      const sz = segNodeMap.get(segKey);
      if (!sz) continue;
      for (const nid of [sz.nodeA, sz.nodeB]) {
        if (!nid) continue;
        if (corridorNodes.has(nid)) {
          touchesMain = true;
          if (!junctionNode) junctionNode = nid;
        }
      }
    }

    // A room is closed where it should be closed when:
    //   - the wall-reconstructor planned a closure for it (planByRoom), OR
    //   - a portal-end-wall element caps one of its segments
    // Required closures: at the junction node (if any) and at every
    // terminal-degree-1 endpoint.
    const planned = planByRoom.get(room.roomId) || [];
    const plannedAtJunction = planned.filter(w => w.kind === 'JUNCTION_WALL').length;
    const plannedAtTerminal = planned.filter(w => w.kind === 'TERMINAL_WALL').length;

    let emittedCaps = 0;
    for (const segKey of branchSegments) {
      emittedCaps += (emittedBySegKey.get(segKey) || []).length;
    }

    // Expected closure sides: junctions cap the corridor side, terminals cap
    // the dead-end side. A room needs at least one closure on each required
    // side. Counts can legitimately exceed 1 when a room branches at multiple
    // junctions or has multiple dead-ends, so we don't flag over-closure
    // unless emitted+planned drastically exceeds segment count.
    const requiresJunctionSide = touchesMain;
    const requiresTerminalSide = room.hasTerminal;
    const totalClosures = plannedAtJunction + plannedAtTerminal + emittedCaps;

    rooms.push({
      room_id:                 room.roomId,
      branch_segment_ids:      branchSegments,
      junction_node:           junctionNode,
      branch_touches_main:     touchesMain,
      // Emitted (JS-side) caps — portal end walls already in css.elements.
      wall_closures_emitted:   emittedCaps,
      // Planned closures by the wall-reconstructor (consumed by generate).
      wall_closures_planned:   planned.length,
      planned_at_junction:     plannedAtJunction,
      planned_at_terminal:     plannedAtTerminal,
      requires_junction_side:  requiresJunctionSide,
      requires_terminal_side:  requiresTerminalSide,
      total_closures:          totalClosures,
      closure_complete:
        (!requiresJunctionSide || plannedAtJunction > 0 || emittedCaps > 0) &&
        (!requiresTerminalSide || plannedAtTerminal > 0),
      missing_junction_closure: requiresJunctionSide && plannedAtJunction === 0 && emittedCaps === 0,
      missing_terminal_closure: requiresTerminalSide && plannedAtTerminal === 0,
      area_estimate:           room.areaEstimate,
      total_length:            room.totalLength,
      has_terminal:            room.hasTerminal
    });
  }

  return {
    summary: {
      rooms:                rooms.length,
      not_touching_main:    rooms.filter(r => !r.branch_touches_main).length,
      incomplete_closure:   rooms.filter(r => r.closure_complete === false).length,
      missing_junction:     rooms.filter(r => r.missing_junction_closure).length,
      missing_terminal:     rooms.filter(r => r.missing_terminal_closure).length,
      total_planned_walls:  allPlannedWalls.length
    },
    rooms
  };
}

// ── C. Door semantic correctness ─────────────────────────────────────────────

function analyzeDoorCorrectness(css, doorPlan) {
  const doors = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'DOOR'
  );

  if (!doorPlan || !Array.isArray(doorPlan.candidateAssignments)) {
    return {
      summary: { totalDoors: doors.length },
      reason: 'door_plan_unavailable'
    };
  }

  const planById = new Map(doorPlan.candidateAssignments.map(c => [c.id, c]));
  const expectedByZone = doorPlan.expectedByZone || {};
  const perRoom = doorPlan.perRoom || [];
  const perRoomById = new Map(perRoom.map(r => [r.roomId, r]));

  // Tally accepted per zone/room from the door elements themselves.
  const acceptedByZone = {};
  const acceptedByRoom = {};
  const rows = [];

  for (const d of doors) {
    const id = d.element_key || d.id;
    const meta = d.metadata || {};
    const status = meta.reconciliationStatus || 'unresolved';
    const cand = planById.get(id) || {};
    const zone = cand.assignedZone || 'UNKNOWN';
    const roomId = cand.assignedRoom || null;

    if (status === 'accepted') {
      acceptedByZone[zone] = (acceptedByZone[zone] || 0) + 1;
      if (roomId) acceptedByRoom[roomId] = (acceptedByRoom[roomId] || 0) + 1;
    }

    // Decide should_exist based on plan rules.
    let shouldExist = null;   // null = unknown
    if (zone === 'MAIN_TUNNEL' || zone === 'VERTICAL_SHAFT' || zone === 'UNKNOWN') {
      shouldExist = false;
    } else if (zone === 'PORTAL') {
      // The portal zone gets exactly 2 doors; presence here is allowed unless
      // the plan already accepted ≥ 2 better candidates. Mark unresolved.
      shouldExist = null;
    } else if (roomId) {
      const r = perRoomById.get(roomId);
      if (r) shouldExist = r.expectedCount > 0;
    }

    let action;
    if (status === 'rejected') action = 'remove';
    else if (shouldExist === false) action = 'remove';
    else if (shouldExist === true && status === 'accepted') action = 'keep';
    else if (shouldExist === true) action = 'rehost';
    else action = 'unresolved';

    rows.push({
      door_id:       id,
      room_id:       roomId,
      zone:          zone,
      portal_id:     zone === 'PORTAL' ? (cand.currentIntentHost || null) : null,
      expected_here: shouldExist === null ? 'unknown' : (shouldExist ? 'yes' : 'no'),
      actual_host:   meta.hostWallKey || cand.currentIntentHost || null,
      should_exist:  shouldExist,
      action,
      currentStatus: status,
      hostKind:      cand.hostKind || null
    });
  }

  // Specific flagging requested by the task.
  const flags = [];

  // C1. Left-branch (and any room) doors that should not exist.
  for (const r of rows) {
    if (r.zone === 'ROOM_INTERIOR' && r.should_exist === false && r.currentStatus === 'accepted') {
      flags.push({ kind: 'room_interior_door_unexpected', door_id: r.door_id, zone: r.zone });
    }
    if (r.zone === 'ROOM_TERMINAL' && r.should_exist === false && r.currentStatus === 'accepted') {
      flags.push({ kind: 'terminal_room_door_unexpected', door_id: r.door_id, room_id: r.room_id });
    }
  }

  // C2. Missing portal entrance doors — check expected vs accepted.
  const portalExpected = expectedByZone.PORTAL?.count ?? 0;
  const portalAccepted = acceptedByZone.PORTAL || 0;
  if (portalExpected > 0 && portalAccepted < portalExpected) {
    flags.push({
      kind: 'missing_portal_entrance_doors',
      expected: portalExpected,
      accepted: portalAccepted,
      shortfall: portalExpected - portalAccepted
    });
  }

  // C3. Misplaced room doors — accepted but action='rehost'.
  for (const r of rows) {
    if (r.action === 'rehost') {
      flags.push({ kind: 'misplaced_room_door', door_id: r.door_id, room_id: r.room_id });
    }
  }

  // C4. Per-room mismatch (already captured in doorPlan.deviations but surface here).
  const perRoomMismatch = [];
  for (const r of perRoom) {
    const have = acceptedByRoom[r.roomId] || 0;
    if (have !== r.expectedCount) {
      perRoomMismatch.push({
        room_id:  r.roomId,
        expected: r.expectedCount,
        actual:   have,
        delta:    have - r.expectedCount
      });
    }
  }

  return {
    summary: {
      totalDoors:        doors.length,
      acceptedByZone,
      acceptedByRoom,
      portalExpected,
      portalAccepted,
      flagsCount:        flags.length,
      perRoomMismatch:   perRoomMismatch.length
    },
    doors: rows,
    flags,
    perRoomMismatch
  };
}

// ── D. Ventilation connectivity ──────────────────────────────────────────────

function analyzeVentilationConnectivity(css) {
  const elements = css.elements || [];
  const linear = elements.filter(e => {
    const t = (e.type || '').toUpperCase();
    const st = e.semanticType || '';
    return t === 'DUCT' || t === 'PIPE' ||
           st === 'IfcDuctSegment' || st === 'IfcPipeSegment' ||
           st === 'IfcCableCarrierSegment';
  });

  // Index existing fittings: any DUCT_FITTING / IfcFlowFitting / IfcDuctFitting.
  const fittings = elements.filter(e => {
    const t  = (e.type || '').toUpperCase();
    const st = e.semanticType || '';
    return t === 'DUCT_FITTING' || st === 'IfcFlowFitting' || st === 'IfcDuctFitting' ||
           st === 'IfcPipeFitting';
  });

  const fittingNodeKeys = new Set();
  for (const f of fittings) {
    const fn = (f.properties || {}).fittingNode;
    if (fn) fittingNodeKeys.add(fn);
  }

  // Build node clusters from element entry/exit nodes (when present) or by
  // proximity-bucketing endpoints to a 0.1m grid.
  const useNodeIds = linear.some(e => (e.properties || {}).entry_node ||
                                       (e.properties || {}).exit_node);
  const nodeMap = new Map();   // nodeKey → [{elem, isEntry, point}]
  const nodeXY  = new Map();
  const GRID = 0.1;
  const bucket = (p) =>
    `${Math.round((p.x || 0) / GRID)}_${Math.round((p.y || 0) / GRID)}_${Math.round((p.z || 0) / GRID)}`;

  function getEndpoint(e, isEntry) {
    const pp = e.geometry?.pathPoints;
    if (Array.isArray(pp) && pp.length >= 2) {
      return isEntry ? { ...pp[0] } : { ...pp[pp.length - 1] };
    }
    const o = e.placement?.origin || { x: 0, y: 0, z: 0 };
    const ax = e.placement?.refDirection || e.placement?.axis || { x: 1, y: 0, z: 0 };
    const d = e.geometry?.depth || 0;
    const half = d / 2;
    return isEntry
      ? { x: o.x - ax.x * half, y: o.y - ax.y * half, z: o.z - ax.z * half }
      : { x: o.x + ax.x * half, y: o.y + ax.y * half, z: o.z + ax.z * half };
  }
  function getAxis(e, isEntry) {
    const pp = e.geometry?.pathPoints;
    if (Array.isArray(pp) && pp.length >= 2) {
      const p0 = isEntry ? pp[0] : pp[pp.length - 2];
      const p1 = isEntry ? pp[1] : pp[pp.length - 1];
      const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
      const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (len > 1e-6) return { x: dx / len, y: dy / len, z: dz / len };
    }
    const ref = e.placement?.refDirection || e.placement?.axis;
    if (!ref) return null;
    const len = Math.sqrt(ref.x**2 + ref.y**2 + ref.z**2);
    if (len < 1e-6) return null;
    return { x: ref.x / len, y: ref.y / len, z: ref.z / len };
  }

  for (const e of linear) {
    const props = e.properties || {};
    for (const isEntry of [true, false]) {
      const pt = getEndpoint(e, isEntry);
      let key;
      if (useNodeIds && (props.entry_node || props.exit_node)) {
        key = isEntry ? (props.entry_node || bucket(pt)) : (props.exit_node || bucket(pt));
      } else {
        key = bucket(pt);
      }
      if (!nodeMap.has(key)) nodeMap.set(key, []);
      nodeMap.get(key).push({ elem: e, isEntry, point: pt });
      if (!nodeXY.has(key)) nodeXY.set(key, pt);
    }
  }

  const runs = [];
  let connected = 0, missingElbow = 0, missingTee = 0, floating = 0, wrongClass = 0;

  // Walk every linear element and classify its two endpoints.
  for (const e of linear) {
    const id = e.element_key || e.id;
    const props = e.properties || {};
    for (const isEntry of [true, false]) {
      const pt = getEndpoint(e, isEntry);
      const key = useNodeIds && (props.entry_node || props.exit_node)
        ? (isEntry ? (props.entry_node || bucket(pt)) : (props.exit_node || bucket(pt)))
        : bucket(pt);

      const peers = (nodeMap.get(key) || []).filter(p => p.elem !== e);
      const peerCount = peers.length;
      const myAxis = getAxis(e, isEntry);

      // Compute max bend angle vs peers.
      let maxAngleDeg = 0;
      let oppositeProfileChange = false;
      let myProf = (e.geometry?.profile || {});
      for (const peer of peers) {
        const peerAxis = getAxis(peer.elem, peer.isEntry);
        if (!myAxis || !peerAxis) continue;
        // Reverse peer axis if it points away from junction.
        const dot = -((myAxis.x * peerAxis.x) + (myAxis.y * peerAxis.y) + (myAxis.z * peerAxis.z));
        const clamped = Math.min(1, Math.max(-1, dot));
        const ang = Math.acos(clamped) * (180 / Math.PI);
        if (ang > maxAngleDeg) maxAngleDeg = ang;
        const peerProf = peer.elem.geometry?.profile || {};
        if ((myProf.type || '').toUpperCase() !== (peerProf.type || '').toUpperCase()) {
          oppositeProfileChange = true;
        }
      }

      const hasFitting = fittingNodeKeys.has(key);

      // Status decision.
      let status;
      let missingFittingType = null;
      const endpointGap = peerCount === 0
        ? null
        : Math.min(...peers.map(p => dist3(pt, p.point)));

      if (peerCount === 0) {
        // No peer at this node — this is a run terminal. Whether it's correct
        // depends on whether the terminal is a fan, room/grille, or open air.
        // We can't tell from geometry alone, so classify as 'terminal' (a
        // descriptive label, not an error). Genuine floating runs (peers≥1
        // with a gap) are flagged below.
        status = 'terminal';
      } else if (peerCount >= 2) {
        // Tee or higher
        if (!hasFitting) { status = 'missing_tee'; missingTee++; missingFittingType = 'tee'; }
        else { status = 'connected'; connected++; }
      } else if (endpointGap !== null && endpointGap > DUCT_ENDPOINT_TOL_M) {
        status = 'floating';
        floating++;
      } else if (maxAngleDeg >= DUCT_FITTING_ANGLE_DEG) {
        if (!hasFitting) { status = 'missing_elbow'; missingElbow++; missingFittingType = 'elbow'; }
        else { status = 'connected'; connected++; }
      } else if (oppositeProfileChange) {
        if (!hasFitting) { status = 'missing_elbow'; missingElbow++; missingFittingType = 'reducer'; }
        else { status = 'connected'; connected++; }
      } else {
        status = 'connected';
        connected++;
      }

      // Wrong class detection: linear MEP using EXTRUSION instead of SWEEP.
      const method = (e.geometry?.method || '').toUpperCase();
      if (method === 'EXTRUSION') {
        // Linear MEP elements should be SWEEP after path-author. Flag once per element.
        if (isEntry) { wrongClass++; if (status === 'connected') status = 'wrong_class'; }
      }

      runs.push({
        source_segment:        id,
        target_segment:        peers.length > 0 ? (peers[0].elem.element_key || peers[0].elem.id) : null,
        endpoint_node_key:     key,
        endpoints:             { x: round(pt.x), y: round(pt.y), z: round(pt.z) },
        endpoint_gap:          round(endpointGap),
        angle_at_connection:   round(maxAngleDeg, 2),
        peer_count:            peerCount,
        has_fitting:           hasFitting,
        missing_fitting_type:  missingFittingType,
        status
      });
    }
  }

  // Count terminals separately for the summary.
  const terminals = runs.filter(r => r.status === 'terminal').length;

  return {
    summary: {
      totalLinearElements: linear.length,
      fittingsPresent:     fittings.length,
      connected,
      missingElbow,
      missingTee,
      floating,
      terminals,
      wrongClass
    },
    runs: runs.slice(0, 400)
  };
}

// ── E. Missing equipment ─────────────────────────────────────────────────────

/**
 * Compares expected equipment (read from css.metadata.expectedEquipment, when
 * upstream extraction populates it) against the elements currently in the
 * model. Does NOT hardcode; if the upstream list is absent the report still
 * enumerates what is present so a human reader can spot omissions.
 */
function analyzeMissingEquipment(css) {
  const elements = css.elements || [];
  const equipment = elements.filter(e =>
    (e.type || '').toUpperCase() === 'EQUIPMENT' ||
    (e.semanticType || '').startsWith('IfcFan') ||
    (e.semanticType || '') === 'IfcElectricGenerator' ||
    (e.semanticType || '') === 'IfcUnitaryEquipment' ||
    (e.semanticType || '') === 'IfcAirTerminal'
  );

  // Group existing items by semanticType + name.
  const presentBySemantic = {};
  for (const eq of equipment) {
    const key = eq.semanticType || (eq.type || 'UNKNOWN');
    if (!presentBySemantic[key]) presentBySemantic[key] = [];
    presentBySemantic[key].push({
      id: eq.element_key || eq.id,
      name: eq.name || null,
      origin: eq.placement?.origin
        ? { x: round(eq.placement.origin.x), y: round(eq.placement.origin.y), z: round(eq.placement.origin.z) }
        : null,
      container: eq.container || null,
      fan_type: eq.properties?.fan_type ?? null,
      airflow:  eq.properties?.airflow_cfm ?? eq.properties?.airflow ?? null
    });
  }

  // Expected — upstream-provided list, if any. Otherwise empty.
  const expected = Array.isArray(css.metadata?.expectedEquipment)
    ? css.metadata.expectedEquipment
    : [];

  const reconciliation = expected.map(spec => {
    const matchKey = spec.semanticType || spec.type;
    const candidates = presentBySemantic[matchKey] || [];
    let matched = null;
    if (spec.airflow_cfm != null) {
      matched = candidates.find(c => c.airflow != null &&
                                       Math.abs((c.airflow ?? 0) - spec.airflow_cfm) <= (spec.airflow_cfm * 0.2));
    } else if (spec.fan_type != null) {
      matched = candidates.find(c => c.fan_type === spec.fan_type);
    }
    return {
      expected_item:        spec,
      matched_item:         matched ? matched.id : null,
      status:               matched ? 'found' : 'missing',
      placement_candidate:  matched ? null
        : (spec.nearest_segment_hint || spec.host_segment_id || null)
    };
  });

  return {
    summary: {
      expected_count:    expected.length,
      present_count:     equipment.length,
      missing_count:     reconciliation.filter(r => r.status === 'missing').length,
      expected_source:   expected.length > 0 ? 'upstream_metadata' : 'not_provided'
    },
    expected_vs_present: reconciliation,
    present_by_semantic: presentBySemantic
  };
}

// ── F. Elevation handling ────────────────────────────────────────────────────

function analyzeElevationHandling(css) {
  const portals = (css.metadata?.portals || []).filter(p => p && (p.elevation_msl != null || p.id || p.name));
  const portalEndWalls = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'WALL' &&
    (e.properties || {}).segmentType === 'PORTAL_END_WALL'
  );

  // Helpers — strip prefixes ("portal-end-wall-", "ventsim_") + lowercase
  // before name matching. Multiple normalised aliases are stored per wall so
  // a portal record's name can match any of them.
  function stripPrefix(s) {
    if (!s) return '';
    let t = String(s).toLowerCase().trim();
    t = t.replace(/^portal-end-wall-/i, '');
    t = t.replace(/^ventsim_/i, '');
    return t;
  }
  function normalisedAliases(wall) {
    const out = new Set();
    const candidates = [
      wall.metadata?.portalName,
      wall.properties?.portalName,
      wall.name,
      wall.element_key,
      wall.id
    ].filter(Boolean);
    for (const c of candidates) {
      const lower = String(c).toLowerCase().trim();
      out.add(lower);
      out.add(stripPrefix(lower));
    }
    return out;
  }

  const wallByAlias  = new Map();
  const wallByExpZ   = new Map();   // wall keyed by metadata.expectedFloorZ
  for (const w of portalEndWalls) {
    for (const alias of normalisedAliases(w)) {
      if (alias) wallByAlias.set(alias, w);
    }
    const expZ = w.metadata?.expectedFloorZ;
    if (expZ != null) wallByExpZ.set(Number(expZ).toFixed(3), w);
  }

  // Compute expected vs actual floor_z per portal record.
  const validElev = portals.filter(p => p.elevation_msl != null).map(p => p.elevation_msl);
  const minElev = validElev.length > 0 ? Math.min(...validElev) : null;

  const rows = portals.map(p => {
    const expectedZ = (p.elevation_msl != null && minElev != null)
      ? p.elevation_msl - minElev
      : null;

    // Match strategy:
    //  1. Direct portalName annotation written by applyPortalElevations
    //  2. Wall alias (raw name, prefix-stripped name) matches portal.name
    //  3. Wall whose metadata.expectedFloorZ equals expectedZ (Phase 6C link)
    //  4. Spatial fallback: nearest portal_end_wall in XY to the portal anchor
    let wall = null;
    let matchKind = 'none';

    if (p.name) {
      const nameLower = String(p.name).toLowerCase().trim();
      wall = wallByAlias.get(nameLower) || wallByAlias.get(stripPrefix(nameLower)) || null;
      if (wall) matchKind = 'name';
    }
    if (!wall && expectedZ != null) {
      wall = wallByExpZ.get(expectedZ.toFixed(3)) || null;
      if (wall) matchKind = 'expected_floor_z';
    }
    if (!wall && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      let best = null, bestD = Infinity;
      for (const w of portalEndWalls) {
        const o = w.placement?.origin;
        if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) continue;
        const dx = (o.x || 0) - (p.x || 0);
        const dy = (o.y || 0) - (p.y || 0);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = w; }
      }
      if (best) { wall = best; matchKind = 'nearest_node'; }
    }

    const actualZ = wall?.placement?.origin?.z ?? null;
    const delta = (expectedZ != null && actualZ != null) ? actualZ - expectedZ : null;
    const needsRamp = delta != null && Math.abs(delta) > PORTAL_ELEV_DELTA_M;
    return {
      portal_id:       p.id || p.name || null,
      name:            p.name || null,
      expected_floor_z: round(expectedZ),
      actual_floor_z:   round(actualZ),
      delta_z:          round(delta),
      needs_ramp:       needsRamp,
      elevation_msl:    p.elevation_msl ?? null,
      matched_wall:     wall ? (wall.element_key || wall.id) : null,
      match_kind:       matchKind
    };
  });

  // Also surface raw element-level Z spread of all portal walls — useful even
  // when metadata.portals is absent.
  const wallZ = portalEndWalls
    .map(w => w.placement?.origin?.z)
    .filter(z => Number.isFinite(z));
  const wallZSpread = wallZ.length >= 2
    ? round(Math.max(...wallZ) - Math.min(...wallZ))
    : null;

  return {
    summary: {
      portals_with_elevation: portals.filter(p => p.elevation_msl != null).length,
      portals_total:          portals.length,
      portal_walls_emitted:   portalEndWalls.length,
      portal_wall_z_spread:   wallZSpread,
      mismatches:             rows.filter(r => r.needs_ramp).length
    },
    portals: rows
  };
}

// ── public entry point ───────────────────────────────────────────────────────

export function buildConnectivityGapReport(css, spaceReport, doorPlan, wallReconReport) {
  const generatedAt = new Date().toISOString();
  const report = {
    reporter:    REPORT_VERSION,
    generatedAt,
    domain:      (css.domain || 'UNKNOWN').toUpperCase(),
    elementCount: (css.elements || []).length,

    A_shellConnectivity:    analyzeShellConnectivity(css, spaceReport),
    B_branchConnectivity:   analyzeBranchConnectivity(css, spaceReport, wallReconReport),
    C_doorCorrectness:      analyzeDoorCorrectness(css, doorPlan),
    D_ventilation:          analyzeVentilationConnectivity(css),
    E_equipment:            analyzeMissingEquipment(css),
    F_elevation:            analyzeElevationHandling(css)
  };

  // Top-level findings count (summary signal for fix orchestration).
  report.findings = {
    shell_gaps:                (report.A_shellConnectivity.summary.gap || 0) +
                                (report.A_shellConnectivity.summary.elevation_mismatch || 0) +
                                (report.A_shellConnectivity.summary.misaligned || 0),
    shell_overlaps:            report.A_shellConnectivity.summary.overlap || 0,
    rooms_disconnected:        report.B_branchConnectivity.summary?.not_touching_main || 0,
    rooms_incomplete_closure:  report.B_branchConnectivity.summary?.incomplete_closure || 0,
    door_flags:                (report.C_doorCorrectness.flags || []).length,
    ventilation_missing_fittings:
      (report.D_ventilation.summary.missingElbow || 0) +
      (report.D_ventilation.summary.missingTee || 0),
    ventilation_floating:      report.D_ventilation.summary.floating || 0,
    ventilation_wrong_class:   report.D_ventilation.summary.wrongClass || 0,
    equipment_missing:         report.E_equipment.summary.missing_count || 0,
    portal_elevation_mismatch: report.F_elevation.summary.mismatches || 0
  };

  return report;
}

export default { buildConnectivityGapReport };
