import { safe, clamp, elemId, vecNormalize, vecDot, vecCross, vecScale, vecAdd, vecSub, vecDist, vecLen, canonicalWallDirection, canonicalWallLength, canonicalWallThickness, setCanonicalWallLength, storeyHeightFromOccupancy, shellThicknessFromProfile } from './shared.mjs';
import { CONFIDENCE } from './config.mjs';
import { logDecision } from '@builting/audit';

/**
 * Data-driven tunnel detection — check for TUNNEL_SEGMENT elements rather than
 * relying on the domain string, so hybrid structures and mis-classified domains
 * are handled correctly. Cached on the css object to avoid repeated O(n) scans.
 */
function hasTunnelSegments(css) {
  if (css._hasTunnelSegmentsCache !== undefined) return css._hasTunnelSegmentsCache;
  const result = (css.elements || []).some(e => e.type === 'TUNNEL_SEGMENT');
  // Cache on object so repeated calls within one pipeline pass are free
  Object.defineProperty(css, '_hasTunnelSegmentsCache', { value: result, writable: true, configurable: true });
  return result;
}

// ============================================================================
// BUILDING ENVELOPE GUARANTEE (non-TUNNEL)
// ============================================================================

function guaranteeBuildingEnvelope(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const levels = css.levelsOrSegments || [];
  // Derive default storey height from occupancy rather than assuming 3m.
  const _occupancy = (css.facilityMeta || css.metadata?.facilityMeta || {}).occupancy || '';
  const _defaultH = storeyHeightFromOccupancy(_occupancy);
  const defaultLevel = levels[0] || { id: 'level-1', elevation_m: 0, height_m: _defaultH };
  const allWalls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');

  // Build storey metadata
  const storeyInfo = {};
  for (const level of levels) {
    storeyInfo[level.id] = { elevation: level.elevation_m || 0, height: level.height_m || _defaultH };
  }
  if (!storeyInfo[defaultLevel.id]) {
    storeyInfo[defaultLevel.id] = { elevation: 0, height: defaultLevel.height_m || _defaultH };
  }

  // Group walls and slabs by container
  const wallsByContainer = new Map();
  const slabsByContainer = new Map();
  for (const e of css.elements) {
    const c = e.container || defaultLevel.id;
    const t = (e.type || '').toUpperCase();
    if (t === 'WALL') {
      if (!wallsByContainer.has(c)) wallsByContainer.set(c, []);
      wallsByContainer.get(c).push(e);
    } else if (t === 'SLAB') {
      if (!slabsByContainer.has(c)) slabsByContainer.set(c, []);
      slabsByContainer.get(c).push(e);
    }
  }

  // Compute global bbox from WALLS only — prevents equipment/MEP from inflating
  // the building footprint, which would cause slabs and roof to overshoot.
  let gMinX = Infinity, gMaxX = -Infinity, gMinY = Infinity, gMaxY = -Infinity;
  for (const w of allWalls) {
    const o = w.placement?.origin;
    if (!o) continue;
    const dir = canonicalWallDirection(w);
    const len = canonicalWallLength(w);
    if (dir && len > 0) {
      const s = vecAdd(o, vecScale(dir, -len / 2));
      const e = vecAdd(o, vecScale(dir, len / 2));
      gMinX = Math.min(gMinX, s.x, e.x); gMaxX = Math.max(gMaxX, s.x, e.x);
      gMinY = Math.min(gMinY, s.y, e.y); gMaxY = Math.max(gMaxY, s.y, e.y);
    } else {
      if (o.x < gMinX) gMinX = o.x; if (o.x > gMaxX) gMaxX = o.x;
      if (o.y < gMinY) gMinY = o.y; if (o.y > gMaxY) gMaxY = o.y;
    }
  }
  // Fallback to all elements if no walls have geometry yet
  if (!isFinite(gMinX)) {
    for (const e of css.elements) {
      const o = e.placement?.origin;
      if (!o) continue;
      if (o.x < gMinX) gMinX = o.x; if (o.x > gMaxX) gMaxX = o.x;
      if (o.y < gMinY) gMinY = o.y; if (o.y > gMaxY) gMaxY = o.y;
    }
  }
  if (!isFinite(gMinX)) return;

  const BOUNDARY_TOL = 0.5;
  for (const wall of allWalls) {
    if (wall.properties?.isExternal) continue;
    const wo = wall.placement?.origin;
    if (!wo) continue;
    const atBoundary = (
      Math.abs(wo.x - gMinX) < BOUNDARY_TOL || Math.abs(wo.x - gMaxX) < BOUNDARY_TOL ||
      Math.abs(wo.y - gMinY) < BOUNDARY_TOL || Math.abs(wo.y - gMaxY) < BOUNDARY_TOL
    );
    if (atBoundary) {
      if (!wall.properties) wall.properties = {};
      wall.properties.isExternal = true;
      wall.properties._externalInferred = true;
    }
  }

  const generated = [];

  // Process each container independently
  const containers = new Set(levels.map(l => l.id));
  if (containers.size === 0) containers.add(defaultLevel.id);

  for (const containerId of containers) {
    const containerWalls = wallsByContainer.get(containerId) || [];
    const containerSlabs = slabsByContainer.get(containerId) || [];
    const info = storeyInfo[containerId] || { elevation: 0, height: _defaultH };
    const storeyZ = info.elevation;
    const storeyH = info.height;

    // Compute per-container bbox from walls in this container
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const w of containerWalls) {
      const o = w.placement?.origin;
      if (!o) continue;
      const dir = canonicalWallDirection(w);
      const len = canonicalWallLength(w);
      if (dir) {
        const s = vecAdd(o, vecScale(dir, -len / 2));
        const e = vecAdd(o, vecScale(dir, len / 2));
        minX = Math.min(minX, s.x, e.x); maxX = Math.max(maxX, s.x, e.x);
        minY = Math.min(minY, s.y, e.y); maxY = Math.max(maxY, s.y, e.y);
      } else {
        minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x);
        minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y);
      }
    }

    // If no walls in container, use global bbox as fallback for this container
    if (!isFinite(minX)) {
      minX = gMinX; maxX = gMaxX; minY = gMinY; maxY = gMaxY;
    }

    const bboxW = Math.max(maxX - minX, 3.0);
    const bboxD = Math.max(maxY - minY, 3.0);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Generate fallback walls if this container has fewer than 4
    const extWalls = containerWalls.filter(w => w.properties?.isExternal);
    if (extWalls.length < 4 && containerWalls.length < 4) {
      const wallThickness = 0.25;
      const wallDefs = [
        { name: `North Wall`, ox: centerX, oy: maxY, dirX: 1, dirY: 0, len: bboxW },
        { name: `South Wall`, ox: centerX, oy: minY, dirX: 1, dirY: 0, len: bboxW },
        { name: `East Wall`, ox: maxX, oy: centerY, dirX: 0, dirY: 1, len: bboxD },
        { name: `West Wall`, ox: minX, oy: centerY, dirX: 0, dirY: 1, len: bboxD },
      ];
      for (const wd of wallDefs) {
        generated.push({
          id: `env-wall-${containerId}-${wd.name.toLowerCase().replace(/\s/g, '-')}`,
          element_key: `env-wall-${containerId}-${wd.name.toLowerCase().replace(/\s/g, '-')}`,
          type: 'WALL', name: wd.name, semanticType: 'IfcWall',
          confidence: 0.4, source: 'ENVELOPE_FALLBACK', container: containerId,
          placement: {
            origin: { x: wd.ox, y: wd.oy, z: storeyZ },
            axis: { x: 0, y: 0, z: 1 },
            refDirection: { x: wd.dirX, y: wd.dirY, z: 0 }
          },
          geometry: {
            method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 },
            depth: storeyH, profile: { type: 'RECTANGLE', width: wd.len, height: wallThickness }
          },
          material: { name: 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 },
          properties: { isExternal: true, isFallback: true, isApproximation: true },
          relationships: []
        });
      }
    }

    // Generate floor slab if missing for this container
    const hasFloor = containerSlabs.some(s => !s.properties?.slabType || s.properties.slabType === 'FLOOR');
    if (!hasFloor) {
      generated.push({
        id: `env-floor-slab-${containerId}`, element_key: `env-floor-slab-${containerId}`,
        type: 'SLAB', name: 'Floor Slab', semanticType: 'IfcSlab',
        confidence: 0.4, source: 'ENVELOPE_FALLBACK', container: containerId,
        placement: {
          origin: { x: centerX, y: centerY, z: storeyZ },
          axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 }
        },
        geometry: {
          method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: 0.2,
          profile: { type: 'RECTANGLE', width: bboxW, height: bboxD }
        },
        material: { name: 'concrete_floor', color: [0.65, 0.65, 0.65], transparency: 0 },
        properties: { slabType: 'FLOOR', isFallback: true, isApproximation: true },
        relationships: []
      });
      logDecision({ pass: 'guaranteeBuildingEnvelope', element_id: `env-floor-slab-${containerId}`,
        action: 'element_created', reason: 'envelope_fallback',
        params: { slabType: 'FLOOR', containerId, isFallback: true, confidence: 0.4 } });
    }
  }

  // Safety net: if NO floor slab exists across ALL containers, force one at the global footprint
  const anyFloor = css.elements.some(e =>
    (e.type || '').toUpperCase() === 'SLAB' &&
    (!e.properties?.slabType || e.properties.slabType === 'FLOOR')
  ) || generated.some(e => e.properties?.slabType === 'FLOOR');
  if (!anyFloor) {
    const floorBboxW = Math.max(gMaxX - gMinX, 3.0);
    const floorBboxD = Math.max(gMaxY - gMinY, 3.0);
    // Use median wall base Z for floor elevation
    const wallBasesAll = [];
    for (const w of allWalls) {
      const wz = w.placement?.origin?.z;
      if (typeof wz === 'number') wallBasesAll.push(wz);
    }
    const floorZ = wallBasesAll.length > 0
      ? wallBasesAll.sort((a, b) => a - b)[Math.floor(wallBasesAll.length / 2)]
      : 0;
    generated.push({
      id: 'env-floor-safety', element_key: 'env-floor-safety',
      type: 'SLAB', name: 'Floor Slab', semanticType: 'IfcSlab',
      confidence: 0.4, source: 'ENVELOPE_FALLBACK', container: defaultLevel.id,
      placement: {
        origin: { x: (gMinX + gMaxX) / 2, y: (gMinY + gMaxY) / 2, z: floorZ },
        axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 }
      },
      geometry: {
        method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: 0.2,
        profile: { type: 'RECTANGLE', width: floorBboxW, height: floorBboxD }
      },
      material: { name: 'concrete_floor', color: [0.65, 0.65, 0.65], transparency: 0 },
      properties: { slabType: 'FLOOR', isFallback: true, isApproximation: true },
      relationships: []
    });
    console.log(`guaranteeBuildingEnvelope: safety-net floor slab at z=${floorZ}`);
  }

  // Roof slab: generate once at the top of the building (last container)
  const allRoofSlabs = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'SLAB' && (e.properties?.slabType || '').toUpperCase() === 'ROOF'
  );
  // Check if existing roof slabs are actually large enough to be visible
  const hasVisibleRoof = allRoofSlabs.some(s => {
    const p = s.geometry?.profile;
    return p && (p.width || 0) > 2.0 && (p.height || 0) > 2.0;
  });
  if (!hasVisibleRoof) {
    const lastLevel = levels.length > 0 ? levels[levels.length - 1] : defaultLevel;
    const roofContainer = lastLevel.id || defaultLevel.id;

    // Compute roof Z from actual wall tops (most reliable), fall back to storey metadata
    let roofZ = null;
    const allWallsForRoof = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
    const wallTops = [];
    for (const w of allWallsForRoof) {
      const wz = w.placement?.origin?.z;
      const wd = w.geometry?.depth;
      if (typeof wz === 'number' && typeof wd === 'number' && wd > 0) {
        wallTops.push(wz + wd);
      }
    }
    if (wallTops.length > 0) {
      wallTops.sort((a, b) => b - a);
      // Use median of top-3 tallest walls
      const topN = wallTops.slice(0, Math.min(3, wallTops.length));
      roofZ = topN[Math.floor(topN.length / 2)];
    }
    if (roofZ === null) {
      roofZ = (lastLevel.elevation_m || 0) + (lastLevel.height_m || _defaultH);
    }

    const bboxW = Math.max(gMaxX - gMinX, 3.0);
    const bboxD = Math.max(gMaxY - gMinY, 3.0);
    generated.push({
      id: 'env-roof-slab', element_key: 'env-roof-slab',
      type: 'SLAB', name: 'Roof Slab', semanticType: 'IfcSlab',
      confidence: 0.4, source: 'ENVELOPE_FALLBACK', container: roofContainer,
      placement: {
        origin: { x: (gMinX + gMaxX) / 2, y: (gMinY + gMaxY) / 2, z: roofZ },
        axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 }
      },
      geometry: {
        method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: 0.2,
        profile: { type: 'RECTANGLE', width: bboxW, height: bboxD }
      },
      material: { name: 'metal_roof', color: [0.4, 0.45, 0.5], transparency: 0 },
      properties: { slabType: 'ROOF', isFallback: true, isApproximation: true },
      relationships: []
    });
    logDecision({ pass: 'guaranteeBuildingEnvelope', element_id: 'env-roof-slab',
      action: 'element_created', reason: 'envelope_fallback',
      params: { slabType: 'ROOF', containerId: roofContainer, isFallback: true, confidence: 0.4 } });
  }

  if (generated.length > 0) {
    for (const ge of generated) {
      ge.provenance = { sourceFile: null, sourceFileStatus: 'derived_inferred', sourceFiles: [], stage: 'topology:guaranteeBuildingEnvelope', modifications: [] };
    }
    css.elements.push(...generated);
    if (!css.metadata) css.metadata = {};
    css.metadata.envelopeFallbackApplied = true;
    css.metadata.envelopeFallback = {
      generatedWalls: generated.filter(e => e.type === 'WALL').length,
      generatedSlabs: generated.filter(e => e.type === 'SLAB').length,
      originalWalls: allWalls.length,
      containersProcessed: containers.size
    };
    console.log(`guaranteeBuildingEnvelope: generated ${generated.length} fallback elements across ${containers.size} container(s)`);
  }
}


// ============================================================================
// ANCILLARY ROOM SLAB SYNTHESIS (TUNNEL renders with DXF walls)
// ============================================================================

/**
 * Synthesize floor and roof slabs for ancillary rooms in tunnel models.
 *
 * Structural tunnel segments get floor slabs from the generate lambda's
 * IFC-level injection. But DXF-walled ancillary rooms (AC room, diesel gen,
 * exhaust chamber, etc.) are plain wall perimeters with no slab synthesis —
 * guaranteeBuildingEnvelope skips them because hasTunnelSegments() is true.
 *
 * For each non-structural container with ≥4 DXF WALL elements:
 *   - Compute the wall-bounded XY bbox
 *   - Create a FLOOR slab at median wall base Z
 *   - Create a ROOF slab at median wall top Z (or base + storey height)
 */
function synthesizeAncillaryRoomSlabs(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (!hasTunnelSegments(css)) return; // only for tunnel renders

  const levels = css.levelsOrSegments || [];
  const defaultLevel = levels[0] || { id: 'level-1', elevation_m: 0 };

  // Group WALL and SLAB elements by container
  const wallsByContainer = new Map();
  const slabsByContainer = new Map();
  for (const e of css.elements) {
    const c = e.container || defaultLevel.id;
    const t = (e.type || '').toUpperCase();
    if (t === 'WALL') {
      if (!wallsByContainer.has(c)) wallsByContainer.set(c, []);
      wallsByContainer.get(c).push(e);
    } else if (t === 'SLAB') {
      if (!slabsByContainer.has(c)) slabsByContainer.set(c, []);
      slabsByContainer.get(c).push(e);
    }
  }

  // Identify tunnel segment containers — skip ALL of them.
  // Any container with a TUNNEL_SEGMENT gets its floor/roof from the generate lambda's
  // IFC-level injection. Previously this only excluded branchClass=STRUCTURAL containers,
  // which allowed the main level-1 container (holding portal building walls) to receive
  // a massive ancillary slab spanning the entire tunnel footprint.
  const structuralContainers = new Set();
  for (const e of css.elements) {
    if (e.type === 'TUNNEL_SEGMENT') {
      const c = e.container || defaultLevel.id;
      structuralContainers.add(c);
      if (e.element_key) structuralContainers.add(e.element_key);
      if (e.id) structuralContainers.add(e.id);
    }
  }

  const SLAB_THICKNESS = 0.20;    // 200mm concrete slab
  const MIN_WALLS = 4;            // closed room needs ≥4 walls
  const MIN_FOOTPRINT = 1.0;      // minimum 1m in each dimension
  const MAX_AREA = 1000;          // reject degenerate bbox > 1000m²
  const MAX_ASPECT_RATIO = 20;    // reject extreme aspect ratios
  const MAX_BORE_MULTIPLIER = 2;  // reject bbox > 2× tunnel bore width

  // Median tunnel bore width — anything wider than 2× this is the whole
  // tunnel envelope masquerading as a room, not an actual room.
  const boreWidths = [];
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'TUNNEL_SEGMENT') continue;
    const w = e.geometry?.profile?.width;
    const r = e.geometry?.profile?.radius;
    const bw = (typeof w === 'number' && w > 0) ? w
             : (typeof r === 'number' && r > 0) ? r * 2 : null;
    if (bw) boreWidths.push(bw);
  }
  const tunnelBoreWidth = boreWidths.length > 0
    ? boreWidths.sort((a, b) => a - b)[Math.floor(boreWidths.length / 2)]
    : null;

  const generated = [];

  for (const [containerId, containerWalls] of wallsByContainer) {
    // Skip structural tunnel segment containers
    if (structuralContainers.has(containerId)) continue;

    // Skip containers that already have both floor and roof slabs
    const existingSlabs = slabsByContainer.get(containerId) || [];
    const hasFloor = existingSlabs.some(s =>
      !s.properties?.slabType || s.properties.slabType === 'FLOOR');
    const hasRoof = existingSlabs.some(s =>
      (s.properties?.slabType || '').toUpperCase() === 'ROOF');
    if (hasFloor && hasRoof) continue;

    // Need enough walls to define a closed room
    if (containerWalls.length < MIN_WALLS) continue;

    // Compute wall-bounded bbox and Z ranges
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const wallBaseZs = [];
    const wallTopZs = [];

    for (const wall of containerWalls) {
      const o = wall.placement?.origin;
      if (!o) continue;

      const wz = o.z;
      if (typeof wz === 'number') {
        wallBaseZs.push(wz);
        const wd = wall.geometry?.depth;
        if (typeof wd === 'number' && wd > 0) {
          wallTopZs.push(wz + wd);
        }
      }

      const dir = canonicalWallDirection(wall);
      const len = canonicalWallLength(wall);
      if (dir && len > 0) {
        const s = vecAdd(o, vecScale(dir, -len / 2));
        const e = vecAdd(o, vecScale(dir, len / 2));
        minX = Math.min(minX, s.x, e.x); maxX = Math.max(maxX, s.x, e.x);
        minY = Math.min(minY, s.y, e.y); maxY = Math.max(maxY, s.y, e.y);
      } else {
        minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x);
        minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y);
      }
    }

    if (!isFinite(minX)) continue;

    const bboxW = maxX - minX;
    const bboxD = maxY - minY;
    if (bboxW < MIN_FOOTPRINT || bboxD < MIN_FOOTPRINT) continue;

    // Sanity checks: reject degenerate geometry
    const area = bboxW * bboxD;
    if (area > MAX_AREA) {
      console.log(`synthesizeAncillaryRoomSlabs: skipping container ${containerId} — bbox area ${area.toFixed(0)}m² exceeds ${MAX_AREA}m² limit`);
      continue;
    }
    const aspectRatio = Math.max(bboxW / bboxD, bboxD / bboxW);
    if (aspectRatio > MAX_ASPECT_RATIO) {
      console.log(`synthesizeAncillaryRoomSlabs: skipping container ${containerId} — aspect ratio ${aspectRatio.toFixed(1)} exceeds ${MAX_ASPECT_RATIO}:1 limit`);
      continue;
    }
    if (tunnelBoreWidth !== null) {
      const maxDim = Math.max(bboxW, bboxD);
      const boreLimit = MAX_BORE_MULTIPLIER * tunnelBoreWidth;
      if (maxDim > boreLimit) {
        console.log(`synthesizeAncillaryRoomSlabs: skipping container ${containerId} — bbox max dimension ${maxDim.toFixed(1)}m exceeds ${MAX_BORE_MULTIPLIER}× tunnel bore width (${boreLimit.toFixed(1)}m). Container spans the tunnel envelope, not a room.`);
        continue;
      }
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Floor Z: median of wall base Z values
    let floorZ = 0;
    if (wallBaseZs.length > 0) {
      const sorted = [...wallBaseZs].sort((a, b) => a - b);
      floorZ = sorted[Math.floor(sorted.length / 2)];
    }

    // Skip containers elevated above ground level — their slabs come from the
    // generate lambda's storey injection, not ancillary synthesis.
    const MAX_ANCILLARY_FLOOR_Z = 2.0;
    if (floorZ > MAX_ANCILLARY_FLOOR_Z) {
      console.log(`synthesizeAncillaryRoomSlabs: skipping container ${containerId} — floorZ ${floorZ.toFixed(2)}m > ${MAX_ANCILLARY_FLOOR_Z}m`);
      continue;
    }

    // Roof Z: median of wall top Z values, fallback to storey height
    let roofZ = null;
    if (wallTopZs.length > 0) {
      const sorted = [...wallTopZs].sort((a, b) => b - a);
      roofZ = sorted[Math.floor(sorted.length / 2)];
    }
    if (roofZ === null) {
      const levelInfo = levels.find(l => l.id === containerId);
      const storeyH = levelInfo?.height_m || 4.0;
      roofZ = floorZ + storeyH;
    }

    if (!hasFloor) {
      generated.push({
        id: `ancillary-floor-${containerId}`,
        element_key: `ancillary-floor-${containerId}`,
        type: 'SLAB', name: 'Floor Slab', semanticType: 'IfcSlab',
        confidence: 0.5, source: 'ANCILLARY_ROOM_SYNTH', container: containerId,
        placement: {
          origin: { x: centerX, y: centerY, z: floorZ },
          axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 }
        },
        geometry: {
          method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: SLAB_THICKNESS,
          profile: { type: 'RECTANGLE', width: bboxW, height: bboxD }
        },
        material: { name: 'concrete_floor', color: [0.65, 0.65, 0.65], transparency: 0 },
        properties: { slabType: 'FLOOR', isAncillaryRoom: true, isApproximation: true },
        relationships: []
      });
    }

    if (!hasRoof) {
      generated.push({
        id: `ancillary-roof-${containerId}`,
        element_key: `ancillary-roof-${containerId}`,
        type: 'SLAB', name: 'Roof Slab', semanticType: 'IfcSlab',
        confidence: 0.5, source: 'ANCILLARY_ROOM_SYNTH', container: containerId,
        placement: {
          origin: { x: centerX, y: centerY, z: roofZ },
          axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 }
        },
        geometry: {
          method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: SLAB_THICKNESS,
          profile: { type: 'RECTANGLE', width: bboxW, height: bboxD }
        },
        material: { name: 'concrete_roof', color: [0.60, 0.60, 0.60], transparency: 0 },
        properties: { slabType: 'ROOF', isAncillaryRoom: true, isApproximation: true },
        relationships: []
      });
    }
  }

  if (generated.length > 0) {
    for (const ge of generated) {
      ge.provenance = { sourceFile: null, sourceFileStatus: 'derived_inferred', sourceFiles: [], stage: 'topology:synthesizeAncillaryRoomSlabs', modifications: [] };
    }
    css.elements.push(...generated);
    if (!css.metadata) css.metadata = {};
    const floorCount = generated.filter(e => e.properties?.slabType === 'FLOOR').length;
    const roofCount = generated.filter(e => e.properties?.slabType === 'ROOF').length;
    const containerCount = new Set(generated.map(e => e.container)).size;
    css.metadata.ancillaryRoomSlabSynthesis = { floorSlabs: floorCount, roofSlabs: roofCount, containersProcessed: containerCount };
    console.log(`synthesizeAncillaryRoomSlabs: created ${generated.length} slabs (${floorCount} floor, ${roofCount} roof) across ${containerCount} ancillary room(s)`);
  }
}


