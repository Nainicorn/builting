// claimsContract — extract → resolve.
// Validates claims.json. Documents the schema as currently produced; no cleanup.
//
// PR 1 captures the schema warts-included. Each TODO names a follow-up
// PR that will tighten the constraint. Do not "fix" anything in this file
// outside its named PR.
//
// Audit trail (where each constant came from):
//   claim_id format          — claimsSchema.mjs:120
//   claim kinds              — claimsSchema.mjs:7-25 (CLAIM_KINDS)
//   claim status             — claimsSchema.mjs:45-50 (CLAIM_STATUS)
//   discipline               — claimsSchema.mjs:256-281 (inferDiscipline switch)
//   evidence enums           — claimsSchema.mjs:53-99
//   parseStatus              — extract/index.mjs:5095-5189 (grep for parseStatus)
//   confidence range         — full [0,1]; resolve filters <0.2 (resolve.mjs:19+88),
//                              but extract may emit any confidence
//   evidence[0] semantics    — resolve.mjs:371,394,405 — see comment on `evidence`

import { z } from 'zod';

// ─── Closed enums ────────────────────────────────────────────────────────

const CLAIM_KINDS = z.enum([
  'segment_geometry', 'wall_candidate', 'slab_candidate', 'equipment_instance',
  'opening_candidate', 'level_definition', 'space_definition', 'material_assignment',
  'spatial_relationship', 'junction_definition', 'portal_definition', 'facility_dimension',
  'vision_finding', 'system_membership', 'column_candidate', 'covering_candidate',
  'fitting_candidate',
]);

const CLAIM_STATUS = z.enum(['asserted', 'ambiguous', 'rejected', 'unresolved']);

const SOURCE_ROLE = z.enum(['NARRATIVE', 'SCHEDULE', 'SIMULATION', 'DRAWING', 'VISION']);

const EXTRACTION_METHOD = z.enum([
  'VSM_PARSER', 'DXF_PARSER', 'LLM_EXTRACTION', 'VISION_MODEL',
  'LLM_REFINEMENT', 'HEURISTIC',
]);

const COORDINATE_SOURCE = z.enum([
  'DIRECT_3D', 'DIRECT_2D', 'ASSEMBLED_2D', 'ESTIMATED', 'LLM_GENERATED', 'NONE',
]);

const COORDINATE_DERIVATION = z.enum(['direct', 'assembled', 'estimated']);

const SHEET_ROLE = z.enum([
  'FLOOR_PLAN', 'ELEVATION', 'SECTION', 'TITLE_SHEET', 'SCHEDULE',
  'DETAIL', 'EQUIPMENT_LAYOUT', 'SITE_PLAN', 'UNKNOWN',
]);

const AUTHORITY_LEVEL = z.enum(['DEFAULT', 'AUTHORITATIVE', 'OVERRIDE']);

// VARIANT: production legitimately uses 'ARCH' for architectural renders
// (hospital). Caught during PR 1 calibration. Domain reflects the actual
// project type and will not be tightened.
const DOMAIN = z.enum(['UNKNOWN', 'TUNNEL', 'BUILDING', 'CIVIL', 'MIXED', 'ARCH']);
// NOTE: claims/canonical default to 'UNKNOWN'; validatedCss defaults to 'BUILDING'.
// Not a silent bug today (no consumer branches on === 'BUILDING'), but a footgun.
// Documented in tunnel-shell.mjs cleanup (deferred to PR 2 or later).

const DISCIPLINE = z.enum([
  'structural', 'architectural', 'mechanical', 'civil',
  'electrical', 'plumbing', 'unknown',
]);

const PARSE_STATUS = z.enum(['success', 'failed', 'low_confidence', 'unsupported']);

// DEBT: extract conflates two field names — `role` and `sourceRole` — at
// createClaimsEnvelope (`sf.sourceRole || sf.role || 'UNKNOWN'`), so a file
// pushed with `role: 'description'` produces sourceRole 'description'
// (lowercase, free-string). Calibration also caught 'TECHNICAL_NARRATIVE'
// outside the original enum. The right cleanup is to standardize on one
// field name and one casing convention in extract; once cleaned, this
// contract should tighten back to a closed enum.
// TODO(phase13-cleanup): standardize role/sourceRole + casing in extract,
// then re-tighten to closed enum.
const SOURCE_MANIFEST_ROLE = z.string();

// Phase 13 PR 3 provenance schema — optional now, required in PR 5.
const PROVENANCE_STATUS = z.enum([
  'direct', 'inherited_consensus', 'inherited_contested',
  'derived_geometric', 'derived_inferred', 'missing', 'legacy',
]);

// ─── Sub-schemas ─────────────────────────────────────────────────────────

const Origin = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
}).strict();

const FacilityMeta = z.object({
  name: z.string().nullable(),
  type: z.string().nullable(),
  description: z.string().nullable(),
  // TODO(phase13-cleanup): extract hardcodes 'M' regardless of source units
  // (claimsSchema.mjs:228). normalize.mjs's unit-conversion branch is
  // unreachable from extract output. Real fix is to plumb source units
  // through; for now contract documents what's emitted.
  units: z.literal('M'),
  origin: Origin,
  // TODO(phase13-cleanup): same story as units — hardcoded.
  axes: z.literal('RIGHT_HANDED_Z_UP'),
}).strict();

