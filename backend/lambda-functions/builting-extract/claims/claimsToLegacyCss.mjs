/**
 * Claims → Legacy CSS converter.
 * Reconstructs the exact CSS object from claims + parserArtifacts.
 * Since claims store complete element data in `attributes`, this is a flattening operation.
 */

import { CLAIM_KINDS } from './claimsSchema.mjs';

/**
 * Extract facility-level metadata from claims and return it ready to merge into css.metadata.
 *
 * FACILITY_DIMENSION and MATERIAL_ASSIGNMENT claims are not renderable geometry — they carry
 * tunnel heights, portal elevations, shaft params, duct specs, room heights, and material zones.
 * This function routes them to css.metadata so the Topology Engine can consume them.
 *
 * @param {Array} claims - Array of claim objects from the claims document
 * @returns {{ facilityDimensions: Array, materialAssignments: Array, portals: Array }}
 */
export function extractFacilityMetadataFromClaims(claims) {
  const facilityDimensions = claims
    .filter(c => c.kind === CLAIM_KINDS.FACILITY_DIMENSION)
    .map(c => ({ ...c.attributes, _source: 'claims_route' }));

  const materialAssignments = claims
    .filter(c => c.kind === CLAIM_KINDS.MATERIAL_ASSIGNMENT)
    .map(c => ({ ...c.attributes }));

  const portals = claims
    .filter(c => c.kind === CLAIM_KINDS.PORTAL_DEFINITION)
    .map(c => ({ ...c.attributes }));

  return { facilityDimensions, materialAssignments, portals };
}

/**
 * Convert a claims document back to legacy CSS format.
 * @param {object} claimsDoc - Full claims envelope (claimsVersion, domain, facilityMeta, claims, ...)
 * @param {object} parserArtifacts - Parser-specific metadata needed for exact CSS reconstruction
 * @returns {object} CSS object identical to the original parser output
 */
export function claimsToLegacyCss(claimsDoc, parserArtifacts = {}) {
  const { parserType } = parserArtifacts;

  switch (parserType) {
    case 'VENTSIM':
      return claimsToVentSimCss(claimsDoc, parserArtifacts);
    case 'DXF':
      return claimsToDxfCss(claimsDoc, parserArtifacts);
    case 'BEDROCK_BUILDING':
    case 'BEDROCK_TUNNEL':
      return claimsToBedrockCss(claimsDoc, parserArtifacts);
    default:
      // Fallback: generic reconstruction
      return claimsToGenericCss(claimsDoc, parserArtifacts);
  }
}

/**
 * Reconstruct VentSim CSS from claims.
 */
function claimsToVentSimCss(claimsDoc, artifacts) {
  const elements = extractElementsFromClaims(claimsDoc.claims);
  const { facilityDimensions, materialAssignments, portals } = extractFacilityMetadataFromClaims(claimsDoc.claims);

  const metadata = { ...(artifacts.metadata || {}) };
  if (facilityDimensions.length > 0) {
    metadata.facilityDimensions = [...(metadata.facilityDimensions || []), ...facilityDimensions];
  }
  if (materialAssignments.length > 0) {
    metadata.materialAssignments = [...(metadata.materialAssignments || []), ...materialAssignments];
  }
  if (portals.length > 0) {
    metadata.portals = [...(metadata.portals || []), ...portals];
  }

  return {
    cssVersion: artifacts.cssVersion || '1.0',
    domain: artifacts.domain || claimsDoc.domain || 'TUNNEL',
    facility: artifacts.facility || facilityFromMeta(claimsDoc.facilityMeta),
    levelsOrSegments: artifacts.levelsOrSegments || extractLevelsFromClaims(claimsDoc.claims),
    elements,
    metadata,
  };
}

/**
 * Reconstruct DXF CSS from claims — flat CSS v1.0 contract.
 */
