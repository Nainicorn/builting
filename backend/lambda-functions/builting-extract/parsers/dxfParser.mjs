import DxfParser from 'dxf-parser';
import { createHash } from 'crypto';

// =============================================================================
// DXF PARSER CONSTANTS — all magic numbers centralized
// =============================================================================

const DXF_MAX_RECURSION_DEPTH = 5;
const DXF_MAX_ENTITY_COUNT = 50_000;
const DXF_DEFAULT_PROFILE_WIDTH = 0.10;   // meters
const DXF_DEFAULT_PROFILE_HEIGHT = 0.10;  // meters
const DXF_COLUMN_DEFAULT_DEPTH = 3.0;     // meters (when upgraded to COLUMN)
const DXF_PROXY_DEFAULT_DEPTH = 0.2;      // meters (conservative PROXY depth)
const DXF_COLUMN_RADIUS_MIN = 0.05;       // meters
const DXF_COLUMN_RADIUS_MAX = 2.0;        // meters
const DXF_WALL_MIN_SEGMENT_LENGTH = 0.3;  // meters (closed polyline)
const DXF_WALL_OPEN_MIN_LENGTH = 0.3;     // meters (open single segment — lowered to capture door-gap segs)
const DXF_3D_Z_RANGE_THRESHOLD = 0.5;     // meters — triggers 3D warning
const DXF_DIRECTION_FALLBACK = [1, 0, 0];
const DXF_DEGENERATE_LENGTH = 1e-6;       // meters — segments shorter are skipped
const DXF_VERTEX_DEDUPE_TOL = 1e-6;       // meters — consecutive vertices closer are deduped
const MAX_ARC_SEGMENTS = 200;

// ENV-configurable overrides
const DXF_UNIT_SCALE = parseFloat(process.env.DXF_UNIT_SCALE) || 1.0;
const ARC_TO_SEGMENTS = process.env.ARC_TO_SEGMENTS === 'true';

// Layers excluded from semantic upgrade (annotation/reference layers)
const DXF_EXCLUDED_LAYERS = /^(DIM|GRID|TEXT|ANNO|DEFPOINTS|HATCH|XREF|VIEWPORT)/i;

// INSUNITS → meters conversion table
const DXF_INSUNITS_TO_METERS = {
  0: null,       // unitless → use DXF_UNIT_SCALE
  1: 0.0254,     // inches
  2: 0.3048,     // feet
  3: 1609.344,   // miles
  4: 0.001,      // millimeters
  5: 0.01,       // centimeters
  6: 1.0,        // meters
  7: 1000.0,     // kilometers
  8: 0.0000254,  // microinches
  9: 0.001,      // mils (1/1000 inch)
  10: 0.9144,    // yards
  11: 1e-10,     // angstroms
  12: 1e-9,      // nanometers
  13: 1e-6,      // microns
  14: 0.1,       // decimeters
  15: 10.0,      // decameters
  16: 100.0,     // hectometers
  17: 1e9,       // gigameters
  18: 1.496e11,  // astronomical units
  19: 9.461e15,  // light years
  20: 3.086e16,  // parsecs
};

// =============================================================================
// HELPERS
// =============================================================================

function distance3d(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z || 0) - (b.z || 0)) ** 2);
}

function midpoint3d(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 };
}

function normalize3d(dx, dy, dz) {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-12) return DXF_DIRECTION_FALLBACK;
  return [dx / len, dy / len, dz / len];
}

function scalePoint(p, scale) {
  return { x: p.x * scale, y: p.y * scale, z: (p.z || 0) * scale };
}

function roundTo(val, decimals = 2) {
  return Math.round(val * 10 ** decimals) / 10 ** decimals;
}

function makeElementKey(layer, entityType, centroid, dimension) {
  return `dxf_${(layer || 'none').replace(/\s+/g, '_')}_${entityType}_${roundTo(centroid.x)}_${roundTo(centroid.y)}_${roundTo(dimension)}`;
}

function elemHash(data) {
  return 'dxf-' + createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 12);
}

/** Dedupe consecutive vertices within tolerance */
function dedupeVertices(vertices, tol = DXF_VERTEX_DEDUPE_TOL) {
  if (vertices.length === 0) return [];
  const result = [vertices[0]];
  for (let i = 1; i < vertices.length; i++) {
    if (distance3d(vertices[i], result[result.length - 1]) > tol) {
      result.push(vertices[i]);
    }
  }
  return result;
}

