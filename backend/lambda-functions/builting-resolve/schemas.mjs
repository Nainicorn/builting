/**
 * schemas.mjs — Constants, mappings, and validators for the Resolve Lambda.
 * Maps claim kinds to observation types and candidate classes.
 */

import { randomUUID } from 'crypto';

// Phase 13 provenance status — mirrors extract/claims/claimsSchema.mjs:PROVENANCE_STATUS.
// Duplicated here to avoid a cross-lambda import. Keep in sync.
export const PROVENANCE_STATUS = {
  DIRECT: 'direct',
  INHERITED_CONSENSUS: 'inherited_consensus',
  INHERITED_CONTESTED: 'inherited_contested',
  DERIVED_GEOMETRIC: 'derived_geometric',
  DERIVED_INFERRED: 'derived_inferred',
  MISSING: 'missing',
  LEGACY: 'legacy',
};

// Observation types for canonical_observed.json
export const OBSERVATION_TYPES = {
  LINEAR_FEATURE: 'linear_feature',
  POLYGON_FEATURE: 'polygon_feature',
  POINT_FEATURE: 'point_feature',
  TEXT_FACT: 'text_fact',
  ASSET_RECORD: 'asset_record',
  LEVEL_MARKER: 'level_marker',
  SPACE_LABEL: 'space_label',
  MATERIAL_FACT: 'material_fact',
  RELATIONSHIP_FACT: 'relationship_fact',
};

// Candidate classes
export const CANDIDATE_CLASSES = {
  WALL: 'wall',
  SLAB: 'slab',
  SEGMENT: 'segment',
  EQUIPMENT: 'equipment',
  OPENING: 'opening',
  LEVEL: 'level',
  SPACE: 'space',
  COLUMN: 'column',
  UNKNOWN: 'unknown',
};

// Candidate class sources
export const CANDIDATE_CLASS_SOURCES = {
  DIRECT_LABEL: 'direct_label',
  PARSER_HEURISTIC: 'parser_heuristic',
  LLM_GUESS: 'llm_guess',
  GEOMETRY_PATTERN: 'geometry_pattern',
};

// Observation statuses
export const OBSERVATION_STATUSES = {
  ACCEPTED: 'accepted',
  AMBIGUOUS: 'ambiguous',
  SUPERSEDED: 'superseded',
};

// Claim kind → observation type mapping
export const KIND_TO_OBSERVATION_TYPE = {
  segment_geometry: OBSERVATION_TYPES.LINEAR_FEATURE,
  wall_candidate: OBSERVATION_TYPES.LINEAR_FEATURE,
  slab_candidate: OBSERVATION_TYPES.POLYGON_FEATURE,
  equipment_instance: OBSERVATION_TYPES.ASSET_RECORD,
  opening_candidate: OBSERVATION_TYPES.POINT_FEATURE,
  level_definition: OBSERVATION_TYPES.LEVEL_MARKER,
  space_definition: OBSERVATION_TYPES.SPACE_LABEL,
  column_candidate: OBSERVATION_TYPES.POINT_FEATURE,
  portal_definition: OBSERVATION_TYPES.POINT_FEATURE,
  junction_definition: OBSERVATION_TYPES.POINT_FEATURE,
  vision_finding: OBSERVATION_TYPES.TEXT_FACT,
  material_assignment: OBSERVATION_TYPES.MATERIAL_FACT,
  spatial_relationship: OBSERVATION_TYPES.RELATIONSHIP_FACT,
  facility_dimension: OBSERVATION_TYPES.TEXT_FACT,
  system_membership: OBSERVATION_TYPES.RELATIONSHIP_FACT,
};

// Claim kind → candidate class mapping
export const KIND_TO_CANDIDATE_CLASS = {
  segment_geometry: CANDIDATE_CLASSES.SEGMENT,
  wall_candidate: CANDIDATE_CLASSES.WALL,
  slab_candidate: CANDIDATE_CLASSES.SLAB,
  equipment_instance: CANDIDATE_CLASSES.EQUIPMENT,
  opening_candidate: CANDIDATE_CLASSES.OPENING,
  level_definition: CANDIDATE_CLASSES.LEVEL,
  space_definition: CANDIDATE_CLASSES.SPACE,
  column_candidate: CANDIDATE_CLASSES.COLUMN,
  portal_definition: CANDIDATE_CLASSES.OPENING,
  junction_definition: CANDIDATE_CLASSES.SEGMENT,
  vision_finding: CANDIDATE_CLASSES.UNKNOWN,
  material_assignment: CANDIDATE_CLASSES.UNKNOWN,
  spatial_relationship: CANDIDATE_CLASSES.UNKNOWN,
  facility_dimension: CANDIDATE_CLASSES.UNKNOWN,
  system_membership: CANDIDATE_CLASSES.UNKNOWN,
};