/**
 * For each ancillary room (portal building room) that has a ceiling slab,
 * synthesize one IfcCovering (suspended ceiling finish) just below it.
 * Mirrors the same room-detection logic as synthesizeAncillaryRoomSlabs.
 */
export function synthesizeCoveringElements(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (!hasTunnelSegments(css)) return;

  const COVERING_THICKNESS = 0.057; // 57mm as spec'd
  const MIN_WALLS = 4;
  const MIN_FOOTPRINT = 1.0;
  const MAX_AREA = 1000;
  const MAX_ASPECT_RATIO = 20;

  const levels = css.levelsOrSegments || [];

  const wallsByContainer = new Map();
  const coveringsByContainer = new Map();
  const slabsByContainer = new Map();

  for (const e of css.elements) {
    const c = e.container || (levels[0]?.id || 'level-1');
    const t = (e.type || '').toUpperCase();
    if (t === 'WALL') {
      if (!wallsByContainer.has(c)) wallsByContainer.set(c, []);
      wallsByContainer.get(c).push(e);
    } else if (t === 'COVERING') {
      if (!coveringsByContainer.has(c)) coveringsByContainer.set(c, []);
      coveringsByContainer.get(c).push(e);
    } else if (t === 'SLAB') {
      if (!slabsByContainer.has(c)) slabsByContainer.set(c, []);
      slabsByContainer.get(c).push(e);
    }
  }

  const structuralContainers = new Set();
  for (const e of css.elements) {
    if (e.type === 'TUNNEL_SEGMENT' &&
        (e.properties?.branchClass || '').toUpperCase() === 'STRUCTURAL') {
      if (e.container) structuralContainers.add(e.container);
      if (e.element_key) structuralContainers.add(e.element_key);
      if (e.id) structuralContainers.add(e.id);
    }
  }

  const generated = [];

  for (const [containerId, containerWalls] of wallsByContainer) {
    if (structuralContainers.has(containerId)) continue;
    if ((coveringsByContainer.get(containerId) || []).length > 0) continue;
    if (containerWalls.length < MIN_WALLS) continue;

    // Need a roof slab to anchor the covering to
    const existingSlabs = slabsByContainer.get(containerId) || [];
    const roofSlab = existingSlabs.find(s =>
      (s.properties?.slabType || '').toUpperCase() === 'ROOF' || s.id?.includes('roof'));
    if (!roofSlab) continue;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const wallTopZs = [];

    for (const wall of containerWalls) {
      const o = wall.placement?.origin;
      if (!o) continue;
      const wd = wall.geometry?.depth;
      if (typeof o.z === 'number' && typeof wd === 'number' && wd > 0) {
        wallTopZs.push(o.z + wd);
      }
      const dir = canonicalWallDirection(wall);
      const len = canonicalWallLength(wall);
      if (dir && len > 0) {
        const s = vecAdd(o, vecScale(dir, -len / 2));
        const e = vecAdd(o, vecScale(dir, len / 2));
        minX = Math.min(minX, s.x, e.x); maxX = Math.max(maxX, s.x, e.x);
        minY = Math.min(minY, s.y, e.y); maxY = Math.max(maxY, s.y, e.y);
      } else {
        minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x);
        minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y);
      }
    }

    if (!isFinite(minX)) continue;

    const bboxW = maxX - minX;
    const bboxD = maxY - minY;
    if (bboxW < MIN_FOOTPRINT || bboxD < MIN_FOOTPRINT) continue;
    if (bboxW * bboxD > MAX_AREA) continue;
    if (Math.max(bboxW / bboxD, bboxD / bboxW) > MAX_ASPECT_RATIO) continue;

    // Roof Z from the slab placement, falling back to wall-top median
    let roofZ = roofSlab.placement?.origin?.z;
    if (roofZ == null && wallTopZs.length > 0) {
      const sorted = [...wallTopZs].sort((a, b) => b - a);
      roofZ = sorted[Math.floor(sorted.length / 2)];
    }
    if (roofZ == null) continue;

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    generated.push({
      id: `ancillary-ceiling-covering-${containerId}`,
      element_key: `ancillary-ceiling-covering-${containerId}`,
      type: 'COVERING',
      name: 'Ceiling Covering',
      semanticType: 'IfcCovering',
      confidence: 0.6,
      source: 'ANCILLARY_ROOM_SYNTH',
      container: containerId,
      placement: {
        origin: { x: centerX, y: centerY, z: roofZ - COVERING_THICKNESS },
        axis: { x: 0, y: 0, z: 1 },
        refDirection: { x: 1, y: 0, z: 0 },
      },
      geometry: {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: COVERING_THICKNESS,
        profile: { type: 'RECTANGLE', width: bboxW, height: bboxD },
      },
      material: { name: 'ceiling_tile', color: [0.95, 0.95, 0.93], transparency: 0 },
      properties: { coveringType: 'CEILING', isAncillaryRoom: true, isApproximation: true },
      relationships: [],
    });
  }

  if (generated.length > 0) {
    for (const ge of generated) {
      ge.provenance = { sourceFile: null, sourceFileStatus: 'derived_inferred', sourceFiles: [], stage: 'topology:synthesizeCoveringElements', modifications: [] };
    }
    css.elements.push(...generated);
    console.log(`synthesizeCoveringElements: created ${generated.length} ceiling covering(s)`);
  }
}


// ============================================================================
// PHASE: DEDUPLICATE OVERLAPPING STRUCTURAL TUNNEL SEGMENTS
// Two-phase approach: (1) node-key normalization, (2) spatial proximity.
// ============================================================================

/**
 * Remove duplicate structural tunnel segments that occupy the same physical space.
 *
 * Phase 1 — Node-key dedup:
 *   Normalizes entry_node/exit_node pairs by sorting alphabetically so that
 *   reversed-direction duplicates (A→B vs B→A) map to the same key.
 *
 * Phase 2 — Spatial proximity dedup:
 *   O(n²) pairwise check for segments with same origin (< 0.5m) and same
 *   bearing direction (|dot| > 0.9) but different node identities.
 *
 * Retention:
 *   - Depth ratio > 2×: keep the shorter segment (longer is over-aggregation)
 *   - Otherwise: keep lower element_key for deterministic reproducibility
 */
