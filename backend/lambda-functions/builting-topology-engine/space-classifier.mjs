/**
 * Phase 6A.5 — Space Classification (planning-only)  v2
 *
 * Sits between topology and intent. Classifies tunnel segments and nodes into
 * functional zones, derives rooms, applies architectural door rules, and emits
 * a semantic door plan. Does NOT mutate elements; the resolver and emitter are
 * unchanged.
 *
 * v2 fixes:
 *   - tolerance-based node clustering (union-find on endpoint XY) instead of
 *     coordinate-rounding keys, which silently split adjacent endpoints into
 *     different node buckets when they straddled a 0.5 m snap boundary.
 *   - portal → nearest node via spatial search (not via key equality).
 *   - BFS path between portal-snap nodes is the MAIN_TUNNEL backbone.
 *   - rooms are connected components of segments AFTER excluding MAIN_TUNNEL,
 *     PORTAL, and VERTICAL_SHAFT — so each branch becomes its own room.
 *   - rich diagnostics: portal nearest segment + node, BFS start/end,
 *     adjacency degree per segment, corridor segment ids, room components.
 *
 * Zones:
 *   MAIN_TUNNEL    — segments on the BFS shortest path between the two portal
 *                    ends (the primary corridor)
 *   PORTAL         — segment whose endpoint node is the portal-snap node
 *   ROOM_TERMINAL  — off-corridor segment with at least one degree-1 endpoint
 *   ROOM_INTERIOR  — off-corridor segment, no degree-1 endpoint
 *   VERTICAL_SHAFT — segment whose axis is mostly vertical
 *
 * Door rules:
 *   PORTAL         → exactly 2 double doors (one per portal)
 *   per ROOM       → 1 single (or 2 if room ≥ 30 m² → "large")
 *   MAIN_TUNNEL    → 0
 *   ROOM_INTERIOR  → 0 (per-zone)
 *   VERTICAL_SHAFT → 0
 */

const CLASSIFIER_VERSION = 'space-classifier/v2';

const NODE_CLUSTER_TOLERANCE_M    = 1.0;   // endpoints within this XY distance share a node
const PORTAL_TO_NODE_MAX_M        = 12.0;  // portal must be within this of a node to snap
const BRIDGE_DISTANCE_M           = 10.0;  // disconnected component → main component if nearest node-pair within this
const VERTICAL_AXIS_DOT_THRESHOLD = 0.85;  // |dot(axis, +Z)| above this → VERTICAL_SHAFT
const LARGE_ROOM_AREA_M2          = 30.0;  // rooms ≥ this expect 2 doors

// ── helpers ──────────────────────────────────────────────────────────────────

