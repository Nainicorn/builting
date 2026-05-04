/**
 * Vision → Claims converter.
 * Converts vision-extracted CSS elements (from image/scanned PDF analysis)
 * into claims. Phase 9a: Enhanced with drawing metadata evidence, sheet role
 * classification, and coordinate derivation tracking.
 */

import {
  buildClaim, buildEvidence, buildProvenance, typeToKind, inferDiscipline,
  CLAIM_KINDS, EXTRACTION_METHODS, COORDINATE_SOURCES, SOURCE_ROLES,
  COORDINATE_DERIVATION, PROVENANCE_STATUS
} from './claimsSchema.mjs';

/**
 * Convert vision-extracted elements into claims.
 * @param {Array} visionFiles - Array of processed files that have visionCSS
 * @returns {Array} Array of claims from vision sources
 */
export function visionToClaims(visionFiles) {
  const claims = [];

  for (const vf of visionFiles) {
    if (!vf.visionCSS) continue;

    const sourceFileName = vf.name;
    const titleBlock = vf.visionCSS.titleBlock || null;
    const sheetRole = vf.visionCSS.sheetRole || null;
    const scaleInfo = vf.visionCSS.scaleInfo || null;

    // Phase 9a: Build drawing metadata for evidence
    const drawingMetadata = titleBlock ? {
      projectName: titleBlock.projectName,
      drawingNumber: titleBlock.drawingNumber,
      sheetNumber: titleBlock.sheetNumber,
      revision: titleBlock.revision,
      date: titleBlock.date,
      scale: titleBlock.scale,
      author: titleBlock.author,
      firm: titleBlock.firm,
      titleBlockConfidence: titleBlock.confidence,
    } : null;

    // Convert vision elements to claims
    for (const el of (vf.visionCSS.elements || [])) {
      const kind = typeToKind(el.type);
      const subjectId = el.element_key || el.id;

      // Phase 9b: Determine coordinate source from assembly derivation
      const derivation = el.metadata?.coordinateDerivation || COORDINATE_DERIVATION.ESTIMATED;
      let coordSource = COORDINATE_SOURCES.ESTIMATED;
      let placementConfidence = 0.30;
      if (derivation === COORDINATE_DERIVATION.DIRECT) {
        coordSource = COORDINATE_SOURCES.DIRECT_2D;
        placementConfidence = 0.55;
      } else if (derivation === COORDINATE_DERIVATION.ASSEMBLED) {
        coordSource = COORDINATE_SOURCES.ASSEMBLED_2D;
        placementConfidence = 0.45;
      }

      const elEvidence = buildEvidence(
        sourceFileName,
        SOURCE_ROLES.VISION,
        EXTRACTION_METHODS.VISION_MODEL,
        coordSource,
        {
          region: vf.visionCSS.region || null,
          sheetRole,
          coordinateDerivation: derivation,
          scaleConfidence: scaleInfo?.detected ? (titleBlock?.fieldConfidence?.scale ?? 0.5) : 0,
          drawingMetadata,
        }
      );

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
        source: 'vision',
        sourceFile: sourceFileName,
        metadata: el.metadata,
      };

      // Phase 9d: Component-based confidence model
      // Document confidence from title block — does NOT inflate geometry confidence
      let documentConf = 0.35;
      if (titleBlock && titleBlock.confidence >= 0.5) {
        documentConf = 0.60;
        if (titleBlock.drawingNumber) documentConf += 0.05;
      }
      // Geometry confidence from scale + dimensions
      let geometryConf = 0.35;
      if (scaleInfo?.detected) geometryConf += 0.10;
      if (el.metadata?.endPoint) geometryConf += 0.10;
      // Weighted element confidence (geometry-heavy, document doesn't inflate geometry)
      const componentConf = geometryConf * 0.5 + placementConfidence * 0.3 + documentConf * 0.2;
      const finalConf = Math.min(Math.max(el.confidence ?? componentConf, 0.15), 0.90);

      claims.push(buildClaim(
        kind,
        subjectId,
        attributes,
        {
          evidence: [elEvidence],
          confidence: finalConf,
          fieldConfidence: {
            dimensions: Math.min(geometryConf, 0.90),
            placement: Math.min(placementConfidence, 0.90),
            material: Math.min(documentConf * 0.6, 0.60),
          },
          discipline: inferDiscipline(el.type, el.properties),
          provenance: buildProvenance(sourceFileName, PROVENANCE_STATUS.DIRECT, 'extract'),
        }
      ));
    }

    // Convert vision findings (low-confidence observations that didn't make geometry)
    const findingEvidence = buildEvidence(
      sourceFileName,
      SOURCE_ROLES.VISION,
      EXTRACTION_METHODS.VISION_MODEL,
      COORDINATE_SOURCES.ESTIMATED,
      { sheetRole, coordinateDerivation: COORDINATE_DERIVATION.ESTIMATED, drawingMetadata }
    );

    for (const finding of (vf.visionCSS.findings || [])) {
      // Skip assembly stats — they are metadata, not claims
      if (finding.type === 'ASSEMBLY_STATS') continue;

      claims.push(buildClaim(
        CLAIM_KINDS.VISION_FINDING,
        `vision-finding-${finding.id || finding.label || Math.random().toString(36).slice(2, 8)}`,
        {
          label: finding.label,
          description: finding.description,
          boundingBox: finding.boundingBox,
          suggestedType: finding.suggestedType,
          properties: finding.properties || {},
        },
        {
          evidence: [findingEvidence],
          confidence: finding.confidence ?? 0.30,
          fieldConfidence: {},
          discipline: 'unknown',
          provenance: buildProvenance(sourceFileName, PROVENANCE_STATUS.DIRECT, 'extract'),
        }
      ));
    }
  }

  return claims;
}
