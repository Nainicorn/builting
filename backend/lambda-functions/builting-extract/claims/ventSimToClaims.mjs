/**
 * VentSim → Claims converter.
 * Converts the output of parseVentSimToCSS() into a claims array.
 * Each CSS element becomes one claim with full attributes preserved for lossless CSS reconstruction.
 */

import {
  buildClaim, buildEvidence, buildProvenance, typeToKind, inferDiscipline,
  CLAIM_KINDS, EXTRACTION_METHODS, COORDINATE_SOURCES, SOURCE_ROLES, PROVENANCE_STATUS
} from './claimsSchema.mjs';

/**
 * Convert a VentSim CSS object into claims + parserArtifacts.
 * @param {object} css - Full CSS object from parseVentSimToCSS()
 * @param {string} sourceFileName - VentSim source file name
 * @returns {{ claims: Array, domain: string, facilityMeta: object, parserArtifacts: object }}
 */
export function ventSimCssToClaims(css, sourceFileName) {
  const claims = [];

  const evidence = buildEvidence(
    sourceFileName,
    SOURCE_ROLES.SIMULATION,
    EXTRACTION_METHODS.VSM_PARSER,
    COORDINATE_SOURCES.DIRECT_3D
  );

  function provFor(sf) {
    const f = sf || null;
    return buildProvenance(f, f ? PROVENANCE_STATUS.DIRECT : PROVENANCE_STATUS.MISSING, 'extract');
  }

  // GAP 9: Build node-ID → segment element_key index for DUCT-in-TUNNEL containment resolution
  const nodeToSegment = {};
  for (const el of (css.elements || [])) {
    if (el.type === 'TUNNEL_SEGMENT') {
      const en = el.properties?.entry_node;
      const ex = el.properties?.exit_node;
      const key = el.element_key || el.id;
      if (en) nodeToSegment[en] = key;
      if (ex) nodeToSegment[ex] = key;
    }
  }

  // Convert levelsOrSegments to level_definition claims
  for (const seg of (css.levelsOrSegments || [])) {
    claims.push(buildClaim(
      CLAIM_KINDS.LEVEL_DEFINITION,
      seg.id,
      {
        id: seg.id,
        type: seg.type,
        name: seg.name,
        elevation_m: seg.elevation_m,
        height_m: seg.height_m,
        startChainage_m: seg.startChainage_m,
        endChainage_m: seg.endChainage_m,
      },
      {
        evidence: [evidence],
        confidence: 0.95,
        fieldConfidence: { dimensions: 0.95, placement: 0.95 },
        discipline: 'civil',
        provenance: provFor(sourceFileName),
      }
    ));
  }

  // Convert each element to a claim
  for (const el of (css.elements || [])) {
    const kind = typeToKind(el.type);
    const subjectId = el.element_key || el.id;

    // Build element-specific evidence, preserving any existing evidence data
    const elEvidence = { ...evidence };
    if (el.metadata?.evidence?.sourceExcerpt) {
      elEvidence.excerpt = el.metadata.evidence.sourceExcerpt;
    }

    // Determine field confidence based on element source
    const fieldConfidence = {
      dimensions: 0.95,
      placement: 0.95,
      material: 0.60,
    };

    // Equipment from VentSim has slightly different confidence profile
    if (el.type === 'EQUIPMENT') {
      fieldConfidence.dimensions = el.source === 'VSM' ? 0.85 : 0.60;
      fieldConfidence.placement = el.source === 'VSM' ? 0.90 : 0.50;
    }

    // Build attributes — the full element data for lossless CSS reconstruction
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
      properties: el.properties || {},
      material: el.material,
      source: el.source,
      sourceFile: el.sourceFile,
      sourceRole: el.sourceRole,
      explicitOrInferred: el.explicitOrInferred,
      metadata: el.metadata,
    };

    // GAP 9: Resolve DUCT/PIPE/EQUIPMENT to host TUNNEL_SEGMENT via node map
    const isMep = ['DUCT', 'PIPE', 'EQUIPMENT', 'DUCT_FITTING', 'FITTING_CANDIDATE'].includes(el.type);
    if (isMep) {
      const en = el.properties?.entry_node;
      const ex = el.properties?.exit_node;
      const hostKey = (en && nodeToSegment[en]) || (ex && nodeToSegment[ex]) || null;
      if (hostKey) {
        attributes.metadata = { ...attributes.metadata, hostSegmentId: hostKey };
      }
      if (el.metadata?.mountingZone) {
        attributes.metadata = { ...attributes.metadata, mountingZone: el.metadata.mountingZone };
      }
    }

    // Collect aliases (VentSim branches can have named aliases)
    const aliases = [];
    if (el.properties?.unique_no !== undefined) {
      aliases.push(`ventsim_branch_${el.properties.unique_no}`);
    }
    if (el.name && el.name !== el.element_key) {
      aliases.push(el.name);
    }

    claims.push(buildClaim(
      kind,
      subjectId,
      attributes,
      {
        evidence: [elEvidence],
        confidence: el.confidence ?? 0.85,
        fieldConfidence,
        discipline: inferDiscipline(el.type, el.properties),
        aliases,
        provenance: provFor(el.sourceFile || sourceFileName),
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
  const parserArtifacts = {
    parserType: 'VENTSIM',
    cssVersion: css.cssVersion,
    domain: css.domain,
    facility: css.facility,
    levelsOrSegments: css.levelsOrSegments,
    metadata: css.metadata,
  };

  return {
    claims,
    domain: css.domain || 'TUNNEL',
    facilityMeta,
    parserArtifacts,
  };
}