function dist(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function getSegEndpoints(seg) {
  const p = seg.properties || {};
  const s = p.startPoint || {};
  const e = p.endPoint   || {};
  const sx = Number(s.x), sy = Number(s.y), sz = Number(s.z);
  const ex = Number(e.x), ey = Number(e.y), ez = Number(e.z);
  if (![sx, sy, ex, ey].every(Number.isFinite)) return null;
  return {
    s: { x: sx, y: sy, z: Number.isFinite(sz) ? sz : 0 },
    e: { x: ex, y: ey, z: Number.isFinite(ez) ? ez : 0 }
  };
}

function segLength3D(ep) {
  const dx = ep.e.x - ep.s.x, dy = ep.e.y - ep.s.y, dz = ep.e.z - ep.s.z;
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

function isSegmentVertical(ep) {
  const len = segLength3D(ep);
  if (len <= 1e-6) return false;
  const dz = (ep.e.z - ep.s.z) / len;
  return Math.abs(dz) >= VERTICAL_AXIS_DOT_THRESHOLD;
}

// ── portal pair detection ────────────────────────────────────────────────────

function findMainPortalPair(elements) {
  const portals = elements
    .filter(e =>
      (e.type || '').toUpperCase() === 'WALL' &&
      (e.properties || {}).segmentType === 'PORTAL_END_WALL'
    )
    .map(e => {
      const o = (e.placement || {}).origin || {};
      const x = Number(o.x), y = Number(o.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { element: e, id: e.element_key || e.id, x, y };
    })
    .filter(p => p !== null);

  if (portals.length < 2) return { pair: null, allPortals: portals };

  let bestDist = -1, pA = null, pB = null;
  for (let i = 0; i < portals.length; i++) {
    for (let j = i + 1; j < portals.length; j++) {
      const d = dist(portals[i].x, portals[i].y, portals[j].x, portals[j].y);
      if (d > bestDist) { bestDist = d; pA = portals[i]; pB = portals[j]; }
    }
  }
  return { pair: [pA, pB], allPortals: portals, separation: bestDist };
}

// ── node clustering: union-find on endpoint XY with tolerance ────────────────

function buildNodeGraph(segmentEntries, tolerance) {
  // 1. Collect all endpoints
  const endpoints = [];  // {x, y, segKey, end}
  for (const { key, ep } of segmentEntries) {
    endpoints.push({ x: ep.s.x, y: ep.s.y, segKey: key, end: 'start' });
    endpoints.push({ x: ep.e.x, y: ep.e.y, segKey: key, end: 'end'   });
  }

  // 2. Union-find by spatial tolerance (O(n²); n is small for tunnel renders)
  const parent = endpoints.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const tol2 = tolerance * tolerance;
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const dx = endpoints[i].x - endpoints[j].x;
      const dy = endpoints[i].y - endpoints[j].y;
      if (dx*dx + dy*dy <= tol2) union(i, j);
    }
  }

  // 3. Assign stable node ids per cluster root
  const rootToId = new Map();
  let nextId = 0;
  const endpointNode = new Array(endpoints.length);
  for (let i = 0; i < endpoints.length; i++) {
    const r = find(i);
    if (!rootToId.has(r)) rootToId.set(r, `n${String(nextId++).padStart(3, '0')}`);
    endpointNode[i] = rootToId.get(r);
  }

  // 4. Per-segment node assignment (nodeA = start, nodeB = end)
  const segNodes = new Map();
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const nid = endpointNode[i];
    if (!segNodes.has(ep.segKey)) segNodes.set(ep.segKey, { nodeA: null, nodeB: null });
    if (ep.end === 'start') segNodes.get(ep.segKey).nodeA = nid;
    else                    segNodes.get(ep.segKey).nodeB = nid;
  }

  // 5. Per-node: list of incident segments + centroid XY
  const nodeSegs = new Map();   // nid → Set<segKey>
  const nodeXYAcc = new Map();  // nid → { sumX, sumY, n }
  for (let i = 0; i < endpoints.length; i++) {
    const nid = endpointNode[i];
    if (!nodeSegs.has(nid)) nodeSegs.set(nid, new Set());
    nodeSegs.get(nid).add(endpoints[i].segKey);
    if (!nodeXYAcc.has(nid)) nodeXYAcc.set(nid, { sumX: 0, sumY: 0, n: 0 });
    const acc = nodeXYAcc.get(nid);
    acc.sumX += endpoints[i].x; acc.sumY += endpoints[i].y; acc.n += 1;
  }
  const nodeXY = new Map();
  for (const [nid, acc] of nodeXYAcc) {
    nodeXY.set(nid, { x: acc.sumX / acc.n, y: acc.sumY / acc.n });
  }

  return { segNodes, nodeSegs, nodeXY };
}

// ── connected components (used by healing pass + diagnostics) ───────────────

function findConnectedComponents(segNodes, nodeSegs) {
  const visited = new Set();
  const comps = [];
  for (const nid of nodeSegs.keys()) {
    if (visited.has(nid)) continue;
    const comp = new Set();
    const stack = [nid];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (visited.has(cur)) continue;
      visited.add(cur); comp.add(cur);
      for (const sk of (nodeSegs.get(cur) || [])) {
        const nodes = segNodes.get(sk);
        if (!nodes) continue;
        const other = nodes.nodeA === cur ? nodes.nodeB : nodes.nodeA;
        if (other && !visited.has(other)) stack.push(other);
      }
    }
    comps.push(comp);
  }
  return comps;
}

// Merge `fromId` into `toId` in-place: rewrite all references and unify segs.
function mergeNodeIds(fromId, toId, segNodes, nodeSegs, nodeXY) {
  if (fromId === toId) return;
  for (const [, n] of segNodes) {
    if (n.nodeA === fromId) n.nodeA = toId;
    if (n.nodeB === fromId) n.nodeB = toId;
  }
  const fromSegs = nodeSegs.get(fromId) || new Set();
  const toSegs   = nodeSegs.get(toId)   || new Set();
  for (const sk of fromSegs) toSegs.add(sk);
  nodeSegs.set(toId, toSegs);
  nodeSegs.delete(fromId);
  nodeXY.delete(fromId);
}

