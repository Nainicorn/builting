/**
 * Phase 8 — Spatial Placement Engine
 *
 * Single source of truth for "where does each element belong?"  Phase 7 closed
 * the data gap (every element type now reaches the IFC); Phase 8 closes the
 * positioning gap.  Without this pass, downstream emit silently defaults
 * missing origins to (0,0,0) and stacks every room/slab/equipment at world
 * zero.
 *
 * Pipeline order (orchestrated by applySpatialPlacement):
 *   inferTunnelSpaces       → SPACE bbox from connected TUNNEL_SEGMENT cluster
 *   placeSlabsAndCoverings  → floor at bbox.minZ, ceiling at bbox.maxZ - t
 *   alignWalls              → snap shell walls to centerline ± half-width,
 *                             flag (do not drop) walls that clip the tunnel
 *   embedDoors              → assign hostWallKey, project onto wall plane,
 *                             tag DOOR_NO_HOST orphans
 *   snapShaft               → snap shaft XY to nearest junction, ensure
 *                             vertical intersection with tunnel, 30m default
 *
 * Wired in index.mjs AFTER applyEquipmentMounting and BEFORE
 * classifyGeometryBehavior.  Counters land in css.metadata.spatialPlacement.
 *
 * Hard rules (per PLAN Phase 8):
 *   - All placement logic lives here, not in generate.
 *   - Generate ONLY consumes placement + emits relationships.
 *   - No element defaults to (0,0,0) except IfcSite (enforced in generate via
 *     _p7_origin → None).
 *   - Do NOT synthesize fake walls.  Tag and report instead.
 */

import {
  vecAdd, vecSub, vecScale, vecDist, vecNormalize, vecDot, vecLen, vecCross,
  canonicalWallDirection, canonicalWallLength, canonicalWallThickness
} from './shared.mjs';

// ─── tunables (all metres) ────────────────────────────────────────────────
const SEGMENT_PROXIMITY_M    = 2.0;     // §8.2 cluster gap tolerance
const SPACE_MIN_VOLUME_M3    = 1.0;     // §8.2 reject tiny clusters
const SPACE_MIN_FOOTPRINT_M  = 1.0;     // bbox W and D both > this
const COVERING_THICKNESS_M   = 0.057;   // §8.3 (matches existing ancillary path)
const SLAB_THICKNESS_M       = 0.25;    // generic floor slab depth
const ORIGIN_ZERO_TOL_M      = 0.05;    // "near (0,0,0)" tolerance
const WALL_INTERSECT_TOL_M   = 0.05;    // §8.4 host-clip tolerance
const DOOR_HOST_RADIUS_M     = 0.5;     // §8.5
const SHAFT_JUNCTION_RADIUS_M = 10.0;   // §8.6
const SHAFT_DEFAULT_DEPTH_M  = 30.0;    // §8.6
const STACKING_CLUSTER_RADIUS_M = 0.5;  // §8.8
const STACKING_CLUSTER_MIN     = 3;     // §8.8 ">2 elements" → flag

// ──────────────────────────────────────────────────────────────────────────
// orchestrator
// ──────────────────────────────────────────────────────────────────────────