/** Determine if a layer is excluded from semantic upgrade */
function isExcludedLayer(layer) {
  return DXF_EXCLUDED_LAYERS.test(layer || '');
}

/** Determine semantic upgrade for a segment/entity */
function getSemanticUpgrade(layer, entityType, length, isClosed, radius) {
  if (!layer || isExcludedLayer(layer)) return null;
  const upper = layer.toUpperCase();

  // AIA CAD standard layer names (A-WALL, A-FLOR, etc.) from Revit/AutoCAD exports
  if (/^A-WALL/i.test(upper)) {
    if (entityType === 'LINE' || entityType === 'LWPOLYLINE' || entityType === 'POLYLINE' || entityType === 'POLYFACE_MESH') {
      if (entityType === 'POLYFACE_MESH') return 'WALL';
      if (isClosed && length >= DXF_WALL_MIN_SEGMENT_LENGTH) return 'WALL';
      if (!isClosed && length >= DXF_WALL_OPEN_MIN_LENGTH) return 'WALL';
    }
  }
  if (/^A-FLOR/i.test(upper)) return 'SLAB';
  if (/^S-COLS/i.test(upper) && entityType === 'CIRCLE' && radius >= DXF_COLUMN_RADIUS_MIN && radius <= DXF_COLUMN_RADIUS_MAX) return 'COLUMN';

  // AIA MEP standard layers: M-HVAC-* → DUCT, E-ELEC-* → EQUIPMENT, M-EQPM* → EQUIPMENT
  if (/^M-HVAC/i.test(upper)) return 'DUCT';
  if (/^E-ELEC/i.test(upper)) return 'EQUIPMENT';
  if (/^M-EQPM/i.test(upper)) return 'EQUIPMENT';
  if (/^P-PIPE/i.test(upper)) return 'PIPE';
  if (/^E-LTNG/i.test(upper)) return 'EQUIPMENT';

  // Generic layer name patterns
  if (upper.startsWith('WALL') && (entityType === 'LINE' || entityType === 'LWPOLYLINE' || entityType === 'POLYLINE')) {
    if (isClosed && length >= DXF_WALL_MIN_SEGMENT_LENGTH) return 'WALL';
    if (!isClosed && length >= DXF_WALL_OPEN_MIN_LENGTH) return 'WALL';
  }
  if (/^HVAC|^DUCT|^MECH-DUCT/i.test(upper)) return 'DUCT';
  if (/^PIPE|^PLUMB/i.test(upper)) return 'PIPE';
  if (/^ELEC|^E-EQPM|^EQPM/i.test(upper)) return 'EQUIPMENT';
  if (upper.startsWith('COLUMN') && (entityType === 'CIRCLE') &&
      radius >= DXF_COLUMN_RADIUS_MIN && radius <= DXF_COLUMN_RADIUS_MAX) {
    return 'COLUMN';
  }
  if (upper.startsWith('SLAB') && (entityType === '3DFACE' || entityType === 'SOLID')) {
    return 'SLAB';
  }
  return null;
}

// =============================================================================
// ENTITY PROCESSORS
// =============================================================================

function processLine(entity, layer, scale) {
  const start = scalePoint(entity.vertices[0], scale);
  const end = scalePoint(entity.vertices[1], scale);
  const len = distance3d(start, end);
  if (len < DXF_DEGENERATE_LENGTH) {
    console.warn(`Degenerate DXF segment skipped (length<1e-6) handle=${entity.handle} layer=${layer}`);
    return [];
  }

  const mid = midpoint3d(start, end);
  const dir = normalize3d(end.x - start.x, end.y - start.y, end.z - start.z);
  const upgrade = getSemanticUpgrade(layer, 'LINE', len, false, null);

  return [{
    element_key: makeElementKey(layer, 'LINE', mid, len),
    id: elemHash({ type: 'LINE', start, end }),
    semantic_type: upgrade || 'PROXY',
    placement: { position: { x: mid.x, y: mid.y, z: mid.z } },
    geometry: {
      length_m: roundTo(len, 4),
      direction: dir,
      profile: { type: 'rectangle', width_m: DXF_DEFAULT_PROFILE_WIDTH, height_m: DXF_DEFAULT_PROFILE_HEIGHT },
      depth_m: roundTo(len, 4)
    },
    sourceLayer: layer,
    sourceEntityType: 'LINE',
    sourceHandle: entity.handle || null,
  }];
}