// Bridge disconnected components to the main component when the nearest
// cross-component node-pair lies within `bridgeDist`. Returns a list of
// {fromComp, mergedFromNode, mergedToNode, distance} for diagnostics.
function healDisconnectedComponents(segNodes, nodeSegs, nodeXY, bridgeDist) {
  const merges = [];
  // Loop until no more merges are possible (in case bridging cascades)
  while (true) {
    const comps = findConnectedComponents(segNodes, nodeSegs);
    if (comps.length <= 1) break;
    // Sort by size desc; main component is the largest
    comps.sort((a, b) => b.size - a.size);
    const main = comps[0];
    let merged = false;
    for (let i = 1; i < comps.length; i++) {
      const stub = comps[i];
      let bestPair = null, bestD = Infinity;
      for (const sNid of stub) {
        const sxy = nodeXY.get(sNid);
        if (!sxy) continue;
        for (const mNid of main) {
          const mxy = nodeXY.get(mNid);
          if (!mxy) continue;
          const d = dist(sxy.x, sxy.y, mxy.x, mxy.y);
          if (d < bestD) { bestD = d; bestPair = { stubNid: sNid, mainNid: mNid, distance: d }; }
        }
      }
      if (bestPair && bestPair.distance <= bridgeDist) {
        mergeNodeIds(bestPair.stubNid, bestPair.mainNid, segNodes, nodeSegs, nodeXY);
        merges.push({
          mergedFromNode: bestPair.stubNid,
          mergedToNode:   bestPair.mainNid,
          distance:       Number(bestPair.distance.toFixed(3)),
          stubSize:       stub.size
        });
        merged = true;
        break;  // restart component scan
      }
    }
    if (!merged) break;
  }
  return merges;
}

// ── snap a portal XY to its nearest node ─────────────────────────────────────

function snapPortalToNode(portal, nodeXY, maxDist) {
  let bestD = Infinity, bestN = null;
  for (const [nid, xy] of nodeXY) {
    const d = dist(portal.x, portal.y, xy.x, xy.y);
    if (d < bestD) { bestD = d; bestN = nid; }
  }
  return { nodeId: bestN, distance: bestD, withinMax: bestD <= maxDist };
}

// ── nearest segment endpoint to a portal (for diagnostics) ───────────────────

function nearestSegmentToPortal(portal, segmentEntries) {
  let bestD = Infinity, bestSeg = null, bestEnd = null;
  for (const { key, ep } of segmentEntries) {
    for (const which of ['s', 'e']) {
      const pt = ep[which];
      const d = dist(portal.x, portal.y, pt.x, pt.y);
      if (d < bestD) { bestD = d; bestSeg = key; bestEnd = which === 's' ? 'start' : 'end'; }
    }
  }
  return { segKey: bestSeg, end: bestEnd, distance: bestD };
}

// ── BFS shortest path on node graph ──────────────────────────────────────────

function bfsCorridor(segNodes, nodeSegs, startNode, goalNode) {
  if (!startNode || !goalNode) {
    return { found: false, segmentKeys: [], nodePath: [] };
  }
  if (startNode === goalNode) {
    return { found: true, segmentKeys: [], nodePath: [startNode], degenerate: true };
  }
  const queue = [startNode];
  const cameFrom = new Map([[startNode, null]]);
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === goalNode) break;
    for (const segKey of (nodeSegs.get(cur) || [])) {
      const nodes = segNodes.get(segKey);
      if (!nodes) continue;
      const other = nodes.nodeA === cur ? nodes.nodeB : nodes.nodeA;
      if (other == null || cameFrom.has(other)) continue;
      cameFrom.set(other, { fromNode: cur, segKey });
      queue.push(other);
    }
  }
  if (!cameFrom.has(goalNode)) {
    return { found: false, segmentKeys: [], nodePath: [], reachedNodes: cameFrom.size };
  }
  const segmentKeys = [];
  const nodePath = [goalNode];
  let cur = goalNode;
  while (cameFrom.get(cur) !== null) {
    const step = cameFrom.get(cur);
    segmentKeys.push(step.segKey);
    nodePath.push(step.fromNode);
    cur = step.fromNode;
  }
  return { found: true, segmentKeys, nodePath: nodePath.reverse() };
}

// ── room derivation: connected components excluding corridor + portal ────────

