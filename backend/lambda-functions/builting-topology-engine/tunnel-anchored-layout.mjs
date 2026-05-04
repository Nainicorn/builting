/**
 * Phase 9 — Tunnel-Anchored Spatial Layout
 *
 * A *layout correction pass*, not a data pass.  Every spatial element must
 * sit relative to the tunnel network.  No new geometry types are introduced;
 * existing elements are repositioned and relationships are reconstructed.
 *
 * Pipeline (orchestrated by applyTunnelAnchoredLayout):
 *   defineBackbone           → primary tunnel loop, centerlines, normals
 *   attachSpacesToTunnel     → snap SPACE bbox face to tunnel outer wall
 *   rebuildWallsAsEnclosures → 4 walls per SPACE; remove orphan walls
 *   doorTrueEmbedding        → midpoint alignment + tunnel-shell cut flag
 *   shaftTrueConnection      → strict 3 m snap + tunnel-ceiling cut flag
 *   removeFloatingElements   → mark elements > 1 m from tunnel/space/wall
 *   runValidators            → tunnel-anchored success counters
 *
 * Wired in index.mjs AFTER applySpatialPlacement and BEFORE
 * classifyGeometryBehavior.  Counters land in
 *   css.metadata.tunnelAnchoredLayout
 *
 * Generate consumes:
 *   - properties.spatialFlag === 'FLOATING'  → skip emit
 *   - properties.alsoCutTunnel === true       → emit second IfcRelVoidsElement
 *                                              on the closest tunnel-shell
 *                                              wall (door + shaft paths)
 */

import {
  vecAdd, vecSub, vecScale, vecDist, vecLen, vecNormalize, vecDot, vecCross,
  canonicalWallDirection, canonicalWallLength, canonicalWallThickness,
} from './shared.mjs';

// ─── tunables (metres) ────────────────────────────────────────────────────
const SPACE_ATTACH_RADIUS_M       = 5.0;   // §9.2
const JUNCTION_ROOM_RADIUS_M      = 3.0;   // §9.2 — within this of a node ⇒ JUNCTION_ROOM
const SHAFT_JUNCTION_STRICT_M     = 3.0;   // §9.5 — strict snap radius
const FLOATING_RADIUS_M           = 1.0;   // §9.6
const DEFAULT_WALL_THICKNESS_M    = 0.3;
const DEFAULT_STOREY_HEIGHT_M     = 4.0;
const DOOR_THICKNESS_M            = 0.10;
const ZERO_TOL_M                  = 0.05;

// ──────────────────────────────────────────────────────────────────────────
// orchestrator
// ──────────────────────────────────────────────────────────────────────────