function deduplicateOverlappingTunnelSegments(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (!hasTunnelSegments(css)) return;

  const ORIGIN_TOL = 0.5;              // metres
  const DIR_DOT_TOL = 0.9;             // |dot product| threshold
  const LENGTH_MISMATCH_RATIO = 2.0;   // depth ratio threshold

  const toRemove = new Set();
  const decisions = [];

  // Collect structural tunnel segments (exclude bridges — they share nodeIds
  // and would be falsely collapsed by Phase 1 node-key dedup)
  const structural = css.elements.filter(e =>
    e.type === 'TUNNEL_SEGMENT' &&
    (e.properties?.branchClass || '').toUpperCase() === 'STRUCTURAL' &&
    !e.properties?._isBridgeSegment
  );

  if (structural.length < 2) return;

  // ── Helpers ──

  /** Bearing direction from placement.refDirection (NOT axis, which is Z-up). */
  function segBearing(e) {
    const rd = e.placement?.refDirection;
    if (rd && (rd.x !== 0 || rd.y !== 0 || rd.z !== 0)) {
      return vecNormalize(rd);
    }
    // Fallback: derive from pathPoints
    const pp = e.geometry?.pathPoints || e.geometry?.path;
    if (pp && pp.length >= 2) {
      return vecNormalize(vecSub(pp[pp.length - 1], pp[0]));
    }
    return null;
  }

  /** Pick which segment to keep. Returns { keep, remove, retentionReason }. */
  function pickKeeper(a, b) {
    const dA = a.geometry?.depth || 0;
    const dB = b.geometry?.depth || 0;
    const minD = Math.min(dA, dB);
    const maxD = Math.max(dA, dB);
    const ratio = minD > 0 ? maxD / minD : Infinity;

    if (ratio > LENGTH_MISMATCH_RATIO) {
      const keep = dA <= dB ? a : b;
      const remove = dA <= dB ? b : a;
      return { keep, remove, retentionReason: `SHORTER_KEPT(ratio=${ratio.toFixed(1)})` };
    }
    // Deterministic: lower element_key wins
    const keyA = a.element_key || a.id || '';
    const keyB = b.element_key || b.id || '';
    const keep = keyA <= keyB ? a : b;
    const remove = keyA <= keyB ? b : a;
    return { keep, remove, retentionReason: 'DETERMINISTIC_LOWER_KEY' };
  }

  // ── Phase 1: Node-key dedup (catches exact-match + reversed-node pairs) ──

  const nodeMap = new Map(); // normalized key → element
  for (const e of structural) {
    const en = e.properties?.entry_node || '';
    const ex = e.properties?.exit_node || '';
    if (!en || !ex) continue;

    // Sort node IDs so A→B and B→A yield the same key
    const sorted = [en, ex].sort();
    const pairKey = `${sorted[0]}→${sorted[1]}`;

    if (nodeMap.has(pairKey)) {
      const existing = nodeMap.get(pairKey);
      if (toRemove.has(existing)) { nodeMap.set(pairKey, e); continue; }

      const existingEn = existing.properties?.entry_node || '';
      const existingEx = existing.properties?.exit_node || '';
      const isReversed = (en === existingEx && ex === existingEn);
      const dedupType = isReversed ? 'REVERSED_NODES' : 'EXACT_MATCH';

      const { keep, remove, retentionReason } = pickKeeper(existing, e);
      toRemove.add(remove);
      nodeMap.set(pairKey, keep);
      decisions.push({ keep, remove, dedupType, retentionReason });
    } else {
      nodeMap.set(pairKey, e);
    }
  }

  // ── Phase 2: Spatial proximity dedup (catches different-node pairs) ──

  const surviving = structural.filter(e => !toRemove.has(e));
  const segData = surviving
    .filter(e => e.placement?.origin && (e.geometry?.depth || 0) > 0)
    .map(e => ({ elem: e, origin: e.placement.origin, dir: segBearing(e) }))
    .filter(s => s.dir !== null);

  for (let i = 0; i < segData.length; i++) {
    if (toRemove.has(segData[i].elem)) continue;
    for (let j = i + 1; j < segData.length; j++) {
      if (toRemove.has(segData[j].elem)) continue;

      const a = segData[i], b = segData[j];
      const dist = vecDist(a.origin, b.origin);
      if (dist > ORIGIN_TOL) continue;

      const dot = Math.abs(vecDot(a.dir, b.dir));
      if (dot < DIR_DOT_TOL) continue;

      // Spatial overlap confirmed
      const { keep, remove, retentionReason } = pickKeeper(a.elem, b.elem);
      toRemove.add(remove);
      decisions.push({ keep, remove, dedupType: 'SPATIAL_OVERLAP', retentionReason });
    }
  }

  // ── Phase 3: Parallel endpoint dedup (catches near-matching path endpoints) ──
  // Two segments with both endpoints within PARALLEL_SNAP are parallel drives
  // (VentSim often exports the same tunnel bore twice with slightly offset coords).
  // This was previously handled in generate (visual hide) — now done here for real removal.

  const PARALLEL_SNAP = 8.0; // metres — accounts for Z offset between parallel drives
  const surviving3 = structural.filter(e => !toRemove.has(e));

  // Build endpoint data from geometry.path or placement + bearing
  const endpointData = [];
  for (const e of surviving3) {
    const path = e.geometry?.path || e.geometry?.pathPoints;
    let entry, exit;
    if (path && path.length >= 2) {
      const p0 = path[0], p1 = path[path.length - 1];
      entry = { x: +p0.x || 0, y: +p0.y || 0, z: +p0.z || 0 };
      exit = { x: +p1.x || 0, y: +p1.y || 0, z: +p1.z || 0 };
    } else {
      // Fallback: compute from placement + bearing * depth
      const o = e.placement?.origin;
      const dir = segBearing(e);
      const depth = e.geometry?.depth || 0;
      if (!o || !dir || depth <= 0) continue;
      entry = { x: o.x - dir.x * depth / 2, y: o.y - dir.y * depth / 2, z: o.z - dir.z * depth / 2 };
      exit = { x: o.x + dir.x * depth / 2, y: o.y + dir.y * depth / 2, z: o.z + dir.z * depth / 2 };
    }
    const prof = e.geometry?.profile || {};
    const area = (prof.width || 0) * (prof.height || 0);
    endpointData.push({ elem: e, entry, exit, area });
  }

  const paired = new Set();
  for (let i = 0; i < endpointData.length; i++) {
    if (paired.has(i) || toRemove.has(endpointData[i].elem)) continue;
    for (let j = i + 1; j < endpointData.length; j++) {
      if (paired.has(j) || toRemove.has(endpointData[j].elem)) continue;
      const a = endpointData[i], b = endpointData[j];

      // Check o1↔o2 & e1↔e2, or o1↔e2 & e1↔o2
      const dOO = vecDist(a.entry, b.entry);
      const dEE = vecDist(a.exit, b.exit);
      const dOE = vecDist(a.entry, b.exit);
      const dEO = vecDist(a.exit, b.entry);
      const matched = (dOO < PARALLEL_SNAP && dEE < PARALLEL_SNAP) ||
                      (dOE < PARALLEL_SNAP && dEO < PARALLEL_SNAP);
      if (!matched) continue;

      // Pick keeper: prefer more area, then more Z variation (slope data)
      const dzA = Math.abs(a.exit.z - a.entry.z);
      const dzB = Math.abs(b.exit.z - b.entry.z);
      let keep, remove;
      if (a.area > b.area) { keep = a.elem; remove = b.elem; }
      else if (b.area > a.area) { keep = b.elem; remove = a.elem; }
      else if (dzA >= dzB) { keep = a.elem; remove = b.elem; }
      else { keep = b.elem; remove = a.elem; }

      toRemove.add(remove);
      decisions.push({ keep, remove, dedupType: 'PARALLEL_ENDPOINTS', retentionReason: dzA >= dzB || a.area > b.area ? 'MORE_AREA_OR_SLOPE' : 'MORE_AREA_OR_SLOPE' });
      paired.add(i);
      paired.add(j);
      break;
    }
  }

  // ── Apply removals ──

  if (toRemove.size > 0) {
    for (const d of decisions) {
      const keptId = d.keep.element_key || d.keep.id;
      const removedId = d.remove.element_key || d.remove.id;
      const keptDepth = (d.keep.geometry?.depth || 0).toFixed(1);
      const removedDepth = (d.remove.geometry?.depth || 0).toFixed(1);
      console.log(`deduplicateOverlappingTunnelSegments: REMOVED ${removedId} (depth=${removedDepth}m) — kept ${keptId} (depth=${keptDepth}m) — ${d.dedupType}, ${d.retentionReason}`);
    }
    css.elements = css.elements.filter(e => !toRemove.has(e));
    console.log(`deduplicateOverlappingTunnelSegments: removed ${toRemove.size} duplicate(s) total`);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.overlappingSegmentsRemoved = toRemove.size;
}


// ============================================================================
// PHASE 4A: OPENING PLACEMENT VALIDATION (non-TUNNEL)
// Conservative: wrong visible geometry is worse than missing geometry.
// ============================================================================

function validateOpeningPlacement(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const openingTypes = new Set(['DOOR', 'WINDOW', 'OPENING']);
  const openings = css.elements.filter(e => openingTypes.has((e.type || '').toUpperCase()));
  if (openings.length === 0) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  if (walls.length === 0) return;

  let valid = 0, rehosted = 0, downgraded = 0;
  const unresolvedOpenings = [];
  const removeKeys = new Set();

  for (const opening of openings) {
    const oo = opening.placement?.origin;
    if (!oo) { valid++; continue; }

    // Find host wall
    let hostWall = null;
    let bestDist = Infinity;
    const hostKey = opening.properties?.hostWallKey;
    if (hostKey) {
      hostWall = walls.find(w => (w.element_key || w.id) === hostKey);
    }
    if (!hostWall) {
      // Find nearest wall — threshold scales with building size so openings
      // at far ends of long walls aren't dropped (distance is to wall CENTER).
      const isInferred = opening.properties?.inferredFromBuildingType === true;
      const maxWallHalfLen = Math.max(...walls.map(w => (canonicalWallLength(w) || 1) / 2), 2.0);
      const maxHostDist = isInferred ? Math.max(5.0, maxWallHalfLen) : maxWallHalfLen;
      for (const w of walls) {
        const wo = w.placement?.origin;
        if (!wo) continue;
        const d = vecDist(oo, wo);
        if (d < bestDist) { bestDist = d; hostWall = w; }
      }
      if (bestDist > maxHostDist) hostWall = null;
    }

    if (!hostWall) {
      // No host — downgrade
      console.log(`Opening dropped: ${opening.name || opening.id} (${opening.type}) nearestWall=${bestDist.toFixed(2)}m reason=no_host_wall`);
      unresolvedOpenings.push({ id: opening.id, name: opening.name, type: opening.type, reason: 'no_host_wall', nearestDist: +bestDist.toFixed(2) });
      removeKeys.add(opening.element_key || opening.id);
      downgraded++;
      continue;
    }

    // Check if opening is within host wall bounds (±0.3m tolerance)
    const wo = hostWall.placement?.origin;
    if (!wo) { valid++; continue; }

    const wW = hostWall.geometry?.profile?.width || 1;
    const wH = hostWall.geometry?.profile?.height || 0.25;
    const wD = hostWall.geometry?.depth || 3;
    const tolerance = 0.3;

    const dist = vecDist(oo, wo);
    const isOutside = dist > (Math.max(wW, wD) / 2 + tolerance);

    if (isOutside) {
      const confidence = opening.confidence || 0.5;
      const isInferred = opening.properties?.inferredFromBuildingType === true;
      const minConfForRehost = isInferred ? 0.3 : 0.6;
      const maxRehostDist = isInferred ? 3.0 : 0.5;
      if (confidence >= minConfForRehost) {
        // Try rehosting to nearest wall within threshold
        let bestRehost = null;
        let bestRehostDist = maxRehostDist;
        for (const w of walls) {
          if (w === hostWall) continue;
          const d = vecDist(oo, w.placement?.origin || { x: 0, y: 0, z: 0 });
          if (d < bestRehostDist) { bestRehostDist = d; bestRehost = w; }
        }
        if (bestRehost) {
          if (!opening.properties) opening.properties = {};
          opening.properties.rehosted = true;
          opening.properties.originalHostWall = hostKey || (hostWall.element_key || hostWall.id);
          opening.properties.hostWallKey = bestRehost.element_key || bestRehost.id;
          rehosted++;
        } else {
          console.log(`Opening dropped: ${opening.name || opening.id} (${opening.type}) dist=${dist.toFixed(2)}m reason=outside_bounds_no_rehost`);
          unresolvedOpenings.push({ id: opening.id, name: opening.name, type: opening.type, reason: 'outside_bounds_no_rehost', dist: +dist.toFixed(2) });
          removeKeys.add(opening.element_key || opening.id);
          downgraded++;
        }
      } else {
        console.log(`Opening dropped: ${opening.name || opening.id} (${opening.type}) dist=${dist.toFixed(2)}m conf=${confidence} reason=low_confidence`);
        unresolvedOpenings.push({ id: opening.id, name: opening.name, type: opening.type, reason: 'outside_bounds_low_confidence', dist: +dist.toFixed(2) });
        removeKeys.add(opening.element_key || opening.id);
        downgraded++;
      }
    } else {
      valid++;
    }

    // Door floor-snap: z within 0.3m of floor level
    if ((opening.type || '').toUpperCase() === 'DOOR' && oo.z !== undefined) {
      const levels = css.levelsOrSegments || [];
      const container = opening.container;
      const level = levels.find(l => l.id === container);
      const floorZ = level?.elevation_m || 0;
      if (Math.abs(oo.z - floorZ) < 0.5) {
        oo.z = floorZ;
      }
    }
  }

  // Remove downgraded openings from elements
  if (removeKeys.size > 0) {
    css.elements = css.elements.filter(e => !removeKeys.has(e.element_key || e.id));
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.openingValidation = { total: openings.length, valid, rehosted, downgraded };
  if (unresolvedOpenings.length > 0) {
    css.metadata.unresolvedOpenings = unresolvedOpenings;
  }
  console.log(`validateOpeningPlacement: ${openings.length} total, ${valid} valid, ${rehosted} rehosted, ${downgraded} downgraded`);
}


// ============================================================================
// PHASE 4B: WALL AXIS CLEANUP (non-TUNNEL)
// Groups walls by direction and aligns. 10° angular cap + 0.3m positional cap.
// ============================================================================

function cleanBuildingWallAxes(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  if (walls.length < 2) return;

  const ANGLE_CAP = 10 * Math.PI / 180; // 10°
  const POSITION_CAP = 0.3; // 0.3m max movement
  const LINE_OFFSET_TOL = 0.2; // 0.2m for collinear detection

  // Group by approximate direction (uses canonical direction from shared.mjs)
  const groups = [];
  for (const wall of walls) {
    const dir = canonicalWallDirection(wall);
    if (!dir) continue;

    let placed = false;
    for (const group of groups) {
      const dot = Math.abs(vecDot(dir, group.avgDir));
      if (dot > Math.cos(ANGLE_CAP)) {
        group.walls.push(wall);
        group.dirs.push(dir);
        // Update average direction
        const sum = group.dirs.reduce((acc, d) => vecAdd(acc, d), { x: 0, y: 0, z: 0 });
        group.avgDir = vecNormalize(sum) || group.avgDir;
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ avgDir: dir, dirs: [dir], walls: [wall] });
    }
  }

  let snappedCount = 0;
  let skippedOverCap = 0;

  for (const group of groups) {
    if (group.walls.length < 2) continue;
    const avgDir = group.avgDir;

    // Snap wall run direction to group average (with endpoint movement cap)
    for (const wall of group.walls) {
      const currentDir = canonicalWallDirection(wall);
      if (!currentDir) continue;
      const dot = Math.abs(vecDot(currentDir, avgDir));
      if (dot >= 0.9998) continue; // already aligned

      // Check endpoint shift from direction change doesn't exceed POSITION_CAP
      const wallLen = canonicalWallLength(wall);
      const origin = wall.placement?.origin;
      if (origin && wallLen > 0) {
        const oldEnd = vecAdd(origin, vecScale(currentDir, wallLen / 2));
        const newEnd = vecAdd(origin, vecScale(avgDir, wallLen / 2));
        const endpointShift = vecDist(oldEnd, newEnd);
        if (endpointShift > POSITION_CAP) {
          skippedOverCap++;
          continue; // don't snap — endpoint would move too far
        }
      }

      // Apply snap: update refDirection (preferred) or axis
      if (wall.placement?.refDirection) {
        wall.placement.refDirection = { ...avgDir };
      } else if (wall.placement?.axis) {
        wall.placement.axis = { ...avgDir };
      } else {
        if (!wall.placement) wall.placement = {};
        wall.placement.refDirection = { ...avgDir };
      }
      snappedCount++;
    }

    // Align nearly-collinear walls (parallel within LINE_OFFSET_TOL)
    for (let i = 0; i < group.walls.length; i++) {
      const wA = group.walls[i];
      const oA = wA.placement?.origin;
      if (!oA) continue;

      for (let j = i + 1; j < group.walls.length; j++) {
        const wB = group.walls[j];
        const oB = wB.placement?.origin;
        if (!oB) continue;

        // Compute perpendicular offset between wall lines
        const ab = vecSub(oB, oA);
        const proj = vecDot(ab, avgDir);
        const perp = vecSub(ab, vecScale(avgDir, proj));
        const perpDist = Math.sqrt(perp.x ** 2 + perp.y ** 2 + perp.z ** 2);

        if (perpDist > 0.001 && perpDist < LINE_OFFSET_TOL) {
          // Move B to A's line (half the offset each)
          const halfPerp = vecScale(perp, 0.5);
          const moveA = Math.sqrt(halfPerp.x ** 2 + halfPerp.y ** 2 + halfPerp.z ** 2);
          if (moveA > POSITION_CAP) {
            skippedOverCap++;
            continue;
          }
          wA.placement.origin = vecAdd(oA, halfPerp);
          wB.placement.origin = vecSub(oB, halfPerp);
          snappedCount += 2;
        }
      }
    }
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.wallAxisCleanup = { groupCount: groups.length, snappedCount, skippedOverCap };
  if (snappedCount > 0) {
    console.log(`cleanBuildingWallAxes: ${snappedCount} wall axis/position corrections across ${groups.length} groups (${skippedOverCap} skipped over 0.3m cap)`);
  }
}


// ============================================================================
// WALL ENVELOPE CLAMPING (BUILDING only)
// Trims interior partition wall endpoints so they don't extend beyond the
// building envelope (defined by exterior walls or overall bounding box).
// ============================================================================

function clampWallsToEnvelope(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  // Compute envelope from exterior walls (or fallback to all-element bbox)
  const exteriorWalls = css.elements.filter(e =>
    e.type === 'WALL' && e.properties?.isExternal === true
  );

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const wallsForBbox = exteriorWalls.length >= 4 ? exteriorWalls : css.elements;
  for (const e of wallsForBbox) {
    const o = e.placement?.origin;
    if (!o || !isFinite(o.x) || !isFinite(o.y)) continue;
    if (o.x < minX) minX = o.x;
    if (o.x > maxX) maxX = o.x;
    if (o.y < minY) minY = o.y;
    if (o.y > maxY) maxY = o.y;
  }

  if (!isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return;

  const MARGIN = 0.5; // allow walls to extend 0.5m beyond envelope (for wall thickness)
  const envMinX = minX - MARGIN, envMaxX = maxX + MARGIN;
  const envMinY = minY - MARGIN, envMaxY = maxY + MARGIN;

  let clampCount = 0;

  for (const wall of css.elements) {
    if (wall.type !== 'WALL') continue;
    if (wall.properties?.isExternal) continue; // don't clamp exterior walls

    const o = wall.placement?.origin;
    if (!o) continue;

    const dir = canonicalWallDirection(wall);
    const len = canonicalWallLength(wall);
    if (!dir || len <= 0) continue;

    // Compute wall endpoints
    const startX = o.x - dir.x * len / 2;
    const startY = o.y - dir.y * len / 2;
    const endX = o.x + dir.x * len / 2;
    const endY = o.y + dir.y * len / 2;

    // Check if either endpoint is outside envelope
    let newStartX = startX, newStartY = startY, newEndX = endX, newEndY = endY;
    let clamped = false;

    // Clamp along the wall direction
    if (Math.abs(dir.x) > 0.5) {
      // Wall runs primarily along X
      if (newStartX < envMinX) { newStartX = envMinX; clamped = true; }
      if (newEndX > envMaxX) { newEndX = envMaxX; clamped = true; }
      if (newStartX > envMaxX) { newStartX = envMaxX; clamped = true; }
      if (newEndX < envMinX) { newEndX = envMinX; clamped = true; }
    }
    if (Math.abs(dir.y) > 0.5) {
      // Wall runs primarily along Y
      if (newStartY < envMinY) { newStartY = envMinY; clamped = true; }
      if (newEndY > envMaxY) { newEndY = envMaxY; clamped = true; }
      if (newStartY > envMaxY) { newStartY = envMaxY; clamped = true; }
      if (newEndY < envMinY) { newEndY = envMinY; clamped = true; }
    }

    if (clamped) {
      // Recompute origin (midpoint) and length
      const newLen = Math.sqrt((newEndX - newStartX) ** 2 + (newEndY - newStartY) ** 2);
      if (newLen < 0.1) continue; // wall fully outside envelope, too small after clamp

      o.x = (newStartX + newEndX) / 2;
      o.y = (newStartY + newEndY) / 2;
      setCanonicalWallLength(wall, newLen);
      clampCount++;
    }
  }

  if (clampCount > 0) {
    console.log(`clampWallsToEnvelope: clamped ${clampCount} interior walls to building footprint`);
  }
}

// ============================================================================
// DIMENSION VALIDATION (Universal — all domains)
// Clamps absurd dimensions with logging.
// ============================================================================

function clampAbsurdDimensions(css) {
  if (!css.elements) return;

  const CLAMPS = {
    WALL: { minW: 0.05, maxW: 200, minH: 0.05, maxH: 2.0, minD: 0.5, maxD: 50 },
    SLAB: { minW: 0.5, maxW: 500, minH: 0.5, maxH: 500, minD: 0.05, maxD: 1.5 },
    COLUMN: { minW: 0.1, maxW: 2.0, minH: 0.1, maxH: 2.0, minD: 0.5, maxD: 20 },
    BEAM: { minW: 0.1, maxW: 2.0, minH: 0.1, maxH: 2.0, minD: 0.5, maxD: 50 },
    SPACE: { minW: 0.5, maxW: 200, minH: 0.5, maxH: 200, minD: 0.5, maxD: 5000 },
    EQUIPMENT: { minW: 0.01, maxW: 20, minH: 0.01, maxH: 20, minD: 0.01, maxD: 20 },
    DOOR: { minW: 0.3, maxW: 5.0, minH: 0.03, maxH: 1.0, minD: 0.5, maxD: 4.0 },
    WINDOW: { minW: 0.3, maxW: 5.0, minH: 0.03, maxH: 1.0, minD: 0.3, maxD: 3.0 },
    DEFAULT: { minW: 0.01, maxW: 500, minH: 0.01, maxH: 500, minD: 0.01, maxD: 5000 }
  };

  let clampCount = 0;

  for (const elem of css.elements) {
    const g = elem.geometry;
    if (!g) continue;
    const type = (elem.type || '').toUpperCase();
    const limits = CLAMPS[type] || CLAMPS.DEFAULT;

    const p = g.profile;
    if (p?.width !== undefined) {
      const orig = p.width;
      p.width = Math.max(limits.minW, Math.min(limits.maxW, p.width));
      if (p.width !== orig) { clampCount++; }
    }
    if (p?.height !== undefined) {
      const orig = p.height;
      p.height = Math.max(limits.minH, Math.min(limits.maxH, p.height));
      if (p.height !== orig) { clampCount++; }
    }
    if (g.depth !== undefined) {
      const orig = g.depth;
      g.depth = Math.max(limits.minD, Math.min(limits.maxD, g.depth));
      if (g.depth !== orig) { clampCount++; }
    }
  }

  if (clampCount > 0) {
    console.log(`clampAbsurdDimensions: ${clampCount} dimension clamps applied`);
    if (!css.metadata) css.metadata = {};
    css.metadata.dimensionClamps = clampCount;
  }
}


// ============================================================================
// WALL ALIGNMENT + MERGE (Phase 6A)
// ============================================================================

function mergeWalls(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) {
    console.log('MergeWalls: skipping for TUNNEL domain (shell walls are independent)');
    return;
  }

  const ANGLE_TOL = 3 * Math.PI / 180; // 3 degrees
  const ENDPOINT_TOL = 0.40; // meters (Phase 2: increased from 0.20, safe with perpendicular offset guard)
  const THICKNESS_TOL = 0.10; // 10% relative

  // Only process WALL elements
  const walls = css.elements.filter(e => (e.type === 'WALL' || e.semantic_type === 'WALL'));
  if (walls.length < 2) return;

  // Direction alignment is handled by cleanBuildingWallAxes (operates on refDirection).
  // The old geometry.direction snap was removed — it incorrectly snapped the extrusion
  // axis (Z-up) instead of the wall run direction.

  // Resolve canonical direction for all walls upfront so merge uses consistent values
  for (const wall of walls) canonicalWallDirection(wall);

  // Group walls by container (storey)
  const wallsByContainer = {};
  for (const wall of walls) {
    const cid = wall.container || 'level-1';
    if (!wallsByContainer[cid]) wallsByContainer[cid] = [];
    wallsByContainer[cid].push(wall);
  }

  const mergedKeys = new Set();
  let mergeIndex = 0;

  for (const [containerId, containerWalls] of Object.entries(wallsByContainer)) {
    // Try to merge pairs within same container
    const merged = new Set();
    for (let i = 0; i < containerWalls.length; i++) {
      if (merged.has(i)) continue;
      const a = containerWalls[i];
      for (let j = i + 1; j < containerWalls.length; j++) {
        if (merged.has(j)) continue;
        const b = containerWalls[j];
        if (!canMergeWalls(a, b, ANGLE_TOL, ENDPOINT_TOL, THICKNESS_TOL)) continue;

        // Merge b into a
        const mergedFromA = a.metadata?.mergedFrom || [a.element_key || a.id];
        const mergedFromB = b.metadata?.mergedFrom || [b.element_key || b.id];

        // Compute new merged wall: extend length, average position
        const aOrigin = getOrigin(a);
        const bOrigin = getOrigin(b);
        const aLen = canonicalWallLength(a);
        const bLen = canonicalWallLength(b);
        const aDirV = canonicalWallDirection(a);
        const aDir = aDirV ? [aDirV.x, aDirV.y, aDirV.z] : [1, 0, 0];

        // Project b's center onto a's line to find total extent
        const abVec = [bOrigin[0] - aOrigin[0], bOrigin[1] - aOrigin[1], bOrigin[2] - aOrigin[2]];
        const proj = abVec[0]*aDir[0] + abVec[1]*aDir[1] + abVec[2]*aDir[2];

        // Endpoints of a along its direction
        const aStart = -aLen/2;
        const aEnd = aLen/2;
        const bStart = proj - bLen/2;
        const bEnd = proj + bLen/2;

        const newStart = Math.min(aStart, bStart);
        const newEnd = Math.max(aEnd, bEnd);
        const newLen = newEnd - newStart;
        const newMid = (newStart + newEnd) / 2;

        // New origin = a's origin shifted along direction by newMid
        const newOrigin = [
          aOrigin[0] + aDir[0] * newMid,
          aOrigin[1] + aDir[1] * newMid,
          aOrigin[2] + aDir[2] * newMid
        ];

        // Update a with merged values
        setOrigin(a, newOrigin);
        setCanonicalWallLength(a, newLen);

        if (!a.metadata) a.metadata = {};
        a.metadata.mergedFrom = [...mergedFromA, ...mergedFromB];
        a.element_key = `merged_wall_${containerId}_${mergeIndex++}`;

        mergedKeys.add(b.element_key || b.id);
        merged.add(j);
      }
    }
  }

  // Remove merged-away elements
  if (mergedKeys.size > 0) {
    css.elements = css.elements.filter(e => !mergedKeys.has(e.element_key || e.id));
    console.log(`Merged ${mergedKeys.size} wall segments`);
  }
}

function canMergeWalls(a, b, angleTol, endpointTol, thicknessTol) {
  const dirAv = canonicalWallDirection(a);
  const dirBv = canonicalWallDirection(b);
  if (!dirAv || !dirBv) return false;
  const dirA = [dirAv.x, dirAv.y, dirAv.z];
  const dirB = [dirBv.x, dirBv.y, dirBv.z];

  // Check angle between directions (use absolute dot product for anti-parallel)
  const dot = Math.abs(dirA[0]*dirB[0] + dirA[1]*dirB[1] + dirA[2]*dirB[2]);
  if (dot < Math.cos(angleTol)) return false;

  // Check thickness compatibility (within 10%)
  const thickA = canonicalWallThickness(a);
  const thickB = canonicalWallThickness(b);
  if (thickA > 0 && thickB > 0) {
    const ratio = Math.abs(thickA - thickB) / Math.max(thickA, thickB);
    if (ratio > thicknessTol) return false;
  }

  // Check perpendicular offset — reject parallel but laterally offset walls
  const aOrigin = getOrigin(a);
  const bOrigin = getOrigin(b);
  const abVec = [bOrigin[0] - aOrigin[0], bOrigin[1] - aOrigin[1], bOrigin[2] - aOrigin[2]];
  const proj = abVec[0]*dirA[0] + abVec[1]*dirA[1] + abVec[2]*dirA[2];
  const perpVec = [abVec[0] - dirA[0]*proj, abVec[1] - dirA[1]*proj, abVec[2] - dirA[2]*proj];
  const perpDist = Math.sqrt(perpVec[0]**2 + perpVec[1]**2 + perpVec[2]**2);
  const maxPerp = Math.max((thickA + thickB) / 4, 0.10); // half avg thickness, min 0.10m
  if (perpDist > maxPerp) return false;

  // Check if endpoints are close enough
  const aLen = canonicalWallLength(a);
  const bLen = canonicalWallLength(b);

  const aEnd1 = [aOrigin[0] - dirA[0]*aLen/2, aOrigin[1] - dirA[1]*aLen/2, aOrigin[2] - dirA[2]*aLen/2];
  const aEnd2 = [aOrigin[0] + dirA[0]*aLen/2, aOrigin[1] + dirA[1]*aLen/2, aOrigin[2] + dirA[2]*aLen/2];
  const bEnd1 = [bOrigin[0] - dirB[0]*bLen/2, bOrigin[1] - dirB[1]*bLen/2, bOrigin[2] - dirB[2]*bLen/2];
  const bEnd2 = [bOrigin[0] + dirB[0]*bLen/2, bOrigin[1] + dirB[1]*bLen/2, bOrigin[2] + dirB[2]*bLen/2];

  const minDist = Math.min(
    dist3(aEnd1, bEnd1), dist3(aEnd1, bEnd2),
    dist3(aEnd2, bEnd1), dist3(aEnd2, bEnd2)
  );
  return minDist <= endpointTol;
}

function getOrigin(elem) {
  const o = elem.placement?.origin || elem.placement?.position || {};
  return [o.x ?? 0, o.y ?? 0, o.z ?? 0];
}

function setOrigin(elem, coords) {
  if (elem.placement?.origin) {
    elem.placement.origin.x = coords[0];
    elem.placement.origin.y = coords[1];
    elem.placement.origin.z = coords[2];
  } else if (elem.placement?.position) {
    elem.placement.position.x = coords[0];
    elem.placement.position.y = coords[1];
    elem.placement.position.z = coords[2];
  }
}

// Legacy wrappers — delegate to canonical helpers from shared.mjs
function getDir(elem) {
  const d = canonicalWallDirection(elem);
  return d ? [d.x, d.y, d.z] : [1, 0, 0];
}
function getWallLength(elem) { return canonicalWallLength(elem); }
function setWallLength(elem, len) { setCanonicalWallLength(elem, len); }
function getWallThickness(elem) { return canonicalWallThickness(elem); }

function dist3(a, b) {
  return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
}


// ============================================================================
// OPENING INFERENCE (v3.2 — scored host-wall matching)
// ============================================================================

/**
 * Normalize a 3D vector to unit length. Returns [0,0,1] if zero-length.
 */
function normalize(v) {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  return len > 1e-9 ? [v[0]/len, v[1]/len, v[2]/len] : [0, 0, 1];
}

/**
 * Dot product of two 3-vectors.
 */
function dot3(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

// Horizontal wall helpers — delegate to canonical versions
function getWallHorizontalLength(wall) { return canonicalWallLength(wall); }
function getWallHorizontalAxis(wall) {
  const d = canonicalWallDirection(wall);
  return d ? [d.x, d.y, d.z] : [1, 0, 0];
}

/**
 * Get wall endpoints along its horizontal axis.
 */
function getWallHorizontalEndpoints(wall) {
  const origin = getOrigin(wall);
  const axis = getWallHorizontalAxis(wall);
  const halfLen = getWallHorizontalLength(wall) / 2;
  return {
    start: [origin[0] - axis[0]*halfLen, origin[1] - axis[1]*halfLen, origin[2]],
    end:   [origin[0] + axis[0]*halfLen, origin[1] + axis[1]*halfLen, origin[2]]
  };
}

function getWallThicknessFromProfile(wall) { return canonicalWallThickness(wall); }

/**
 * Get opening width — the wider profile dimension (horizontal extent of the opening).
 */
function getOpeningWidth(elem) {
  const p = elem.geometry?.profile;
  if (!p) return 1;
  const w = p.width || 1;
  const h = p.height || 1;
  return Math.max(w, h);
}

/**
 * Get opening height (the depth of the extrusion = vertical extent).
 */
function getOpeningHeight(elem) {
  return elem.geometry?.depth || elem.geometry?.length_m || 2;
}

/**
 * Get the opening's face normal — the direction it faces through the wall.
 * This is along the thin profile dimension (not the extrusion direction).
 */
function getOpeningNormal(elem) {
  // Derive normal from refDirection if available (set by extract or alignment)
  const ref = elem.placement?.refDirection;
  if (ref) {
    const rx = ref.x || 0, ry = ref.y || 0;
    // Opening normal is perpendicular to refDirection (wall-through direction)
    const len = Math.sqrt(rx * rx + ry * ry);
    if (len > 1e-9) {
      return [-ry / len, rx / len, 0]; // perpendicular in XY plane
    }
  }
  // Fallback: try both directions — the scoring function tests both orientations anyway
  return [0, 1, 0];
}

/**
 * Project a point onto a line segment defined by two endpoints.
 * Returns { t, closest, perpDist } where:
 *   t = parameter along segment (0 = start, 1 = end)
 *   closest = closest point on segment
 *   perpDist = perpendicular distance from point to segment
 */
function projectPointToSegment(point, segStart, segEnd) {
  const seg = [segEnd[0]-segStart[0], segEnd[1]-segStart[1], segEnd[2]-segStart[2]];
  const segLen = Math.sqrt(seg[0]*seg[0] + seg[1]*seg[1] + seg[2]*seg[2]);
  if (segLen < 1e-9) {
    return { t: 0, closest: segStart, perpDist: dist3(point, segStart) };
  }
  const segDir = [seg[0]/segLen, seg[1]/segLen, seg[2]/segLen];
  const toPoint = [point[0]-segStart[0], point[1]-segStart[1], point[2]-segStart[2]];
  const proj = dot3(toPoint, segDir);
  const t = proj / segLen; // 0..1 along segment
  const tClamped = Math.max(0, Math.min(1, t));
  const closest = [
    segStart[0] + segDir[0] * tClamped * segLen,
    segStart[1] + segDir[1] * tClamped * segLen,
    segStart[2] + segDir[2] * tClamped * segLen
  ];
  const perpDist = dist3(point, closest);
  return { t, tClamped, closest, perpDist, proj, segLen };
}

/**
 * Get wall endpoints along horizontal axis (used by opening matching).
 * Delegates to getWallHorizontalEndpoints.
 */
function getWallEndpoints(wall) {
  return getWallHorizontalEndpoints(wall);
}

function inferOpenings(css) {
  if (!css.elements || css.elements.length === 0) return;

  // Phase 6B: when the engineer-intent resolver is in consume-doors mode (or
  // higher), it has already chosen each door's host. We mirror its decisions
  // into the legacy fields (hostWallKey/match/portal flag) so downstream
  // passes (createOpeningRelationships, validateOpeningPlacement, the v2
  // adapter) keep working unchanged. Doors WITHOUT intent are NOT scored or
  // salvaged — strict no-fallback rule.
  const intentMode = (css.metadata?.featureFlags?.intentMode || 'report').toLowerCase();
  const consumeDoorIntent = ['consume-doors', 'consume-mep', 'consume-all'].includes(intentMode);
  if (consumeDoorIntent) {
    return _inferOpeningsFromIntent(css);
  }

  const isTunnel = hasTunnelSegments(css);

  // Tunnel domain: assign doors/windows to nearest valid host.
  // Search both STRUCTURAL TUNNEL_SEGMENTs and PORTAL_END_WALL closure walls.
  // PORTAL_END_WALL gets priority when distances are similar (doors belong at tunnel mouths).
  if (isTunnel) {
    const tunnelHosts = css.elements.filter(e => {
      const t = (e.type || '').toUpperCase();
      if (t === 'TUNNEL_SEGMENT' && (e.properties?.branchClass || '').toUpperCase() === 'STRUCTURAL') return true;
      if (t === 'WALL' && e.properties?.segmentType === 'PORTAL_END_WALL') return true;
      return false;
    });
    const openingCandidates = css.elements.filter(e => {
      const t = (e.type || '').toUpperCase();
      return t === 'DOOR' || t === 'WINDOW';
    });
    if (tunnelHosts.length === 0 || openingCandidates.length === 0) return;

    let matched = 0;
    for (const candidate of openingCandidates) {
      const o = getOrigin(candidate);
      let bestKey = null, bestDist = Infinity;
      let bestIsPortal = false;
      for (const host of tunnelHosts) {
        const { start, end } = getWallEndpoints(host);
        const { perpDist, tClamped } = projectPointToSegment(o, start, end);
        if (tClamped >= 0 && tClamped <= 1 && perpDist < 15.0) {
          const isPortal = host.properties?.segmentType === 'PORTAL_END_WALL';
          // PORTAL_END_WALL gets priority: prefer it unless segment is much closer (>3m difference)
          const effectiveDist = isPortal ? perpDist * 0.5 : perpDist;
          if (effectiveDist < bestDist) {
            bestDist = effectiveDist;
            bestKey = host.element_key || host.id;
            bestIsPortal = isPortal;
          }
        }
      }
      if (bestKey) {
        if (!candidate.metadata) candidate.metadata = {};
        candidate.metadata.hostWallKey = bestKey;
        candidate.metadata.hostWallMatchScore = Math.max(0, 1 - bestDist / 15.0);
        candidate.metadata.hostIsPortalEndWall = bestIsPortal;
        if (candidate.provenance) candidate.provenance.modifications = [...(candidate.provenance.modifications || []), 'topology:inferOpenings'];
        matched++;

        // Tunnel door Z-snap: set door Z to tunnel floor level (bottom of host segment).
        // validateOpeningPlacement skips tunnels, so this is the only Z correction path.
        if ((candidate.type || '').toUpperCase() === 'DOOR' && candidate.placement?.origin) {
          const host = tunnelHosts.find(h => (h.element_key || h.id) === bestKey);
          if (host) {
            const hostZ = host.placement?.origin?.z ?? 0;
            const hostH = host.geometry?.profile?.height ?? 5;
            const shellT = host.properties?.shellThickness_m ?? 0.3;
            const floorZ = hostZ - hostH / 2 + shellT;
            const doorH = candidate.geometry?.profile?.height
                       || candidate.geometry?.depth || 2.1;
            // Place door origin at floor + half door height (origin = center)
            candidate.placement.origin.z = floorZ + doorH / 2;
            console.log(`Tunnel door Z-snap: ${candidate.name || candidate.id} z=${candidate.placement.origin.z.toFixed(2)} (floor=${floorZ.toFixed(2)}, hostZ=${hostZ.toFixed(2)})`);
          }
        }
      }
    }
    console.log(`InferOpenings (tunnel): ${matched} of ${openingCandidates.length} doors/windows matched (portal end walls included)`);
    return;
  }

  const PERP_DIST_MAX = 1.0;         // max perpendicular distance to wall line
  const SEGMENT_TOL = 0.2;           // opening can extend 0.2m past wall endpoints
  const ORIENTATION_TOL = 0.2;       // |dot(openingNormal, wallAxis)| must be < this
  const WIDTH_RATIO_MAX = 0.8;       // opening width must be < 80% of wall length
  const AMBIGUITY_RATIO = 0.92;      // only skip if scores are nearly identical (was 0.7 — too strict)
  const SALVAGE_PERP_MAX = 3.0;      // salvage pass: max perpendicular distance (was 1.5 — too small for thick walls)
  const SALVAGE_SEGMENT_TOL = 0.5;   // salvage: projected point must be within segment ± this

  // Get structure class from metadata (set by builting-extract)
  const structureClass = (css.metadata?.structureClass || 'BUILDING').toUpperCase();

  const walls = css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return t === 'WALL'; // only semantic WALLs, never PROXY
  });
  const openingCandidates = css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return t === 'DOOR' || t === 'WINDOW';
  });

  if (walls.length === 0 || openingCandidates.length === 0) {
    // LINEAR structures: openings should not exist, skip all
    if (structureClass === 'LINEAR' && openingCandidates.length > 0) {
      _skipAllOpenings(css, openingCandidates, 'linear_structure_no_openings');
    }
    return;
  }

  // LINEAR structures: skip all openings
  if (structureClass === 'LINEAR') {
    _skipAllOpenings(css, openingCandidates, 'linear_structure_no_openings');
    return;
  }

  css.metadata = css.metadata || {};
  css.metadata.skippedOpenings = css.metadata.skippedOpenings || [];

  let matched = 0;
  let skipped = 0;
  const toRemove = new Set();

  for (const candidate of openingCandidates) {
    const result = _scoreOpeningAgainstWalls(candidate, walls, {
      PERP_DIST_MAX, SEGMENT_TOL, ORIENTATION_TOL, WIDTH_RATIO_MAX, AMBIGUITY_RATIO
    });

    if (result.matched) {
      if (!candidate.metadata) candidate.metadata = {};
      candidate.metadata.hostWallKey = result.wallKey;
      candidate.metadata.hostWallMatchScore = result.score;
      if (candidate.provenance) candidate.provenance.modifications = [...(candidate.provenance.modifications || []), 'topology:inferOpenings'];
      // Align opening orientation and position to host wall
      _alignOpeningToWall(candidate, walls, result.wallKey);
      logDecision({ pass: 'inferOpenings', element_id: candidate.element_key || candidate.id,
        action: 'opening_matched', reason: 'nearest_host',
        params: { hostWallKey: result.wallKey, score: result.score, type: candidate.type } });
      matched++;
      continue;
    }

    // Salvage pass: try snapping to nearest wall centerline
    const salvageResult = _salvageOpening(candidate, walls, {
      SALVAGE_PERP_MAX, SALVAGE_SEGMENT_TOL,
      PERP_DIST_MAX, SEGMENT_TOL, ORIENTATION_TOL, WIDTH_RATIO_MAX, AMBIGUITY_RATIO
    });

    if (salvageResult.matched) {
      if (!candidate.metadata) candidate.metadata = {};
      candidate.metadata.hostWallKey = salvageResult.wallKey;
      candidate.metadata.hostWallMatchScore = salvageResult.score;
      candidate.metadata.salvageSnapped = true;
      candidate.metadata.isInferred = true;
      if (candidate.provenance) candidate.provenance.modifications = [...(candidate.provenance.modifications || []), 'topology:inferOpenings'];
      // Mark evidence basis as inferred for provenance tracking
      if (!candidate.metadata.evidence) candidate.metadata.evidence = {};
      candidate.metadata.evidence.basis = 'INFERRED_OPENING_SNAP';
      // Apply the snap
      setOrigin(candidate, salvageResult.snappedOrigin);
      // Align opening orientation to host wall
      _alignOpeningToWall(candidate, walls, salvageResult.wallKey);
      logDecision({ pass: 'inferOpenings', element_id: candidate.element_key || candidate.id,
        action: 'opening_matched', reason: 'salvage_snap',
        params: { hostWallKey: salvageResult.wallKey, score: salvageResult.score, type: candidate.type } });
      matched++;
      continue;
    }

    // No match — skip the opening
    const skipReason = result.rejectReason || salvageResult.rejectReason || 'no_wall_match';
    if (structureClass === 'BUILDING' || structureClass === 'FACILITY') {
      toRemove.add(candidate.id || candidate.element_key);
      css.metadata.skippedOpenings.push({
        id: candidate.id || candidate.element_key,
        type: (candidate.type || '').toUpperCase(),
        skipReason,
        hostWallRejectReason: result.rejectReason
      });
      skipped++;
    }
  }

  // Remove skipped openings from elements
  if (toRemove.size > 0) {
    css.elements = css.elements.filter(e => !toRemove.has(e.id || e.element_key));
  }

  // Window alignment heuristic: snap WINDOW sill heights on same wall
  _alignWindowSillHeights(css);

  console.log(`Opening inference: ${matched} matched, ${skipped} skipped`);
}

