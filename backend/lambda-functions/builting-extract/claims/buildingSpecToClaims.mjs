/**
 * Bedrock Building/Tunnel Spec → Claims converter.
 * Converts the CSS output from Bedrock extraction (building or tunnel domain)
 * into a claims array. Each CSS element becomes one claim with full attributes
 * preserved for lossless CSS reconstruction.
 */

import {
  buildClaim, buildEvidence, buildProvenance, typeToKind, inferDiscipline,
  CLAIM_KINDS, EXTRACTION_METHODS, COORDINATE_SOURCES, SOURCE_ROLES, PROVENANCE_STATUS
} from './claimsSchema.mjs';

/**
 * Convert a Bedrock-extracted CSS object into claims + parserArtifacts.
 * @param {object} css - Full CSS object from Bedrock extraction
 * @param {Array} sourceFiles - Array of { name, role, sourceRole } source file info
 * @returns {{ claims: Array, domain: string, facilityMeta: object, parserArtifacts: object }}
 */
export function buildingSpecToClaims(css, sourceFiles = [], options = {}) {
  const claims = [];
  const domain = css.domain || 'BUILDING';
  const isTunnel = domain === 'TUNNEL';
  const extractionMethod = options.isRefinement
    ? EXTRACTION_METHODS.LLM_REFINEMENT
    : EXTRACTION_METHODS.LLM_EXTRACTION;

  function provFor(sf) {
    const f = sf || null;
    return buildProvenance(f, f ? PROVENANCE_STATUS.DIRECT : PROVENANCE_STATUS.MISSING, 'extract');
  }

  // Build evidence from source files
  function buildEvidenceForElement(el) {
    const evidenceList = [];

    // Primary evidence from the extraction method
    const sourceFile = el.sourceFile || el.source || (sourceFiles[0]?.name) || 'description.txt';
    const sourceRole = el.sourceRole || detectSourceRole(sourceFile);
    const coordSource = el.placement?.origin
      ? COORDINATE_SOURCES.LLM_GENERATED
      : COORDINATE_SOURCES.NONE;

    evidenceList.push(buildEvidence(
      sourceFile,
      sourceRole,
      extractionMethod,
      coordSource,
      {
        excerpt: el.evidence_quote || el.metadata?.evidence?.sourceExcerpt || null,
        page: el.source_page ?? null,
      }
    ));

    return evidenceList;
  }

  // Convert levelsOrSegments to level_definition claims
  for (const seg of (css.levelsOrSegments || [])) {
    const segEvidence = buildEvidence(
      sourceFiles[0]?.name || 'description.txt',
      SOURCE_ROLES.NARRATIVE,
      EXTRACTION_METHODS.LLM_EXTRACTION,
      seg.elevation_m !== undefined ? COORDINATE_SOURCES.LLM_GENERATED : COORDINATE_SOURCES.NONE
    );

    claims.push(buildClaim(
      CLAIM_KINDS.LEVEL_DEFINITION,
      seg.id,
      {
        id: seg.id,
        type: seg.type || (isTunnel ? 'SEGMENT' : 'STOREY'),
        name: seg.name,
        elevation_m: seg.elevation_m,
        height_m: seg.height_m,
        startChainage_m: seg.startChainage_m,
        endChainage_m: seg.endChainage_m,
      },
      {
        evidence: [segEvidence],
        confidence: 0.70,
        fieldConfidence: { dimensions: 0.65, placement: 0.60 },
        discipline: isTunnel ? 'civil' : 'architectural',
        provenance: provFor(sourceFiles[0]?.name || null),
      }
    ));
  }

  // Convert each element to a claim
  for (const el of (css.elements || [])) {
    const kind = typeToKind(el.type);
    const subjectId = el.element_key || el.id;

    // LLM-generated coordinates have lower confidence
    const hasPlacement = el.placement?.origin && (
      el.placement.origin.x !== 0 || el.placement.origin.y !== 0 || el.placement.origin.z !== 0
    );

    const fieldConfidence = {
      dimensions: hasPlacement ? 0.60 : 0.40,
      placement: hasPlacement ? 0.55 : 0.30,
      material: 0.50,
    };

    // Elements explicitly extracted from structured data have higher confidence
    if (el.explicitOrInferred === 'explicit') {
      fieldConfidence.dimensions = Math.min(fieldConfidence.dimensions + 0.15, 0.95);
      fieldConfidence.placement = Math.min(fieldConfidence.placement + 0.10, 0.90);
    }

    // GAP 15: Map spatial containment fields to properties for topology engine
    const spatialContainmentProps = {};
    if (el.duct_host_segment) {
      spatialContainmentProps.hostSegmentId = el.duct_host_segment;
    }
    if (el.equipment_mounting_zone) {
      spatialContainmentProps.mountingZone = el.equipment_mounting_zone;
    }
    if (el.equipment_z_offset_m != null) {
      spatialContainmentProps.zOffset_m = el.equipment_z_offset_m;
    }
    if (el.equipment_longitudinal_position_m != null) {
      spatialContainmentProps.longitudinalPosition_m = el.equipment_longitudinal_position_m;
    }

    const attributes = {
      id: el.id,
      element_key: el.element_key,
      type: el.type,
      semanticType: el.semanticType,
      name: el.name,
      placement: el.placement,
      geometry: el.geometry,
      container: el.container,
      relationships: el.relationships || [],
      properties: {
        ...(el.properties || {}),
        ...spatialContainmentProps,
      },
      material: el.material,
      source: el.source,
      sourceFile: el.sourceFile,
      sourceRole: el.sourceRole,
      explicitOrInferred: el.explicitOrInferred,
      metadata: el.metadata,
      confidence: el.confidence,
    };

    const aliases = [];
    if (el.name && el.name !== el.element_key) {
      aliases.push(el.name);
    }
    if (el.properties?.assetTag) {
      aliases.push(el.properties.assetTag);
    }

    const elSourceFile = el.sourceFile || el.source || sourceFiles[0]?.name || null;
    claims.push(buildClaim(
      kind,
      subjectId,
      attributes,
      {
        evidence: buildEvidenceForElement(el),
        confidence: el.confidence ?? 0.60,
        fieldConfidence,
        discipline: inferDiscipline(el.type, el.properties),
        aliases,
        provenance: provFor(elSourceFile),
      }
    ));
  }

  // Extract facility metadata
  const facilityMeta = css.facility ? {
    name: css.facility.name,
    type: css.facility.type,
    description: css.facility.description,
    units: css.facility.units || 'M',
    origin: css.facility.origin || { x: 0, y: 0, z: 0 },
    axes: css.facility.axes || 'RIGHT_HANDED_Z_UP',
  } : null;

  // Parser artifacts for lossless CSS reconstruction
  const parserType = isTunnel ? 'BEDROCK_TUNNEL' : 'BEDROCK_BUILDING';
  const parserArtifacts = {
    parserType,
    cssVersion: css.cssVersion,
    domain,
    facility: css.facility,
    levelsOrSegments: css.levelsOrSegments,
    metadata: css.metadata,
  };

  return {
    claims,
    domain,
    facilityMeta,
    parserArtifacts,
  };
}

/**
 * Detect source role from file name/extension.
 */
function detectSourceRole(fileName) {
  if (!fileName) return SOURCE_ROLES.NARRATIVE;
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.dxf') || lower.endsWith('.dwg')) return SOURCE_ROLES.DRAWING;
  if (lower.endsWith('.vsm') || lower.endsWith('.txt') && lower.includes('ventsim')) return SOURCE_ROLES.SIMULATION;
  if (lower.endsWith('.xlsx') || lower.endsWith('.csv')) return SOURCE_ROLES.SCHEDULE;
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return SOURCE_ROLES.VISION;
  return SOURCE_ROLES.NARRATIVE;
}