function processPolyFaceMesh(entity, layer, scale) {
  // Position vertices have flag 192 (AcDbPolyFaceMeshVertex); face records have
  // flag 128 (AcDbFaceRecord) with x=y=z=0. Filter to real positions only.
  const posVerts = (entity.vertices || [])
    .filter(v => v.flags !== undefined
      ? (v.flags & 192) === 192
      : Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) > 0)
    .map(v => scalePoint(v, scale));

  if (posVerts.length < 2) return [];

  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;
  let zMin = Infinity, zMax = -Infinity;
  for (const v of posVerts) {
    xMin = Math.min(xMin, v.x); xMax = Math.max(xMax, v.x);
    yMin = Math.min(yMin, v.y); yMax = Math.max(yMax, v.y);
    zMin = Math.min(zMin, v.z); zMax = Math.max(zMax, v.z);
  }

  const centroid = { x: (xMin + xMax) / 2, y: (yMin + yMax) / 2, z: (zMin + zMax) / 2 };
  const width = xMax - xMin;
  const depth = yMax - yMin;
  const height = zMax - zMin;
  const span = Math.max(width, depth);
  const upgrade = getSemanticUpgrade(layer, 'POLYFACE_MESH', span, false, null);

  return [{
    element_key: makeElementKey(layer, 'POLYFACE', centroid, span),
    id: elemHash({ type: 'POLYFACE', centroid, width, depth, height }),
    semantic_type: upgrade || 'PROXY',
    placement: { position: { x: centroid.x, y: centroid.y, z: zMin } },
    geometry: {
      width_m: roundTo(width, 4),
      depth_m: roundTo(depth, 4),
      height_m: roundTo(height, 4),
      bbox: {
        min: { x: roundTo(xMin, 4), y: roundTo(yMin, 4), z: roundTo(zMin, 4) },
        max: { x: roundTo(xMax, 4), y: roundTo(yMax, 4), z: roundTo(zMax, 4) },
      },
      vertexCount: posVerts.length,
    },
    sourceLayer: layer,
    sourceEntityType: 'POLYFACE_MESH',
    sourceHandle: entity.handle || null,
    metadata: { primitive: 'POLYFACE_MESH' },
  }];
}

function processPolyline(entity, layer, scale) {
  // PolyFaceMesh (Revit 3D solid export, flag 64) — extract bounding box footprint
  if ((entity.flags & 64) || entity.mesh) return processPolyFaceMesh(entity, layer, scale);

  const rawVertices = (entity.vertices || []).map(v => scalePoint(v, scale));
  const vertices = dedupeVertices(rawVertices);

  if (vertices.length < 2) {
    console.warn(`Degenerate polyline skipped (<2 unique vertices) handle=${entity.handle} layer=${layer}`);
    return [];
  }

  const isClosed = entity.shape || entity.closed || false;
  const elements = [];
  const pairs = [];

  for (let i = 0; i < vertices.length - 1; i++) {
    pairs.push([vertices[i], vertices[i + 1]]);
  }
  if (isClosed && vertices.length >= 3) {
    pairs.push([vertices[vertices.length - 1], vertices[0]]);
  }

  for (const [start, end] of pairs) {
    const len = distance3d(start, end);
    if (len < DXF_DEGENERATE_LENGTH) {
      console.warn(`Degenerate DXF segment skipped (length<1e-6) handle=${entity.handle} layer=${layer}`);
      continue;
    }

    const mid = midpoint3d(start, end);
    const dir = normalize3d(end.x - start.x, end.y - start.y, end.z - start.z);
    const upgrade = getSemanticUpgrade(layer, entity.type, len, isClosed, null);

    elements.push({
      element_key: makeElementKey(layer, 'POLYLINE_SEG', mid, len),
      id: elemHash({ type: 'POLYLINE_SEG', start, end }),
      semantic_type: upgrade || 'PROXY',
      placement: { position: { x: mid.x, y: mid.y, z: mid.z } },
      geometry: {
        length_m: roundTo(len, 4),
        direction: dir,
        profile: { type: 'rectangle', width_m: DXF_DEFAULT_PROFILE_WIDTH, height_m: DXF_DEFAULT_PROFILE_HEIGHT },
        depth_m: roundTo(len, 4)
      },
      sourceLayer: layer,
      sourceEntityType: entity.type,
      sourceHandle: entity.handle || null,
      metadata: {
        sourcePolyline: { handle: entity.handle, vertexCount: rawVertices.length, closed: isClosed }
      }
    });
  }

  return elements;
}

