/**
 * DOCX Structured Params → Claims converter.
 *
 * Takes the output of extractStructuredParams() (filled-in domain schema) and emits
 * claims that carry facility-level metadata through the pipeline.
 *
 * These claims use FACILITY_DIMENSION and MATERIAL_ASSIGNMENT kinds — they are NOT
 * renderable geometry and must NOT appear in css.elements. extractFacilityMetadataFromClaims()
 * in claimsToLegacyCss.mjs routes them into css.metadata instead.
 */

import {
  buildClaim, buildEvidence, buildProvenance,
  CLAIM_KINDS, EXTRACTION_METHODS, COORDINATE_SOURCES, SOURCE_ROLES, PROVENANCE_STATUS,
} from './claimsSchema.mjs';

/**
 * Convert structured tunnel params into FACILITY_DIMENSION and MATERIAL_ASSIGNMENT claims.
 *
 * @param {object} structuredParams  - Output of extractStructuredParams() for a tunnel schema
 * @param {string} sourceFileName    - DOCX file name, for evidence
 * @returns {Array} Array of claim objects
 */
export function docxToClaims(structuredParams, sourceFileName) {
  if (!structuredParams) return [];

  const claims = [];

  const evidence = buildEvidence(
    sourceFileName,
    SOURCE_ROLES.NARRATIVE,
    EXTRACTION_METHODS.LLM_EXTRACTION,
    COORDINATE_SOURCES.NONE
  );

  const sf = sourceFileName || null;
  const prov = buildProvenance(sf, sf ? PROVENANCE_STATUS.DIRECT : PROVENANCE_STATUS.MISSING, 'extract');

  // ── Tunnel profile / height ────────────────────────────────────────────────
  const profile = structuredParams.tunnelProfile;
  if (profile && (profile.height_m != null || profile.width_m != null)) {
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'tunnel-profile',
      {
        subKind: 'TUNNEL_PROFILE',
        shape: profile.shape || null,
        height_m: profile.height_m ?? null,
        width_m: profile.width_m ?? null,
      },
      {
        evidence: [evidence],
        confidence: 0.80,
        fieldConfidence: { dimensions: 0.80 },
        discipline: 'civil',
        provenance: prov,
      }
    ));
  }

  // ── Portals ────────────────────────────────────────────────────────────────
  for (const portal of (structuredParams.portals || [])) {
    if (!portal.name && portal.elevation_msl == null) continue;
    claims.push(buildClaim(
      CLAIM_KINDS.PORTAL_DEFINITION,
      `portal-${(portal.name || 'unknown').toLowerCase().replace(/\s+/g, '-')}`,
      {
        subKind: 'PORTAL',
        name: portal.name || null,
        elevation_msl: portal.elevation_msl ?? null,
        orientation: portal.orientation || null,
      },
      {
        evidence: [evidence],
        confidence: 0.75,
        fieldConfidence: { placement: 0.75, dimensions: 0.75 },
        discipline: 'civil',
        provenance: prov,
      }
    ));
  }

  // ── Shaft ──────────────────────────────────────────────────────────────────
  const shaft = structuredParams.shaft;
  if (shaft && shaft.vertical_length_m != null) {
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'shaft-params',
      {
        subKind: 'SHAFT',
        vertical_length_m: shaft.vertical_length_m,
        collar_elevation_msl: shaft.collar_elevation_msl ?? null,
        location_description: shaft.location_description || null,
      },
      {
        evidence: [evidence],
        confidence: 0.75,
        fieldConfidence: { dimensions: 0.75, placement: 0.50 },
        discipline: 'civil',
        provenance: prov,
      }
    ));
  }

  // ── Duct spec ─────────────────────────────────────────────────────────────
  const ducts = structuredParams.ducts;
  if (ducts && ducts.diameter_m != null) {
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'duct-spec',
      {
        subKind: 'DUCT_SPEC',
        diameter_m: ducts.diameter_m,
        shape: ducts.shape || 'circular',
      },
      {
        evidence: [evidence],
        confidence: 0.75,
        fieldConfidence: { dimensions: 0.75 },
        discipline: 'mechanical',
        provenance: prov,
      }
    ));
  }

  // ── Room heights ───────────────────────────────────────────────────────────
  for (const room of (structuredParams.rooms || [])) {
    if (room.height_m == null && room.door_height_m == null) continue;
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      `room-${(room.name || 'unknown').toLowerCase().replace(/\s+/g, '-')}`,
      {
        subKind: 'ROOM_HEIGHT',
        name: room.name || null,
        width_m: room.width_m ?? null,
        length_m: room.length_m ?? null,
        height_m: room.height_m ?? null,
        door_height_m: room.door_height_m ?? null,
      },
      {
        evidence: [evidence],
        confidence: 0.70,
        fieldConfidence: { dimensions: 0.70 },
        discipline: 'architectural',
        provenance: prov,
      }
    ));
  }

  // ── Material zones ─────────────────────────────────────────────────────────
  for (const zone of (structuredParams.materialZones || [])) {
    if (!zone.material) continue;
    claims.push(buildClaim(
      CLAIM_KINDS.MATERIAL_ASSIGNMENT,
      `material-${(zone.material || 'unknown').toLowerCase().replace(/\s+/g, '-')}`,
      {
        material: zone.material,
        zone_description: zone.zone_description || null,
        start_description: zone.start_description || null,
        end_description: zone.end_description || null,
      },
      {
        evidence: [evidence],
        confidence: 0.70,
        fieldConfidence: { material: 0.70 },
        discipline: 'civil',
        provenance: prov,
      }
    ));
  }

  return claims;
}