/**
 * Phase 6B — intent-driven opening inference. Single decision-maker.
 *
 * Reads each DOOR/WINDOW's metadata.intent (written by intent-resolver.mjs)
 * and mirrors it into the legacy fields createOpeningRelationships /
 * validateOpeningPlacement / generate already understand:
 *   - metadata.hostWallKey            ← intent.hostSegmentId
 *   - metadata.hostWallMatchScore     ← intent.confidence
 *   - metadata.hostIsPortalEndWall    ← intent.hostWallType === 'PORTAL_END_WALL'
 *   - metadata.intentResolved         ← true (provenance marker)
 *   - placement.origin                ← intent.position (resolved center)
 *
 * For tunnel hosts, intent.position.z is already snapped to floor + doorH/2
 * by the resolver — mirror it onto placement.origin.z too, matching the
 * legacy tunnel Z-snap behaviour.
 *
 * Strict rule: doors WITHOUT intent (or with skipReason / confidence below
 * MEDIUM) are LEFT ALONE. Legacy scoring/salvage heuristics must not run.
 */
function _inferOpeningsFromIntent(css) {
  let mirrored = 0;
  let skippedNoIntent = 0;
  let skippedLowConfidence = 0;
  let skippedExplicitReject = 0;

  for (const elem of css.elements || []) {
    const t = (elem.type || '').toUpperCase();
    if (t !== 'DOOR' && t !== 'WINDOW') continue;
    const intent = elem.metadata?.intent;
    if (!intent) { skippedNoIntent++; continue; }
    if (intent.skipReason)        { skippedExplicitReject++; continue; }
    if (!intent.hostSegmentId)    { skippedNoIntent++; continue; }
    if ((intent.confidence ?? 0) < CONFIDENCE.MEDIUM) { skippedLowConfidence++; continue; }

    if (!elem.metadata) elem.metadata = {};
    elem.metadata.hostWallKey = intent.hostSegmentId;
    elem.metadata.hostWallMatchScore = intent.confidence;
    elem.metadata.hostIsPortalEndWall = intent.hostWallType === 'PORTAL_END_WALL';
    elem.metadata.intentResolved = true;
    if (elem.provenance) elem.provenance.modifications = [...(elem.provenance.modifications || []), 'topology:inferOpenings'];

    if (intent.position) {
      if (!elem.placement) elem.placement = {};
      if (!elem.placement.origin) elem.placement.origin = {};
      elem.placement.origin.x = intent.position.x;
      elem.placement.origin.y = intent.position.y;
      elem.placement.origin.z = intent.position.z;
    }

    mirrored++;
  }
  console.log(`Opening inference (intent mode): ${mirrored} mirrored, `
    + `${skippedNoIntent} no_intent, ${skippedExplicitReject} resolver_rejected, `
    + `${skippedLowConfidence} low_confidence`);
}

/**
 * Align an opening's orientation and perpendicular position to its host wall.
 * Sets refDirection to match wall horizontal axis and snaps origin to wall centerline.
 */
function _alignOpeningToWall(opening, walls, wallKey) {
  const hostWall = walls.find(w => (w.element_key || w.id) === wallKey);
  if (!hostWall) return;

  const wallAxis = getWallHorizontalAxis(hostWall);
  if (!opening.placement) opening.placement = {};
  opening.placement.refDirection = { x: wallAxis[0], y: wallAxis[1], z: 0 };
  opening.placement.axis = { x: 0, y: 0, z: 1 };

  // Snap opening origin's perpendicular coordinate to wall centerline
  const openingOrigin = getOrigin(opening);
  const { start, end } = getWallEndpoints(hostWall);
  const { closest } = projectPointToSegment(openingOrigin, start, end);
  setOrigin(opening, [closest[0], closest[1], openingOrigin[2]]);
}

/**
 * Score an opening against all candidate walls. Returns best match or rejection.
 */