function processCircle(entity, layer, scale) {
  const center = scalePoint(entity.center, scale);
  const radius = (entity.radius || 0) * scale;
  const upgrade = getSemanticUpgrade(layer, 'CIRCLE', 0, false, radius);
  const depth = upgrade === 'COLUMN' ? DXF_COLUMN_DEFAULT_DEPTH : DXF_PROXY_DEFAULT_DEPTH;

  return [{
    element_key: makeElementKey(layer, 'CIRCLE', center, radius),
    id: elemHash({ type: 'CIRCLE', center, radius }),
    semantic_type: upgrade || 'PROXY',
    placement: { position: { x: center.x, y: center.y, z: center.z } },
    geometry: {
      profile: { type: 'circle', radius_m: roundTo(radius, 4) },
      depth_m: depth
    },
    sourceLayer: layer,
    sourceEntityType: 'CIRCLE',
    sourceHandle: entity.handle || null,
  }];
}

function processArc(entity, layer, scale) {
  const center = scalePoint(entity.center, scale);
  const radius = (entity.radius || 0) * scale;
  const startAngle = entity.startAngle || 0;
  const endAngle = entity.endAngle || 360;

  const elements = [{
    element_key: makeElementKey(layer, 'ARC', center, radius),
    id: elemHash({ type: 'ARC', center, radius, startAngle, endAngle }),
    semantic_type: 'PROXY',
    placement: { position: { x: center.x, y: center.y, z: center.z } },
    geometry: {
      profile: { type: 'circle', radius_m: roundTo(radius, 4) },
      depth_m: DXF_PROXY_DEFAULT_DEPTH
    },
    sourceLayer: layer,
    sourceEntityType: 'ARC',
    sourceHandle: entity.handle || null,
    metadata: {
      primitive: 'ARC',
      center: { x: center.x, y: center.y, z: center.z },
      radius: roundTo(radius, 4),
      startAngle, endAngle
    }
  }];

  // Optional arc-to-segments approximation
  if (ARC_TO_SEGMENTS && radius > 0) {
    const angleDelta = ((endAngle - startAngle + 360) % 360) * Math.PI / 180;
    const arcLength = radius * angleDelta;
    let segmentCount = Math.ceil(arcLength / 0.5); // target chord ≤ 0.5m
    segmentCount = Math.min(segmentCount, MAX_ARC_SEGMENTS);
    segmentCount = Math.max(segmentCount, 1);

    const stepAngle = angleDelta / segmentCount;
    const startRad = startAngle * Math.PI / 180;

    for (let i = 0; i < segmentCount; i++) {
      const a1 = startRad + i * stepAngle;
      const a2 = startRad + (i + 1) * stepAngle;
      const p1 = { x: center.x + radius * Math.cos(a1), y: center.y + radius * Math.sin(a1), z: center.z };
      const p2 = { x: center.x + radius * Math.cos(a2), y: center.y + radius * Math.sin(a2), z: center.z };
      const mid = midpoint3d(p1, p2);
      const len = distance3d(p1, p2);
      if (len < DXF_DEGENERATE_LENGTH) continue;
      const dir = normalize3d(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);

      elements.push({
        element_key: makeElementKey(layer, 'ARC_SEG', mid, len),
        id: elemHash({ type: 'ARC_SEG', p1, p2 }),
        semantic_type: 'PROXY',
        placement: { position: { x: mid.x, y: mid.y, z: mid.z } },
        geometry: {
          length_m: roundTo(len, 4),
          direction: dir,
          profile: { type: 'rectangle', width_m: DXF_DEFAULT_PROFILE_WIDTH, height_m: DXF_DEFAULT_PROFILE_HEIGHT },
          depth_m: roundTo(len, 4)
        },
        sourceLayer: layer,
        sourceEntityType: 'ARC_SEG',
        sourceHandle: entity.handle || null,
      });
    }
  }

  return elements;
}