function claimsToDxfCss(claimsDoc, artifacts) {
  const elements = extractElementsFromClaims(claimsDoc.claims);
  const { facilityDimensions, materialAssignments, portals } = extractFacilityMetadataFromClaims(claimsDoc.claims);

  const metadata = artifacts.metadata || { title: 'DXF Import', source: 'DXF', confidence: 0.5, schema_version: '1.0' };
  if (facilityDimensions.length > 0) {
    metadata.facilityDimensions = [...(metadata.facilityDimensions || []), ...facilityDimensions];
  }
  if (materialAssignments.length > 0) {
    metadata.materialAssignments = [...(metadata.materialAssignments || []), ...materialAssignments];
  }
  if (portals.length > 0) {
    metadata.portals = [...(metadata.portals || []), ...portals];
  }

  return {
    cssVersion: artifacts.cssVersion || '1.0',
    domain: artifacts.domain || claimsDoc.domain || 'BUILDING',
    levelsOrSegments: artifacts.levelsOrSegments || extractLevelsFromClaims(claimsDoc.claims),
    elements,
    metadata,
  };
}

/**
 * Reconstruct Bedrock-extracted CSS from claims.
 */
function claimsToBedrockCss(claimsDoc, artifacts) {
  const elements = extractElementsFromClaims(claimsDoc.claims);
  const { facilityDimensions, materialAssignments, portals } = extractFacilityMetadataFromClaims(claimsDoc.claims);

  const metadata = { ...(artifacts.metadata || {}) };
  if (facilityDimensions.length > 0) {
    metadata.facilityDimensions = [...(metadata.facilityDimensions || []), ...facilityDimensions];
  }
  if (materialAssignments.length > 0) {
    metadata.materialAssignments = [...(metadata.materialAssignments || []), ...materialAssignments];
  }
  if (portals.length > 0) {
    metadata.portals = [...(metadata.portals || []), ...portals];
  }

  return {
    cssVersion: artifacts.cssVersion || '1.0',
    domain: artifacts.domain || claimsDoc.domain || 'BUILDING',
    facility: artifacts.facility || facilityFromMeta(claimsDoc.facilityMeta),
    levelsOrSegments: artifacts.levelsOrSegments || extractLevelsFromClaims(claimsDoc.claims),
    elements,
    metadata,
  };
}

/**
 * Generic CSS reconstruction for unknown parser types.
 */
function claimsToGenericCss(claimsDoc, artifacts) {
  const elements = extractElementsFromClaims(claimsDoc.claims);
  const { facilityDimensions, materialAssignments, portals } = extractFacilityMetadataFromClaims(claimsDoc.claims);

  const metadata = { ...(artifacts.metadata || {}) };
  if (facilityDimensions.length > 0) {
    metadata.facilityDimensions = [...(metadata.facilityDimensions || []), ...facilityDimensions];
  }
  if (materialAssignments.length > 0) {
    metadata.materialAssignments = [...(metadata.materialAssignments || []), ...materialAssignments];
  }
  if (portals.length > 0) {
    metadata.portals = [...(metadata.portals || []), ...portals];
  }

  return {
    cssVersion: artifacts.cssVersion || '1.0',
    domain: artifacts.domain || claimsDoc.domain || 'UNKNOWN',
    facility: artifacts.facility || facilityFromMeta(claimsDoc.facilityMeta),
    levelsOrSegments: artifacts.levelsOrSegments || extractLevelsFromClaims(claimsDoc.claims),
    elements,
    metadata,
  };
}

/**
 * Extract CSS elements from claims by flattening claim.attributes back into element objects.
 * Only processes element-type claims (not level_definition, facility_dimension, etc.).
 */