const Evidence = z.object({
  source: z.string().nullable(),
  sourceRole: SOURCE_ROLE.nullable(),
  extractionMethod: EXTRACTION_METHOD.nullable(),
  coordinateSource: COORDINATE_SOURCE,
  authority: AUTHORITY_LEVEL,
  excerpt: z.string().nullable(),
  page: z.number().nullable(),
  // TODO(phase13-cleanup): `region`, `drawingMetadata` are free-form. Tighten
  // when actual shapes are catalogued from observed renders.
  region: z.unknown().nullable(),
  sheetName: z.string().nullable(),
  dxfLayer: z.string().nullable(),
  dxfHandle: z.string().nullable(),
  sheetRole: SHEET_ROLE.nullable(),
  coordinateDerivation: COORDINATE_DERIVATION.nullable(),
  scaleConfidence: z.number().nullable(),
  drawingMetadata: z.unknown().nullable(),
}).strict();

const Claim = z.object({
  claim_id: z.string().regex(/^c-\d{4}$/, 'expected c-NNNN format'),
  kind: CLAIM_KINDS,
  subject_local_id: z.string(),
  // TODO(phase13-cleanup): per-kind sub-schemas — 17 kinds, varied shapes.
  // For now `attributes` is free-form. Resolve indexes into specific keys
  // (e.g. attributes.placement.origin in resolve.mjs:218) without checking
  // shape; that's a soft contract not enforced here.
  attributes: z.record(z.unknown()),
  status: CLAIM_STATUS,
  // TODO(phase13-cleanup): `alternatives` item shape unspecified — empty in
  // observed output. Tighten when populated cases surface.
  alternatives: z.array(z.unknown()),
  requires_review: z.boolean(),
  // SEMANTIC: order matters in `evidence`.
  //   evidence[0]   — primary; resolve uses it for extractionMethod priority,
  //                   coordinateSource priority, and observation construction
  //                   (resolve.mjs:371, 394, 405).
  //   evidence[1..] — unordered set of additional evidence; no priority
  //                   implied. Do not treat evidence[1] as "second-most
  //                   authoritative."
  // Schema can't express ordering; do not reorder evidence in extract
  // without coordinating a resolve change.
  evidence: z.array(Evidence),
  // confidence is full [0, 1]. Resolve filters <0.2 (resolve.mjs:19+88) into
  // resolution_report.droppedClaims with reason: 'below_confidence_threshold'.
  // Phase 14 will replace the merge rule with disagreement-penalty; do not
  // tighten the lower bound here.
  confidence: z.number().min(0).max(1),
  // TODO(phase13-cleanup): fieldConfidence is free-form. Phase 14 will
  // structure it (per-field score + factors blob).
  fieldConfidence: z.record(z.unknown()),
  aliases: z.array(z.string()),
  // TODO(phase13-cleanup): source_revision_hint shape unspecified.
  source_revision_hint: z.unknown().nullable(),
  discipline: DISCIPLINE,
  parserVersion: z.string(),
  // Phase 13 PR 5 — required. Every claim must carry provenance from extract.
  provenance: z.object({
    sourceFile: z.string().nullable(),
    sourceFileStatus: PROVENANCE_STATUS,
    sourceFiles: z.array(z.string()),
    stage: z.string(),
    modifications: z.array(z.string()),
  }).strict(),
}).strict();

const SourceManifestEntry = z.object({
  name: z.string(),
  parseStatus: PARSE_STATUS,
  sourceRole: SOURCE_MANIFEST_ROLE,
  claimCount: z.number().int().min(0),
  geometryContributor: z.boolean(),
}).strict();

const ConfidenceDistribution = z.object({
  high: z.number().int().min(0),
  medium: z.number().int().min(0),
  low: z.number().int().min(0),
}).strict();

const ExtractionReport = z.object({
  totalClaims: z.number().int().min(0),
  byKind: z.record(z.number().int().min(0)),
  bySource: z.record(z.number().int().min(0)),
  confidenceDistribution: ConfidenceDistribution,
  // TODO(phase13-cleanup): parseErrors always empty in observed output;
  // either the populating site is missing or aspirational. Find and document.
  parseErrors: z.array(z.unknown()),
  ambiguousClaims: z.number().int().min(0),
  unresolvedClaims: z.number().int().min(0),
}).strict();

// ─── Top-level envelope + cross-field check ──────────────────────────────

const ClaimsEnvelopeBase = z.object({
  claimsVersion: z.literal('1.0'),
  domain: DOMAIN,
  facilityMeta: FacilityMeta,
  claims: z.array(Claim),
  sourceManifest: z.array(SourceManifestEntry),
  extractionReport: ExtractionReport,
}).strict();

// Cross-field invariant: extractionReport.totalClaims must equal claims.length.
// Enforced in extract code (claimsSchema.mjs:235: `totalClaims: claims.length`).
// If they disagree, the artifact is malformed even though no individual
// field is wrong.
//
// FUTURE cross-field constraints land here in PR 3:
//   - provenance.sourceFileStatus === 'inherited_consensus'
//     ⇒ provenance.sourceFiles.length >= 2
//   - provenance.sourceFileStatus === 'direct'
//     ⇒ provenance.sourceFile !== null
export const claimsContract = ClaimsEnvelopeBase.refine(
  (env) => env.extractionReport.totalClaims === env.claims.length,
  {
    message: 'extractionReport.totalClaims must equal claims.length',
    path: ['extractionReport', 'totalClaims'],
  },
);

export const claimsContractMeta = {
  name: 'claimsContract',
  producer: 'extract',
  consumer: 'resolve',
  artifact: 'claims.json',
  version: '0.1.0',
};
