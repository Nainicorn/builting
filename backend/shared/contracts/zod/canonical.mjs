// canonicalContract — resolve self-check (no downstream consumer).
// Validates canonical_observed.json. Documents the schema as currently
// produced; no cleanup.
//
// Operational note: this contract has NO downstream consumer. Topology
// reads css_raw.json directly from extract, NOT canonical_observed.json
// from resolve. canonical exists as a diagnostic artifact. Resolve runs
// this contract on its own output before returning; on failure it logs
// `contract_self_check_failure` to the trace (PR 2) and continues —
// the pipeline does NOT halt because no consumer depends on this output.
//
// The check still catches regressions in resolve's output shape, which
// matters because Phase 14 will give canonical a consumer (provenance
// propagation), at which point this becomes a real boundary contract.
//
// PR 1 captures the schema warts-included.
//
// Audit trail:
//   envelope            — resolve/schemas.mjs:147 (buildCanonicalObservedEnvelope)
//   observation shape   — resolve/resolve.mjs:487-510 (buildObservation)
//   internal-field strip — resolve/identity.mjs:63 (removes _sourceAliases etc.
//                          before write — contract validates POST-strip shape)
//   merge confidence    — resolve/resolve.mjs:283-284 (weighted average; will
//                          change in Phase 14 to disagreement-penalty)

import { z } from 'zod';

// ─── Closed enums ────────────────────────────────────────────────────────

// VARIANT: 'ARCH' is legitimate (hospital render).
const DOMAIN = z.enum(['UNKNOWN', 'TUNNEL', 'BUILDING', 'CIVIL', 'MIXED', 'ARCH']);

const OBSERVATION_TYPES = z.enum([
  'linear_feature', 'polygon_feature', 'point_feature', 'text_fact',
  'asset_record', 'level_marker', 'space_label', 'material_fact',
  'relationship_fact',
]);

const OBSERVATION_STATUSES = z.enum(['accepted', 'ambiguous', 'superseded']);

const CANDIDATE_CLASSES = z.enum([
  'wall', 'slab', 'segment', 'equipment', 'opening', 'level',
  'space', 'column', 'unknown',
]);

const CANDIDATE_CLASS_SOURCES = z.enum([
  'direct_label', 'parser_heuristic', 'llm_guess', 'geometry_pattern',
]);

const COORDINATE_SOURCE = z.enum([
  'DIRECT_3D', 'DIRECT_2D', 'ASSEMBLED_2D', 'ESTIMATED', 'LLM_GENERATED', 'NONE',
]);

const EXTRACTION_METHOD = z.enum([
  'VSM_PARSER', 'DXF_PARSER', 'LLM_EXTRACTION', 'VISION_MODEL',
  'LLM_REFINEMENT', 'HEURISTIC',
]);

// ─── Sub-schemas ─────────────────────────────────────────────────────────

const Vec3 = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
}).strict();

const Facility = z.object({
  name: z.string().nullable(),
  type: z.string().nullable(),
  description: z.string().nullable(),
  units: z.literal('M'),
  origin: Vec3,
  axes: z.literal('RIGHT_HANDED_Z_UP'),
}).strict();

// Geometry/semantic/context evidence — buildObservation always emits these
// blocks even when empty. The shape mirrors resolve.mjs:407-449.
const GeometryEvidence = z.object({
  curves: z.array(z.unknown()),
  points: z.array(Vec3),
  profiles: z.array(z.unknown()),
  rawCoordinates: z.array(z.unknown()),
  // dimensions is a free-form record (depth/width/height + spread keys
  // from element-specific dimension fields). passthrough.
  dimensions: z.record(z.unknown()),
}).strict();

const SemanticEvidence = z.object({
  labels: z.array(z.string()),
  tags: z.array(z.string()),
  // properties carries the raw element properties through; free-form.
  properties: z.record(z.unknown()),
  materials: z.array(z.unknown()),
}).strict();

const ContextEvidence = z.object({
  containerHints: z.array(z.unknown()),
  adjacencyHints: z.array(z.string()),
  hostHints: z.array(z.string()),
  systemHints: z.array(z.string()),
}).strict();