function extractElementsFromClaims(claims) {
  const elementKinds = new Set([
    CLAIM_KINDS.SEGMENT_GEOMETRY,
    CLAIM_KINDS.WALL_CANDIDATE,
    CLAIM_KINDS.SLAB_CANDIDATE,
    CLAIM_KINDS.EQUIPMENT_INSTANCE,
    CLAIM_KINDS.OPENING_CANDIDATE,
    CLAIM_KINDS.SPACE_DEFINITION,
    CLAIM_KINDS.COLUMN_CANDIDATE,
    CLAIM_KINDS.PORTAL_DEFINITION,
    CLAIM_KINDS.JUNCTION_DEFINITION,
    CLAIM_KINDS.VISION_FINDING,
  ]);

  return claims
    .filter(c => elementKinds.has(c.kind))
    .map(c => {
      // Flatten attributes back into a CSS element
      const el = { ...c.attributes };
      // Ensure confidence is preserved (claim confidence overrides if attributes didn't have it)
      if (el.confidence === undefined) {
        el.confidence = c.confidence;
      }
      return el;
    });
}

/**
 * Extract level/segment definitions from claims.
 */
function extractLevelsFromClaims(claims) {
  return claims
    .filter(c => c.kind === CLAIM_KINDS.LEVEL_DEFINITION)
    .map(c => ({ ...c.attributes }));
}

/**
 * Build facility object from facilityMeta.
 */
function facilityFromMeta(meta) {
  if (!meta) return { name: null, type: null, description: null, units: 'M', origin: { x: 0, y: 0, z: 0 }, axes: 'RIGHT_HANDED_Z_UP' };
  return {
    name: meta.name,
    type: meta.type,
    description: meta.description,
    units: meta.units || 'M',
    crs: null,
    origin: meta.origin || { x: 0, y: 0, z: 0 },
    axes: meta.axes || 'RIGHT_HANDED_Z_UP',
  };
}

/**
 * Merge spec-text-derived claims (rooms, shaft, doors, fittings, tunnel-bore override,
 * material/system metadata) into an existing per-parser CSS so that downstream
 * topology engine + generate lambda see them.
 *
 * Per-parser CSS (VentSim / DXF / Bedrock) is parser-scoped — it does not contain
 * narrative-text claims. The topology engine reads css_raw.json by S3 key and never
 * touches claims.json, so without this bridge the spec-text data is invisible to it.
 *
 * Mutates css in place. Idempotent on element ids: skips elements with ids that
 * already exist in css.elements.
 */
export function mergeSpecClaimsIntoCss(css, specClaims) {
  if (!specClaims || specClaims.length === 0) return css;
  if (!css.elements) css.elements = [];
  if (!css.metadata) css.metadata = {};
  if (!Array.isArray(css.levelsOrSegments)) css.levelsOrSegments = [];

  const existingIds = new Set(css.elements.map(e => e.id || e.element_key).filter(Boolean));
  const existingLevelIds = new Set(css.levelsOrSegments.map(l => l.id).filter(Boolean));

  let added = { spaces: 0, doors: 0, fittings: 0, equipment: 0, levels: 0, dims: 0, materials: 0, systems: 0 };

  for (const claim of specClaims) {
    const a = claim.attributes || {};
    const kind = claim.kind;

    if (kind === CLAIM_KINDS.LEVEL_DEFINITION) {
      if (a.id && !existingLevelIds.has(a.id)) {
        css.levelsOrSegments.push({ ...a });
        existingLevelIds.add(a.id);
        added.levels++;
      }
    } else if (kind === CLAIM_KINDS.SPACE_DEFINITION) {
      if (a.id && !existingIds.has(a.id)) {
        css.elements.push(buildSpaceElement(claim));
        existingIds.add(a.id);
        added.spaces++;
      }
    } else if (kind === CLAIM_KINDS.OPENING_CANDIDATE) {
      if (a.id && !existingIds.has(a.id)) {
        css.elements.push(buildDoorElement(claim));
        existingIds.add(a.id);
        added.doors++;
      }
    } else if (kind === CLAIM_KINDS.FITTING_CANDIDATE) {
      if (a.id && !existingIds.has(a.id)) {
        css.elements.push(buildFittingElement(claim));
        existingIds.add(a.id);
        added.fittings++;
      }
    } else if (kind === CLAIM_KINDS.EQUIPMENT_INSTANCE) {
      if (a.id && !existingIds.has(a.id)) {
        css.elements.push(buildEquipmentElement(claim));
        existingIds.add(a.id);
        added.equipment++;
      }
    } else if (kind === CLAIM_KINDS.FACILITY_DIMENSION) {
      if (!css.metadata.facilityDimensions) css.metadata.facilityDimensions = [];
      css.metadata.facilityDimensions.push(facilityDimensionEntry(a));
      added.dims++;
    } else if (kind === CLAIM_KINDS.MATERIAL_ASSIGNMENT) {
      if (!css.metadata.materialAssignments) css.metadata.materialAssignments = [];
      css.metadata.materialAssignments.push({ ...a });
      added.materials++;
    } else if (kind === CLAIM_KINDS.SYSTEM_MEMBERSHIP) {
      if (!css.metadata.systems) css.metadata.systems = [];
      css.metadata.systems.push({ ...a });
      added.systems++;
    }
  }

  console.log(`mergeSpecClaimsIntoCss: +${added.spaces} spaces, +${added.doors} doors, +${added.fittings} fittings, +${added.equipment} equipment, +${added.levels} levels, +${added.dims} facilityDimensions, +${added.materials} materials, +${added.systems} systems`);

  return css;
}