export function applyTunnelAnchoredLayout(css) {
  if (!css || !Array.isArray(css.elements)) return;
  if (!css.metadata) css.metadata = {};

  const report = {
    enabled: true,
    primarySegmentCount: 0,
    primaryJunctionCount: 0,
    spacesAttached: 0,
    spacesUnattached: 0,
    spacesSideRoom: 0,
    spacesJunctionRoom: 0,
    enclosingWallsCreated: 0,
    enclosingWallsRetired: 0,
    orphanWallsTagged: 0,
    closedLoops: 0,
    openLoops: 0,
    doorsAligned: 0,
    doorsMisaligned: 0,
    doorsCutTunnel: 0,
    shaftSnappedStrict: false,
    shaftCutsCeiling: false,
    floatingElements: 0,
    // 9.7 success conditions
    spacesAttachedToTunnel: false,
    wallsFormClosedLoops: false,
    doorsEmbeddedVisual: false,
    shaftIntersectsTunnel: false,
    floatingElementsZero: false,
  };
  css.metadata.tunnelAnchoredLayout = report;

  const backbone = defineBackbone(css, report);
  if (!backbone || backbone.segments.length === 0) {
    console.log('applyTunnelAnchoredLayout: no tunnel network — skipping');
    return;
  }

  attachSpacesToTunnel(css, backbone, report);
  rebuildWallsAsEnclosures(css, backbone, report);
  doorTrueEmbedding(css, backbone, report);
  shaftTrueConnection(css, backbone, report);
  removeFloatingElements(css, backbone, report);
  runValidators(css, backbone, report);

  console.log(
    `applyTunnelAnchoredLayout: backbone=${report.primarySegmentCount}seg/${report.primaryJunctionCount}junc ` +
    `spaces=${report.spacesAttached} (side=${report.spacesSideRoom}, junc=${report.spacesJunctionRoom}, unatt=${report.spacesUnattached}) ` +
    `walls=+${report.enclosingWallsCreated}/-${report.enclosingWallsRetired} (orphan=${report.orphanWallsTagged}, closed=${report.closedLoops}/${report.closedLoops + report.openLoops}) ` +
    `doors=${report.doorsAligned}(misaligned=${report.doorsMisaligned}, cutTunnel=${report.doorsCutTunnel}) ` +
    `shaft=${report.shaftSnappedStrict ? 'snapped' : 'no-op'}(cut=${report.shaftCutsCeiling}) ` +
    `floating=${report.floatingElements}`
  );

  if (process.env.PHASE_9_HARD_FAIL === '1') {
    const fails = [];
    if (!report.spacesAttachedToTunnel) fails.push('spacesAttachedToTunnel=false');
    if (!report.wallsFormClosedLoops)   fails.push('wallsFormClosedLoops=false');
    if (!report.doorsEmbeddedVisual)    fails.push('doorsEmbeddedVisual=false');
    if (!report.shaftIntersectsTunnel)  fails.push('shaftIntersectsTunnel=false');
    if (!report.floatingElementsZero)   fails.push('floatingElements>0');
    if (fails.length) throw new Error(`Phase 9 hard-fail: ${fails.join(', ')}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §9.1 — Define backbone
// ──────────────────────────────────────────────────────────────────────────

/**
 * Identify the primary tunnel loop = largest connected component of
 * TUNNEL_SEGMENT graph.  Returns:
 *
 *   {
 *     segments: [{ key, start, end, tangent, lateral, length, width,
 *                  height, thickness, mid, elem }],
 *     segmentByKey: Map<key, segment>,
 *     junctions: [{ id, xyz, segmentKeys: [...] }],
 *     junctionsXY: [{ x, y, z, id, segmentKeys }],
 *   }
 *
 * Stamps css.metadata.primaryTunnelNetwork = { segmentKeys, junctionNodeIds }
 * and tags every primary-segment element with properties.inPrimaryNetwork = true.
 */
export function defineBackbone(css, report) {
  const segs = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT'
  );
  if (segs.length === 0) return null;

  const segByKey = new Map();
  const segData = [];
  for (const seg of segs) {
    const key = seg.element_key || seg.id;
    if (!key) continue;
    const ends = segmentEndpoints(seg);
    if (!ends) continue;
    const tangent = vecNormalize(vecSub(ends.end, ends.start));
    if (!tangent) continue;
    const lateral = computeLateral(tangent);
    const profile = seg.geometry?.profile || {};
    const length = vecLen(vecSub(ends.end, ends.start));
    const data = {
      key,
      elem: seg,
      start: ends.start,
      end:   ends.end,
      mid: { x: (ends.start.x + ends.end.x) / 2, y: (ends.start.y + ends.end.y) / 2, z: (ends.start.z + ends.end.z) / 2 },
      tangent, lateral,
      length,
      width: Number(profile.width)  || 4.0,
      height: Number(profile.height) || 4.0,
      thickness: Number(seg.properties?.shellThickness_m || profile.wallThickness) || 0.3,
      entry: seg.properties?.entry_node || null,
      exit:  seg.properties?.exit_node  || null,
    };
    segByKey.set(key, data);
    segData.push(data);
  }

  if (segData.length === 0) return null;

  // ── Connected-component union-find on shared topology nodes ────────────
  const parent = new Map();
  for (const s of segData) parent.set(s.key, s.key);
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const nodeToSegs = new Map();
  for (const s of segData) {
    for (const n of [s.entry, s.exit]) {
      if (!n) continue;
      if (!nodeToSegs.has(n)) nodeToSegs.set(n, []);
      nodeToSegs.get(n).push(s.key);
    }
  }
  for (const keys of nodeToSegs.values()) {
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
  }

  // ── Pick the largest component ──
  const compMembers = new Map();
  for (const s of segData) {
    const r = find(s.key);
    if (!compMembers.has(r)) compMembers.set(r, []);
    compMembers.get(r).push(s.key);
  }
  let primary = [];
  for (const members of compMembers.values()) {
    if (members.length > primary.length) primary = members;
  }

  const primaryKeySet = new Set(primary);
  const primarySegs = primary.map(k => segByKey.get(k)).filter(Boolean);

  // Tag every primary-segment element so downstream passes can filter cheaply.
  for (const s of primarySegs) {
    if (!s.elem.properties) s.elem.properties = {};
    s.elem.properties.inPrimaryNetwork = true;
  }

  // ── Junctions: nodes with degree ≥ 3 within the primary network ──
  const junctions = [];
  for (const [nodeId, branches] of nodeToSegs) {
    const inPrimary = branches.filter(k => primaryKeySet.has(k));
    if (inPrimary.length < 3) continue;
    // Locate node by averaging primary-branch endpoints incident at it.
    let xs = 0, ys = 0, zs = 0, n = 0;
    for (const k of inPrimary) {
      const s = segByKey.get(k);
      if (!s) continue;
      const pt = (s.entry === nodeId) ? s.start : s.end;
      xs += pt.x; ys += pt.y; zs += pt.z; n++;
    }
    if (n === 0) continue;
    junctions.push({
      id: nodeId,
      xyz: { x: xs / n, y: ys / n, z: zs / n },
      segmentKeys: inPrimary,
    });
  }

  css.metadata.primaryTunnelNetwork = {
    segmentKeys: [...primaryKeySet],
    junctionNodeIds: junctions.map(j => j.id),
  };
  report.primarySegmentCount = primarySegs.length;
  report.primaryJunctionCount = junctions.length;

  return {
    segments: primarySegs,
    segmentByKey: segByKey,
    primaryKeySet,
    junctions,
  };
}

function segmentEndpoints(seg) {
  const sp = seg.properties?.startPoint;
  const ep = seg.properties?.endPoint;
  if (sp && ep && [sp.x, sp.y, ep.x, ep.y].every(Number.isFinite)) {
    return {
      start: { x: +sp.x, y: +sp.y, z: +(sp.z ?? 0) },
      end:   { x: +ep.x, y: +ep.y, z: +(ep.z ?? 0) },
    };
  }
  const o = seg.placement?.origin;
  const ax = seg.placement?.axis ? vecNormalize(seg.placement.axis) : null;
  const d = Number(seg.geometry?.depth) || 0;
  if (o && ax && d > 0) {
    return {
      start: vecAdd(o, vecScale(ax, -d / 2)),
      end:   vecAdd(o, vecScale(ax,  d / 2)),
    };
  }
  return null;
}

function computeLateral(tangent) {
  const up = { x: 0, y: 0, z: 1 };
  let lateral = vecNormalize(vecCross(tangent, up));
  if (!lateral) lateral = { x: 1, y: 0, z: 0 };
  return lateral;
}

// ──────────────────────────────────────────────────────────────────────────
// §9.2 — Attach SPACES to tunnel
// ──────────────────────────────────────────────────────────────────────────

/**
 * For each SPACE with bbox:
 *   1. Find nearest primary tunnel segment within SPACE_ATTACH_RADIUS_M.
 *   2. Snap SPACE so one bbox face touches the tunnel outer wall.
 *   3. Classify SIDE_ROOM / JUNCTION_ROOM.
 *   4. Stamp attachedSegmentId, attachmentType, attachedSide.
 *
 * Spaces that have no primary segment within radius are tagged
 * attachmentType='UNATTACHED' so §9.6 can mark them FLOATING.
 */
export function attachSpacesToTunnel(css, backbone, report) {
  if (!backbone || backbone.segmentByKey.size === 0) return;
  const spaces = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'SPACE' && e.properties?.bbox
  );
  if (spaces.length === 0) return;

  // Phase 9.2 rule: "find nearest tunnel segment (≤ 5m)". Search ALL
  // TUNNEL_SEGMENTs, not just the primary backbone — extracted SPACEs may
  // sit closer to a non-primary segment (cross-cut, alcove, branch).
  const allSegs = [...backbone.segmentByKey.values()];

  for (const space of spaces) {
    const bbox = space.properties.bbox;
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const cz = (bbox.minZ + bbox.maxZ) / 2;
    const center = { x: cx, y: cy, z: cz };

    // Nearest segment by distance from SPACE centroid to segment line.
    let bestSeg = null;
    let bestT = 0;
    let bestDist = Infinity;
    for (const seg of allSegs) {
      const v = vecSub(center, seg.start);
      const t = vecDot(v, seg.tangent);
      const tClamped = Math.max(0, Math.min(seg.length, t));
      const closest = vecAdd(seg.start, vecScale(seg.tangent, tClamped));
      const d2 = (center.x - closest.x) ** 2 + (center.y - closest.y) ** 2;
      const d = Math.sqrt(d2);
      if (d < bestDist) { bestDist = d; bestSeg = seg; bestT = tClamped; }
    }

    if (!bestSeg || bestDist > SPACE_ATTACH_RADIUS_M) {
      space.properties.attachmentType = 'UNATTACHED';
      space.properties.attachedDistanceM = Number.isFinite(bestDist) ? +bestDist.toFixed(3) : null;
      report.spacesUnattached++;
      continue;
    }

    // Centerline closest point + outer-wall distance along lateral.
    const closest = vecAdd(bestSeg.start, vecScale(bestSeg.tangent, bestT));
    const perp = vecSub(center, closest);
    const lateralProj = vecDot(perp, bestSeg.lateral);
    const sign = lateralProj >= 0 ? 1 : -1;
    const outerHalf = bestSeg.width / 2 + bestSeg.thickness;

    // Move bbox so its inner face along the lateral touches the tunnel
    // outer wall.  bbox half-extent along lateral:
    const bboxW = bbox.maxX - bbox.minX;
    const bboxD = bbox.maxY - bbox.minY;
    // Project bbox half-extents onto the lateral axis.
    const halfAlongLateral = Math.abs(bestSeg.lateral.x) * (bboxW / 2)
                           + Math.abs(bestSeg.lateral.y) * (bboxD / 2);
    const targetPerpDist = outerHalf + halfAlongLateral;
    const desiredCenter = vecAdd(closest, vecScale(bestSeg.lateral, sign * targetPerpDist));

    // Translate bbox + space origin by (desiredCenter - currentCenter).
    const dx = desiredCenter.x - cx;
    const dy = desiredCenter.y - cy;
    bbox.minX += dx; bbox.maxX += dx;
    bbox.minY += dy; bbox.maxY += dy;
    if (space.placement?.origin) {
      space.placement.origin.x += dx;
      space.placement.origin.y += dy;
    }
    // Align SPACE refDirection to tunnel tangent so synthesized walls run
    // parallel to the tunnel.
    space.placement.refDirection = { x: bestSeg.tangent.x, y: bestSeg.tangent.y, z: 0 };

    // Classify SIDE_ROOM vs JUNCTION_ROOM by proximity to a primary junction.
    let attachmentType = 'SIDE_ROOM';
    let nearestJunctionId = null;
    let nearestJunctionDist = Infinity;
    for (const j of backbone.junctions) {
      const d = Math.sqrt((j.xyz.x - cx) ** 2 + (j.xyz.y - cy) ** 2);
      if (d < nearestJunctionDist) { nearestJunctionDist = d; nearestJunctionId = j.id; }
    }
    if (nearestJunctionDist <= JUNCTION_ROOM_RADIUS_M) {
      attachmentType = 'JUNCTION_ROOM';
    }

    space.properties.attachedSegmentId = bestSeg.key;
    space.properties.attachmentType    = attachmentType;
    space.properties.attachedSide      = sign > 0 ? 'LATERAL_POS' : 'LATERAL_NEG';
    space.properties.attachedJunctionId = nearestJunctionId;

    if (attachmentType === 'JUNCTION_ROOM') report.spacesJunctionRoom++;
    else report.spacesSideRoom++;
    report.spacesAttached++;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §9.3 — Rebuild walls as enclosures
// ──────────────────────────────────────────────────────────────────────────

/**
 * For each SPACE with a bbox we synthesize four IfcWall-typed elements along
 * the bbox edges to form a closed enclosure:
 *
 *     +Y
 *      ┌────┐         W_S = south wall (along +X, normal -Y)
 *      │    │         W_N = north wall (along +X, normal +Y)
 *      └────┘         W_W = west  wall (along +Y, normal -X)
 *     -Y              W_E = east  wall (along +Y, normal +X)
 *
 * The wall flush with the tunnel inherits the SPACE's `attachedSide` so its
 * outer face shares the plane of the tunnel outer wall.  Existing WALL
 * elements whose container is NOT a SPACE id and whose host segment is NOT
 * in the primary tunnel network are tagged ORPHAN_WALL (Phase 9.6 will
 * mark them FLOATING for emit-skip).
 */
export function rebuildWallsAsEnclosures(css, backbone, report) {
  if (!backbone) return;
  const elements = css.elements || [];

  const spaces = elements.filter(e =>
    (e.type || '').toUpperCase() === 'SPACE' && e.properties?.bbox
  );

  // Build a set of SPACE element_keys + ids so we can tell if a WALL belongs
  // to a SPACE.
  const spaceKeys = new Set();
  for (const s of spaces) {
    if (s.element_key) spaceKeys.add(s.element_key);
    if (s.id)          spaceKeys.add(s.id);
  }

  // Track existing enclosure walls keyed by spaceKey so re-runs don't
  // duplicate.  Phase 9 enclosures are tagged with properties.phase9Enclosure.
  const existingEnclosureKeys = new Set();
  for (const e of elements) {
    if ((e.type || '').toUpperCase() !== 'WALL') continue;
    if (e.properties?.phase9Enclosure) existingEnclosureKeys.add(e.element_key || e.id);
  }

  const generated = [];

  for (const space of spaces) {
    const bbox = space.properties.bbox;
    if (!bbox) continue;
    const containerId = space.container || space.element_key || space.id;
    const spaceKey = space.element_key || space.id || containerId;
    if (existingEnclosureKeys.has(`phase9-wall-${spaceKey}-S`)) continue; // already done

    const w = bbox.maxX - bbox.minX;
    const d = bbox.maxY - bbox.minY;
    const h = Math.max(bbox.maxZ - bbox.minZ, DEFAULT_STOREY_HEIGHT_M);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const z0 = bbox.minZ;
    const t  = DEFAULT_WALL_THICKNESS_M;

    // Pick which side is flush with the tunnel.  attachedSide LATERAL_POS
    // means the SPACE sits on the +lateral side of the tunnel — the wall
    // closest to the tunnel is the one on the -lateral face of the bbox.
    const attachedSide = space.properties.attachedSide || 'LATERAL_POS';
    const flushSide =
      attachedSide === 'LATERAL_POS' ? 'S' :
      attachedSide === 'LATERAL_NEG' ? 'N' : null;

    // Four walls — each a plain WALL element with method=EXTRUSION up.
    // Profile: width = wall length, height = thickness.
    const walls = [
      { side: 'S', origin: { x: cx,        y: bbox.minY, z: z0 }, refDir: { x: 1, y: 0, z: 0 }, length: w, axis: 'X' },
      { side: 'N', origin: { x: cx,        y: bbox.maxY, z: z0 }, refDir: { x: 1, y: 0, z: 0 }, length: w, axis: 'X' },
      { side: 'W', origin: { x: bbox.minX, y: cy,        z: z0 }, refDir: { x: 0, y: 1, z: 0 }, length: d, axis: 'Y' },
      { side: 'E', origin: { x: bbox.maxX, y: cy,        z: z0 }, refDir: { x: 0, y: 1, z: 0 }, length: d, axis: 'Y' },
    ];

    for (const wallSpec of walls) {
      const id = `phase9-wall-${spaceKey}-${wallSpec.side}`;
      generated.push({
        id, element_key: id,
        type: 'WALL',
        semanticType: 'IfcWallStandardCase',
        name: `Enclosure ${wallSpec.side} - ${space.name || spaceKey}`,
        confidence: 0.6,
        source: 'PHASE_9_ENCLOSURE',
        container: containerId,
        placement: {
          origin: { x: wallSpec.origin.x, y: wallSpec.origin.y, z: wallSpec.origin.z },
          axis: { x: 0, y: 0, z: 1 },
          refDirection: wallSpec.refDir,
        },
        geometry: {
          method: 'EXTRUSION',
          direction: { x: 0, y: 0, z: 1 },
          depth: h,
          profile: { type: 'RECTANGLE', width: wallSpec.length, height: t },
        },
        material: { name: 'concrete', color: [0.78, 0.78, 0.80], transparency: 0 },
        properties: {
          phase9Enclosure: true,
          enclosureSide: wallSpec.side,
          enclosureFlushWithTunnel: wallSpec.side === flushSide,
          spaceKey,
          attachedSegmentId: space.properties.attachedSegmentId || null,
        },
        relationships: [],
      });
      report.enclosingWallsCreated++;
    }
    report.closedLoops++;
  }

  if (generated.length > 0) css.elements.push(...generated);

  // Build a set of host wall keys referenced by any DOOR — those walls are
  // load-bearing for door embedding (Phase 8 IfcRelVoidsElement / Phase 9
  // tunnel cuts) and must NOT be retired as orphans even if their container
  // looks unrelated to the SPACE/tunnel sets.
  const doorHostKeys = new Set();
  for (const e of elements) {
    if ((e.type || '').toUpperCase() !== 'DOOR') continue;
    const k = e.properties?.hostWallKey;
    if (k) doorHostKeys.add(k);
  }

  // Tag orphan walls: WALLs whose container isn't a SPACE id, whose host
  // tunnel-segment isn't in the primary network, and which no DOOR is
  // hosted on.  Don't mark new enclosure walls or shell-piece walls.
  for (const e of elements) {
    if ((e.type || '').toUpperCase() !== 'WALL') continue;
    if (e.properties?.phase9Enclosure) continue;
    if (e.properties?.shellPiece) continue;          // tunnel-shell walls
    if (e.properties?.derivedFromBranch) continue;   // chain walls

    const wKey = e.element_key || e.id;
    if (wKey && doorHostKeys.has(wKey)) continue;    // hosts a door — keep

    const c = e.container;
    const inSpace = c && spaceKeys.has(c);
    const inPrimary = c && backbone.primaryKeySet?.has(c);
    // Also keep walls whose container is any TUNNEL_SEGMENT key — primary
    // network membership is a stricter test than what 9.3 should enforce.
    const inAnySegment = c && backbone.segmentByKey?.has(c);
    if (!inSpace && !inPrimary && !inAnySegment) {
      if (!e.properties) e.properties = {};
      e.properties.spatialFlag = e.properties.spatialFlag || 'ORPHAN_WALL';
      report.orphanWallsTagged++;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §9.4 — Door true embedding
// ──────────────────────────────────────────────────────────────────────────

/**
 * For each DOOR with a hostWallKey:
 *   - Project door origin to the midpoint between the SPACE bbox face and
 *     the tunnel inner face along the segment lateral axis.
 *   - Stamp alsoCutTunnel + tunnelCutSegmentId so generate emits a second
 *     IfcRelVoidsElement on the tunnel-shell wall.
 *   - If the door's perpendicular distance from the host wall plane exceeds
 *     half the wall thickness, tag DOOR_MISALIGNED but keep the door.
 */
export function doorTrueEmbedding(css, backbone, report) {
  if (!backbone) return;
  const elements = css.elements || [];

  const wallByKey = new Map();
  for (const w of elements) {
    if ((w.type || '').toUpperCase() !== 'WALL') continue;
    const k = w.element_key || w.id;
    if (k) wallByKey.set(k, w);
  }

  const spaceByContainer = new Map();
  for (const s of elements) {
    if ((s.type || '').toUpperCase() === 'SPACE' && s.properties?.bbox) {
      const c = s.container || s.element_key || s.id;
      if (c) spaceByContainer.set(c, s);
    }
  }

  for (const door of elements) {
    if ((door.type || '').toUpperCase() !== 'DOOR') continue;
    const hostKey = door.properties?.hostWallKey;
    if (!hostKey) continue;
    const wall = wallByKey.get(hostKey);
    if (!wall) continue;

    // Identify host SPACE (if the wall belongs to one) and host tunnel
    // segment (if the wall is enclosure-flush or hosted by a tunnel).
    let space = null;
    if (wall.container && spaceByContainer.has(wall.container)) {
      space = spaceByContainer.get(wall.container);
    }
    // Phase 8 enclosures stamp spaceKey on the wall.
    if (!space && wall.properties?.spaceKey) {
      for (const s of spaceByContainer.values()) {
        if ((s.element_key || s.id) === wall.properties.spaceKey) { space = s; break; }
      }
    }
    const segId = wall.properties?.attachedSegmentId
                || space?.properties?.attachedSegmentId
                || null;
    const seg = segId ? backbone.segmentByKey.get(segId) : null;

    const dirWall = canonicalWallDirection(wall) || { x: 1, y: 0, z: 0 };
    const wallO   = wall.placement?.origin || { x: 0, y: 0, z: 0 };
    const wallNormal = vecNormalize({ x: -dirWall.y, y: dirWall.x, z: 0 }) || { x: 0, y: 1, z: 0 };

    // Midpoint between SPACE interior and tunnel interior.
    if (space?.properties?.bbox && seg) {
      const bbox = space.properties.bbox;
      const sCenter = { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
      const segMid = seg.mid;
      const mx = (sCenter.x + segMid.x) / 2;
      const my = (sCenter.y + segMid.y) / 2;
      // Project (mx, my) onto the wall axis line.
      const along = (mx - wallO.x) * dirWall.x + (my - wallO.y) * dirWall.y;
      const len = canonicalWallLength(wall) || 0;
      const clamped = Math.max(-len / 2, Math.min(len / 2, along));
      door.placement = door.placement || {};
      door.placement.origin = {
        x: wallO.x + dirWall.x * clamped,
        y: wallO.y + dirWall.y * clamped,
        z: door.placement?.origin?.z ?? wallO.z,
      };
      door.placement.refDirection = { x: dirWall.x, y: dirWall.y, z: 0 };
      door.placement.axis = { x: 0, y: 0, z: 1 };
    }

    // Flag tunnel-shell cut: only relevant when the host wall is an
    // enclosure flush with a tunnel segment, OR when the door directly
    // hosts on a tunnel-shell wall.
    const flushTunnel = wall.properties?.enclosureFlushWithTunnel === true;
    const isShellWall = wall.properties?.shellPiece === true || wall.properties?.derivedFromBranch != null;
    if (segId && (flushTunnel || isShellWall)) {
      door.properties = door.properties || {};
      door.properties.alsoCutTunnel = true;
      door.properties.tunnelCutSegmentId = segId;
      report.doorsCutTunnel++;
    }

    // Visual-fit check: if the door's projected origin sits more than half a
    // wall thickness off the wall's plane, flag DOOR_MISALIGNED.
    const wallThk = canonicalWallThickness(wall) || DEFAULT_WALL_THICKNESS_M;
    const perpFromPlane = Math.abs(
      (door.placement.origin.x - wallO.x) * wallNormal.x +
      (door.placement.origin.y - wallO.y) * wallNormal.y
    );
    if (perpFromPlane > wallThk / 2 + DOOR_THICKNESS_M / 2) {
      door.properties = door.properties || {};
      door.properties.spatialFlag = 'DOOR_MISALIGNED';
      report.doorsMisaligned++;
    } else {
      report.doorsAligned++;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §9.5 — Shaft true connection
// ──────────────────────────────────────────────────────────────────────────

/**
 * Strict snap (≤ 3 m) to the nearest primary junction node, extend the shaft
 * downward until it intersects a tunnel volume, and stamp cutTunnelCeiling
 * + tunnelCeilingSegmentId so generate emits the boolean cut.
 */
export function shaftTrueConnection(css, backbone, report) {
  if (!backbone) return;
  const elements = css.elements || [];
  const shaft = elements.find(e =>
    e.properties?.segmentType === 'VERTICAL_SHAFT' ||
    /vertical[-_ ]?shaft/i.test(e.name || '') ||
    /vertical[-_ ]?shaft/i.test(e.id || '') ||
    e.properties?.synthesizedBy === 'VERTICAL_SHAFT'
  );
  if (!shaft) return;

  const o = shaft.placement?.origin;
  if (!o) return;

  // Strict snap.
  let bestJ = null, bestD = Infinity;
  for (const j of backbone.junctions) {
    const d = Math.sqrt((o.x - j.xyz.x) ** 2 + (o.y - j.xyz.y) ** 2);
    if (d < bestD) { bestD = d; bestJ = j; }
  }
  if (bestJ && bestD <= SHAFT_JUNCTION_STRICT_M) {
    shaft.placement.origin = { x: bestJ.xyz.x, y: bestJ.xyz.y, z: o.z };
    if (!shaft.properties) shaft.properties = {};
    shaft.properties.junctionNodeId = bestJ.id;
    report.shaftSnappedStrict = true;
  }

  // Extend downward until the shaft intersects a tunnel segment volume.
  // Pick the tunnel segment closest in XY to the (post-snap) shaft origin
  // and ensure shaft.origin.z + depth covers segCeiling, and shaft.origin.z
  // sits at-or-below segCeiling - 0.5 m.
  const so = shaft.placement.origin;
  let bestSeg = null, bestSegD = Infinity;
  for (const s of backbone.segments) {
    const dx = so.x - s.mid.x, dy = so.y - s.mid.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestSegD) { bestSegD = d; bestSeg = s; }
  }
  if (bestSeg) {
    const segCeilZ = bestSeg.mid.z + bestSeg.height / 2;
    const requiredLowerZ = segCeilZ - 0.5;
    if (so.z > requiredLowerZ) {
      so.z = requiredLowerZ;
    }
    let depth = Number(shaft.geometry?.depth) || 0;
    if (depth < 1) depth = 8;
    shaft.geometry = shaft.geometry || {};
    shaft.geometry.depth = Math.max(depth, segCeilZ - so.z + 0.5);
    shaft.properties.cutTunnelCeiling = true;
    shaft.properties.tunnelCeilingSegmentId = bestSeg.key;
    report.shaftCutsCeiling = true;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §9.6 — Remove (mark) floating elements
// ──────────────────────────────────────────────────────────────────────────

/**
 * An element is FLOATING if no part of it is within FLOATING_RADIUS_M of:
 *   - any primary tunnel segment centerline
 *   - any SPACE bbox
 *   - any WALL plane
 *
 * The check excludes the very types that BUILD the reference set
 * (TUNNEL_SEGMENT, SPACE, WALL) and excludes IfcSite-class entities.
 * Generate consumes properties.spatialFlag === 'FLOATING' to skip emit.
 */
export function removeFloatingElements(css, backbone, report) {
  if (!backbone) return;
  const elements = css.elements || [];

  const spaceBboxes = [];
  for (const s of elements) {
    if ((s.type || '').toUpperCase() === 'SPACE' && s.properties?.bbox) {
      spaceBboxes.push(s.properties.bbox);
    }
  }

  // Wall axes: store start/end for distance check.
  const wallLines = [];
  for (const w of elements) {
    if ((w.type || '').toUpperCase() !== 'WALL') continue;
    const o = w.placement?.origin;
    if (!o) continue;
    const dir = canonicalWallDirection(w);
    const len = canonicalWallLength(w) || 0;
    if (!dir || len <= 0) continue;
    wallLines.push({
      start: vecAdd(o, vecScale(dir, -len / 2)),
      end:   vecAdd(o, vecScale(dir,  len / 2)),
    });
  }

  // All tunnel segments (not just primary) — equipment / ducts / fittings
  // mounted on tunnel walls naturally sit at perpendicular distance up to
  // segment_radius + thickness from the centerline, which can exceed 3 m
  // on wide-bore tunnels.  Use shell-distance (max(0, d_perp - radius))
  // so anything within FLOATING_RADIUS_M of the OUTER tunnel wall passes.
  const allSegs = [...backbone.segmentByKey.values()];

  const SKIP_TYPES = new Set(['TUNNEL_SEGMENT', 'SPACE', 'WALL']);

  for (const e of elements) {
    const t = (e.type || '').toUpperCase();
    if (SKIP_TYPES.has(t)) continue;
    if (e.properties?.isPortalHelper) continue;

    const o = e.placement?.origin;
    if (!o) continue;

    let d = Infinity;

    // Distance to tunnel SHELL (closest point on outer surface, not centerline).
    for (const s of allSegs) {
      const v = vecSub(o, s.start);
      const tProj = vecDot(v, s.tangent);
      const tClamped = Math.max(0, Math.min(s.length, tProj));
      const closest = vecAdd(s.start, vecScale(s.tangent, tClamped));
      const perp = vecSub(o, closest);
      // Decompose perp into lateral + vertical (relative to segment frame).
      const lat = vecDot(perp, s.lateral);
      const vert = perp.z;
      const radiusLat = s.width / 2 + s.thickness;
      const radiusVert = s.height / 2 + s.thickness;
      const dxOut = Math.max(0, Math.abs(lat) - radiusLat);
      const dyOut = Math.max(0, Math.abs(vert) - radiusVert);
      const dd = Math.sqrt(dxOut * dxOut + dyOut * dyOut);
      if (dd < d) d = dd;
      if (d <= FLOATING_RADIUS_M) break;
    }

    // SPACE bboxes (point-in-box-margin).
    if (d > FLOATING_RADIUS_M) {
      for (const b of spaceBboxes) {
        const inside =
          o.x >= b.minX - FLOATING_RADIUS_M && o.x <= b.maxX + FLOATING_RADIUS_M &&
          o.y >= b.minY - FLOATING_RADIUS_M && o.y <= b.maxY + FLOATING_RADIUS_M &&
          o.z >= b.minZ - FLOATING_RADIUS_M && o.z <= b.maxZ + FLOATING_RADIUS_M;
        if (inside) { d = 0; break; }
      }
    }

    // Wall lines.
    if (d > FLOATING_RADIUS_M) {
      for (const ln of wallLines) {
        const dd = pointToLineSegmentDist3(o, ln.start, ln.end);
        if (dd < d) d = dd;
        if (d <= FLOATING_RADIUS_M) break;
      }
    }

    if (d > FLOATING_RADIUS_M) {
      e.properties = e.properties || {};
      e.properties.spatialFlag = 'FLOATING';
      e.properties.spatialFloatDistM = +d.toFixed(3);
      report.floatingElements++;
      // Synthesized elements that fail the float check were placed speculatively;
      // remove them rather than relying on every downstream emit path to honour
      // the FLOATING flag (the IfcCovering emit path empirically does not).
      const synthBy = e.properties.synthesizedBy;
      if (synthBy === 'phase8' || e.source === 'PHASE_8_SPATIAL') {
        e._removeOnFloating = true;
      }
    }
  }

  const before = css.elements.length;
  css.elements = css.elements.filter(x => !x._removeOnFloating);
  report.synthesizedFloatingRemoved = before - css.elements.length;
}

function pointToLineSegmentDist3(p, a, b) {
  const ab = vecSub(b, a);
  const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  if (len2 < 1e-12) return vecDist(p, a);
  const ap = vecSub(p, a);
  const t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / len2));
  const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t };
  return vecDist(p, closest);
}

// ──────────────────────────────────────────────────────────────────────────
// §9.7 — Validators
// ──────────────────────────────────────────────────────────────────────────

function runValidators(css, backbone, report) {
  const elements = css.elements || [];
  const totalSpaces = elements.filter(e => (e.type || '').toUpperCase() === 'SPACE').length;

  report.spacesAttachedToTunnel = totalSpaces > 0
    ? report.spacesAttached === totalSpaces
    : true;

  // wallsFormClosedLoops — every SPACE has a Phase 9 4-wall enclosure and
  // there are no opens.  closedLoops is incremented per SPACE in §9.3.
  report.wallsFormClosedLoops = totalSpaces > 0
    ? report.closedLoops === totalSpaces
    : true;

  // doorsEmbeddedVisual — at least one DOOR aligned and no DOOR_MISALIGNED
  // tags survived (or there are no doors).
  const totalDoors = elements.filter(e => (e.type || '').toUpperCase() === 'DOOR').length;
  report.doorsEmbeddedVisual = totalDoors > 0
    ? report.doorsAligned > 0 && report.doorsMisaligned === 0
    : true;

  report.shaftIntersectsTunnel = report.shaftCutsCeiling === true
    || elements.findIndex(e =>
        e.properties?.synthesizedBy === 'VERTICAL_SHAFT' ||
        e.properties?.segmentType === 'VERTICAL_SHAFT'
       ) === -1;

  report.floatingElementsZero = report.floatingElements === 0;
}