// Extraction method priority (higher index = higher priority for conflict resolution)
export const EXTRACTION_METHOD_PRIORITY = [
  'HEURISTIC',
  'VISION_MODEL',
  'LLM_REFINEMENT',
  'LLM_EXTRACTION',
  'VSM_PARSER',
  'DXF_PARSER',
];

// Source authority priority — applied BEFORE confidence/method when resolving
// conflicting claims. A claim whose evidence carries a higher authority level
// wins the field, even if its confidence is lower. Authority is set by extract
// based on filename pattern or self-declared header text in the source file.
// Higher index = higher priority.
export const AUTHORITY_PRIORITY = [
  'DEFAULT',
  'AUTHORITATIVE',
  'OVERRIDE',
];

// Coordinate source priority (higher index = higher priority)
export const COORDINATE_SOURCE_PRIORITY = [
  'NONE',
  'LLM_GENERATED',
  'ESTIMATED',
  'DIRECT_2D',
  'DIRECT_3D',
];

// Extraction method → candidate class source
export function extractionMethodToClassSource(method) {
  switch (method) {
    case 'DXF_PARSER':
    case 'VSM_PARSER':
    case 'HEURISTIC':
      return CANDIDATE_CLASS_SOURCES.PARSER_HEURISTIC;
    case 'LLM_EXTRACTION':
    case 'LLM_REFINEMENT':
      return CANDIDATE_CLASS_SOURCES.LLM_GUESS;
    case 'VISION_MODEL':
      return CANDIDATE_CLASS_SOURCES.GEOMETRY_PATTERN;
    default:
      return CANDIDATE_CLASS_SOURCES.PARSER_HEURISTIC;
  }
}

// Valid canonical source roles
export const CANONICAL_SOURCE_ROLES = new Set([
  'NARRATIVE', 'SCHEDULE', 'SIMULATION', 'DRAWING', 'VISION',
]);

// Valid claim statuses
export const VALID_STATUSES = new Set([
  'asserted', 'ambiguous', 'rejected', 'unresolved',
]);

/**
 * Build the canonical_observed.json envelope.
 */
export function buildCanonicalObservedEnvelope(observations, domain, facility, metadata) {
  return {
    schemaVersion: '2.0',
    layer: 'canonical_observed',
    domain: domain || 'UNKNOWN',
    facility: facility || {
      name: null,
      type: null,
      description: null,
      units: 'M',
      origin: { x: 0, y: 0, z: 0 },
      axes: 'RIGHT_HANDED_Z_UP',
    },
    observations,
    metadata: {
      claimsConsumed: metadata?.claimsConsumed || 0,
      observationsProduced: metadata?.observationsProduced || observations.length,
      rejectedClaims: metadata?.rejectedClaims || 0,
    },
  };
}

/**
 * Validate an observation object has required fields.
 * Returns array of validation issues (empty if valid).
 */
export function validateObservation(obs) {
  const issues = [];
  if (!obs.observation_id) issues.push('missing observation_id');
  if (!obs.instance_id) issues.push('missing instance_id');
  if (!obs.source_claim_ids || obs.source_claim_ids.length === 0) issues.push('missing source_claim_ids');
  if (!obs.observation_type) issues.push('missing observation_type');
  if (!obs.candidate_class) issues.push('missing candidate_class');
  if (obs.confidence === undefined || obs.confidence === null) issues.push('missing confidence');
  return issues;
}

/**
 * Generate a new observation ID.
 */
let obsCounter = 0;
export function generateObservationId() {
  obsCounter++;
  return `obs-${String(obsCounter).padStart(4, '0')}`;
}

export function resetObservationCounter() {
  obsCounter = 0;
}

/**
 * Generate a new canonical ID.
 */
export function generateCanonicalId() {
  return `canon-${randomUUID().slice(0, 12)}`;
}

/**
 * Generate a new instance ID.
 */
export function generateInstanceId() {
  return randomUUID();
}