/**
 * Translate a FACILITY_DIMENSION claim's `category` into the `subKind` that
 * dimension-apply.buildDimensionLookup() expects, while keeping the original
 * payload for downstream consumers.
 */
function facilityDimensionEntry(attrs) {
  const out = { ...attrs, _source: 'spec_text_claim' };
  const category = (attrs.category || '').toUpperCase();

  if (category === 'TUNNEL_BORE') {
    out.subKind = 'TUNNEL_PROFILE';
    if (attrs.bore_height_m != null && out.height_m == null) out.height_m = attrs.bore_height_m;
    if (attrs.bore_width_m  != null && out.width_m  == null) out.width_m  = attrs.bore_width_m;
    if (attrs.lining_min_m  != null && out.wallThickness_m == null) out.wallThickness_m = attrs.lining_min_m;
    if (attrs.bore_shape && out.shape == null) out.shape = attrs.bore_shape;
  } else if (category === 'VERTICAL_SHAFT') {
    out.subKind = 'SHAFT';
    if (attrs.depth_m       != null && out.vertical_length_m    == null) out.vertical_length_m    = attrs.depth_m;
    if (attrs.collar_msl_m  != null && out.collar_elevation_msl == null) out.collar_elevation_msl = attrs.collar_msl_m;
  } else if (category === 'DUCT_SPEC') {
    out.subKind = 'DUCT_SPEC';
  }

  return out;
}

function buildSpaceElement(claim) {
  const a = claim.attributes || {};
  const g = a.geometry || {};
  const isCircular = String(g.shape || '').toUpperCase() === 'CIRCULAR';

  let geometry;
  if (isCircular) {
    const depth = g.length_m ?? g.height_m ?? g.depth_m ?? 30;
    const radius = (g.diameter_m != null && g.diameter_m > 0) ? g.diameter_m / 2 : 3.0;
    geometry = {
      method: 'EXTRUSION',
      direction: { x: 0, y: 0, z: 1 },
      depth,
      profile: { type: 'CIRCLE', radius },
    };
  } else {
    geometry = {
      method: 'EXTRUSION',
      direction: { x: 0, y: 0, z: 1 },
      depth: g.height_m ?? 4,
      profile: { type: 'RECTANGLE', width: g.length_m ?? 1, height: g.depth_m ?? 1 },
    };
  }

  return {
    id: a.id,
    element_key: a.id,
    type: 'SPACE',
    semanticType: a.semanticType || 'IfcSpace',
    name: a.name,
    confidence: typeof claim.confidence === 'number' ? claim.confidence : 0.85,
    source: 'SPEC_TEXT',
    container: a.container || 'level-0',
    placement: {
      origin: a.placement?.origin || { x: 0, y: 0, z: 0 },
      axis: a.placement?.axis || { x: 0, y: 0, z: 1 },
      refDirection: a.placement?.refDirection || { x: 1, y: 0, z: 0 },
    },
    geometry,
    material: { name: 'space', color: [0.88, 0.88, 0.88], transparency: 0.7 },
    sourceFile: claim.provenance?.sourceFile || null,
    properties: a.properties || {},
    relationships: a.relationships || [],
    metadata: a.metadata || {},
  };
}

