/**
 * Claims Schema — constants, claim ID generation, envelope builder, evidence builder, validation.
 * Foundation module for Phase 1 claims dual-write.
 */
import { logDecision } from '@builting/audit';

// Claim kind constants
export const CLAIM_KINDS = {
  SEGMENT_GEOMETRY: 'segment_geometry',
  WALL_CANDIDATE: 'wall_candidate',
  SLAB_CANDIDATE: 'slab_candidate',
  EQUIPMENT_INSTANCE: 'equipment_instance',
  OPENING_CANDIDATE: 'opening_candidate',
  LEVEL_DEFINITION: 'level_definition',
  SPACE_DEFINITION: 'space_definition',
  MATERIAL_ASSIGNMENT: 'material_assignment',
  SPATIAL_RELATIONSHIP: 'spatial_relationship',
  JUNCTION_DEFINITION: 'junction_definition',
  PORTAL_DEFINITION: 'portal_definition',
  FACILITY_DIMENSION: 'facility_dimension',
  VISION_FINDING: 'vision_finding',
  SYSTEM_MEMBERSHIP: 'system_membership',
  COLUMN_CANDIDATE: 'column_candidate',
  COVERING_CANDIDATE: 'covering_candidate',
  FITTING_CANDIDATE: 'fitting_candidate',
};

// Map CSS element types to claim kinds
export const TYPE_TO_KIND = {
  TUNNEL_SEGMENT: CLAIM_KINDS.SEGMENT_GEOMETRY,
  DUCT: CLAIM_KINDS.SEGMENT_GEOMETRY,
  BEAM: CLAIM_KINDS.SEGMENT_GEOMETRY,
  WALL: CLAIM_KINDS.WALL_CANDIDATE,
  SLAB: CLAIM_KINDS.SLAB_CANDIDATE,
  ROOF: CLAIM_KINDS.SLAB_CANDIDATE,
  EQUIPMENT: CLAIM_KINDS.EQUIPMENT_INSTANCE,
  DOOR: CLAIM_KINDS.OPENING_CANDIDATE,
  WINDOW: CLAIM_KINDS.OPENING_CANDIDATE,
  SPACE: CLAIM_KINDS.SPACE_DEFINITION,
  COLUMN: CLAIM_KINDS.COLUMN_CANDIDATE,
  COVERING: CLAIM_KINDS.COVERING_CANDIDATE,
  DUCT_FITTING: CLAIM_KINDS.FITTING_CANDIDATE,
};

// Valid claim statuses
export const CLAIM_STATUS = {
  ASSERTED: 'asserted',
  AMBIGUOUS: 'ambiguous',
  REJECTED: 'rejected',
  UNRESOLVED: 'unresolved',
};

// Phase 13 provenance status values
// Describes how a claim (or element) got its source attribution.
export const PROVENANCE_STATUS = {
  DIRECT: 'direct',                       // attributed to one specific upload file
  INHERITED_CONSENSUS: 'inherited_consensus', // merged from ≥2 sources, all agreed
  INHERITED_CONTESTED: 'inherited_contested', // merged from ≥2 sources, ≥1 alternative discarded
  DERIVED_GEOMETRIC: 'derived_geometric', // deterministic transform of an existing element
  DERIVED_INFERRED: 'derived_inferred',   // heuristic new element (inferred slab, derived opening)
  MISSING: 'missing',                     // extract couldn't attribute to a source
  LEGACY: 'legacy',                       // pre-Phase-13 element with no provenance record
};

/**
 * Build a Phase 13 provenance object.
 * @param {string|null} sourceFile - S3 key or filename of the upload that produced this claim
 * @param {string} status - One of PROVENANCE_STATUS values
 * @param {string} stage - Pipeline stage that assigned this provenance ('extract', 'resolve', 'topology:snap', ...)
 * @param {string[]} modifications - Ordered list of pipeline passes that modified this element
 */
export function buildProvenance(sourceFile, status, stage, modifications = []) {
  const sf = sourceFile || null;
  return {
    sourceFile: sf,
    sourceFileStatus: status || PROVENANCE_STATUS.MISSING,
    sourceFiles: sf ? [sf] : [],
    stage: stage || 'extract',
    modifications: Array.isArray(modifications) ? modifications : [],
  };
}