export function applySpatialPlacement(css) {
  if (!css || !Array.isArray(css.elements)) return;
  if (!css.metadata) css.metadata = {};

  const report = {
    enabled: true,
    spacesCreated: 0,
    spacesWithBBox: 0,
    slabsPlaced: 0,
    slabsReplaced: 0,
    coveringsPlaced: 0,
    coveringsReplaced: 0,
    wallsAligned: 0,
    wallsIntersectingHost: 0,
    doorsHosted: 0,
    doorsOrphan: 0,
    shaftSnapped: false,
    shaftDepthDefaulted: false,
    shaftJunctionNodeId: null,
    // validators
    noDefaultOrigin: 0,
    slabsCorrectZ: 0,
    stackingClusters: 0,
    stackingClusterDetail: [],
  };
  css.metadata.spatialPlacement = report;

  inferTunnelSpaces(css, report);
  placeSlabsAndCoverings(css, report);
  alignWalls(css, report);
  embedDoors(css, report);
  snapShaft(css, report);
  runValidators(css, report);

  console.log(
    `applySpatialPlacement: spaces=${report.spacesCreated}/${report.spacesWithBBox} ` +
    `slabs=${report.slabsPlaced}(${report.slabsReplaced} repl) ` +
    `coverings=${report.coveringsPlaced}(${report.coveringsReplaced} repl) ` +
    `walls=${report.wallsAligned}(${report.wallsIntersectingHost} clip) ` +
    `doors=${report.doorsHosted}/+${report.doorsOrphan} orphan ` +
    `shaft=${report.shaftSnapped ? 'snapped' : 'no-op'} ` +
    `noDefaultOrigin=${report.noDefaultOrigin} ` +
    `stackingClusters=${report.stackingClusters}`
  );

  if (process.env.PHASE_8_HARD_FAIL === '1') {
    const fails = [];
    if (report.noDefaultOrigin > 0) fails.push(`noDefaultOrigin=${report.noDefaultOrigin}`);
    if (report.doorsOrphan > 0)     fails.push(`doorsOrphan=${report.doorsOrphan}`);
    if (report.wallsIntersectingHost > 0) fails.push(`wallsIntersectingHost=${report.wallsIntersectingHost}`);
    if (report.stackingClusters > 0) fails.push(`stackingClusters=${report.stackingClusters}`);
    if (fails.length) throw new Error(`Phase 8 hard-fail: ${fails.join(', ')}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §8.2 — SPACE inference (graph cluster + bbox, no name matching)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Cluster TUNNEL_SEGMENTs by:
 *   (a) shared topology-graph nodes (entry_node / exit_node), AND
 *   (b) spatial proximity ≤ SEGMENT_PROXIMITY_M between any segment endpoints.
 *
 * Each cluster becomes an SPACE element with placement.origin = bbox centre at
 * minZ and properties.bbox carrying the full {minX,maxX,minY,maxY,minZ,maxZ}.
 *
 * Names are LABELS ONLY — derived after clustering by intersecting segment
 * names.  Never used for grouping.
 */
export function inferTunnelSpaces(css, report) {
  const segs = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT'
  );
  if (segs.length === 0) return;

  // Pre-compute endpoints per segment.
  const segEnds = new Map(); // key → { start, end, label, key, container }
  for (const s of segs) {
    const ends = segmentEndpoints(s);
    if (!ends) continue;
    const key = s.element_key || s.id;
    segEnds.set(key, {
      start: ends.start,
      end:   ends.end,
      label: (s.name || '').trim(),
      key,
      container: s.container || null,
    });
  }
  if (segEnds.size === 0) return;

  // Topology graph adjacency by shared node IDs.
  const nodeToBranch = new Map();
  for (const seg of segs) {
    const k = seg.element_key || seg.id;
    const entry = seg.properties?.entry_node;
    const exit  = seg.properties?.exit_node;
    if (entry) {
      if (!nodeToBranch.has(entry)) nodeToBranch.set(entry, []);
      nodeToBranch.get(entry).push(k);
    }
    if (exit) {
      if (!nodeToBranch.has(exit)) nodeToBranch.set(exit, []);
      nodeToBranch.get(exit).push(k);
    }
  }

  // Union-Find over segment keys.
  const parent = new Map();
  for (const k of segEnds.keys()) parent.set(k, k);
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Edge: shared topology node.
  for (const branches of nodeToBranch.values()) {
    if (branches.length < 2) continue;
    for (let i = 1; i < branches.length; i++) union(branches[0], branches[i]);
  }

  // Edge: spatial proximity ≤ SEGMENT_PROXIMITY_M between any endpoints.
  const keys = [...segEnds.keys()];
  for (let i = 0; i < keys.length; i++) {
    const a = segEnds.get(keys[i]);
    for (let j = i + 1; j < keys.length; j++) {
      const b = segEnds.get(keys[j]);
      const d = Math.min(
        vecDist(a.start, b.start),
        vecDist(a.start, b.end),
        vecDist(a.end,   b.start),
        vecDist(a.end,   b.end),
      );
      if (d <= SEGMENT_PROXIMITY_M) union(keys[i], keys[j]);
    }
  }

  // Group by cluster root.
  const clusters = new Map();
  for (const k of keys) {
    const r = find(k);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(k);
  }

  // Don't re-create SPACEs already present (e.g. from BUILDING-domain
  // inferSpaces or ancillary-room synthesis).
  const existingSpaceContainers = new Set();
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() === 'SPACE') {
      if (e.container) existingSpaceContainers.add(e.container);
    }
  }

  const generated = [];
  for (const [rootKey, members] of clusters) {
    if (members.length === 0) continue;

    let minX =  Infinity, maxX = -Infinity;
    let minY =  Infinity, maxY = -Infinity;
    let minZ =  Infinity, maxZ = -Infinity;
    const labelCounts = new Map();
    let labelDominant = '';
    let labelDominantCount = 0;
    let primaryContainer = null;

    for (const k of members) {
      const ends = segEnds.get(k);
      if (!ends) continue;
      for (const p of [ends.start, ends.end]) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
      if (ends.label) {
        const c = (labelCounts.get(ends.label) || 0) + 1;
        labelCounts.set(ends.label, c);
        if (c > labelDominantCount) { labelDominantCount = c; labelDominant = ends.label; }
      }
      if (!primaryContainer && ends.container) primaryContainer = ends.container;
    }

    if (!isFinite(minX)) continue;

    const bboxW = maxX - minX;
    const bboxD = maxY - minY;
    const bboxH = Math.max(maxZ - minZ, 0);
    const volume = bboxW * bboxD * Math.max(bboxH, 1);
    if (bboxW < SPACE_MIN_FOOTPRINT_M) continue;
    if (bboxD < SPACE_MIN_FOOTPRINT_M) continue;
    if (volume < SPACE_MIN_VOLUME_M3) continue;
    if (primaryContainer && existingSpaceContainers.has(primaryContainer)) continue;

    const containerId = primaryContainer || rootKey;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    generated.push({
      id: `phase8-space-${containerId}`,
      element_key: `phase8-space-${containerId}`,
      type: 'SPACE',
      semanticType: 'IfcSpace',
      name: labelDominant || `Tunnel Space (${containerId})`,
      confidence: 0.55,
      source: 'PHASE_8_SPATIAL',
      container: containerId,
      placement: {
        origin: { x: cx, y: cy, z: minZ },
        axis: { x: 0, y: 0, z: 1 },
        refDirection: { x: 1, y: 0, z: 0 },
      },
      geometry: {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: Math.max(bboxH, 2.0),
        profile: { type: 'RECTANGLE', width: bboxW, height: bboxD },
      },
      material: { name: 'space', color: [0.88, 0.88, 0.95], transparency: 0.7 },
      properties: {
        bbox: { minX, maxX, minY, maxY, minZ, maxZ },
        memberSegmentKeys: [...members],
        labelDominant: labelDominant || null,
        usage: 'TUNNEL',
        synthesizedBy: 'phase8',
      },
      relationships: [],
    });
  }

  if (generated.length > 0) {
    css.elements.push(...generated);
    report.spacesCreated += generated.length;
  }

  // Stamp bbox on existing SPACEs that don't have one yet (so 8.3/8.5 can
  // anchor against them universally).
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'SPACE') continue;
    if (e.properties?.bbox) { report.spacesWithBBox++; continue; }
    const inferred = bboxFromSpace(e);
    if (!inferred) continue;
    if (!e.properties) e.properties = {};
    e.properties.bbox = inferred;
    report.spacesWithBBox++;
  }
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
  // fall back to placement.origin ± axis × depth/2
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

function bboxFromSpace(space) {
  const o = space.placement?.origin;
  const prof = space.geometry?.profile;
  const depth = Number(space.geometry?.depth);
  if (!o || !prof || !Number.isFinite(prof.width) || !Number.isFinite(prof.height)) return null;
  const w = prof.width, d = prof.height;
  const halfW = w / 2, halfD = d / 2;
  return {
    minX: o.x - halfW, maxX: o.x + halfW,
    minY: o.y - halfD, maxY: o.y + halfD,
    minZ: Number.isFinite(o.z) ? o.z : 0,
    maxZ: Number.isFinite(o.z) ? o.z + (Number.isFinite(depth) ? depth : 3.0) : 3.0,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// §8.3 — SLAB / COVERING placement
// ──────────────────────────────────────────────────────────────────────────

/**
 * For each SPACE with a bbox:
 *   - Floor slab origin.z = bbox.minZ; size = bbox extents.
 *   - Ceiling covering origin.z = bbox.maxZ - COVERING_THICKNESS_M.
 *
 * Replace ONLY existing slabs/coverings whose origin is near (0,0,0) AND
 * whose container matches the SPACE.  Anything else is left alone (per §8.3:
 * "Replace ONLY elements with origin near (0,0,0) AND same container").
 */
export function placeSlabsAndCoverings(css, report) {
  const spaces = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'SPACE' && e.properties?.bbox
  );
  if (spaces.length === 0) return;

  const slabsByContainer = new Map();
  const coveringsByContainer = new Map();
  for (const e of css.elements) {
    const t = (e.type || '').toUpperCase();
    const c = e.container || '__none__';
    if (t === 'SLAB') {
      if (!slabsByContainer.has(c)) slabsByContainer.set(c, []);
      slabsByContainer.get(c).push(e);
    } else if (t === 'COVERING') {
      if (!coveringsByContainer.has(c)) coveringsByContainer.set(c, []);
      coveringsByContainer.get(c).push(e);
    }
  }

  const generated = [];

  for (const space of spaces) {
    const bbox = space.properties.bbox;
    if (!bbox) continue;
    const containerId = space.container || space.element_key || space.id;
    // Phase 8: keys must include the SPACE's own identity, otherwise multiple
    // SPACEs that share a container (typical for tunnel renders where every
    // SPACE lives on level-0) collide on phase8-floor-<container>.
    const spaceKey = space.element_key || space.id || containerId;
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const w  = bbox.maxX - bbox.minX;
    const d  = bbox.maxY - bbox.minY;

    // ── floor slab ─────────────────────────────────────────────
    const existingSlabs = slabsByContainer.get(containerId) || [];
    const orphanFloor = existingSlabs.find(s =>
      isOrphanOrigin(s.placement?.origin) &&
      ((s.properties?.slabType || '').toUpperCase() !== 'ROOF')
    );
    const hasGoodFloor = existingSlabs.some(s =>
      !isOrphanOrigin(s.placement?.origin) &&
      (s.properties?.slabType || '').toUpperCase() !== 'ROOF'
    );

    const floorOrigin = { x: cx, y: cy, z: bbox.minZ };
    if (orphanFloor) {
      orphanFloor.placement = orphanFloor.placement || {};
      orphanFloor.placement.origin = floorOrigin;
      orphanFloor.placement.axis = { x: 0, y: 0, z: 1 };
      orphanFloor.placement.refDirection = { x: 1, y: 0, z: 0 };
      orphanFloor.geometry = orphanFloor.geometry || {};
      orphanFloor.geometry.method = 'EXTRUSION';
      orphanFloor.geometry.direction = { x: 0, y: 0, z: 1 };
      orphanFloor.geometry.depth = SLAB_THICKNESS_M;
      orphanFloor.geometry.profile = { type: 'RECTANGLE', width: w, height: d };
      orphanFloor.properties = orphanFloor.properties || {};
      orphanFloor.properties.slabType = 'FLOOR';
      orphanFloor.properties.relocatedBy = 'phase8';
      report.slabsReplaced++;
      report.slabsPlaced++;
    } else if (!hasGoodFloor) {
      generated.push({
        id: `phase8-floor-${spaceKey}`,
        element_key: `phase8-floor-${spaceKey}`,
        type: 'SLAB', name: 'Floor Slab', semanticType: 'IfcSlab',
        confidence: 0.55, source: 'PHASE_8_SPATIAL', container: containerId,
        placement: {
          origin: floorOrigin,
          axis: { x: 0, y: 0, z: 1 },
          refDirection: { x: 1, y: 0, z: 0 },
        },
        geometry: {
          method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 },
          depth: SLAB_THICKNESS_M,
          profile: { type: 'RECTANGLE', width: w, height: d },
        },
        material: { name: 'concrete_floor', color: [0.65, 0.65, 0.65], transparency: 0 },
        properties: {
          slabType: 'FLOOR',
          spaceKey: space.element_key || space.id,
          synthesizedBy: 'phase8',
        },
        relationships: [],
      });
      report.slabsPlaced++;
    }

    // ── ceiling covering ───────────────────────────────────────
    const existingCoverings = coveringsByContainer.get(containerId) || [];
    const orphanCovering = existingCoverings.find(c => isOrphanOrigin(c.placement?.origin));
    const hasGoodCovering = existingCoverings.some(c => !isOrphanOrigin(c.placement?.origin));

    const ceilZ = bbox.maxZ - COVERING_THICKNESS_M;
    const ceilOrigin = { x: cx, y: cy, z: ceilZ };
    if (orphanCovering) {
      orphanCovering.placement = orphanCovering.placement || {};
      orphanCovering.placement.origin = ceilOrigin;
      orphanCovering.placement.axis = { x: 0, y: 0, z: 1 };
      orphanCovering.placement.refDirection = { x: 1, y: 0, z: 0 };
      orphanCovering.geometry = orphanCovering.geometry || {};
      orphanCovering.geometry.method = 'EXTRUSION';
      orphanCovering.geometry.direction = { x: 0, y: 0, z: 1 };
      orphanCovering.geometry.depth = COVERING_THICKNESS_M;
      orphanCovering.geometry.profile = { type: 'RECTANGLE', width: w, height: d };
      orphanCovering.properties = orphanCovering.properties || {};
      orphanCovering.properties.relocatedBy = 'phase8';
      report.coveringsReplaced++;
      report.coveringsPlaced++;
    } else if (!hasGoodCovering) {
      generated.push({
        id: `phase8-ceiling-${spaceKey}`,
        element_key: `phase8-ceiling-${spaceKey}`,
        type: 'COVERING', name: 'Ceiling Covering', semanticType: 'IfcCovering',
        confidence: 0.55, source: 'PHASE_8_SPATIAL', container: containerId,
        placement: {
          origin: ceilOrigin,
          axis: { x: 0, y: 0, z: 1 },
          refDirection: { x: 1, y: 0, z: 0 },
        },
        geometry: {
          method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 },
          depth: COVERING_THICKNESS_M,
          profile: { type: 'RECTANGLE', width: w, height: d },
        },
        material: { name: 'gypsum', color: [0.85, 0.85, 0.85], transparency: 0 },
        properties: {
          coveringType: 'CEILING',
          spaceKey: space.element_key || space.id,
          synthesizedBy: 'phase8',
        },
        relationships: [],
      });
      report.coveringsPlaced++;
    }
  }

  if (generated.length > 0) css.elements.push(...generated);
}

function isOrphanOrigin(o) {
  if (!o || typeof o !== 'object') return true;
  const x = Number(o.x), y = Number(o.y), z = Number(o.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return true;
  return (
    Math.abs(x) < ORIGIN_ZERO_TOL_M &&
    Math.abs(y) < ORIGIN_ZERO_TOL_M &&
    Math.abs(z) < ORIGIN_ZERO_TOL_M
  );
}

// ──────────────────────────────────────────────────────────────────────────
// §8.4 — Wall alignment (STRICT, no synthesis)
// ──────────────────────────────────────────────────────────────────────────

/**
 * For each WALL whose container points at a TUNNEL_SEGMENT:
 *   - Compute segment direction vector and perpendicular normal.
 *   - Snap wall to centerline ± (tunnel_width / 2).
 *   - Align wall refDirection to the segment direction (so the wall runs
 *     parallel to the segment, not across it).
 *   - If the wall's footprint still intersects the tunnel BREP by > 0.05 m
 *     after snap, tag spatialFlag = WALL_INTERSECTS_HOST.
 *
 * Never synthesizes new walls.
 */
export function alignWalls(css, report) {
  const segIndex = new Map();
  for (const e of (css.elements || [])) {
    if ((e.type || '').toUpperCase() !== 'TUNNEL_SEGMENT') continue;
    const k = e.element_key || e.id;
    if (k) segIndex.set(k, e);
  }
  if (segIndex.size === 0) return;

  for (const wall of (css.elements || [])) {
    if ((wall.type || '').toUpperCase() !== 'WALL') continue;
    const host = segIndex.get(wall.container);
    if (!host) continue;

    const ends = segmentEndpoints(host);
    if (!ends) continue;
    const segDir = vecNormalize(vecSub(ends.end, ends.start));
    if (!segDir) continue;

    // Tunnel cross-section width.  Profile width is along the lateral axis.
    const segWidth = Number(host.geometry?.profile?.width) || 0;
    if (segWidth <= 0) continue;

    const halfW = segWidth / 2;

    // Lateral direction = horizontal-perpendicular to segDir.
    const up = { x: 0, y: 0, z: 1 };
    let lateral = vecNormalize(vecCross(segDir, up));
    if (!lateral) {
      // segment is vertical — pick global X as lateral
      lateral = { x: 1, y: 0, z: 0 };
    }

    // Project wall origin onto the segment centerline.
    const o = wall.placement?.origin;
    if (!o) continue;
    const v = vecSub(o, ends.start);
    const along = vecDot(v, segDir);
    const onCenterline = vecAdd(ends.start, vecScale(segDir, Math.max(0, Math.min(along, vecLen(vecSub(ends.end, ends.start))))));

    // Decide which side of the centerline this wall is on.  Use existing
    // perpendicular offset sign; if the wall is exactly on the axis, default
    // to +lateral.
    const perpVec = vecSub(o, onCenterline);
    const perpDot = vecDot(perpVec, lateral);
    const sign = perpDot >= 0 ? 1 : -1;

    const snapped = vecAdd(onCenterline, vecScale(lateral, sign * halfW));
    snapped.z = o.z; // keep wall vertical placement intact

    wall.placement.origin = { x: snapped.x, y: snapped.y, z: snapped.z };
    // refDirection runs along the segment; profile width is along refDirection.
    wall.placement.refDirection = { x: segDir.x, y: segDir.y, z: 0 };
    if (!wall.placement.axis) wall.placement.axis = { x: 0, y: 0, z: 1 };

    report.wallsAligned++;

    // Intersection check: the wall shouldn't sit IN the tunnel.  Half-width
    // on each side is the cleanly-aligned spot; if the wall thickness would
    // push its inner face past the centerline it clips the host bore.
    const wallThk = canonicalWallThickness(wall) || 0;
    const innerOffset = halfW - wallThk;
    if (innerOffset < -WALL_INTERSECT_TOL_M) {
      if (!wall.properties) wall.properties = {};
      wall.properties.spatialFlag = 'WALL_INTERSECTS_HOST';
      wall.properties.spatialIntersectionM = +(-innerOffset).toFixed(4);
      report.wallsIntersectingHost++;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §8.5 — Door embedding (assign hostWallKey + project)
// ──────────────────────────────────────────────────────────────────────────

/**
 * For each DOOR:
 *   - If properties.hostWallKey is missing, find the nearest WALL within
 *     DOOR_HOST_RADIUS_M and assign it.
 *   - Project door origin onto the wall plane and align door refDirection to
 *     the wall normal so generate's panel-and-void logic emits a clean cut.
 *   - If no wall is within radius, tag spatialFlag = DOOR_NO_HOST and bump
 *     report.doorsOrphan.
 */
export function embedDoors(css, report) {
  const walls = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'WALL' && e.placement?.origin
  );
  if (walls.length === 0) return;

  // Pre-compute wall lines.
  const wallLines = walls.map(w => {
    const dir = canonicalWallDirection(w) || { x: 1, y: 0, z: 0 };
    const len = canonicalWallLength(w) || 0;
    const o = w.placement.origin;
    return {
      wall: w,
      origin: { x: o.x, y: o.y, z: o.z },
      dir,
      halfLen: len / 2,
      key: w.element_key || w.id,
    };
  });

  for (const door of (css.elements || [])) {
    if ((door.type || '').toUpperCase() !== 'DOOR') continue;

    const o = door.placement?.origin;
    if (!o) continue;

    let hostKey = door.properties?.hostWallKey || null;
    let bestLine = null;

    if (hostKey) {
      bestLine = wallLines.find(l => l.key === hostKey) || null;
    }

    if (!bestLine) {
      // Nearest wall within DOOR_HOST_RADIUS_M, measured to the wall's
      // infinite axis line clamped to its half-length.
      let bestD = Infinity;
      for (const line of wallLines) {
        const d = pointToWallSegmentDist(o, line);
        if (d < bestD) { bestD = d; bestLine = line; }
      }
      if (!bestLine || bestD > DOOR_HOST_RADIUS_M) {
        if (!door.properties) door.properties = {};
        door.properties.spatialFlag = 'DOOR_NO_HOST';
        door.properties.spatialNearestDistM = bestLine ? +bestD.toFixed(4) : null;
        report.doorsOrphan++;
        continue;
      }
      hostKey = bestLine.key;
    }

    if (!door.properties) door.properties = {};
    door.properties.hostWallKey = hostKey;

    // Project the door onto the wall plane.
    const projected = projectPointOntoWall(o, bestLine);
    door.placement.origin = projected;

    // Door refDirection = wall direction (panel runs along the wall).
    door.placement.refDirection = {
      x: bestLine.dir.x, y: bestLine.dir.y, z: 0,
    };
    if (!door.placement.axis) door.placement.axis = { x: 0, y: 0, z: 1 };

    report.doorsHosted++;
  }
}

function pointToWallSegmentDist(p, line) {
  const dx = p.x - line.origin.x;
  const dy = p.y - line.origin.y;
  // Project onto wall direction
  const along = dx * line.dir.x + dy * line.dir.y;
  const clamped = Math.max(-line.halfLen, Math.min(line.halfLen, along));
  const px = line.origin.x + line.dir.x * clamped;
  const py = line.origin.y + line.dir.y * clamped;
  const ex = p.x - px, ey = p.y - py;
  return Math.sqrt(ex * ex + ey * ey);
}

function projectPointOntoWall(p, line) {
  const dx = p.x - line.origin.x;
  const dy = p.y - line.origin.y;
  const along = dx * line.dir.x + dy * line.dir.y;
  const clamped = Math.max(-line.halfLen, Math.min(line.halfLen, along));
  return {
    x: line.origin.x + line.dir.x * clamped,
    y: line.origin.y + line.dir.y * clamped,
    z: Number.isFinite(p.z) ? p.z : line.origin.z,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// §8.6 — Shaft snap to nearest junction + ensure intersection
// ──────────────────────────────────────────────────────────────────────────

/**
 * Find the existing vertical-shaft element (created earlier by
 * synthesizeVerticalShaft) and:
 *   1. Snap its XY to the nearest topology junction node within 10 m.
 *   2. Ensure the shaft base intersects the tunnel — if the shaft's lower
 *      mouth is above the closest segment's interior, lower the shaft origin
 *      so they overlap by at least 0.5 m.
 *   3. Default geometry.depth to 30 m if missing or zero.
 *   4. Stamp properties.junctionNodeId so generate can emit
 *      IfcRelConnectsElements (shaft ↔ tunnel).
 */
export function snapShaft(css, report) {
  const elements = css.elements || [];
  const shaft = elements.find(e =>
    e.properties?.segmentType === 'VERTICAL_SHAFT' ||
    /vertical[-_ ]?shaft/i.test(e.name || '') ||
    /vertical[-_ ]?shaft/i.test(e.id || '') ||
    e.properties?.synthesizedBy === 'VERTICAL_SHAFT'
  );
  if (!shaft) return;

  const segs = elements.filter(e => (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT');
  if (segs.length === 0) return;

  // 1. Snap to nearest junction node (degree ≥ 3).
  const junctions = (css.topology?.nodes || []).filter(n => (n.degree || 0) >= 3 && n.xyz);
  const o = shaft.placement?.origin;
  if (o && junctions.length > 0) {
    let best = null;
    let bestD = Infinity;
    for (const j of junctions) {
      const d = vecDist(o, j.xyz);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best && bestD <= SHAFT_JUNCTION_RADIUS_M) {
      shaft.placement.origin = { x: best.xyz.x, y: best.xyz.y, z: o.z };
      if (!shaft.properties) shaft.properties = {};
      shaft.properties.junctionNodeId = best.id;
      report.shaftJunctionNodeId = best.id;
      report.shaftSnapped = true;
    }
  }

  // 3. Set default depth if missing.
  if (!shaft.geometry) shaft.geometry = {};
  let depth = Number(shaft.geometry.depth);
  if (!Number.isFinite(depth) || depth <= 0) {
    shaft.geometry.depth = SHAFT_DEFAULT_DEPTH_M;
    report.shaftDepthDefaulted = true;
    depth = SHAFT_DEFAULT_DEPTH_M;
  }

  // 2. Ensure vertical intersection with tunnel: pick the closest segment by
  //    XY distance and lower the shaft origin so its lower mouth overlaps the
  //    segment's interior by at least 0.5 m.
  const so = shaft.placement?.origin;
  if (so) {
    let bestSeg = null;
    let bestSegD = Infinity;
    for (const s of segs) {
      const sp = s.properties?.startPoint;
      const ep = s.properties?.endPoint;
      if (!sp || !ep) continue;
      const mid = { x: (sp.x + ep.x) / 2, y: (sp.y + ep.y) / 2, z: ((sp.z ?? 0) + (ep.z ?? 0)) / 2 };
      const dx = so.x - mid.x, dy = so.y - mid.y;
      const d2d = Math.sqrt(dx * dx + dy * dy);
      if (d2d < bestSegD) { bestSegD = d2d; bestSeg = s; }
    }
    if (bestSeg) {
      const segH = Number(bestSeg.geometry?.profile?.height) || 4.0;
      const segMidZ = ((bestSeg.properties?.startPoint?.z ?? 0) + (bestSeg.properties?.endPoint?.z ?? 0)) / 2;
      const segCeilZ = segMidZ + segH / 2;
      // Shaft is extruded along +Z from its origin, so its lower mouth is at
      // origin.z and its top at origin.z + depth.  The lower mouth needs to
      // sit at or below segCeilZ - 0.5 to guarantee intersection.
      const requiredLowerZ = segCeilZ - 0.5;
      if (so.z > requiredLowerZ) {
        so.z = requiredLowerZ;
        if (!shaft.properties) shaft.properties = {};
        shaft.properties.shaftBaseAdjusted = true;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §8.8 — validators + counters
// ──────────────────────────────────────────────────────────────────────────

function runValidators(css, report) {
  const elements = css.elements || [];

  // noDefaultOrigin — count spatial elements at (0,0,0).
  const SPATIAL_TYPES = new Set([
    'SPACE', 'SLAB', 'COVERING', 'WALL', 'DOOR', 'EQUIPMENT',
    'TUNNEL_SEGMENT', 'DUCT', 'DUCT_FITTING', 'SHAFT',
  ]);
  for (const e of elements) {
    const t = (e.type || '').toUpperCase();
    if (!SPATIAL_TYPES.has(t)) continue;
    if (e.properties?.isPortalHelper) continue;
    if (isOrphanOrigin(e.placement?.origin)) report.noDefaultOrigin++;
  }

  // slabsCorrectZ — slab.origin.z within 0.5m of containing space's bbox.minZ
  // (or bbox.maxZ for ROOF slabs).
  const spaceByContainer = new Map();
  for (const e of elements) {
    if ((e.type || '').toUpperCase() === 'SPACE' && e.properties?.bbox) {
      const c = e.container;
      if (c) spaceByContainer.set(c, e);
    }
  }
  for (const e of elements) {
    const t = (e.type || '').toUpperCase();
    if (t !== 'SLAB') continue;
    const space = spaceByContainer.get(e.container);
    if (!space) continue;
    const z = Number(e.placement?.origin?.z);
    if (!Number.isFinite(z)) continue;
    const bbox = space.properties.bbox;
    const isRoof = (e.properties?.slabType || '').toUpperCase() === 'ROOF';
    const target = isRoof ? bbox.maxZ : bbox.minZ;
    if (Math.abs(z - target) <= 0.5) report.slabsCorrectZ++;
  }

  // stackingClusters — cluster origins within 0.5 m and flag clusters of >2.
  const points = [];
  for (const e of elements) {
    const t = (e.type || '').toUpperCase();
    if (!SPATIAL_TYPES.has(t)) continue;
    const o = e.placement?.origin;
    if (!o || !Number.isFinite(o.x)) continue;
    if (t === 'TUNNEL_SEGMENT') continue; // segments naturally cluster at junctions
    points.push({ key: e.element_key || e.id, type: t, o });
  }
  const visited = new Array(points.length).fill(false);
  for (let i = 0; i < points.length; i++) {
    if (visited[i]) continue;
    const cluster = [i];
    visited[i] = true;
    for (let j = i + 1; j < points.length; j++) {
      if (visited[j]) continue;
      if (vecDist(points[i].o, points[j].o) <= STACKING_CLUSTER_RADIUS_M) {
        cluster.push(j);
        visited[j] = true;
      }
    }
    if (cluster.length >= STACKING_CLUSTER_MIN) {
      report.stackingClusters++;
      if (report.stackingClusterDetail.length < 10) {
        report.stackingClusterDetail.push({
          centre: points[cluster[0]].o,
          size: cluster.length,
          members: cluster.map(idx => `${points[idx].type}:${points[idx].key}`),
        });
      }
    }
  }
}