function deriveRooms(segmentEntries, segZone, segNodes) {
  const roomEligibleZones = new Set(['ROOM_TERMINAL', 'ROOM_INTERIOR']);
  const eligible = new Set();
  for (const { key } of segmentEntries) {
    if (roomEligibleZones.has(segZone.get(key))) eligible.add(key);
  }

  // Build adjacency using node ids (only eligible-to-eligible)
  const nodeToEligibleSegs = new Map();
  for (const segKey of eligible) {
    const nodes = segNodes.get(segKey) || {};
    for (const nid of [nodes.nodeA, nodes.nodeB]) {
      if (!nid) continue;
      if (!nodeToEligibleSegs.has(nid)) nodeToEligibleSegs.set(nid, new Set());
      nodeToEligibleSegs.get(nid).add(segKey);
    }
  }
  const adj = new Map();
  for (const segs of nodeToEligibleSegs.values()) {
    const arr = [...segs];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (!adj.has(arr[i])) adj.set(arr[i], new Set());
        if (!adj.has(arr[j])) adj.set(arr[j], new Set());
        adj.get(arr[i]).add(arr[j]);
        adj.get(arr[j]).add(arr[i]);
      }
    }
  }

  const roomOf = new Map();
  let nextRoomId = 1;
  for (const seed of eligible) {
    if (roomOf.has(seed)) continue;
    const roomId = `room-${String(nextRoomId++).padStart(2, '0')}`;
    const stack = [seed];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (roomOf.has(cur)) continue;
      roomOf.set(cur, roomId);
      for (const nb of (adj.get(cur) || [])) {
        if (eligible.has(nb) && !roomOf.has(nb)) stack.push(nb);
      }
    }
  }

  const rooms = new Map();
  for (const [segKey, roomId] of roomOf) {
    if (!rooms.has(roomId)) rooms.set(roomId, { roomId, segmentKeys: [], hasTerminal: false });
    rooms.get(roomId).segmentKeys.push(segKey);
  }
  for (const [segKey, roomId] of roomOf) {
    if (segZone.get(segKey) === 'ROOM_TERMINAL') rooms.get(roomId).hasTerminal = true;
  }
  return { roomOf, rooms };
}

// ── public entry point ───────────────────────────────────────────────────────