// Valid extraction methods
export const EXTRACTION_METHODS = {
  VSM_PARSER: 'VSM_PARSER',
  DXF_PARSER: 'DXF_PARSER',
  LLM_EXTRACTION: 'LLM_EXTRACTION',
  VISION_MODEL: 'VISION_MODEL',
  LLM_REFINEMENT: 'LLM_REFINEMENT',
  HEURISTIC: 'HEURISTIC',
};

// Valid coordinate sources
export const COORDINATE_SOURCES = {
  DIRECT_3D: 'DIRECT_3D',
  DIRECT_2D: 'DIRECT_2D',
  ASSEMBLED_2D: 'ASSEMBLED_2D',
  ESTIMATED: 'ESTIMATED',
  LLM_GENERATED: 'LLM_GENERATED',
  NONE: 'NONE',
};

// Valid coordinate derivation methods (for vision pipeline)
export const COORDINATE_DERIVATION = {
  DIRECT: 'direct',
  ASSEMBLED: 'assembled',
  ESTIMATED: 'estimated',
};

// Sheet/page role classification
export const SHEET_ROLES = {
  FLOOR_PLAN: 'FLOOR_PLAN',
  ELEVATION: 'ELEVATION',
  SECTION: 'SECTION',
  TITLE_SHEET: 'TITLE_SHEET',
  SCHEDULE: 'SCHEDULE',
  DETAIL: 'DETAIL',
  EQUIPMENT_LAYOUT: 'EQUIPMENT_LAYOUT',
  SITE_PLAN: 'SITE_PLAN',
  UNKNOWN: 'UNKNOWN',
};

// Valid source roles
export const SOURCE_ROLES = {
  NARRATIVE: 'NARRATIVE',
  SCHEDULE: 'SCHEDULE',
  SIMULATION: 'SIMULATION',
  DRAWING: 'DRAWING',
  VISION: 'VISION',
};

// Source authority levels — used by resolve to break field conflicts
// before falling back to confidence/extraction-method ranking.
// OVERRIDE wins over AUTHORITATIVE wins over DEFAULT.
// A source declares itself OVERRIDE either via a filename pattern
// (e.g. "*Supplemental_Specs*") or via a self-declared header
// (e.g. "THIS DOCUMENT IS THE HIGHEST-AUTHORITY SOURCE").
export const AUTHORITY_LEVELS = {
  DEFAULT: 'DEFAULT',
  AUTHORITATIVE: 'AUTHORITATIVE',
  OVERRIDE: 'OVERRIDE',
};

let claimCounter = 0;

/**
 * Generate a unique claim ID. Resets counter per invocation via resetClaimCounter().
 */
export function generateClaimId() {
  claimCounter++;
  return `c-${String(claimCounter).padStart(4, '0')}`;
}

/**
 * Reset claim counter (call at start of each extraction run).
 */
export function resetClaimCounter() {
  claimCounter = 0;
}

/**
 * Build a single evidence object.
 */
export function buildEvidence(source, sourceRole, extractionMethod, coordinateSource, extras = {}) {
  return {
    source: source || null,
    sourceRole: sourceRole || null,
    extractionMethod: extractionMethod || null,
    coordinateSource: coordinateSource || COORDINATE_SOURCES.NONE,
    authority: extras.authority || 'DEFAULT',
    excerpt: extras.excerpt || null,
    page: extras.page || null,
    region: extras.region || null,
    sheetName: extras.sheetName || null,
    dxfLayer: extras.dxfLayer || null,
    dxfHandle: extras.dxfHandle || null,
    sheetRole: extras.sheetRole || null,
    coordinateDerivation: extras.coordinateDerivation || null,
    scaleConfidence: extras.scaleConfidence ?? null,
    drawingMetadata: extras.drawingMetadata || null,
  };
}

/**
 * Build a single claim object from element data.
 * @param {string} kind - Claim kind from CLAIM_KINDS
 * @param {string} subjectLocalId - Parser-local identifier
 * @param {object} attributes - Full element data (placement, geometry, material, properties, etc.)
 * @param {object} options - { evidence, confidence, fieldConfidence, status, discipline, aliases }
 */