// Phase 13 PR 3 provenance schema — replaces the old basis/coordinateSource shape.
// Optional at the observation level; PR 5 flips to required.
const PROVENANCE_STATUS = z.enum([
  'direct', 'inherited_consensus', 'inherited_contested',
  'derived_geometric', 'derived_inferred', 'missing', 'legacy',
]);

const Provenance = z.object({
  sourceFile: z.string().nullable(),
  sourceFileStatus: PROVENANCE_STATUS,
  sourceFiles: z.array(z.string()),
  stage: z.string(),
  modifications: z.array(z.string()),
}).strict();

const Observation = z.object({
  observation_id: z.string().regex(/^obs-\d{4}$/, 'expected obs-NNNN format'),
  // Set by identity.mjs after resolve.mjs builds the observation.
  //
  // ACTUAL FORMAT: `canon-<8hex>-<3hex>`. The implementation is
  //   `'canon-' + randomUUID().slice(0, 12)`
  // and randomUUID() returns 'xxxxxxxx-xxxx-...' so the first 12 chars
  // include an embedded hyphen at position 8. Calibration caught this —
  // the original 12-hex regex rejected every real canonical_id.
  canonical_id: z.string().regex(/^canon-[0-9a-f]{8}-[0-9a-f]{3}$/, 'expected canon-<8hex>-<3hex>'),
  // instance_id is a UUID v4 from randomUUID(); we only enforce non-empty
  // string shape (regex would be over-tight if Node's randomUUID format
  // ever changes).
  instance_id: z.string().min(1),
  source_claim_ids: z.array(z.string().regex(/^c-\d{4}$/)),
  observation_type: OBSERVATION_TYPES,
  observation_status: OBSERVATION_STATUSES,
  candidate_class: CANDIDATE_CLASSES,
  candidate_class_source: CANDIDATE_CLASS_SOURCES,
  geometry_evidence: GeometryEvidence,
  semantic_evidence: SemanticEvidence,
  context_evidence: ContextEvidence,
  // Same confidence-bound rationale as claimsContract: full [0, 1]. By
  // construction observations have ≥0.2 (resolve filters claims below
  // MIN_CONFIDENCE before merge), but Phase 14 disagreement-penalty merge
  // will produce sub-0.2 values from claims that individually pass the
  // filter. Do not tighten the lower bound.
  confidence: z.number().min(0).max(1),
  provenance: Provenance,
}).strict();

// DEBT: validation_summary HAS a real shape (ran, timestamp, domain,
// storeys, containment, wallGeometry, totalWarnings, warnings) — we just
// haven't formalized it. Phase 13.5 defines structured semantic
// validators and will give this a proper contract. Free-form for PR 1
// is the honest interim state.
// TODO(phase13.5): replace with structured ValidationSummary contract.
const ValidationSummary = z.record(z.unknown());

// ─── Top-level envelope (strict) + cross-field check ─────────────────────

const CanonicalEnvelopeBase = z.object({
  schemaVersion: z.literal('2.0'),
  layer: z.literal('canonical_observed'),
  domain: DOMAIN,
  facility: Facility.nullable(),
  observations: z.array(Observation),
  metadata: z.object({
    claimsConsumed: z.number().int().min(0),
    observationsProduced: z.number().int().min(0),
    rejectedClaims: z.number().int().min(0),
  }).strict(),
  validation_summary: ValidationSummary.optional(),
}).strict();

// Cross-field invariant: metadata.observationsProduced must equal
// observations.length. Resolve sets it from observations.length at write
// time (resolve/index.mjs:122-125). Identical pattern to claimsContract's
// totalClaims invariant.
export const canonicalContract = CanonicalEnvelopeBase.refine(
  (env) => env.metadata.observationsProduced === env.observations.length,
  {
    message: 'metadata.observationsProduced must equal observations.length',
    path: ['metadata', 'observationsProduced'],
  },
);

export const canonicalContractMeta = {
  name: 'canonicalContract',
  producer: 'resolve',
  consumer: null,  // diagnostic only; runs as resolve self-check
  artifact: 'canonical_observed.json',
  version: '0.1.0',
  selfCheck: true,
};