function _scoreOpeningAgainstWalls(opening, walls, opts) {
  const openingOrigin = getOrigin(opening);
  const openingContainer = opening.container || 'level-1';
  const openingWidth = getOpeningWidth(opening);
  const openingNormal = normalize(getOpeningNormal(opening));

  const scores = [];

  for (const wall of walls) {
    const wallContainer = wall.container || 'level-1';
    if (wallContainer !== openingContainer) continue;

    const wallType = (wall.type || wall.semantic_type || '').toUpperCase();
    if (wallType !== 'WALL') continue;

    const wallDir = normalize(getWallHorizontalAxis(wall));
    const wallLength = getWallHorizontalLength(wall);
    const { start, end } = getWallEndpoints(wall);

    // Hard rejection: opening wider than 80% of wall
    if (openingWidth >= wallLength * opts.WIDTH_RATIO_MAX) continue;

    // Orientation check: opening normal should be perpendicular to wall axis.
    // Try both profile-derived normal and its perpendicular, since the LLM
    // uses a consistent width>height convention regardless of wall orientation.
    const orientDot = Math.abs(dot3(openingNormal, wallDir));
    const altNormal = [openingNormal[1], openingNormal[0], openingNormal[2]]; // swap X/Y
    const altOrientDot = Math.abs(dot3(altNormal, wallDir));
    if (orientDot > opts.ORIENTATION_TOL && altOrientDot > opts.ORIENTATION_TOL) continue;

    // Perpendicular distance check
    const { perpDist, t, proj, segLen } = projectPointToSegment(openingOrigin, start, end);
    if (perpDist > opts.PERP_DIST_MAX) continue;

    // Projection bounds check: opening center must project within wall ± tolerance
    const halfOpeningWidth = openingWidth / 2;
    const projStart = proj - halfOpeningWidth;
    const projEnd = proj + halfOpeningWidth;
    if (projStart < -opts.SEGMENT_TOL || projEnd > segLen + opts.SEGMENT_TOL) continue;

    // Coverage: how centered is the opening on the wall
    const projectionCoverage = 1 - Math.abs(proj / segLen - 0.5) * 2; // 1=centered, 0=edge

    // Score: lower is better
    const score = perpDist * 1.0
      + (1.0 - Math.max(0, projectionCoverage)) * 0.5
      + (openingWidth / wallLength) * 0.3;

    scores.push({
      wall,
      wallKey: wall.element_key || wall.id,
      score,
      perpDist
    });
  }

  if (scores.length === 0) {
    return { matched: false, rejectReason: 'no_candidate_walls_passed_rejection' };
  }

  scores.sort((a, b) => a.score - b.score);

  // Ambiguity check
  if (scores.length >= 2) {
    const ratio = scores[0].score / scores[1].score;
    if (ratio > opts.AMBIGUITY_RATIO) {
      return { matched: false, rejectReason: 'ambiguous_match' };
    }
  }

  return { matched: true, wallKey: scores[0].wallKey, score: scores[0].score };
}

/**
 * Salvage pass: snap opening to nearest wall centerline and retry matching.
 */
function _salvageOpening(opening, walls, opts) {
  const openingOrigin = getOrigin(opening);
  const openingContainer = opening.container || 'level-1';

  let bestWall = null;
  let bestPerpDist = Infinity;
  let bestClosest = null;
  let bestProj = null;
  let bestSegLen = null;

  for (const wall of walls) {
    if ((wall.container || 'level-1') !== openingContainer) continue;
    const { start, end } = getWallEndpoints(wall);
    const { perpDist, closest, proj, segLen } = projectPointToSegment(openingOrigin, start, end);

    if (perpDist > opts.SALVAGE_PERP_MAX) continue;

    // Safety bound: projected point must be within segment bounds ± tolerance
    if (proj < -opts.SALVAGE_SEGMENT_TOL || proj > segLen + opts.SALVAGE_SEGMENT_TOL) continue;

    if (perpDist < bestPerpDist) {
      bestPerpDist = perpDist;
      bestWall = wall;
      bestClosest = closest;
      bestProj = proj;
      bestSegLen = segLen;
    }
  }

  if (!bestWall || !bestClosest) {
    return { matched: false, rejectReason: 'salvage_no_nearby_wall' };
  }

  // Snap opening center to wall centerline
  const snappedOrigin = [bestClosest[0], bestClosest[1], openingOrigin[2]]; // keep Z

  // Retry scoring with snapped position
  const tempOpening = JSON.parse(JSON.stringify(opening));
  setOrigin(tempOpening, snappedOrigin);

  const result = _scoreOpeningAgainstWalls(tempOpening, walls, {
    PERP_DIST_MAX: opts.PERP_DIST_MAX,
    SEGMENT_TOL: opts.SEGMENT_TOL,
    ORIENTATION_TOL: opts.ORIENTATION_TOL,
    WIDTH_RATIO_MAX: opts.WIDTH_RATIO_MAX,
    AMBIGUITY_RATIO: opts.AMBIGUITY_RATIO
  });

  if (result.matched) {
    return { ...result, snappedOrigin };
  }
  return { matched: false, rejectReason: 'salvage_retry_failed' };
}

/**
 * Remove all openings (for LINEAR structures).
 */
function _skipAllOpenings(css, openings, reason) {
  css.metadata = css.metadata || {};
  css.metadata.skippedOpenings = css.metadata.skippedOpenings || [];

  const ids = new Set();
  for (const o of openings) {
    const oid = o.id || o.element_key;
    ids.add(oid);
    css.metadata.skippedOpenings.push({
      id: oid,
      type: (o.type || '').toUpperCase(),
      skipReason: reason
    });
  }
  css.elements = css.elements.filter(e => !ids.has(e.id || e.element_key));
  console.log(`Skipped all ${openings.length} openings: ${reason}`);
}

/**
 * Window alignment heuristic: snap WINDOW sill heights (Z positions) within tolerance.
 * DOORS are excluded — they sit at floor level and should not be aligned with windows.
 */
function _alignWindowSillHeights(css) {
  const ALIGN_TOL = 0.15; // meters

  // Group windows by host wall
  const windowsByWall = {};
  for (const elem of css.elements) {
    const t = (elem.type || elem.semantic_type || '').toUpperCase();
    if (t !== 'WINDOW') continue;
    const wallKey = elem.metadata?.hostWallKey;
    if (!wallKey) continue;
    if (!windowsByWall[wallKey]) windowsByWall[wallKey] = [];
    windowsByWall[wallKey].push(elem);
  }

  for (const [wallKey, windows] of Object.entries(windowsByWall)) {
    if (windows.length < 2) continue;

    // Get Z values
    const zValues = windows.map(w => (w.placement?.origin?.z ?? 0));
    const avgZ = zValues.reduce((a, b) => a + b, 0) / zValues.length;

    // Snap all to average if within tolerance
    for (let i = 0; i < windows.length; i++) {
      if (Math.abs(zValues[i] - avgZ) <= ALIGN_TOL) {
        if (windows[i].placement?.origin) {
          windows[i].placement.origin.z = avgZ;
        }
      }
    }
  }
}


// ============================================================================
// OPENING RELATIONSHIPS — VALIDATED VOIDS CREATION (v3.2 Task 2)
// ============================================================================

/**
 * Append a VOIDS relationship to an opening, deduping by (type, target).
 * Phase 6B — guard against duplicate VOIDS when intent and legacy logic
 * disagree on host (validator flags duplicates as `contradictory_relationships`).
 */
function _addVoidsRel(opening, target) {
  if (!opening.relationships) opening.relationships = [];
  const exists = opening.relationships.some(r => r && r.type === 'VOIDS' && r.target === target);
  if (exists) return;
  opening.relationships.push({ type: 'VOIDS', target });
}

function createOpeningRelationships(css) {
  if (!css.elements || css.elements.length === 0) return;

  const structureClass = (css.metadata?.structureClass || 'BUILDING').toUpperCase();
  css.metadata = css.metadata || {};
  css.metadata.skippedOpenings = css.metadata.skippedOpenings || [];

  // Build a map of walls (and tunnel segments) by key for quick lookup
  const wallMap = {};
  for (const elem of css.elements) {
    const t = (elem.type || elem.semantic_type || '').toUpperCase();
    if (t === 'WALL' || t === 'TUNNEL_SEGMENT') {
      wallMap[elem.element_key || elem.id] = elem;
    }
  }

  // Get storey heights for validation — derive from occupancy, not hardcoded 3m
  const _occOpen = (css.facilityMeta || css.metadata?.facilityMeta || {}).occupancy || '';
  const _defaultHOpen = storeyHeightFromOccupancy(_occOpen);
  const storeyHeights = {};
  for (const level of (css.levelsOrSegments || [])) {
    storeyHeights[level.id] = level.height_m || _defaultHOpen;
  }

  const toRemove = new Set();
  let created = 0;
  let skipped = 0;

  const openings = css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return (t === 'DOOR' || t === 'WINDOW') && e.metadata?.hostWallKey;
  });

  for (const opening of openings) {
    const wallKey = opening.metadata.hostWallKey;
    let hostWall = wallMap[wallKey];

    // Host wall must still exist — if not, try resolving through derivedFromBranch
    // lineage (the original tunnel segment may have been decomposed into shell walls
    // with different IDs by decomposeTunnelShell)
    if (!hostWall) {
      const fallbackWall = css.elements.find(e => {
        const t = (e.type || '').toUpperCase();
        return (t === 'WALL' || t === 'TUNNEL_SEGMENT') &&
          (e.properties?.derivedFromBranch === wallKey || e.properties?.hostBranch === wallKey);
      });
      if (fallbackWall) {
        hostWall = fallbackWall;
        opening.metadata.hostWallKey = fallbackWall.element_key || fallbackWall.id;
        opening.metadata.hostWallResolved = 'derived_branch_fallback';
      }
    }
    if (!hostWall) {
      _skipOpeningVoids(css, opening, toRemove, structureClass, 'host_wall_missing');
      skipped++;
      continue;
    }

    const hostType = (hostWall.type || '').toUpperCase();
    const isTunnelHost = hostType === 'TUNNEL_SEGMENT';

    // Tunnel-hosted openings: skip building-specific geometry checks (wall span, endpoint
    // proximity) since a tunnel segment's "width" is its cross-section, not its run length.
    // We only validate that the door dimensions are sane (not bigger than the tube interior).
    if (isTunnelHost) {
      const tunnelW = hostWall.geometry?.profile?.width || 5;
      const tunnelH = hostWall.geometry?.profile?.height || 5;
      const openingWidth = getOpeningWidth(opening);
      const openingHeight = getOpeningHeight(opening);
      if (openingWidth >= tunnelW * 0.9 || openingHeight >= tunnelH * 0.9) {
        _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_too_large_for_tunnel');
        skipped++;
        continue;
      }
      // All checks passed — create VOIDS relationship.
      // Use element_key as the canonical target (validator builds elementKeys from element_key).
      _addVoidsRel(opening, hostWall.element_key || hostWall.id);
      if (!opening.metadata) opening.metadata = {};
      opening.metadata.openingVoidsCreated = true;
      created++;
      continue;
    }

    const openingWidth = getOpeningWidth(opening);
    const openingHeight = getOpeningHeight(opening);
    const wallLength = getWallHorizontalLength(hostWall);
    const storeyHeight = storeyHeights[opening.container || 'level-1'] || _defaultHOpen;

    // Validation: opening width < min(10m, wallLength * 0.7)
    if (openingWidth >= Math.min(10, wallLength * 0.7)) {
      _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_too_wide_for_wall');
      skipped++;
      continue;
    }

    // Validation: opening width < 80% of usable wall span (wall minus 0.6m margins)
    const usableSpan = wallLength - 0.6;
    if (usableSpan > 0 && openingWidth >= usableSpan * 0.8) {
      _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_exceeds_usable_span');
      skipped++;
      continue;
    }

    // Validation: opening height + sill height <= storey height
    const sillHeight = (opening.placement?.origin?.z ?? 0) -
      ((css.levelsOrSegments || []).find(l => l.id === opening.container)?.elevation_m ?? 0);
    if (openingHeight + Math.max(0, sillHeight) > storeyHeight + 0.2) {
      _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_exceeds_storey_height');
      skipped++;
      continue;
    }

    // Validation: opening not within 0.15m of wall endpoint
    const { start, end } = getWallEndpoints(hostWall);
    const openingOrigin = getOrigin(opening);
    const { proj, segLen } = projectPointToSegment(openingOrigin, start, end);
    const halfWidth = openingWidth / 2;
    if (proj - halfWidth < 0.15 || proj + halfWidth > segLen - 0.15) {
      // Only skip if wall is long enough that this matters
      if (wallLength > openingWidth + 0.6) {
        _skipOpeningVoids(css, opening, toRemove, structureClass, 'opening_too_close_to_wall_edge');
        skipped++;
        continue;
      }
    }

    // Clamp opening profile thickness to wall thickness so it doesn't protrude
    const wallThick = getWallThicknessFromProfile(hostWall);
    const p = opening.geometry?.profile;
    if (p && wallThick > 0) {
      const pw = p.width || 1;
      const ph = p.height || 1;
      const thinDim = Math.min(pw, ph);
      if (thinDim > wallThick) {
        if (pw <= ph) {
          p.width = wallThick;
        } else {
          p.height = wallThick;
        }
      }
    }

    // All checks passed — create VOIDS relationship.
    // Use element_key as the canonical target (validator builds elementKeys from element_key).
    _addVoidsRel(opening, hostWall.element_key || hostWall.id);
    if (!opening.metadata) opening.metadata = {};
    opening.metadata.openingVoidsCreated = true;
    created++;
  }

  // Remove skipped openings
  if (toRemove.size > 0) {
    css.elements = css.elements.filter(e => !toRemove.has(e.id || e.element_key));
  }

  console.log(`VOIDS relationships: ${created} created, ${skipped} skipped`);
}

/**
 * Skip an opening during VOIDS creation. For BUILDING/FACILITY: remove from elements.
 */
function _skipOpeningVoids(css, opening, toRemove, structureClass, reason) {
  const oid = opening.id || opening.element_key;
  if (structureClass === 'BUILDING' || structureClass === 'FACILITY') {
    toRemove.add(oid);
  }
  css.metadata.skippedOpenings.push({
    id: oid,
    type: (opening.type || '').toUpperCase(),
    skipReason: reason,
    phase: 'voids_creation'
  });
}


// ============================================================================
// SLAB INFERENCE (Phase 6C)
// ============================================================================

function inferSlabs(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) {
    console.log('InferSlabs: skipping for TUNNEL domain (shell slabs pre-classified)');
    return;
  }

  // Compute wall base and top Z ranges per container for geometric slab typing
  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  const wallBasesByContainer = new Map();
  const wallTopsByContainer = new Map();
  for (const wall of walls) {
    const c = wall.container || '_default';
    const oz = wall.placement?.origin?.z;
    const depth = wall.geometry?.depth;
    if (typeof oz !== 'number') continue;
    if (!wallBasesByContainer.has(c)) wallBasesByContainer.set(c, []);
    wallBasesByContainer.get(c).push(oz);
    if (typeof depth === 'number' && depth > 0) {
      if (!wallTopsByContainer.has(c)) wallTopsByContainer.set(c, []);
      wallTopsByContainer.get(c).push(oz + depth);
    }
  }

  let upgraded = 0;
  for (const elem of css.elements) {
    const t = (elem.type || elem.semantic_type || '').toUpperCase();
    if (t !== 'SLAB') continue;
    if (!elem.properties) elem.properties = {};
    // Skip only if slabType is already a valid standard value.
    // Non-standard values like COMPOSITE_FLOOR pass through so InferSlabs can assign
    // the correct type (FLOOR vs ROOF) based on Z-proximity to wall bases and tops.
    const _VALID_INFER_TYPES = new Set(['FLOOR', 'ROOF', 'BASESLAB', 'LANDING', 'NOTDEFINED', 'USERDEFINED']);
    if (elem.properties.slabType && _VALID_INFER_TYPES.has(elem.properties.slabType.toUpperCase())) continue;

    const slabZ = elem.placement?.origin?.z;
    if (typeof slabZ !== 'number') {
      elem.properties.slabType = 'FLOOR';
      if (elem.provenance) elem.provenance.modifications = [...(elem.provenance.modifications || []), 'topology:inferSlabs'];
      upgraded++;
      continue;
    }

    const c = elem.container || '_default';
    const bases = wallBasesByContainer.get(c) || [];
    const tops = wallTopsByContainer.get(c) || [];

    if (bases.length > 0 && tops.length > 0) {
      // Geometric: compare slab Z to wall bases and tops
      const sortedBases = [...bases].sort((a, b) => a - b);
      const medianBase = sortedBases[Math.floor(sortedBases.length / 2)];
      const sortedTops = [...tops].sort((a, b) => b - a);
      const medianTop = sortedTops[Math.floor(sortedTops.length / 2)];

      const distToBase = Math.abs(slabZ - medianBase);
      const distToTop = Math.abs(slabZ - medianTop);

      if (distToTop < distToBase && distToTop < 1.0) {
        elem.properties.slabType = 'ROOF';
        logDecision({ pass: 'inferSlabs', element_id: elem.element_key || elem.id,
          action: 'slab_typed', reason: 'geometric_proximity',
          params: { slabType: 'ROOF', distToBase: Math.round(distToBase * 1000) / 1000, distToTop: Math.round(distToTop * 1000) / 1000 } });
      } else {
        elem.properties.slabType = 'FLOOR';
        logDecision({ pass: 'inferSlabs', element_id: elem.element_key || elem.id,
          action: 'slab_typed', reason: 'geometric_proximity',
          params: { slabType: 'FLOOR', distToBase: Math.round(distToBase * 1000) / 1000, distToTop: Math.round(distToTop * 1000) / 1000 } });
      }
    } else {
      // Fallback: storey index (original logic)
      const levels = css.levelsOrSegments || [];
      const levelIndex = levels.findIndex(l => l.id === c);
      if (levelIndex === levels.length - 1 && levels.length > 1 && levelIndex > 0) {
        elem.properties.slabType = 'ROOF';
        logDecision({ pass: 'inferSlabs', element_id: elem.element_key || elem.id,
          action: 'slab_typed', reason: 'storey_fallback',
          params: { slabType: 'ROOF', levelIndex, totalLevels: levels.length } });
      } else {
        elem.properties.slabType = 'FLOOR';
        logDecision({ pass: 'inferSlabs', element_id: elem.element_key || elem.id,
          action: 'slab_typed', reason: 'storey_fallback',
          params: { slabType: 'FLOOR', levelIndex, totalLevels: levels.length } });
      }
    }
    if (elem.provenance) elem.provenance.modifications = [...(elem.provenance.modifications || []), 'topology:inferSlabs'];
    upgraded++;
  }

  if (upgraded > 0) {
    console.log(`InferSlabs: assigned slabType to ${upgraded} slab(s) using geometric Z-proximity`);
  }
}


// ============================================================================
// ENVELOPE FALLBACK (v3.2)
// ============================================================================

function checkEnvelopeFallback(css) {
  if (!css.metadata) return;
  if (hasTunnelSegments(css)) return;

  const skippedOpenings = css.metadata.skippedOpenings || [];
  const totalOpeningsOriginal = skippedOpenings.length + css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return t === 'DOOR' || t === 'WINDOW';
  }).length;

  // Calculate opening removal ratio
  const openingsRemovedRatio = totalOpeningsOriginal > 0
    ? skippedOpenings.length / totalOpeningsOriginal
    : 0;

  // Count remaining structural elements (walls, slabs, rooms)
  const structuralTypes = new Set(['WALL', 'SLAB', 'SPACE', 'COLUMN']);
  const structuralRemaining = css.elements.filter(e => {
    const t = (e.type || e.semantic_type || '').toUpperCase();
    return structuralTypes.has(t);
  }).length;

  // v3.2: Trigger ONLY when BOTH conditions are true
  if (openingsRemovedRatio >= 0.5 && structuralRemaining < 4) {
    console.log(`Envelope fallback triggered: ${(openingsRemovedRatio * 100).toFixed(0)}% openings removed, ${structuralRemaining} structural elements remaining`);

    // Keep only walls and slabs, remove everything else
    css.elements = css.elements.filter(e => {
      const t = (e.type || e.semantic_type || '').toUpperCase();
      return t === 'WALL' || t === 'SLAB';
    });

    css.metadata.envelopeFallback = true;
  }
}

// ============================================================================
// v6: BUILDING STRUCTURAL VALIDATION
// ============================================================================