export function buildClaim(kind, subjectLocalId, attributes, options = {}) {
  const claim = {
    claim_id: generateClaimId(),
    kind,
    subject_local_id: subjectLocalId,
    attributes,
    status: options.status || CLAIM_STATUS.ASSERTED,
    alternatives: options.alternatives || [],
    requires_review: options.requires_review || false,
    evidence: options.evidence || [],
    confidence: options.confidence ?? 0.5,
    fieldConfidence: options.fieldConfidence || {},
    aliases: options.aliases || [],
    source_revision_hint: options.source_revision_hint || null,
    discipline: options.discipline || 'unknown',
    parserVersion: '1.0',
    provenance: options.provenance || buildProvenance(null, PROVENANCE_STATUS.MISSING, 'extract'),
  };
  logDecision({
    pass: 'extraction', element_id: claim.claim_id, action: 'claim_emitted',
    reason: 'source_extracted',
    params: { kind: claim.kind, sourceFile: claim.provenance?.sourceFile ?? null,
              method: claim.evidence?.[0]?.method ?? null, confidence: claim.confidence },
  });
  return claim;
}

/**
 * Build the top-level claims.json envelope.
 * @param {string} domain - TUNNEL, BUILDING, CIVIL, MIXED
 * @param {object} facilityMeta - { name, type, description, units, origin, axes }
 * @param {Array} claims - Array of claim objects
 * @param {Array} sourceFilesList - Array of { name, parseStatus, role/sourceRole, ... }
 */
export function createClaimsEnvelope(domain, facilityMeta, claims, sourceFilesList = []) {
  // Build source manifest from sourceFiles
  const sourceManifest = sourceFilesList.map(sf => {
    const claimCount = claims.filter(c =>
      c.evidence.some(e => e.source === sf.name)
    ).length;
    return {
      name: sf.name,
      parseStatus: sf.parseStatus || 'success',
      sourceRole: sf.sourceRole || sf.role || 'UNKNOWN',
      claimCount,
      geometryContributor: claimCount > 0,
    };
  });

  // Build extraction report
  const byKind = {};
  const bySource = {};
  let highConf = 0, medConf = 0, lowConf = 0;
  let ambiguousClaims = 0, unresolvedClaims = 0;

  for (const c of claims) {
    byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    for (const e of c.evidence) {
      if (e.extractionMethod) {
        bySource[e.extractionMethod] = (bySource[e.extractionMethod] || 0) + 1;
      }
    }
    if (c.confidence >= 0.7) highConf++;
    else if (c.confidence >= 0.4) medConf++;
    else lowConf++;
    if (c.status === CLAIM_STATUS.AMBIGUOUS) ambiguousClaims++;
    if (c.status === CLAIM_STATUS.UNRESOLVED) unresolvedClaims++;
  }

  return {
    claimsVersion: '1.0',
    domain: domain || 'UNKNOWN',
    facilityMeta: {
      name: facilityMeta?.name || null,
      type: facilityMeta?.type || null,
      description: facilityMeta?.description || null,
      units: 'M',
      origin: facilityMeta?.origin || { x: 0, y: 0, z: 0 },
      axes: 'RIGHT_HANDED_Z_UP',
    },
    claims,
    sourceManifest,
    extractionReport: {
      totalClaims: claims.length,
      byKind,
      bySource,
      confidenceDistribution: { high: highConf, medium: medConf, low: lowConf },
      parseErrors: [],
      ambiguousClaims,
      unresolvedClaims,
    },
  };
}

/**
 * Map a CSS element type string to the appropriate claim kind.
 */
export function typeToKind(cssType) {
  return TYPE_TO_KIND[cssType] || CLAIM_KINDS.EQUIPMENT_INSTANCE;
}

/**
 * Determine discipline from element type and properties.
 */
export function inferDiscipline(type, properties = {}) {
  switch (type) {
    case 'WALL':
    case 'SLAB':
    case 'ROOF':
    case 'COLUMN':
    case 'BEAM':
      return 'structural';
    case 'DOOR':
    case 'WINDOW':
    case 'SPACE':
    case 'COVERING':
      return 'architectural';
    case 'TUNNEL_SEGMENT':
    case 'DUCT':
      return properties.systemType ? 'mechanical' : 'civil';
    case 'DUCT_FITTING':
      return 'mechanical';
    case 'EQUIPMENT':
      if (properties.systemType === 'ELECTRICAL' || properties.systemType === 'CABLE_TRAY') return 'electrical';
      if (properties.systemType === 'PLUMBING') return 'plumbing';
      return 'mechanical';
    default:
      return 'unknown';
  }
}