function processFaceset(entity, layer, scale) {
  const vertices = (entity.vertices || []).map(v => scalePoint(v, scale));
  if (vertices.length < 3) return [];

  const centroid = {
    x: vertices.reduce((s, v) => s + v.x, 0) / vertices.length,
    y: vertices.reduce((s, v) => s + v.y, 0) / vertices.length,
    z: vertices.reduce((s, v) => s + v.z, 0) / vertices.length,
  };
  const upgrade = getSemanticUpgrade(layer, entity.type, 0, false, null);

  return [{
    element_key: makeElementKey(layer, 'FACESET', centroid, vertices.length),
    id: elemHash({ type: 'FACESET', centroid, vertexCount: vertices.length }),
    semantic_type: upgrade || 'PROXY',
    placement: { position: { x: centroid.x, y: centroid.y, z: centroid.z } },
    geometry: {
      vertices: vertices.map(v => ({ x: roundTo(v.x, 4), y: roundTo(v.y, 4), z: roundTo(v.z, 4) })),
      depth_m: DXF_PROXY_DEFAULT_DEPTH
    },
    sourceLayer: layer,
    sourceEntityType: entity.type,
    sourceHandle: entity.handle || null,
    metadata: { primitive: 'FACESET' }
  }];
}

// =============================================================================
// INSERT EXPANSION
// =============================================================================

function expandInserts(entities, blocks, scale, depth = 0, visited = new Set(), entityCount = { current: 0 }) {
  const results = [];

  for (const entity of entities) {
    if (entity.type !== 'INSERT') {
      // Non-INSERT entities always parsed, even after cap
      const processed = processEntity(entity, scale);
      results.push(...processed);
      entityCount.current += processed.length;
      continue;
    }

    // INSERT expansion
    if (depth >= DXF_MAX_RECURSION_DEPTH) {
      console.warn(`INSERT recursion depth limit (${DXF_MAX_RECURSION_DEPTH}) reached, skipping block=${entity.name}`);
      continue;
    }
    if (visited.has(entity.name)) {
      console.warn(`INSERT cycle detected for block=${entity.name}, skipping`);
      continue;
    }

    const block = blocks[entity.name];
    if (!block || !block.entities) continue;

    const blockEntityCount = block.entities.length;
    const rows = entity.rowCount || 1;
    const cols = entity.columnCount || 1;
    const rowSpacing = (entity.rowSpacing || 0) * scale;
    const colSpacing = (entity.columnSpacing || 0) * scale;
    const insertPt = scalePoint(entity.position || { x: 0, y: 0, z: 0 }, scale);
    const rotation = (entity.rotation || 0) * Math.PI / 180;
    const scaleX = entity.xScale || 1;
    const scaleY = entity.yScale || 1;
    const scaleZ = entity.zScale || 1;

    // Pre-expansion cap check
    let actualRows = rows;
    let actualCols = cols;
    const predicted = rows * cols * blockEntityCount;
    const remaining = DXF_MAX_ENTITY_COUNT - entityCount.current;

    if (predicted > remaining) {
      // Clamp proportionally
      const maxInstances = Math.max(1, Math.floor(remaining / blockEntityCount));
      actualCols = Math.min(cols, maxInstances);
      actualRows = Math.min(rows, Math.max(1, Math.floor(maxInstances / actualCols)));
      console.warn(`INSERT expansion clamped: requested ${rows}x${cols}x${blockEntityCount}=${predicted}, capacity=${remaining}. Clamped to ${actualRows}x${actualCols}.`);
    }

    if (entityCount.current >= DXF_MAX_ENTITY_COUNT) {
      console.warn(`Entity count cap reached (${DXF_MAX_ENTITY_COUNT}). Remaining INSERT expansions skipped.`);
      continue;
    }

    const childVisited = new Set(visited);
    childVisited.add(entity.name);

    for (let r = 0; r < actualRows; r++) {
      for (let c = 0; c < actualCols; c++) {
        if (entityCount.current >= DXF_MAX_ENTITY_COUNT) break;

        const offsetX = c * colSpacing;
        const offsetY = r * rowSpacing;

        // Transform block entities
        const transformed = block.entities.map(be => {
          const cloned = JSON.parse(JSON.stringify(be));
          // DXF BYBLOCK: entities on layer "0" inside a block inherit the INSERT's layer
          if (cloned.layer === '0' || !cloned.layer) {
            cloned.layer = entity.layer;
          }
          transformEntity(cloned, insertPt, rotation, scaleX, scaleY, scaleZ, offsetX, offsetY, scale);
          return cloned;
        });

        const expanded = expandInserts(transformed, blocks, 1.0, depth + 1, childVisited, entityCount);
        results.push(...expanded);
      }
    }
  }

  return results;
}