function validateBuildingStructure(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const bbox = css.metadata?.bbox;
  if (!bbox) return;

  const warnings = [];
  const STOREY_Z_TOL = 0.5; // elements should be within ±0.5m of storey elevation

  // Build storey elevation and height maps — derive default from occupancy
  const _occVal = (css.facilityMeta || css.metadata?.facilityMeta || {}).occupancy || '';
  const _defaultHVal = storeyHeightFromOccupancy(_occVal);
  const storeyElevations = {};
  const storeyHeights = {};
  for (const level of css.levelsOrSegments || []) {
    storeyElevations[level.id] = level.elevation_m || 0;
    storeyHeights[level.id] = level.height_m || _defaultHVal;
  }

  // Check exterior wall completeness
  const extWalls = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'WALL' && e.properties?.isExternal
  );
  if (extWalls.length < 4) {
    warnings.push(`Only ${extWalls.length} exterior walls (minimum 4 expected)`);
  }

  // Check elements outside footprint
  let outsideCount = 0;
  for (const elem of css.elements) {
    const o = elem.placement?.origin;
    if (!o) continue;
    const margin = 5.0; // allow 5m beyond bbox for sections/overhangs
    if (o.x < bbox.min.x - margin || o.x > bbox.max.x + margin ||
        o.y < bbox.min.y - margin || o.y > bbox.max.y + margin) {
      outsideCount++;
    }
  }
  if (outsideCount > 0) {
    warnings.push(`${outsideCount} elements outside building footprint (with 5m margin)`);
  }

  // Check storey-z consistency
  let storeyInconsistentCount = 0;
  for (const elem of css.elements) {
    const container = elem.container;
    if (!container || !storeyElevations.hasOwnProperty(container)) continue;
    const expectedZ = storeyElevations[container];
    const actualZ = elem.placement?.origin?.z;
    if (actualZ !== undefined && Math.abs(actualZ - expectedZ) > STOREY_Z_TOL + (storeyHeights[container] || 3)) {
      storeyInconsistentCount++;
    }
  }
  if (storeyInconsistentCount > 0) {
    warnings.push(`${storeyInconsistentCount} elements have z inconsistent with their storey elevation`);
  }

  // Phase 4C: Interior coherence grading (metadata-only)
  const rooms = css.elements.filter(e => (e.type || '').toUpperCase() === 'SPACE' && !e.properties?.isTransitionHelper);
  const partitions = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL' && !e.properties?.isExternal && !e.properties?.isFallback);
  let interiorCoherence = 'ENVELOPE_ONLY';
  if (rooms.length >= 3 && partitions.length >= 2) {
    interiorCoherence = 'STRUCTURED_INTERIOR';
  } else if (rooms.length >= 1 || partitions.length >= 1) {
    interiorCoherence = 'PARTIAL_INTERIOR';
  }

  if (warnings.length > 0) {
    console.warn(`v6 Building validation: ${warnings.join('; ')}`);
  }
  if (!css.metadata) css.metadata = {};
  css.metadata.buildingValidationWarnings = warnings.length > 0 ? warnings : undefined;
  css.metadata.interiorCoherence = interiorCoherence;
}


// ============================================================================
// ROOF DEDUPLICATION — removes ROOF elements that duplicate a SLAB with slabType=ROOF
// at the same position. Keeps the SLAB representation (it gets material layers in generate).
// ============================================================================

function deduplicateRoofs(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const roofElements = css.elements.filter(e => (e.type || '').toUpperCase() === 'ROOF');
  const slabRoofs = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'SLAB' &&
    (e.properties?.slabType || '').toUpperCase() === 'ROOF'
  );

  if (roofElements.length === 0 || slabRoofs.length === 0) return;

  const removeIds = new Set();
  for (const roof of roofElements) {
    const ro = roof.placement?.origin || {};
    const rContainer = roof.container || '';
    const rz = ro.z || 0;
    const rProf = roof.geometry?.profile || {};
    const rw = rProf.width || 0;
    const rh = rProf.height || 0;
    for (const slab of slabRoofs) {
      const so = slab.placement?.origin || {};
      const sContainer = slab.container || '';
      if (rContainer !== sContainer) continue;
      const dx = (ro.x || 0) - (so.x || 0);
      const dy = (ro.y || 0) - (so.y || 0);
      const dz = rz - (so.z || 0);
      const xyDist = Math.sqrt(dx * dx + dy * dy);
      // Require: same container, XY within 0.5m, Z within 1m, dimensions similar (within 50%)
      if (xyDist > 0.5) continue;
      if (Math.abs(dz) > 1.0) continue;
      const sProf = slab.geometry?.profile || {};
      const sw = sProf.width || 0;
      const sh = sProf.height || 0;
      if (rw > 0 && sw > 0 && (Math.abs(rw - sw) / Math.max(rw, sw)) > 0.5) continue;
      if (rh > 0 && sh > 0 && (Math.abs(rh - sh) / Math.max(rh, sh)) > 0.5) continue;
      removeIds.add(roof.id || roof.element_key);
      break;
    }
  }

  if (removeIds.size > 0) {
    css.elements = css.elements.filter(e => !removeIds.has(e.id) && !removeIds.has(e.element_key));
    console.log(`DeduplicateRoofs: removed ${removeIds.size} ROOF element(s) that duplicate SLAB-ROOF at same position`);
  }
}

/**
 * Validate space/room container assignments and Z values.
 * Ensures every SPACE element has a valid container and its Z is clamped
 * to the storey elevation or host segment origin.
 */
function validateSpaceContainment(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  // Build storey elevation map
  const storeyElevations = {};
  for (const level of css.levelsOrSegments || []) {
    storeyElevations[level.id] = level.elevation_m || 0;
  }
  const defaultContainer = (css.levelsOrSegments || [])[0]?.id || 'level-1';

  // Build wall floor Z per container (median wall base)
  const wallBasesByContainer = new Map();
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'WALL') continue;
    const c = e.container || defaultContainer;
    const z = e.placement?.origin?.z;
    if (typeof z !== 'number') continue;
    if (!wallBasesByContainer.has(c)) wallBasesByContainer.set(c, []);
    wallBasesByContainer.get(c).push(z);
  }

  let corrected = 0;
  for (const elem of css.elements) {
    if ((elem.type || '').toUpperCase() !== 'SPACE') continue;

    // Ensure valid container
    if (!elem.container || !storeyElevations.hasOwnProperty(elem.container)) {
      elem.container = defaultContainer;
    }

    // Clamp Z to storey elevation if it looks wrong
    const o = elem.placement?.origin;
    if (!o || typeof o.z !== 'number') continue;

    const storeyZ = storeyElevations[elem.container] || 0;
    const wallBases = wallBasesByContainer.get(elem.container);
    const targetZ = wallBases && wallBases.length > 0
      ? wallBases.sort((a, b) => a - b)[Math.floor(wallBases.length / 2)]
      : storeyZ;

    // If space Z differs from expected floor by more than 1m, snap it
    if (Math.abs(o.z - targetZ) > 1.0) {
      o.z = targetZ;
      if (!elem.properties) elem.properties = {};
      elem.properties._containerZCorrected = true;
      corrected++;
    }
  }

  if (corrected > 0) {
    console.log(`validateSpaceContainment: corrected ${corrected} space(s) Z to match storey/wall floor`);
  }
}

/**
 * Infer IfcSpace elements for building containers that have walls but no rooms.
 * Simple bbox approach: if a container has >= 4 walls, create one space from the
 * wall footprint. Does NOT attempt graph-based closed-loop detection (too risky).
 */
function inferSpaces(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  // Check if any SPACE elements already exist from extract
  const existingSpaces = css.elements.filter(e => (e.type || '').toUpperCase() === 'SPACE');
  if (existingSpaces.length > 0) {
    console.log(`inferSpaces: ${existingSpaces.length} spaces already exist from extract, skipping`);
    return;
  }

  const levels = css.levelsOrSegments || [];
  const defaultContainer = levels[0]?.id || 'level-1';

  // Group walls by container
  const wallsByContainer = new Map();
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'WALL') continue;
    const c = e.container || defaultContainer;
    if (!wallsByContainer.has(c)) wallsByContainer.set(c, []);
    wallsByContainer.get(c).push(e);
  }

  // Build storey elevation map — derive default from occupancy
  const _occSpace = (css.facilityMeta || css.metadata?.facilityMeta || {}).occupancy || '';
  const _defaultHSpace = storeyHeightFromOccupancy(_occSpace);
  const storeyInfo = {};
  for (const level of levels) {
    storeyInfo[level.id] = { elevation: level.elevation_m || 0, height: level.height_m || _defaultHSpace };
  }

  let created = 0;
  const generated = [];

  for (const [containerId, containerWalls] of wallsByContainer) {
    if (containerWalls.length < 4) continue;

    // Compute wall footprint bbox
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const wall of containerWalls) {
      const o = wall.placement?.origin;
      if (!o) continue;
      const dir = canonicalWallDirection(wall);
      const len = canonicalWallLength(wall);
      if (dir) {
        const s = vecAdd(o, vecScale(dir, -len / 2));
        const e = vecAdd(o, vecScale(dir, len / 2));
        minX = Math.min(minX, s.x, e.x); maxX = Math.max(maxX, s.x, e.x);
        minY = Math.min(minY, s.y, e.y); maxY = Math.max(maxY, s.y, e.y);
      } else {
        minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x);
        minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y);
      }
    }
    if (!isFinite(minX)) continue;

    const spaceW = maxX - minX;
    const spaceD = maxY - minY;
    if (spaceW < 1.0 || spaceD < 1.0) continue; // too small to be a room

    const info = storeyInfo[containerId] || { elevation: 0, height: _defaultHSpace };
    const spaceZ = info.elevation;
    const spaceH = info.height;

    // Inset slightly from wall faces (use median wall thickness as margin)
    const thicknesses = containerWalls.map(w => canonicalWallThickness(w)).filter(t => t > 0);
    const inset = thicknesses.length > 0
      ? thicknesses.sort((a, b) => a - b)[Math.floor(thicknesses.length / 2)]
      : 0.2;

    const innerW = Math.max(1.0, spaceW - 2 * inset);
    const innerD = Math.max(1.0, spaceD - 2 * inset);

    generated.push({
      id: `inferred-space-${containerId}`,
      element_key: `inferred-space-${containerId}`,
      type: 'SPACE',
      name: `Room (${containerId})`,
      semanticType: 'IfcSpace',
      confidence: 0.4,
      source: 'INFERRED',
      container: containerId,
      placement: {
        origin: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: spaceZ },
        axis: { x: 0, y: 0, z: 1 },
        refDirection: { x: 1, y: 0, z: 0 }
      },
      geometry: {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: spaceH,
        profile: { type: 'RECTANGLE', width: innerW, height: innerD }
      },
      material: { name: 'space', color: [0.88, 0.88, 0.88], transparency: 0.7 },
      properties: { usage: 'GENERAL', isInferred: true },
      relationships: []
    });
    created++;
  }

  if (generated.length > 0) {
    for (const ge of generated) {
      ge.provenance = { sourceFile: null, sourceFileStatus: 'derived_inferred', sourceFiles: [], stage: 'topology:inferSpaces', modifications: [] };
    }
    css.elements.push(...generated);
    console.log(`inferSpaces: created ${created} inferred space(s) from wall footprints`);
  }
}

/**
 * Snap spec-text-derived SLAB elements to the nearest STOREY level elevation.
 * Spec authors typically write round numbers ("4.0m") that drift slightly from
 * the topology's level definitions ("4.1m" once level-0 height is added).
 * Without this snap, spec slabs land 0.1-0.3m off the actual storey floor and
 * read as "floating mid-air" in the viewer.
 */
function snapSpecSlabsToLevels(css) {
  if (!css.elements || css.elements.length === 0) return;
  const SNAP_THRESHOLD_M = 0.3;
  const storeys = (css.levelsOrSegments || [])
    .filter(l => (l.type || '').toUpperCase() === 'STOREY' && typeof l.elevation_m === 'number');
  if (storeys.length === 0) return;
  let snapped = 0;
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'SLAB') continue;
    const isSpec = e.source === 'SPEC_TEXT' || e.properties?.specInstance === true;
    if (!isSpec) continue;
    const o = e.placement?.origin;
    if (!o || typeof o.z !== 'number') continue;
    let nearest = null, bestDelta = Infinity;
    for (const s of storeys) {
      const delta = Math.abs(o.z - s.elevation_m);
      if (delta < bestDelta) { bestDelta = delta; nearest = s; }
    }
    if (nearest && bestDelta > 0 && bestDelta <= SNAP_THRESHOLD_M) {
      const oldZ = o.z;
      o.z = nearest.elevation_m;
      e.provenance = e.provenance || {};
      e.provenance.modifications = e.provenance.modifications || [];
      e.provenance.modifications.push(
        `topology:snapSpecSlabsToLevels: placement.origin.z ${oldZ} → ${nearest.elevation_m} (snapped to ${nearest.id})`
      );
      snapped++;
    }
  }
  if (snapped > 0) console.log(`snapSpecSlabsToLevels: snapped ${snapped} spec slab(s) to nearest storey elevation`);
}

export {
  mergeWalls, inferOpenings, createOpeningRelationships,
  validateOpeningPlacement, inferSlabs, guaranteeBuildingEnvelope,
  cleanBuildingWallAxes, checkEnvelopeFallback, validateBuildingStructure,
  clampAbsurdDimensions, clampWallsToEnvelope, snapWallEndpoints, alignSlabsToWalls,
  countAmbiguousProfiles, deduplicateRoofs,
  deriveRoofElevation, snapSlabsToWallBases, snapWallsToStoreyFloor, snapTunnelSegmentEndpoints,
  validateSpaceContainment, inferSpaces,
  synthesizeAncillaryRoomSlabs, snapSpecSlabsToLevels,
  deduplicateOverlappingTunnelSegments,
  solveJunctionPositions,
  trimSegmentsAtJunctions,
  // Helpers exposed for engineer-intent resolver (intent-resolver.mjs)
  projectPointToSegment, getWallHorizontalEndpoints, getOrigin, hasTunnelSegments, dist3
};

// Ambiguous profile count — now counted from canonical helper annotations
let ambiguousProfileCount = 0;
export function getAmbiguousProfileCount() { return ambiguousProfileCount; }
export function resetAmbiguousProfileCount() { ambiguousProfileCount = 0; }
function countAmbiguousProfiles(css) {
  ambiguousProfileCount = (css.elements || []).filter(e =>
    e.type === 'WALL' && e.properties?._ambiguousProfile
  ).length;
}

// ============================================================================
// ENDPOINT SNAPPING (Phase 2C)
// ============================================================================

/**
 * Snap wall endpoints to shared positions so walls share exact junction points.
 * Clusters endpoints within SNAP_RADIUS, snaps each cluster to its centroid,
 * then adjusts wall origins + lengths to match.
 */
function snapWallEndpoints(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  // Tiered snapping: Pass 1 at 50mm (high-confidence), Pass 2 at 300mm (repair orphans)
  const SNAP_PASS_1 = 0.05;  // 50mm — endpoints that are clearly the same point
  const SNAP_PASS_2 = 0.30;  // 300mm — repair orphan endpoints not snapped in Pass 1
  const MAX_SHIFT = 0.40;    // 400mm — max origin movement per wall

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  if (walls.length < 2) return;

  // Compute endpoints for all walls
  const wallData = [];
  for (const wall of walls) {
    const dir = canonicalWallDirection(wall);
    if (!dir) continue;
    const len = canonicalWallLength(wall);
    const o = wall.placement?.origin;
    if (!o || len <= 0) continue;
    const start = vecAdd(o, vecScale(dir, -len / 2));
    const end = vecAdd(o, vecScale(dir, len / 2));
    wallData.push({ wall, dir, len, start, end });
  }

  // Collect all endpoints
  const endpoints = [];
  for (let i = 0; i < wallData.length; i++) {
    endpoints.push({ wallIdx: i, which: 'start', pt: wallData[i].start });
    endpoints.push({ wallIdx: i, which: 'end', pt: wallData[i].end });
  }

  let totalSnapped = 0;
  let totalSkippedOverCap = 0;
  let pass1Snapped = 0;
  let pass2Snapped = 0;

  // Track which endpoints have been snapped (by index)
  const alreadySnapped = new Set();

  // Run a snapping pass at the given radius, only on un-snapped endpoints
  function runSnapPass(radius, passName) {
    const parent = endpoints.map((_, i) => i);
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function union(a, b) { parent[find(a)] = find(b); }

    for (let i = 0; i < endpoints.length; i++) {
      for (let j = i + 1; j < endpoints.length; j++) {
        // In Pass 2, skip pairs where both are already snapped
        if (passName === 'pass2' && alreadySnapped.has(i) && alreadySnapped.has(j)) continue;
        if (vecDist(endpoints[i].pt, endpoints[j].pt) < radius) {
          union(i, j);
        }
      }
    }

    const clusters = new Map();
    for (let i = 0; i < endpoints.length; i++) {
      const root = find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(i);
    }

    let passSnapped = 0;

    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      // In Pass 2, skip clusters where all members are already snapped
      if (passName === 'pass2' && members.every(m => alreadySnapped.has(m))) continue;

      const centroid = { x: 0, y: 0, z: 0 };
      for (const idx of members) {
        centroid.x += endpoints[idx].pt.x;
        centroid.y += endpoints[idx].pt.y;
        centroid.z += endpoints[idx].pt.z;
      }
      centroid.x /= members.length;
      centroid.y /= members.length;
      centroid.z /= members.length;

      for (const idx of members) {
        if (alreadySnapped.has(idx)) continue; // Don't re-snap

        const ep = endpoints[idx];
        const wd = wallData[ep.wallIdx];
        const wall = wd.wall;
        const dir = wd.dir;

        const delta = vecSub(centroid, ep.pt);
        const alongDir = vecDot(delta, dir);

        const originShift = vecScale(delta, 0.5);
        const shiftMag = vecLen(originShift);
        if (shiftMag > MAX_SHIFT) {
          totalSkippedOverCap++;
          if (!wall.properties) wall.properties = {};
          wall.properties._endpointSnapSkipped = true;
          continue;
        }

        const o = wall.placement.origin;
        const _snapBefore = { x: o.x, y: o.y, z: o.z };
        const _snapLenBefore = wd.len;
        o.x += originShift.x;
        o.y += originShift.y;
        o.z += originShift.z;

        // Propagate Z shift to child openings hosted on this wall
        if (Math.abs(originShift.z) > 1e-6) {
          const wallId = wall.element_key || wall.id;
          for (const el of css.elements) {
            if (el.properties?.hostWallKey !== wallId) continue;
            if (el.placement?.origin) el.placement.origin.z += originShift.z;
          }
        }

        const lenChange = (ep.which === 'start') ? -alongDir : alongDir;
        const newLen = wd.len + lenChange;
        if (newLen > 0.01) {
          setCanonicalWallLength(wall, newLen);
          wd.len = newLen;
        }

        ep.pt = { ...centroid };
        if (wall.provenance) wall.provenance.modifications = [...(wall.provenance.modifications || []), 'topology:snap'];
        logDecision({ pass: passName, element_id: wall.element_key || wall.id,
          action: 'endpoint_modified', reason: 'snap_within_tolerance',
          before: { origin: _snapBefore, length: _snapLenBefore },
          after: { origin: { x: o.x, y: o.y, z: o.z }, length: wd.len },
          params: { distance_mm: Math.round(shiftMag * 1000), tolerance_mm: Math.round(radius * 1000), endpoint: ep.which } });
        alreadySnapped.add(idx);
        passSnapped++;
        totalSnapped++;
      }
    }

    return passSnapped;
  }

  // Pass 1: High-confidence snap at 50mm
  pass1Snapped = runSnapPass(SNAP_PASS_1, 'pass1');

  // Pass 2: Repair orphans at 150mm (only endpoints not already snapped)
  pass2Snapped = runSnapPass(SNAP_PASS_2, 'pass2');

  if (!css.metadata) css.metadata = {};
  css.metadata.endpointSnapping = {
    snappedPairs: totalSnapped,
    pass1Snapped,
    pass2Snapped,
    skippedOverCap: totalSkippedOverCap,
    wallCount: walls.length,
    snapRadii: { pass1: SNAP_PASS_1, pass2: SNAP_PASS_2 },
    maxShift: MAX_SHIFT
  };
  if (totalSnapped > 0) {
    console.log(`snapWallEndpoints: Pass 1 (${SNAP_PASS_1 * 1000}mm) snapped ${pass1Snapped}, Pass 2 (${SNAP_PASS_2 * 1000}mm) snapped ${pass2Snapped}, skipped ${totalSkippedOverCap}`);
  }
}

/**
 * Parametric roof height derivation — ensures roof slabs sit at the top of walls.
 * Uses median of top-3 tallest walls per storey to avoid LLM outliers.
 * Snaps whenever deviation > 1mm — catches both gross misplacements and
 * sub-200mm "ghosting gaps" that cause visual artifacts in the viewer.
 */