export function classifySpacesAndPlanDoors(css) {
  const elements = (css && css.elements) || [];

  // 1. Build segment list
  const segmentEntries = [];
  for (const e of elements) {
    if ((e.type || '').toUpperCase() !== 'TUNNEL_SEGMENT') continue;
    const ep = getSegEndpoints(e);
    if (!ep) continue;
    segmentEntries.push({
      key: e.element_key || e.id,
      element: e,
      ep,
      length: segLength3D(ep),
      vertical: isSegmentVertical(ep)
    });
  }

  // 2. Build node graph with tolerance-based clustering
  const { segNodes, nodeSegs, nodeXY } = buildNodeGraph(segmentEntries, NODE_CLUSTER_TOLERANCE_M);

  // 2A. Snapshot pre-heal connected components for diagnostics
  const compsBefore = findConnectedComponents(segNodes, nodeSegs).map(s => [...s]);

  // 2B. Heal disconnected components: bridge stubs to the main component when
  // the nearest cross-component node pair is within BRIDGE_DISTANCE_M. This is
  // a planning concession for upstream topology gaps; structural lambda still
  // owns true endpoint coincidence.
  const componentMerges = healDisconnectedComponents(
    segNodes, nodeSegs, nodeXY, BRIDGE_DISTANCE_M);
  const compsAfter = findConnectedComponents(segNodes, nodeSegs).map(s => [...s]);

  // 3. Portal pair + snap each portal to nearest node + nearest segment endpoint
  const portalSearch = findMainPortalPair(elements);
  const mainPortalPair = portalSearch.pair;
  let portalDiag = null;
  let corridorBFS = { found: false, startNodeId: null, goalNodeId: null,
                      pathSegmentKeys: [], pathLengthNodes: 0 };
  let corridorSet = new Set();
  if (mainPortalPair) {
    const [pA, pB] = mainPortalPair;
    const snapA = snapPortalToNode(pA, nodeXY, PORTAL_TO_NODE_MAX_M);
    const snapB = snapPortalToNode(pB, nodeXY, PORTAL_TO_NODE_MAX_M);
    const nearestSegA = nearestSegmentToPortal(pA, segmentEntries);
    const nearestSegB = nearestSegmentToPortal(pB, segmentEntries);
    portalDiag = [
      { id: pA.id, x: pA.x, y: pA.y,
        nearestSegmentKey: nearestSegA.segKey, nearestSegmentEnd: nearestSegA.end,
        nearestSegmentDist: Number(nearestSegA.distance.toFixed(3)),
        nearestNodeId: snapA.nodeId,
        nearestNodeDist: Number(snapA.distance.toFixed(3)),
        snapWithinMax: snapA.withinMax },
      { id: pB.id, x: pB.x, y: pB.y,
        nearestSegmentKey: nearestSegB.segKey, nearestSegmentEnd: nearestSegB.end,
        nearestSegmentDist: Number(nearestSegB.distance.toFixed(3)),
        nearestNodeId: snapB.nodeId,
        nearestNodeDist: Number(snapB.distance.toFixed(3)),
        snapWithinMax: snapB.withinMax }
    ];

    if (snapA.withinMax && snapB.withinMax) {
      const bfs = bfsCorridor(segNodes, nodeSegs, snapA.nodeId, snapB.nodeId);
      corridorBFS = {
        startNodeId:        snapA.nodeId,
        goalNodeId:         snapB.nodeId,
        startNearestSegKey: nearestSegA.segKey,
        goalNearestSegKey:  nearestSegB.segKey,
        found:              bfs.found,
        pathSegmentKeys:    bfs.segmentKeys,
        pathLengthNodes:    bfs.nodePath ? bfs.nodePath.length : 0,
        nodePath:           bfs.nodePath,
        reachedNodes:       bfs.reachedNodes
      };
      if (bfs.found) corridorSet = new Set(bfs.segmentKeys);
    } else {
      corridorBFS.failureReason = 'portal_node_snap_exceeds_max';
    }
  }

  // 4. Per-segment zone classification
  const segZone = new Map();
  const portalNodeIds = new Set();
  if (portalDiag) {
    for (const p of portalDiag) if (p.snapWithinMax && p.nearestNodeId) portalNodeIds.add(p.nearestNodeId);
  }
  for (const { key, vertical } of segmentEntries) {
    if (vertical) { segZone.set(key, 'VERTICAL_SHAFT'); continue; }

    if (corridorSet.has(key)) { segZone.set(key, 'MAIN_TUNNEL'); continue; }

    // PORTAL: segment touches a portal-snap node
    const nodes = segNodes.get(key) || {};
    if (portalNodeIds.has(nodes.nodeA) || portalNodeIds.has(nodes.nodeB)) {
      segZone.set(key, 'PORTAL'); continue;
    }

    // Off-corridor: terminal vs interior depends on whether segment has a deg-1 endpoint
    const degA = (nodeSegs.get(nodes.nodeA) || new Set()).size;
    const degB = (nodeSegs.get(nodes.nodeB) || new Set()).size;
    const hasFreeEnd = degA <= 1 || degB <= 1;
    segZone.set(key, hasFreeEnd ? 'ROOM_TERMINAL' : 'ROOM_INTERIOR');
  }

  // 5. Junction nodes: degree ≥ 3
  const junctionNodes = [];
  for (const [nid, segs] of nodeSegs) {
    if (segs.size >= 3) {
      const xy = nodeXY.get(nid);
      junctionNodes.push({ nodeId: nid, x: xy.x, y: xy.y, degree: segs.size, segments: [...segs] });
    }
  }

  // 6. Rooms — connected components of off-corridor non-portal segments
  const { roomOf, rooms } = deriveRooms(segmentEntries, segZone, segNodes);

  // 7. Per-room geometry
  const segMeta = new Map();
  for (const { key, length, element } of segmentEntries) segMeta.set(key, { length, element });
  for (const room of rooms.values()) {
    let totalLen = 0, totalArea = 0;
    for (const segKey of room.segmentKeys) {
      const m = segMeta.get(segKey);
      if (!m) continue;
      totalLen += m.length;
      const props = m.element.properties || {};
      const innerW = Number(props.innerWidth) || Number(props.bore_width) || 4.0;
      totalArea += m.length * innerW;
    }
    room.totalLength  = Number(totalLen.toFixed(2));
    room.areaEstimate = Number(totalArea.toFixed(2));
    room.isLarge      = totalArea >= LARGE_ROOM_AREA_M2;
  }

  // 8. Vertical-shaft elements (CSS-level VERTICAL_SHAFT, separate from segment axis test)
  const shaftElements = [];
  for (const e of elements) {
    const segType = (e.properties || {}).segmentType;
    if (segType === 'VERTICAL_SHAFT' || (e.type || '').toUpperCase() === 'VERTICAL_SHAFT') {
      shaftElements.push({ id: e.element_key || e.id, segmentType: segType, type: e.type });
    }
  }

  // 9. Door candidates → assign zone + room (READ ONLY — do not mutate elements)
  const doorElements = elements.filter(e => (e.type || '').toUpperCase() === 'DOOR');
  const acceptedIds = new Set();
  const rejectedIds = new Set();
  for (const d of doorElements) {
    const id = d.element_key || d.id;
    const status = (d.metadata || {}).reconciliationStatus;
    if (status === 'accepted') acceptedIds.add(id);
    else if (status === 'rejected') rejectedIds.add(id);
  }

  // Index PORTAL_END_WALL elements (id → xy origin) and the main portal subset.
  // PORTAL_END_WALL caps exist at every terminal/dead-end in the network, so
  // being one is NOT enough to be a "main entrance" — only the 2 from
  // mainPortalPair are real entrances. Other portal-end-walls cap interior
  // dead-ends and a door hosted on them belongs to that branch's room.
  // We also keep their xy so we can fall back to a nearest-segment lookup
  // when the wall references a segKey that no longer exists in css_processed.
  const portalEndWallById = new Map();  // id → { x, y }
  for (const e of elements) {
    if ((e.type || '').toUpperCase() === 'WALL' &&
        (e.properties || {}).segmentType === 'PORTAL_END_WALL') {
      const id = e.element_key || e.id;
      const o  = (e.placement || {}).origin || {};
      const x = Number(o.x), y = Number(o.y);
      portalEndWallById.set(id, {
        x: Number.isFinite(x) ? x : null,
        y: Number.isFinite(y) ? y : null
      });
    }
  }
  const mainPortalEndWallIds = new Set();
  if (mainPortalPair) {
    for (const p of mainPortalPair) mainPortalEndWallIds.add(p.id);
  }

  // Parse 'portal-end-wall-{segKey}-{start|end}' → segKey, used to resolve a
  // non-main PORTAL_END_WALL host back to the segment it caps.
  function parsePortalEndWallSegment(id) {
    if (typeof id !== 'string' || !id.startsWith('portal-end-wall-')) return null;
    const rest = id.slice('portal-end-wall-'.length);
    if (rest.endsWith('-start')) return rest.slice(0, -'-start'.length);
    if (rest.endsWith('-end'))   return rest.slice(0, -'-end'.length);
    return null;
  }

  function nearestSegKeyTo(o) {
    if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
    let bestD = Infinity, bestK = null;
    for (const { key, ep } of segmentEntries) {
      for (const pt of [ep.s, ep.e]) {
        const d = dist(o.x, o.y, pt.x, pt.y);
        if (d < bestD) { bestD = d; bestK = key; }
      }
    }
    return bestK;
  }

  const candidateAssignments = doorElements.map(d => {
    const id     = d.element_key || d.id;
    const intent = (d.metadata || {}).intent || {};
    const status = (d.metadata || {}).reconciliationStatus || null;
    const evZone = (d.metadata || {}).evidenceZone || null;
    const origin = (d.placement || {}).origin || {};
    const intentHost = intent.hostSegmentId || null;
    // Host classification priority:
    //   1. main PORTAL_END_WALL host → PORTAL zone (real entrance)
    //   2. non-main PORTAL_END_WALL host → resolve to capped segment's zone
    //   3. TUNNEL_SEGMENT host → that segment's zone
    //   4. evidenceZone === PORTAL → PORTAL (reconciler hint, no intent host)
    //   5. nearest TUNNEL_SEGMENT to origin → that segment's zone
    let hostZone   = null;
    let hostSegKey = null;     // for room lookup when host resolves to a segment
    let hostKind   = 'none';   // diagnostic: how the host was resolved
    if (intentHost && mainPortalEndWallIds.has(intentHost)) {
      hostZone = 'PORTAL'; hostKind = 'main_portal_end_wall';
    } else if (intentHost && portalEndWallById.has(intentHost)) {
      // Try parsing the wall id back to its capped segment first
      const cappedSeg = parsePortalEndWallSegment(intentHost);
      if (cappedSeg && segZone.has(cappedSeg)) {
        hostZone = segZone.get(cappedSeg);
        hostSegKey = cappedSeg;
        hostKind = 'non_main_portal_end_wall_resolved_to_segment';
      } else {
        // The capped segment isn't in css_processed (data inconsistency —
        // generated wall references a stripped segment). Fall back to the
        // wall's own xy origin → nearest tunnel segment.
        const wxy = portalEndWallById.get(intentHost);
        if (wxy && wxy.x != null && wxy.y != null) {
          const ns = nearestSegKeyTo(wxy);
          if (ns && segZone.has(ns)) {
            hostZone = segZone.get(ns);
            hostSegKey = ns;
            hostKind = 'non_main_portal_end_wall_resolved_by_origin';
          } else {
            hostKind = 'non_main_portal_end_wall_unresolved';
          }
        } else {
          hostKind = 'non_main_portal_end_wall_unresolved';
        }
      }
    } else if (intentHost && segZone.has(intentHost)) {
      hostZone = segZone.get(intentHost);
      hostSegKey = intentHost;
      hostKind = 'tunnel_segment';
    } else if (intentHost) {
      hostKind = 'unknown_host_id';
    }
    const fallbackSeg  = hostZone ? null : nearestSegKeyTo(origin);
    const fallbackZone = fallbackSeg ? (segZone.get(fallbackSeg) || null) : null;
    const zone = hostZone || fallbackZone || (evZone === 'PORTAL' ? 'PORTAL' : null) || 'UNKNOWN';
    const roomLookupSeg = hostSegKey || fallbackSeg;
    const roomId = (zone !== 'PORTAL' && roomLookupSeg && roomOf.get(roomLookupSeg)) || null;
    return {
      id,
      currentStatus: status,
      currentEvidenceZone: evZone,
      currentIntentHost: intentHost,
      currentIntentDoorType: intent.doorType || null,
      hostKind,
      hostSegKey,
      assignedZone: zone,
      assignedRoom: roomId,
      origin: { x: origin.x, y: origin.y, z: origin.z }
    };
  });

  // 10. Per-zone rules. PORTAL is the only zone with a global quota; room
  //     zones (ROOM_TERMINAL, ROOM_INTERIOR) are spatial labels, not quota
  //     buckets — door counts inside rooms are evaluated through perRoom[]
  //     only. MAIN_TUNNEL / VERTICAL_SHAFT / UNKNOWN keep the hard zero
  //     because no architectural rule places doors there.
  const portalZoneCount = mainPortalPair ? 2 : 0;
  const expectedByZone = {
    PORTAL:        { count: portalZoneCount, type: 'double', reason: '2 double doors — one per main portal entrance' },
    MAIN_TUNNEL:   { count: 0,               type: null,     reason: 'no doors along the main corridor' },
    ROOM_TERMINAL: { count: null,            type: 'single', reason: 'count is per-room, not per-zone — see perRoom[]' },
    ROOM_INTERIOR: { count: null,            type: null,     reason: 'count is per-room, not per-zone — see perRoom[]' },
    VERTICAL_SHAFT:{ count: 0,               type: null,     reason: 'no doors on vertical shafts' },
    UNKNOWN:       { count: 0,               type: null,     reason: 'unclassified — likely outside tunnel network' }
  };

  // Per-room rules (every derived room)
  const perRoomRules = [...rooms.values()].map(r => ({
    roomId:        r.roomId,
    segmentKeys:   r.segmentKeys,
    hasTerminal:   r.hasTerminal,
    totalLength:   r.totalLength,
    areaEstimate:  r.areaEstimate,
    isLarge:       r.isLarge,
    expectedCount: r.hasTerminal ? (r.isLarge ? 2 : 1) : 0,
    expectedType:  r.hasTerminal ? 'single' : null,
    reason: r.hasTerminal
      ? (r.isLarge ? 'large terminal room → 2 single doors' : 'terminal room → 1 single door')
      : 'no terminal endpoint → no door'
  }));

  // 11. Group candidates by zone/room
  const byZone = {};
  for (const z of Object.keys(expectedByZone)) byZone[z] = { candidateIds: [], acceptedIds: [], rejectedIds: [] };
  for (const c of candidateAssignments) {
    const bucket = byZone[c.assignedZone] || (byZone[c.assignedZone] = { candidateIds: [], acceptedIds: [], rejectedIds: [] });
    bucket.candidateIds.push(c.id);
    if (c.currentStatus === 'accepted') bucket.acceptedIds.push(c.id);
    else if (c.currentStatus === 'rejected') bucket.rejectedIds.push(c.id);
  }
  const byRoom = {};
  for (const r of perRoomRules) byRoom[r.roomId] = { candidateIds: [], acceptedIds: [], rejectedIds: [] };
  for (const c of candidateAssignments) {
    if (!c.assignedRoom) continue;
    if (!byRoom[c.assignedRoom]) byRoom[c.assignedRoom] = { candidateIds: [], acceptedIds: [], rejectedIds: [] };
    byRoom[c.assignedRoom].candidateIds.push(c.id);
    if (c.currentStatus === 'accepted') byRoom[c.assignedRoom].acceptedIds.push(c.id);
    else if (c.currentStatus === 'rejected') byRoom[c.assignedRoom].rejectedIds.push(c.id);
  }

  // 12. Deviations — only flag zones with hard-zero counts; ROOM_TERMINAL is per-room only.
  const deviations = [];
  for (const [zone, info] of Object.entries(byZone)) {
    const expected = expectedByZone[zone];
    if (!expected) continue;
    if (expected.count === 0 && info.acceptedIds.length > 0) {
      deviations.push({
        kind:   'unexpected_accept',
        zone,
        ids:    info.acceptedIds,
        reason: `zone ${zone} expects 0 doors but ${info.acceptedIds.length} accepted`
      });
    }
    if (zone === 'PORTAL' && info.acceptedIds.length !== expected.count) {
      deviations.push({
        kind:    'count_mismatch',
        zone,
        expected: expected.count,
        actual:   info.acceptedIds.length,
        ids:      info.acceptedIds,
        reason:  `PORTAL expects ${expected.count} doors, got ${info.acceptedIds.length}`
      });
    }
  }
  for (const r of perRoomRules) {
    const have = (byRoom[r.roomId]?.acceptedIds || []).length;
    if (have !== r.expectedCount) {
      deviations.push({
        kind:        'room_count_mismatch',
        roomId:      r.roomId,
        expected:    r.expectedCount,
        actual:      have,
        acceptedIds: byRoom[r.roomId]?.acceptedIds || [],
        candidateIds: byRoom[r.roomId]?.candidateIds || [],
        reason:      r.reason + ` — got ${have}`
      });
    }
  }
  // Portal door-type check
  for (const c of candidateAssignments) {
    if (c.currentStatus !== 'accepted' || c.assignedZone !== 'PORTAL') continue;
    if (c.currentIntentDoorType && c.currentIntentDoorType !== 'double') {
      deviations.push({
        kind:         'type_mismatch',
        id:           c.id,
        zone:         'PORTAL',
        expectedType: 'double',
        actualType:   c.currentIntentDoorType,
        reason:       'portal door must be double-leaf'
      });
    }
  }

  // 13. Diagnostics — node graph + per-segment adjacency degree
  const segmentZones = segmentEntries.map(s => {
    const nodes = segNodes.get(s.key) || {};
    const degA = (nodeSegs.get(nodes.nodeA) || new Set()).size;
    const degB = (nodeSegs.get(nodes.nodeB) || new Set()).size;
    const neighborSegs = new Set();
    for (const nid of [nodes.nodeA, nodes.nodeB]) {
      for (const sk of (nodeSegs.get(nid) || [])) if (sk !== s.key) neighborSegs.add(sk);
    }
    return {
      key:               s.key,
      zone:              segZone.get(s.key),
      length:            Number(s.length.toFixed(3)),
      vertical:          s.vertical,
      onMainCorridor:    corridorSet.has(s.key),
      roomId:            roomOf.get(s.key) || null,
      nodeA:             nodes.nodeA,
      nodeB:             nodes.nodeB,
      nodeADegree:       degA,
      nodeBDegree:       degB,
      neighborSegCount:  neighborSegs.size
    };
  });
  const nodeGraphDiag = [...nodeXY.entries()].map(([nid, xy]) => ({
    id:       nid,
    x:        Number(xy.x.toFixed(3)),
    y:        Number(xy.y.toFixed(3)),
    degree:   (nodeSegs.get(nid) || new Set()).size,
    segKeys:  [...(nodeSegs.get(nid) || new Set())]
  }));

  // 14. Build reports
  const spaceReport = {
    classifier:    CLASSIFIER_VERSION,
    generatedAt:   new Date().toISOString(),
    config: {
      nodeClusterToleranceM:    NODE_CLUSTER_TOLERANCE_M,
      portalToNodeMaxM:         PORTAL_TO_NODE_MAX_M,
      bridgeDistanceM:          BRIDGE_DISTANCE_M,
      verticalAxisDotThreshold: VERTICAL_AXIS_DOT_THRESHOLD,
      largeRoomAreaM2:          LARGE_ROOM_AREA_M2
    },
    counts: {
      segments:             segmentEntries.length,
      nodes:                nodeXY.size,
      mainPortalPairFound:  !!mainPortalPair,
      mainCorridorSegments: corridorSet.size,
      junctionNodes:        junctionNodes.length,
      shaftElements:        shaftElements.length,
      rooms:                rooms.size,
      componentsBeforeHeal: compsBefore.length,
      componentsAfterHeal:  compsAfter.length,
      bridgesAdded:         componentMerges.length
    },
    componentsBeforeHeal: compsBefore,
    componentsAfterHeal:  compsAfter,
    componentMerges,
    mainPortalPair: portalDiag,
    corridorBFS,
    nodeGraph:       nodeGraphDiag,
    segmentZones,
    junctionNodes,
    shaftElements,
    rooms: [...rooms.values()].map(r => ({
      roomId:       r.roomId,
      segmentKeys:  r.segmentKeys,
      hasTerminal:  r.hasTerminal,
      totalLength:  r.totalLength,
      areaEstimate: r.areaEstimate,
      isLarge:      r.isLarge
    }))
  };

  const doorPlan = {
    classifier:  CLASSIFIER_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      totalCandidates: doorElements.length,
      currentAccepted: acceptedIds.size,
      currentRejected: rejectedIds.size,
      expectedTotal:
        portalZoneCount +
        perRoomRules.reduce((acc, r) => acc + r.expectedCount, 0)
    },
    expectedByZone,
    perRoom: perRoomRules,
    candidateAssignments,
    byZone,
    byRoom,
    deviations
  };

  return { spaceReport, doorPlan };
}