/** Apply INSERT transform (rotation, scale, translation) to entity coordinates */
function transformEntity(entity, insertPt, rotation, sx, sy, sz, offsetX, offsetY, scale) {
  const transform = (p) => {
    let x = (p.x || 0) * sx;
    let y = (p.y || 0) * sy;
    let z = (p.z || 0) * sz;
    // Rotate about origin
    if (rotation !== 0) {
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      x = rx;
      y = ry;
    }
    // Translate
    p.x = x + insertPt.x + offsetX;
    p.y = y + insertPt.y + offsetY;
    p.z = z + insertPt.z;
  };

  if (entity.vertices) entity.vertices.forEach(transform);
  if (entity.center) transform(entity.center);
  if (entity.position) transform(entity.position);
}

/** Process a single entity into CSS elements */
function processEntity(entity, scale) {
  const layer = entity.layer || '0';
  switch (entity.type) {
    case 'LINE':
      return processLine(entity, layer, scale);
    case 'LWPOLYLINE':
    case 'POLYLINE':
      return processPolyline(entity, layer, scale);
    case 'CIRCLE':
      return processCircle(entity, layer, scale);
    case 'ARC':
      return processArc(entity, layer, scale);
    case '3DFACE':
    case 'SOLID':
      return processFaceset(entity, layer, scale);
    default:
      return [];
  }
}

// =============================================================================
// CSS v1.0 FIELD HELPERS
// =============================================================================

/** Infer geometry.method from raw DXF geometry shape */
function inferGeometryMethod(geo) {
  if (geo.vertices && geo.vertices.length > 0) return 'BREP';
  if (geo.bbox) return 'BREP';
  return 'EXTRUSION';
}

/** Strip _m suffixes from geometry fields to match CSS v1.0 contract */
function normalizeCssGeometry(geo) {
  const out = { method: inferGeometryMethod(geo) };
  if (geo.length_m !== undefined) out.length = geo.length_m;
  if (geo.depth_m !== undefined) out.depth = geo.depth_m;
  if (geo.width_m !== undefined) out.width = geo.width_m;
  if (geo.height_m !== undefined) out.height = geo.height_m;
  if (geo.direction) out.direction = geo.direction;
  if (geo.profile) {
    out.profile = { type: geo.profile.type };
    if (geo.profile.width_m !== undefined) out.profile.width = geo.profile.width_m;
    if (geo.profile.height_m !== undefined) out.profile.height = geo.profile.height_m;
    if (geo.profile.radius_m !== undefined) out.profile.radius = geo.profile.radius_m;
  }
  if (geo.vertices) out.vertices = geo.vertices;
  if (geo.bbox) out.bbox = geo.bbox;
  if (geo.vertexCount !== undefined) out.vertexCount = geo.vertexCount;
  return out;
}

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Parse DXF text content into CSS v1.0 JSON.
 * @param {string} dxfText - Raw DXF file content
 * @returns {object} CSS v1.0 JSON (flat contract: elements[], levelsOrSegments[])
 */