function deriveRoofElevation(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  const roofSlabs = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'SLAB' && e.properties?.slabType === 'ROOF'
  );

  if (walls.length === 0 || roofSlabs.length === 0) return;

  // Group walls by container, preferring external walls
  const extWallsByContainer = new Map();
  const allWallsByContainer = new Map();
  for (const wall of walls) {
    const container = wall.container || '_default';
    if (!allWallsByContainer.has(container)) allWallsByContainer.set(container, []);
    allWallsByContainer.get(container).push(wall);
    if (wall.properties?.isExternal) {
      if (!extWallsByContainer.has(container)) extWallsByContainer.set(container, []);
      extWallsByContainer.get(container).push(wall);
    }
  }

  let adjusted = 0;

  for (const slab of roofSlabs) {
    const container = slab.container || '_default';
    // Prefer external walls; fall back to all walls filtered against outlier heights
    let containerWalls = extWallsByContainer.get(container);
    if (!containerWalls) {
      const allWalls = allWallsByContainer.get(container) || [];
      if (allWalls.length > 2) {
        // Filter out interior walls taller than 1.5x median to prevent them pulling roof Z up
        const heights = allWalls.map(w => w.geometry?.depth || 0).sort((a, b) => a - b);
        const medianH = heights[Math.floor(heights.length / 2)];
        containerWalls = allWalls.filter(w => (w.geometry?.depth || 0) <= medianH * 1.5);
      } else {
        containerWalls = allWalls;
      }
    }
    if (!containerWalls || containerWalls.length === 0) continue;

    // Compute wall tops: origin.z + depth (height)
    const wallTops = [];
    for (const wall of containerWalls) {
      const oz = wall.placement?.origin?.z;
      const depth = wall.geometry?.depth;
      if (typeof oz === 'number' && typeof depth === 'number' && depth > 0) {
        wallTops.push(oz + depth);
      }
    }

    if (wallTops.length === 0) continue;

    // Median of top-3 tallest walls (or all if fewer than 3)
    wallTops.sort((a, b) => b - a);
    const topN = wallTops.slice(0, Math.min(3, wallTops.length));
    const medianIdx = Math.floor(topN.length / 2);
    const derivedZ = topN.length % 2 === 1
      ? topN[medianIdx]
      : (topN[medianIdx - 1] + topN[medianIdx]) / 2;

    // Snap whenever not already exact (> 1mm) — catches ghosting gaps AND gross misplacements
    const currentZ = slab.placement?.origin?.z;
    if (typeof currentZ !== 'number') continue;

    if (Math.abs(currentZ - derivedZ) > 0.001) {
      slab.placement.origin.z = derivedZ;
      if (!slab.properties) slab.properties = {};
      slab.properties._heightChainAdjusted = true;
      slab.properties._derivedFromWallHeight = Math.round(derivedZ * 1000) / 1000;
      slab.properties._previousZ = Math.round(currentZ * 1000) / 1000;
      adjusted++;
    }
  }

  if (adjusted > 0) {
    console.log(`deriveRoofElevation: adjusted ${adjusted} roof slab(s) to match wall heights`);
  }
}

/**
 * Snap floor slabs to wall bases — if a floor slab is within 100mm of a wall's
 * base Z, snap it exactly. Prevents "light leaks" between floor and walls.
 */
function snapSlabsToWallBases(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  const floorSlabs = css.elements.filter(e =>
    (e.type || '').toUpperCase() === 'SLAB' &&
    (e.properties?.slabType === 'FLOOR' || !e.properties?.slabType)
  );

  if (walls.length === 0 || floorSlabs.length === 0) return;

  // Group wall base Z values by container
  const wallBasesByContainer = new Map();
  for (const wall of walls) {
    const container = wall.container || '_default';
    const baseZ = wall.placement?.origin?.z;
    if (typeof baseZ !== 'number') continue;
    if (!wallBasesByContainer.has(container)) wallBasesByContainer.set(container, []);
    wallBasesByContainer.get(container).push(baseZ);
  }

  let snapped = 0;

  for (const slab of floorSlabs) {
    const container = slab.container || '_default';
    const bases = wallBasesByContainer.get(container);
    if (!bases || bases.length === 0) continue;

    const slabZ = slab.placement?.origin?.z;
    if (typeof slabZ !== 'number') continue;

    // Find median wall base Z for this storey
    const sorted = [...bases].sort((a, b) => a - b);
    const medianBase = sorted[Math.floor(sorted.length / 2)];

    // Snap if within 100mm
    if (Math.abs(slabZ - medianBase) <= 0.10 && Math.abs(slabZ - medianBase) > 0.001) {
      slab.placement.origin.z = medianBase;
      if (!slab.properties) slab.properties = {};
      slab.properties._wallBaseSnapped = true;
      snapped++;
    }
  }

  if (snapped > 0) {
    console.log(`snapSlabsToWallBases: snapped ${snapped} floor slab(s) to wall base Z`);
  }
}

// ============================================================================
// WALL-TO-FLOOR Z SNAP
// Ensures wall bases sit exactly on their storey floor elevation — closes the
// visible gap between interior walls and the floor slab.
// ============================================================================

function snapWallsToStoreyFloor(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const levels = css.levelsOrSegments || [];
  if (levels.length === 0) return;

  // Build storey elevation map from levels
  const storeyElevation = new Map();
  for (const level of levels) {
    storeyElevation.set(level.id, level.elevation_m || 0);
  }

  // Also derive floor-slab top Z per container for higher accuracy
  const slabTopByContainer = new Map();
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'SLAB') continue;
    if (e.properties?.slabType && e.properties.slabType !== 'FLOOR') continue;
    const c = e.container || '_default';
    const z = e.placement?.origin?.z;
    const d = e.geometry?.depth || 0.2;
    if (typeof z === 'number') {
      const top = z + d;
      if (!slabTopByContainer.has(c) || top > slabTopByContainer.get(c)) {
        slabTopByContainer.set(c, top);
      }
    }
  }

  let snapped = 0;

  for (const elem of css.elements) {
    const t = (elem.type || '').toUpperCase();
    if (t !== 'WALL') continue;

    const o = elem.placement?.origin;
    if (!o || typeof o.z !== 'number') continue;

    const container = elem.container || '_default';

    // Prefer slab-top Z, fall back to storey elevation
    let targetZ = slabTopByContainer.get(container);
    if (targetZ === undefined) targetZ = storeyElevation.get(container);
    if (targetZ === undefined) continue;

    // Snap if within 500mm — wall should sit on its storey floor
    const gap = Math.abs(o.z - targetZ);
    if (gap > 0.001 && gap <= 0.5) {
      o.z = targetZ;
      snapped++;
    }
  }

  if (snapped > 0) {
    console.log(`snapWallsToStoreyFloor: snapped ${snapped} wall(s) to storey floor elevation`);
  }
}

// ============================================================================
// WALL-SLAB ALIGNMENT (Phase 2G)
// ============================================================================

/**
 * Extend slab footprints to align with outermost wall endpoints.
 */