function buildDoorElement(claim) {
  const a = claim.attributes || {};
  const g = a.geometry || {};
  return {
    id: a.id,
    element_key: a.id,
    type: 'DOOR',
    semanticType: a.semanticType || 'IfcDoor',
    name: a.name,
    confidence: typeof claim.confidence === 'number' ? claim.confidence : 0.85,
    source: 'SPEC_TEXT',
    container: a.container || 'level-0',
    placement: {
      origin: a.placement?.origin || { x: 0, y: 0, z: 0 },
      axis: a.placement?.axis || { x: 0, y: 0, z: 1 },
      refDirection: a.placement?.refDirection || { x: 1, y: 0, z: 0 },
    },
    geometry: {
      method: 'EXTRUSION',
      direction: { x: 0, y: 0, z: 1 },
      depth: g.height_m ?? 2.11,
      profile: { type: 'RECTANGLE', width: g.width_m ?? 0.81, height: 0.08 },
    },
    sourceFile: claim.provenance?.sourceFile || null,
    properties: a.properties || {},
    relationships: a.relationships || [],
  };
}

function buildFittingElement(claim) {
  const a = claim.attributes || {};
  const g = a.geometry || {};
  const dia = g.diameter_m ?? 0.5;
  return {
    id: a.id,
    element_key: a.id,
    type: 'DUCT_FITTING',
    semanticType: a.semanticType || 'IfcDuctFitting',
    name: a.name,
    confidence: typeof claim.confidence === 'number' ? claim.confidence : 0.85,
    source: 'SPEC_TEXT',
    container: a.container || 'level-0',
    placement: {
      origin: a.placement?.origin || { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 0, z: 1 },
      refDirection: { x: 1, y: 0, z: 0 },
    },
    geometry: {
      method: 'EXTRUSION',
      direction: { x: 1, y: 0, z: 0 },
      depth: dia,
      profile: { type: 'CIRCLE', radius: dia / 2 },
    },
    sourceFile: claim.provenance?.sourceFile || null,
    properties: a.properties || {},
  };
}

function buildEquipmentElement(claim) {
  const a = claim.attributes || {};
  const origin = a.placement?.origin || { x: 0, y: 0, z: 0 };
  return {
    id: a.id,
    element_key: a.id,
    type: 'EQUIPMENT',
    semanticType: a.semanticType || 'IfcBuildingElementProxy',
    name: a.name,
    confidence: typeof claim.confidence === 'number' ? claim.confidence : 0.75,
    source: 'SPEC_TEXT',
    container: a.container || 'level-0',
    placement: {
      origin,
      axis: { x: 0, y: 0, z: 1 },
      refDirection: { x: 1, y: 0, z: 0 },
    },
    geometry: {
      method: 'EXTRUSION',
      direction: { x: 0, y: 0, z: 1 },
      depth: 1.5,
      profile: { type: 'RECTANGLE', width: 1.0, height: 1.0 },
    },
    sourceFile: claim.provenance?.sourceFile || null,
    properties: a.properties || {},
    relationships: a.relationships || [],
  };
}