export function parseDxfToCSS(dxfText) {
  console.log('Parsing DXF format to CSS...');

  const parser = new DxfParser();
  const dxf = parser.parseSync(dxfText);

  if (!dxf || !dxf.entities) {
    console.warn('DXF parse returned no entities');
    return buildFallbackCSS('DXF file contained no parseable entities');
  }

  // Step 1: Determine unit scale
  let insunits = null;
  let scaleFactor = DXF_UNIT_SCALE;
  let unitSource = 'default';

  if (dxf.header && dxf.header['$INSUNITS'] !== undefined) {
    insunits = dxf.header['$INSUNITS'];
    const meters = DXF_INSUNITS_TO_METERS[insunits];
    if (meters !== null && meters !== undefined) {
      scaleFactor = meters;
      unitSource = 'header';
    }
    // insunits=0 or not in table → use DXF_UNIT_SCALE default
  }

  // Sanity-check declared units against actual model extents.
  // Revit DXF exports commonly set INSUNITS=6 (meters) while coordinates are
  // actually in millimeters. Detect by checking if any extent value exceeds
  // 10,000 — a 10km span is impossible for a single building in meters.
  if (scaleFactor === 1.0 && dxf.header) {
    const extMax = dxf.header['$EXTMAX'];
    const extMin = dxf.header['$EXTMIN'];
    if (extMax) {
      const span = Math.max(
        Math.abs(extMax.x || 0), Math.abs(extMax.y || 0), Math.abs(extMax.z || 0),
        Math.abs((extMin || {}).x || 0), Math.abs((extMin || {}).y || 0), Math.abs((extMin || {}).z || 0)
      );
      if (span > 10000) {
        scaleFactor = 0.001;
        unitSource = 'extent-override-mm';
        console.warn(`DXF INSUNITS=${insunits} declares meters but max extent=${span.toFixed(0)} — overriding to mm (×0.001)`);
      }
    }
  }

  console.log(`DXF units: INSUNITS=${insunits}, scaleFactor=${scaleFactor}, source=${unitSource}`);

  // Step 2: Scale all coordinates, then compute derived geometry
  const blocks = {};
  if (dxf.blocks) {
    for (const [name, block] of Object.entries(dxf.blocks)) {
      blocks[name] = block;
    }
  }

  // Step 3: Expand INSERTs and process entities
  const rawElements = expandInserts(dxf.entities, blocks, scaleFactor);

  // Step 4: Compute statistics
  let proxyCount = 0;
  let semanticUpgradeCount = 0;
  let zMin = Infinity, zMax = -Infinity;

  for (const el of rawElements) {
    if (el.semantic_type === 'PROXY') proxyCount++;
    else semanticUpgradeCount++;
    const z = el.placement?.position?.z || 0;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }

  const warnings = [];
  if ((zMax - zMin) > DXF_3D_Z_RANGE_THRESHOLD) {
    warnings.push('DXF appears 3D; multi-storey inference not implemented.');
  }

  // Step 5: Compute confidence
  const totalElements = rawElements.length;
  const upgradeRatio = totalElements > 0 ? semanticUpgradeCount / totalElements : 0;
  const confidence = upgradeRatio > 0.5 ? 0.6 : 0.4;

  // Step 6: Build flat CSS v1.0 output
  const levelId = 'level-1';

  return {
    cssVersion: '1.0',
    domain: 'BUILDING',
    levelsOrSegments: [{
      id: levelId,
      type: 'STOREY',
      name: 'Ground Floor',
      elevation_m: 0,
      height_m: 3.5,
    }],
    elements: rawElements.map(el => ({
      id: el.id,
      element_key: el.element_key,
      type: el.semantic_type,
      container: levelId,
      placement: { origin: el.placement.position },
      geometry: normalizeCssGeometry(el.geometry),
      confidence,
      source: 'DXF',
      sourceLayer: el.sourceLayer,
      sourceEntityType: el.sourceEntityType,
      sourceHandle: el.sourceHandle,
      metadata: el.metadata || {},
    })),
    metadata: {
      title: 'DXF Import',
      source: 'DXF',
      confidence,
      schema_version: '1.0',
      dxfUnits: { insunits, scaleFactor, source: unitSource },
      warnings,
      diagnostics: {
        parserUsed: 'DXF',
        elementCount: totalElements,
        proxyCount,
        semanticUpgradeCount,
        enrichmentApplied: false,
        enrichmentPatchCount: 0,
        truncatedFiles: []
      }
    },
  };
}

function buildFallbackCSS(reason) {
  return {
    cssVersion: '1.0',
    domain: 'BUILDING',
    levelsOrSegments: [],
    elements: [],
    metadata: {
      title: 'DXF Import (empty)',
      source: 'DXF',
      confidence: 0.0,
      schema_version: '1.0',
      warnings: [reason],
      diagnostics: {
        parserUsed: 'DXF',
        elementCount: 0,
        proxyCount: 0,
        semanticUpgradeCount: 0,
        enrichmentApplied: false,
        enrichmentPatchCount: 0,
        truncatedFiles: []
      }
    },
  };
}