function alignSlabsToWalls(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (hasTunnelSegments(css)) return;

  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
  const slabs = css.elements.filter(e => (e.type || '').toUpperCase() === 'SLAB' && !e.properties?.isFallbackEnvelope);
  if (walls.length === 0 || slabs.length === 0) return;

  // Group walls by container so each slab aligns to its own storey's walls
  const wallsByContainer = new Map();
  for (const wall of walls) {
    const c = wall.container || '_default';
    if (!wallsByContainer.has(c)) wallsByContainer.set(c, []);
    wallsByContainer.get(c).push(wall);
  }

  const OVERHANG = 0.05;
  let alignedCount = 0;

  for (const slab of slabs) {
    const p = slab.geometry?.profile;
    const o = slab.placement?.origin;
    if (!p || !o) continue;

    const container = slab.container || '_default';
    const containerWalls = wallsByContainer.get(container);
    if (!containerWalls || containerWalls.length === 0) continue; // no walls in this container — skip slab

    // Compute ROBUST wall bbox — use only the main building walls, not outlier
    // section walls (e.g. garage misplaced at y=15 when house ends at y=9).
    // Collect all wall endpoint X and Y coordinates, then use the core cluster
    // (reject endpoints that would more than double the footprint).
    const allXs = [], allYs = [];
    for (const wall of containerWalls) {
      const dir = canonicalWallDirection(wall);
      if (!dir) continue;
      const len = canonicalWallLength(wall);
      const wo = wall.placement?.origin;
      if (!wo) continue;
      const start = vecAdd(wo, vecScale(dir, -len / 2));
      const end = vecAdd(wo, vecScale(dir, len / 2));
      allXs.push(start.x, end.x);
      allYs.push(start.y, end.y);
    }
    if (allXs.length === 0) continue;

    // Sort and use 10th/90th percentile to define core footprint, then extend
    // to include any wall within 2x that range (catches attached garages at
    // correct positions but rejects wildly misplaced outliers).
    allXs.sort((a, b) => a - b);
    allYs.sort((a, b) => a - b);
    const p10i = Math.floor(allXs.length * 0.1);
    const p90i = Math.min(allXs.length - 1, Math.floor(allXs.length * 0.9));
    const coreMinX = allXs[p10i], coreMaxX = allXs[p90i];
    const coreMinY = allYs[p10i], coreMaxY = allYs[p90i];
    const coreW = Math.max(coreMaxX - coreMinX, 1);
    const coreH = Math.max(coreMaxY - coreMinY, 1);

    // Include walls within 1.5x of core range (catches nearby sections)
    let minX = coreMinX, maxX = coreMaxX, minY = coreMinY, maxY = coreMaxY;
    for (const x of allXs) {
      if (x >= coreMinX - coreW * 0.5 && x <= coreMaxX + coreW * 0.5) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    for (const y of allYs) {
      if (y >= coreMinY - coreH * 0.5 && y <= coreMaxY + coreH * 0.5) {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }

    const wallExtentX = (maxX - minX) + 2 * OVERHANG;
    const wallExtentY = (maxY - minY) + 2 * OVERHANG;
    const wallCenterX = (minX + maxX) / 2;
    const wallCenterY = (minY + maxY) / 2;

    const slabW = p.width || 0;
    const slabH = p.height || 0;

    // Clip slabs to wall footprint — both undersized AND oversized slabs get corrected
    const needsAlign = (
      Math.abs(slabW - wallExtentX) > 0.1 ||
      Math.abs(slabH - wallExtentY) > 0.1 ||
      Math.abs(o.x - wallCenterX) > 0.1 ||
      Math.abs(o.y - wallCenterY) > 0.1
    );
    if (needsAlign) {
      p.width = wallExtentX;
      p.height = wallExtentY;
      o.x = wallCenterX;
      o.y = wallCenterY;
      alignedCount++;
    }
  }

  if (alignedCount > 0) {
    console.log(`alignSlabsToWalls: aligned ${alignedCount} slab(s) to container wall footprint`);
  }
}

// ============================================================================
// TUNNEL ENDPOINT SNAPPING
// Ensures adjacent tunnel segment shell pieces share exact endpoint coordinates,
// eliminating "not watertight" gaps between pieces.
// ============================================================================

/**
 * Snap tunnel segment/shell piece endpoints within 150mm to exact shared coords.
 * For each pair of adjacent segments, if exit[A] ≈ entry[B] (within 150mm),
 * both endpoints are moved to their midpoint. Origin is adjusted accordingly.
 */
/**
 * Merge tunnel segments shorter than MIN_SEGMENT_LENGTH into their longest adjacent neighbor.
 * Short stubs (< 0.5m) cause snap failures and skeleton fragmentation — absorb them into
 * the longest connected neighbor to preserve path continuity without collapsing any geometry.
 */
export function mergeShortTunnelSegments(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (!hasTunnelSegments(css)) return;

  const MIN_LENGTH = 0.5; // metres — stubs shorter than this are merged
  const CLOSE_THRESHOLD = 0.2; // endpoint proximity threshold for "connected"

  // Only consider non-decomposed parent tunnel segments
  const tunnelSegs = css.elements.filter(e => {
    const t = (e.type || '').toUpperCase();
    return t === 'TUNNEL_SEGMENT'
      && e.placement?.origin && e.placement?.axis
      && (e.geometry?.depth || 0) > 0;
  });

  const vecNorm = (v) => {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    return len > 1e-10 ? { x: v.x / len, y: v.y / len, z: v.z / len } : null;
  };
  const vecDist3 = (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
  const vecAddS = (o, d, s) => ({ x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s });

  let merged = 0;

  for (const seg of tunnelSegs) {
    const depth = seg.geometry.depth;
    if (depth >= MIN_LENGTH || seg._mergedIntoNeighbor) continue;

    const segAxis = vecNorm(seg.placement.axis);
    if (!segAxis) continue;

    const segEntry = vecAddS(seg.placement.origin, segAxis, -depth / 2);
    const segExit  = vecAddS(seg.placement.origin, segAxis,  depth / 2);

    // Find best neighbor: must be longer, adjacent (within CLOSE_THRESHOLD), not already merged
    let bestNeighbor = null;
    let bestLen = -1;
    let bestExtension = 0;
    let bestExtendAtStart = false;

    for (const candidate of tunnelSegs) {
      if (candidate === seg || candidate._mergedIntoNeighbor) continue;
      const cDepth = candidate.geometry.depth;
      if (cDepth <= depth) continue; // only absorb into something longer

      const cAxis = vecNorm(candidate.placement.axis);
      if (!cAxis) continue;
      const cEntry = vecAddS(candidate.placement.origin, cAxis, -cDepth / 2);
      const cExit  = vecAddS(candidate.placement.origin, cAxis,  cDepth / 2);

      // seg.exit ≈ candidate.entry → extend candidate backward
      const d1 = vecDist3(segExit, cEntry);
      // seg.entry ≈ candidate.exit → extend candidate forward
      const d2 = vecDist3(segEntry, cExit);
      // also check reversed-orientation junctions
      const d3 = vecDist3(segExit, cExit);
      const d4 = vecDist3(segEntry, cEntry);

      const minDist = Math.min(d1, d2, d3, d4);
      if (minDist >= CLOSE_THRESHOLD || cDepth <= bestLen) continue;

      bestLen = cDepth;
      bestNeighbor = { elem: candidate, axis: cAxis, depth: cDepth, entry: cEntry, exit: cExit };
      if (d1 <= minDist + 1e-6) {
        // Extend candidate start: add depth to the entry side
        bestExtension = depth + d1;
        bestExtendAtStart = true;
      } else if (d2 <= minDist + 1e-6) {
        // Extend candidate end: add depth to the exit side
        bestExtension = depth + d2;
        bestExtendAtStart = false;
      } else {
        // Degenerate overlap case — just extend by stub depth
        bestExtension = depth;
        bestExtendAtStart = d3 < d4;
      }
    }

    if (!bestNeighbor) continue;

    const n = bestNeighbor;
    if (bestExtendAtStart) {
      // Extend neighbor backward: shift origin back, increase depth
      n.elem.geometry.depth += bestExtension;
      n.elem.placement.origin.x -= n.axis.x * (bestExtension / 2);
      n.elem.placement.origin.y -= n.axis.y * (bestExtension / 2);
      n.elem.placement.origin.z -= n.axis.z * (bestExtension / 2);
    } else {
      // Extend neighbor forward: shift origin forward, increase depth
      n.elem.geometry.depth += bestExtension;
      n.elem.placement.origin.x += n.axis.x * (bestExtension / 2);
      n.elem.placement.origin.y += n.axis.y * (bestExtension / 2);
      n.elem.placement.origin.z += n.axis.z * (bestExtension / 2);
    }

    seg._mergedIntoNeighbor = true;
    merged++;
  }

  if (merged > 0) {
    css.elements = css.elements.filter(e => !e._mergedIntoNeighbor);
    console.log(`mergeShortTunnelSegments: absorbed ${merged} stub(s) < ${MIN_LENGTH}m into longer neighbors`);
  }
  if (!css.metadata) css.metadata = {};
  css.metadata.shortSegmentsMerged = merged;
}


function snapTunnelSegmentEndpoints(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (!hasTunnelSegments(css)) return;

  // Tiered snapping: Pass 1 high-confidence, Pass 2 repair orphans
  const SNAP_PASS_1 = 0.05;  // 50mm — endpoints that are clearly the same point
  const SNAP_PASS_2 = 0.15;  // 150mm — repair orphan endpoints not snapped in Pass 1
  const MAX_ADJUST  = 0.25;  // 250mm max origin shift to prevent mangling long elements

  // Collect all tunnel segments and shell pieces with valid geometry
  const segs = css.elements.filter(e => {
    const t = (e.type || '').toUpperCase();
    return (t === 'TUNNEL_SEGMENT' || e.properties?.shellPiece) &&
           e.placement?.origin && e.placement?.axis && (e.geometry?.depth || 0) > 0;
  });
  if (segs.length < 2) return;

  // Resolve the actual bore direction — placement.axis is often {0,0,1} (vertical)
  // for tunnel segments, with the real bearing in placement.refDirection.
  function getBearing(elem) {
    const axis = elem.placement?.axis ? vecNormalize(elem.placement.axis) : null;
    const refDir = elem.placement?.refDirection ? vecNormalize(elem.placement.refDirection) : null;
    if (axis && Math.abs(axis.z) > 0.9 && refDir) return refDir; // vertical axis → use refDirection
    if (axis) return axis;
    if (refDir) return refDir;
    return null;
  }

  // Pre-compute entry/exit endpoints for each segment
  const segData = segs.map(elem => {
    const o = elem.placement.origin;
    const bearing = getBearing(elem);
    if (!bearing) return null;
    const depth = elem.geometry.depth;
    const entry = vecAdd(o, vecScale(bearing, -depth / 2));
    const exit  = vecAdd(o, vecScale(bearing,  depth / 2));
    return { elem, bearing, depth, entry, exit, snapped: false };
  }).filter(Boolean);

  let pass1Snapped = 0;
  let pass2Snapped = 0;

  function runSnapPass(radius, passName, segData) {
    let passSnapped = 0;

    // O(n²) pair check — tunnel models rarely exceed ~100 segments, so this is fine
    for (let i = 0; i < segData.length; i++) {
      for (let j = i + 1; j < segData.length; j++) {
        const a = segData[i];
        const b = segData[j];

        // Same element — skip
        if (a.elem === b.elem) continue;

        // In pass 2, skip pairs where both were already snapped
        if (passName === 'pass2' && a.snapped && b.snapped) continue;

        // Check both orientations: exit[a]≈entry[b] and entry[a]≈exit[b]
        const checks = [
          { aEnd: 'exit',  bEnd: 'entry' },
          { aEnd: 'entry', bEnd: 'exit'  },
        ];

        for (const { aEnd, bEnd } of checks) {
          const aPt = a[aEnd];
          const bPt = b[bEnd];
          const dist = vecDist(aPt, bPt);
          if (dist >= radius || dist < 1e-6) continue;

          // Snap to midpoint
          const mid = {
            x: (aPt.x + bPt.x) / 2,
            y: (aPt.y + bPt.y) / 2,
            z: (aPt.z + bPt.z) / 2,
          };

          // Adjust a's origin: origin = mid ∓ bearing * depth/2
          const aSign = aEnd === 'exit' ? -1 : 1;
          const newAOrigin = vecAdd(mid, vecScale(a.bearing, aSign * a.depth / 2));
          const aShift = vecDist(newAOrigin, a.elem.placement.origin);
          if (aShift <= MAX_ADJUST) {
            a.elem.placement.origin.x = newAOrigin.x;
            a.elem.placement.origin.y = newAOrigin.y;
            a.elem.placement.origin.z = newAOrigin.z;
            a[aEnd] = { ...mid };
            a[aEnd === 'exit' ? 'entry' : 'exit'] = vecAdd(
              a.elem.placement.origin,
              vecScale(a.bearing, (aEnd === 'exit' ? -1 : 1) * a.depth / 2)
            );
            a.snapped = true;
          }

          // Adjust b's origin similarly
          const bSign = bEnd === 'exit' ? -1 : 1;
          const newBOrigin = vecAdd(mid, vecScale(b.bearing, bSign * b.depth / 2));
          const bShift = vecDist(newBOrigin, b.elem.placement.origin);
          if (bShift <= MAX_ADJUST) {
            b.elem.placement.origin.x = newBOrigin.x;
            b.elem.placement.origin.y = newBOrigin.y;
            b.elem.placement.origin.z = newBOrigin.z;
            b[bEnd] = { ...mid };
            b[bEnd === 'exit' ? 'entry' : 'exit'] = vecAdd(
              b.elem.placement.origin,
              vecScale(b.bearing, (bEnd === 'exit' ? -1 : 1) * b.depth / 2)
            );
            b.snapped = true;
          }

          passSnapped++;
          break; // Only one orientation can match per pair
        }
      }
    }

    return passSnapped;
  }

  // Pass 1: High-confidence snap at 50mm
  pass1Snapped = runSnapPass(SNAP_PASS_1, 'pass1', segData);

  // Pass 2: Repair orphans at 150mm (only endpoints not already snapped)
  pass2Snapped = runSnapPass(SNAP_PASS_2, 'pass2', segData);

  const totalSnapped = pass1Snapped + pass2Snapped;
  if (totalSnapped > 0) {
    console.log(`snapTunnelSegmentEndpoints: Pass 1 (${SNAP_PASS_1 * 1000}mm) snapped ${pass1Snapped}, Pass 2 (${SNAP_PASS_2 * 1000}mm) snapped ${pass2Snapped}`);
  }
  if (!css.metadata) css.metadata = {};
  css.metadata.tunnelEndpointSnapping = { pass1Snapped, pass2Snapped, totalSnapped };
}

// ============================================================================
// JUNCTION CONSTRAINT SOLVER (migrated from generate lambda)
// ============================================================================

/**
 * Find the 3D point closest to all bearing lines (least-squares).
 *
 * Each line is { px, py, pz, dx, dy, dz } where (px,py,pz) is a point on the
 * line and (dx,dy,dz) is a unit direction vector.
 *
 * Solves: minimize Σ_i ||(I - D_i D_i^T)(X - P_i)||²
 * Normal equation: (Σ M_i) X = Σ M_i P_i  where M_i = I - D_i D_i^T
 *
 * Returns { x, y, z } or null if degenerate (parallel/coincident lines).
 */
function solveJunctionPoint(lines) {
  let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  for (const { px, py, pz, dx, dy, dz } of lines) {
    const m00 = 1 - dx * dx;
    const m01 = -dx * dy;
    const m02 = -dx * dz;
    const m11 = 1 - dy * dy;
    const m12 = -dy * dz;
    const m22 = 1 - dz * dz;
    a00 += m00; a01 += m01; a02 += m02;
    a11 += m11; a12 += m12; a22 += m22;
    b0 += m00 * px + m01 * py + m02 * pz;
    b1 += m01 * px + m11 * py + m12 * pz;
    b2 += m02 * px + m12 * py + m22 * pz;
  }
  const det = a00 * (a11 * a22 - a12 * a12)
            - a01 * (a01 * a22 - a12 * a02)
            + a02 * (a01 * a12 - a11 * a02);
  if (Math.abs(det) < 1e-6) return null;
  const inv = 1 / det;
  return {
    x: inv * (b0 * (a11 * a22 - a12 * a12) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a12 - a11 * b2)),
    y: inv * (a00 * (b1 * a22 - a12 * b2) - b0 * (a01 * a22 - a12 * a02) + a02 * (a01 * b2 - b1 * a02)),
    z: inv * (a00 * (a11 * b2 - b1 * a12) - a01 * (a01 * b2 - b1 * a02) + b0 * (a01 * a12 - a11 * a02))
  };
}

/**
 * Junction constraint solver — close VentSim endpoint scatter at shared nodes.
 *
 * Migrated from generate lambda. Runs in the topology engine so that solved
 * positions are available to all downstream stages (shell decomposition,
 * path connections, bridge segments, etc.) rather than being computed too late
 * in generate where shell pieces have already been placed from unsolved data.
 *
 * Algorithm:
 *   1. Build junction graph: collect bearing lines per topology node
 *   2. Per node: solve via least-squares line intersection (centroid fallback)
 *   3. Move endpoints toward junction points:
 *        - 2-way junctions (bends): direct snap
 *        - 3+ way junctions (T/cross): bearing-project only (no lateral drift)
 *   4. Recompute placement.origin, geometry.depth, properties.startPoint/endPoint
 */
function solveJunctionPositions(css) {
  if (!css.elements || css.elements.length === 0) return;
  if (!hasTunnelSegments(css)) return;

  // Resolve bore direction — same logic as snapTunnelSegmentEndpoints
  function getBearing(elem) {
    const axis = elem.placement?.axis ? vecNormalize(elem.placement.axis) : null;
    const refDir = elem.placement?.refDirection ? vecNormalize(elem.placement.refDirection) : null;
    if (axis && Math.abs(axis.z) > 0.9 && refDir) return refDir;
    if (axis) return axis;
    if (refDir) return refDir;
    return null;
  }

  const segments = [];
  for (const elem of css.elements) {
    if (elem.type !== 'TUNNEL_SEGMENT') continue;
    if ((elem.properties?.branchClass || '') !== 'STRUCTURAL') continue;
    const bearing = getBearing(elem);
    if (!bearing) continue;
    const o = elem.placement?.origin;
    if (!o) continue;
    const depth = elem.geometry?.depth || 0;
    if (depth < 0.5) continue;

    const entryNode = elem.properties?.entry_node;
    const exitNode = elem.properties?.exit_node;
    if (entryNode == null || exitNode == null) continue;

    const entry = vecAdd(o, vecScale(bearing, -depth / 2));
    const exit = vecAdd(o, vecScale(bearing, depth / 2));

    segments.push({ elem, bearing, depth, entry, exit, entryNode: String(entryNode), exitNode: String(exitNode) });
  }

  if (segments.length < 2) return;

  // STEP 1: Build junction graph — collect bearing lines per node
  const nodeLines = {};  // nodeId → [{ segIdx, pathEnd, px, py, pz, dx, dy, dz }]
  const origLengths = {};  // segIdx → original depth

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    origLengths[i] = s.depth;
    const bx = s.bearing.x, by = s.bearing.y, bz = s.bearing.z;

    if (s.entryNode) {
      if (!nodeLines[s.entryNode]) nodeLines[s.entryNode] = [];
      nodeLines[s.entryNode].push({
        segIdx: i, pathEnd: 'entry',
        px: s.entry.x, py: s.entry.y, pz: s.entry.z,
        dx: bx, dy: by, dz: bz
      });
    }
    if (s.exitNode) {
      if (!nodeLines[s.exitNode]) nodeLines[s.exitNode] = [];
      nodeLines[s.exitNode].push({
        segIdx: i, pathEnd: 'exit',
        px: s.exit.x, py: s.exit.y, pz: s.exit.z,
        dx: bx, dy: by, dz: bz
      });
    }
  }

  // STEP 2: Solve junction positions (per-node)
  const junctionPts = {};  // nodeId → { x, y, z }
  const fbNodes = new Set();
  let solvedLS = 0, solvedFB = 0;

  for (const [nodeId, lines] of Object.entries(nodeLines)) {
    if (lines.length < 2) continue;

    // Centroid fallback
    const fbX = lines.reduce((s, l) => s + l.px, 0) / lines.length;
    const fbY = lines.reduce((s, l) => s + l.py, 0) / lines.length;
    const fbZ = lines.reduce((s, l) => s + l.pz, 0) / lines.length;

    const pt = solveJunctionPoint(lines);
    let useFallback = false;
    if (!pt) {
      useFallback = true;
    } else {
      for (const l of lines) {
        const d = Math.sqrt((pt.x - l.px) ** 2 + (pt.y - l.py) ** 2 + (pt.z - l.pz) ** 2);
        if (d > 50) { useFallback = true; break; }
      }
    }

    if (useFallback) {
      junctionPts[nodeId] = { x: fbX, y: fbY, z: fbZ };
      fbNodes.add(nodeId);
      solvedFB++;
    } else {
      junctionPts[nodeId] = pt;
      solvedLS++;
    }
  }

  // STEP 3: Move endpoints toward junction points
  const adjustments = {};  // `${segIdx}:${pathEnd}` → { x, y, z }
  const edgeGaps = {};
  let maxLenChange = 0, lenClamped = 0, directSnapped = 0;
  const LENGTH_TOL = 0.20;

  for (const [nodeId, jpt] of Object.entries(junctionPts)) {
    const regs = nodeLines[nodeId] || [];
    const is2Way = regs.length === 2;

    for (const reg of regs) {
      const origLen = origLengths[reg.segIdx] || 1;
      let nx, ny, nz;

      if (is2Way) {
        // 2-way: direct snap to junction point (closes gap fully)
        nx = jpt.x; ny = jpt.y; nz = jpt.z;
        let shift = Math.sqrt((nx - reg.px) ** 2 + (ny - reg.py) ** 2 + (nz - reg.pz) ** 2);
        const shiftMax = 0.40 * origLen;
        if (shift > shiftMax && shift > 1e-6) {
          const scale = shiftMax / shift;
          nx = reg.px + (jpt.x - reg.px) * scale;
          ny = reg.py + (jpt.y - reg.py) * scale;
          nz = reg.pz + (jpt.z - reg.pz) * scale;
          lenClamped++;
        }
        directSnapped++;
      } else {
        // 3+ way: bearing-project only (no lateral drift)
        let t = (jpt.x - reg.px) * reg.dx + (jpt.y - reg.py) * reg.dy + (jpt.z - reg.pz) * reg.dz;
        const tMax = LENGTH_TOL * origLen;
        if (Math.abs(t) > tMax) { t = Math.sign(t) * tMax; lenClamped++; }
        maxLenChange = Math.max(maxLenChange, Math.abs(t) / origLen * 100);
        nx = reg.px + t * reg.dx;
        ny = reg.py + t * reg.dy;
        nz = reg.pz + t * reg.dz;
      }

      adjustments[`${reg.segIdx}:${reg.pathEnd}`] = { x: nx, y: ny, z: nz };

      // Residual gap
      const gx = jpt.x - nx, gy = jpt.y - ny, gz = jpt.z - nz;
      const gmag = Math.sqrt(gx * gx + gy * gy + gz * gz);
      const ek = segments[reg.segIdx].elem.element_key || segments[reg.segIdx].elem.id || '';
      edgeGaps[`${nodeId}:${ek}:${reg.pathEnd}`] = gmag;
    }
  }

  // STEP 4: Apply adjustments — recompute placement from solved endpoints
  const affectedSegs = new Set();
  for (const key of Object.keys(adjustments)) {
    affectedSegs.add(parseInt(key.split(':')[0]));
  }

  let recomputed = 0;
  let maxOriginShift = 0;

  for (const idx of affectedSegs) {
    const s = segments[idx];
    const entryAdj = adjustments[`${idx}:entry`];
    const exitAdj = adjustments[`${idx}:exit`];
    const ep0 = entryAdj || s.entry;
    const ep1 = exitAdj || s.exit;

    const dx = ep1.x - ep0.x, dy = ep1.y - ep0.y, dz = ep1.z - ep0.z;
    const newLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (newLen < 0.5) {
      console.log(`  WARNING: segment ${idx} degenerate after junction solve (len=${newLen.toFixed(3)}m)`);
      continue;
    }

    const bx = dx / newLen, by = dy / newLen, bz = dz / newLen;
    const mx = (ep0.x + ep1.x) / 2, my = (ep0.y + ep1.y) / 2, mz = (ep0.z + ep1.z) / 2;

    const oldO = s.elem.placement.origin;
    const shift = Math.sqrt((mx - oldO.x) ** 2 + (my - oldO.y) ** 2 + (mz - oldO.z) ** 2);
    maxOriginShift = Math.max(maxOriginShift, shift);

    // Update placement
    s.elem.placement.origin = { x: mx, y: my, z: mz };
    s.elem.placement.refDirection = { x: bx, y: by, z: bz };
    if (!s.elem.placement.axis) s.elem.placement.axis = { x: 0, y: 0, z: 1 };

    // Update geometry
    if (!s.elem.geometry) s.elem.geometry = {};
    s.elem.geometry.depth = newLen;
    s.elem.geometry.direction = { x: bx, y: by, z: bz };

    // Update geometry.path
    s.elem.geometry.path = [
      { x: ep0.x, y: ep0.y, z: ep0.z },
      { x: ep1.x, y: ep1.y, z: ep1.z }
    ];

    // Update properties.startPoint/endPoint so generate's VentSim re-placement
    // produces the same solved coordinates (keeps both in sync).
    if (!s.elem.properties) s.elem.properties = {};
    s.elem.properties.startPoint = { x: ep0.x, y: ep0.y, z: ep0.z };
    s.elem.properties.endPoint = { x: ep1.x, y: ep1.y, z: ep1.z };

    recomputed++;
  }

  if (solvedLS || solvedFB) {
    console.log(`Junction solver (topology): ${solvedLS} nodes solved (least-squares), `
      + `${solvedFB} nodes solved (centroid fallback), `
      + `${directSnapped} endpoints direct-snapped (2-way junctions)`);
  }
  if (recomputed) {
    const gapMags = Object.values(edgeGaps);
    const avgGap = gapMags.length ? gapMags.reduce((a, b) => a + b, 0) / gapMags.length : 0;
    const maxGap = gapMags.length ? Math.max(...gapMags) : 0;
    console.log(`Junction solver applied: ${recomputed} segments recomputed, `
      + `max origin shift=${maxOriginShift.toFixed(2)}m, `
      + `max length change=${maxLenChange.toFixed(1)}%, `
      + `${lenClamped} endpoints length-clamped`);
    console.log(`  Residual edge gaps: avg=${avgGap.toFixed(2)}m, max=${maxGap.toFixed(2)}m `
      + `(${gapMags.length} edges)`);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.junctionSolver = { solvedLS, solvedFB, directSnapped, recomputed, maxOriginShift, lenClamped };
}

/**
 * Phase 6D.1 P2 — host-shell trim at multi-way junctions.
 *
 * Shortens every TUNNEL_SEGMENT end that meets another segment at the same
 * topology node by `trimRadiusM` along the segment's bearing. Generate's CSG
 * filler hulls then occupy the void at the joint instead of stacking on top
 * of the original shell.
 *
 * Runs AFTER solveJunctionPositions so endpoints are at canonical joint
 * positions before retraction. Applies to STRUCTURAL segments only.
 *
 * Mutates: placement.origin, placement.refDirection, geometry.depth,
 * geometry.path, properties.startPoint/endPoint.
 *
 * Skips a trim if the resulting depth would fall below `minDepthM` (default
 * 0.5m) — keeps short stubs intact instead of collapsing them.
 */
function trimSegmentsAtJunctions(css, trimRadiusM = 0.5, minDepthM = 0.5) {
  if (!css.elements || css.elements.length === 0) return;
  if (!hasTunnelSegments(css)) return;
  if (!Number.isFinite(trimRadiusM) || trimRadiusM <= 0) return;

  function getBearing(elem) {
    const axis = elem.placement?.axis ? vecNormalize(elem.placement.axis) : null;
    const refDir = elem.placement?.refDirection ? vecNormalize(elem.placement.refDirection) : null;
    if (axis && Math.abs(axis.z) > 0.9 && refDir) return refDir;
    if (axis) return axis;
    if (refDir) return refDir;
    return null;
  }

  const segments = [];
  for (const elem of css.elements) {
    if (elem.type !== 'TUNNEL_SEGMENT') continue;
    if ((elem.properties?.branchClass || '') !== 'STRUCTURAL') continue;
    const bearing = getBearing(elem);
    if (!bearing) continue;
    const o = elem.placement?.origin;
    if (!o) continue;
    const depth = elem.geometry?.depth || 0;
    if (depth < minDepthM + 2 * trimRadiusM) continue;
    const entryNode = elem.properties?.entry_node;
    const exitNode = elem.properties?.exit_node;
    if (entryNode == null && exitNode == null) continue;

    const entry = vecAdd(o, vecScale(bearing, -depth / 2));
    const exit  = vecAdd(o, vecScale(bearing,  depth / 2));
    segments.push({
      elem, bearing, depth, entry, exit,
      entryNode: entryNode != null ? String(entryNode) : null,
      exitNode:  exitNode  != null ? String(exitNode)  : null,
    });
  }
  if (segments.length < 2) return;

  // Build node → segment-count map. A node is a "junction" iff ≥ 2 segments
  // meet there (covers 2-way bends and 3+ way intersections).
  const nodeCounts = {};
  for (const s of segments) {
    if (s.entryNode) nodeCounts[s.entryNode] = (nodeCounts[s.entryNode] || 0) + 1;
    if (s.exitNode)  nodeCounts[s.exitNode]  = (nodeCounts[s.exitNode]  || 0) + 1;
  }

  let endsTrimmed = 0;
  let segmentsTouched = 0;
  let skippedTooShort = 0;

  for (const s of segments) {
    const trimEntry = s.entryNode && (nodeCounts[s.entryNode] || 0) >= 2;
    const trimExit  = s.exitNode  && (nodeCounts[s.exitNode]  || 0) >= 2;
    if (!trimEntry && !trimExit) continue;

    const totalTrim = (trimEntry ? trimRadiusM : 0) + (trimExit ? trimRadiusM : 0);
    if (s.depth - totalTrim < minDepthM) {
      skippedTooShort++;
      continue;
    }

    const newEntry = trimEntry
      ? vecAdd(s.entry, vecScale(s.bearing,  trimRadiusM))
      : { x: s.entry.x, y: s.entry.y, z: s.entry.z };
    const newExit = trimExit
      ? vecAdd(s.exit,  vecScale(s.bearing, -trimRadiusM))
      : { x: s.exit.x,  y: s.exit.y,  z: s.exit.z  };

    const dx = newExit.x - newEntry.x;
    const dy = newExit.y - newEntry.y;
    const dz = newExit.z - newEntry.z;
    const newLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (newLen < minDepthM) { skippedTooShort++; continue; }

    const bx = dx / newLen, by = dy / newLen, bz = dz / newLen;
    const mx = (newEntry.x + newExit.x) / 2;
    const my = (newEntry.y + newExit.y) / 2;
    const mz = (newEntry.z + newExit.z) / 2;

    s.elem.placement.origin = { x: mx, y: my, z: mz };
    s.elem.placement.refDirection = { x: bx, y: by, z: bz };
    if (!s.elem.placement.axis) s.elem.placement.axis = { x: 0, y: 0, z: 1 };

    if (!s.elem.geometry) s.elem.geometry = {};
    s.elem.geometry.depth = newLen;
    s.elem.geometry.direction = { x: bx, y: by, z: bz };
    s.elem.geometry.path = [
      { x: newEntry.x, y: newEntry.y, z: newEntry.z },
      { x: newExit.x,  y: newExit.y,  z: newExit.z  },
    ];
    if (!s.elem.properties) s.elem.properties = {};
    s.elem.properties.startPoint = { x: newEntry.x, y: newEntry.y, z: newEntry.z };
    s.elem.properties.endPoint   = { x: newExit.x,  y: newExit.y,  z: newExit.z  };
    s.elem.properties.junctionTrimMeters = trimRadiusM;
    s.elem.properties.junctionTrimEnds = (trimEntry ? 'entry' : '')
      + (trimEntry && trimExit ? '+' : '')
      + (trimExit ? 'exit' : '');
    // Record the pre-trim joint position(s) so the generate lambda's CSG
    // cluster builder can recover the canonical junction centre (averaging
    // post-trim endpoints would give a point offset from the bisector).
    s.elem.properties.preTrimJointStart = trimEntry
      ? { x: s.entry.x, y: s.entry.y, z: s.entry.z }
      : null;
    s.elem.properties.preTrimJointEnd = trimExit
      ? { x: s.exit.x,  y: s.exit.y,  z: s.exit.z  }
      : null;

    if (trimEntry) endsTrimmed++;
    if (trimExit)  endsTrimmed++;
    segmentsTouched++;
  }

  if (segmentsTouched > 0 || skippedTooShort > 0) {
    console.log(`trimSegmentsAtJunctions: trimRadius=${trimRadiusM}m `
      + `segments_trimmed=${segmentsTouched} ends_trimmed=${endsTrimmed} `
      + `skipped_too_short=${skippedTooShort}`);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.junctionTrim = {
    trimRadiusM, segmentsTouched, endsTrimmed, skippedTooShort,
  };
}
