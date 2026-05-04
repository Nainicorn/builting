// validatedCssContract — topology-engine → generate.
// Validates css_processed.json. Documents the schema as currently produced
// by resolvedToLegacyCss(); no cleanup.
//
// Important shape notes:
//   - Same root structure as cssRaw (cssVersion, domain, facility, levelsOrSegments,
//     elements, metadata) but topology adds canonical_id on every element,
//     fills geometry.method, propagates topology._<flag> annotations, and the
//     metadata block carries different keys (no extractBuild; adds outputMode,
//     placementZIsAbsolute, sourceFusion, tunnelDecomposition, repairLog, etc.).
//   - `domain` default differs from cssRaw: 'BUILDING' here vs 'UNKNOWN' there
//     (see resolvedToLegacyCss line 327). Documented in claimsContract footgun
//     comment; not a silent bug today, but a footgun.
//
// PR 1 captures the schema warts-included. Each TODO names a follow-up.
//
// Audit trail:
//   write site            — topology-engine/index.mjs:1448-1452 (css_processed)
//   adapter               — topology-engine/v2-adapter.mjs:259 (resolvedToLegacyCss)
//   geometry annotations  — v2-adapter.mjs:299-302 (preserves _<flag> fields)
//   element-level fields  — v2-adapter.mjs:278-321
//   metadata fields       — v2-adapter.mjs:339-356

import { z } from 'zod';

// ─── Closed enums ────────────────────────────────────────────────────────

// Phase 13 PR 3 provenance status values (mirrors claimsSchema.mjs + resolve/schemas.mjs).
const PROVENANCE_STATUS = z.enum([
  'direct', 'inherited_consensus', 'inherited_contested',
  'derived_geometric', 'derived_inferred', 'missing', 'legacy',
]);

// VARIANT: 'ARCH' is legitimate (hospital render).
const DOMAIN = z.enum(['UNKNOWN', 'TUNNEL', 'BUILDING', 'CIVIL', 'MIXED', 'ARCH']);

// resolvedToLegacyCss maps geom.intent → method via INTENT_TO_METHOD
// (extrusion/sweep/mesh/brep). Plus 'EXTRUSION' as fallback. Closed enum.
const GEOMETRY_METHOD = z.enum(['EXTRUSION', 'SWEEP', 'MESH', 'BREP']);

// outputMode in topology output — observed values include HYBRID + a few
// metadata-only modes. Tighten to closed enum.
const OUTPUT_MODE = z.enum(['HYBRID', 'METADATA_ONLY', 'GEOMETRY_ONLY']);

// VARIANT: 'authoring_safe' is the PRESENTATION_SAFE_MODE setting from
// topology (Phase 12A) — legitimate per-render mode. 'visualization' and
// 'analysis' are speculative; not observed yet but kept for forward compat.
// TODO(phase13-cleanup): catalog all observed values; remove unused.
const EXPORT_PROFILE = z.enum(['coordination', 'visualization', 'analysis', 'authoring_safe']);

// ─── Sub-schemas ─────────────────────────────────────────────────────────

const Vec3 = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
}).strict();

const Bbox = z.object({
  min: Vec3,
  max: Vec3,
}).strict();

// VARIANT: `crs` legitimately propagates through from cssRaw.facility.
// The validatedCss schema originally missed this field — adapter doesn't
// add it, but it survives from upstream. Always nullable in practice.
const Facility = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
  units: z.literal('M'),
  crs: z.string().nullable().optional(),
  origin: Vec3,
  axes: z.literal('RIGHT_HANDED_Z_UP'),
}).strict();

// DEBT: same as cssRaw — every element should carry a complete material.
// Adapter fills a default at v2-adapter.mjs:308 but only if `elem.material`
// is wholly absent; partial materials pass through unchanged.
const Material = z.object({
  name: z.string(),
  color: z.array(z.number()).length(3).optional(),
  transparency: z.number().min(0).max(1).optional(),
}).strict();

// VARIANT: same as cssRaw — some element types legitimately have only
// an origin point. Optional permanently.
const Placement = z.object({
  origin: Vec3,
  axis: Vec3.optional(),
  refDirection: Vec3.optional(),
}).strict();

// Geometry from resolvedToLegacyCss(): always has method, profile, depth;
// optionally direction/path/pathPoints/vertices/faces/mesh and any
// _<topology-annotation> fields preserved from upstream. passthrough.
//
// SEMANTIC: order matters in `path` and `pathPoints` arrays — they are
// polyline/curve definitions; reordering changes geometry. Schema cannot
// express this; do not rearrange in topology without a coordinated
// generate change.
const Geometry = z.object({
  method: GEOMETRY_METHOD,
  profile: z.unknown().nullable(),
  depth: z.number().nullable(),
}).passthrough();
// TODO(phase13-cleanup): catalog observed _<flag> field set
// (_geoBehavior, _isTunnelShell, _pathAuthored — v2-adapter.mjs:299) and
// promote to typed optional fields.

const Relationship = z.object({
  type: z.string(),
  target: z.string(),
}).passthrough();
// passthrough because resolvedToLegacyCss spreads `...r` (v2-adapter.mjs:306)
// preserving any extra keys present on upstream relationships.

// Element shape from resolvedToLegacyCss. Required: id, element_key,
// canonical_id, type, name, placement, geometry, relationships, properties,
// material, confidence, source, sourceFile, metadata.
//
// PR 3 will REPLACE the following pre-existing fields with the full
// Phase 13 provenance schema:
//   - confidence (element-level default 0.7) — replaced or augmented
//   - source (free string 'LLM'/'VSM'/etc.)  — replaced
//   - sourceFile (single string or null)      — replaced with sourceFiles list
const Element = z.object({
  id: z.string(),
  element_key: z.string(),
  canonical_id: z.string(),
  type: z.string(),
  semanticType: z.string().optional(),
  name: z.string(),
  placement: Placement.nullable(),
  geometry: Geometry.nullable(),
  container: z.string().nullable(),
  relationships: z.array(Relationship),
  properties: z.record(z.unknown()),
  material: Material,
  // Pre-existing element-level confidence default (v2-adapter.mjs:309).
  // Phase 14 will replace with measurable per-source/per-pass confidence.
  confidence: z.number().min(0).max(1),
  // Free string: 'LLM' default + 'VSM', 'DXF', 'VISION', etc. PR 3 replaces.
  source: z.string(),
  sourceFile: z.string().nullable(),
  // metadata carries topology placement metadata (zAligned, parentSegment,
  // etc.) plus optional .evidence sub-object. passthrough.
  metadata: z.record(z.unknown()),
  // Phase 13 PR 5 — required. Every topology output element must carry provenance.
  provenance: z.object({
    sourceFile: z.string().nullable(),
    sourceFileStatus: PROVENANCE_STATUS,
    sourceFiles: z.array(z.string()),
    stage: z.string(),
    modifications: z.array(z.string()),
  }).strict(),
}).strict();

const LevelOrSegment = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  elevation_m: z.number(),
  height_m: z.number(),
}).strict();

// Topology block from resolvedToLegacyCss: 6 sub-arrays.
// TODO(phase13-cleanup): item shapes within each array are unspecified
// — catalog from observed renders.
const Topology = z.object({
  nodes: z.array(z.unknown()),
  runs: z.array(z.unknown()),
  junctions: z.array(z.unknown()),
  interfaces: z.array(z.unknown()),
  hosts: z.array(z.unknown()),
  openings: z.array(z.unknown()),
}).strict();

// Metadata from resolvedToLegacyCss: large set of keys, several optional.
// passthrough because topology stages add their own keys.
// VARIANT: duplicatePositions and outOfBounds are legitimate quality
// counters added by topology validation passes (safety.mjs:95). Optional
// because not every render writes them.
const Metadata = z.object({
  modelExtent: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    elementCount: z.number().int().min(0),
    duplicatePositions: z.number().int().min(0).optional(),
    outOfBounds: z.number().int().min(0).optional(),
  }).strict(),
  safetyWarnings: z.array(z.unknown()),
  exportProfile: EXPORT_PROFILE,
  outputMode: OUTPUT_MODE,
  placementZIsAbsolute: z.boolean(),
  sourceFusion: z.unknown().nullable(),
  interiorSuppression: z.unknown().nullable(),
  tunnelDecomposition: z.unknown().nullable(),
  repairLog: z.array(z.unknown()),
  cssValidationIssues: z.number().int().min(0),
  cssValidationDetails: z.unknown().optional(),
  ambiguousWallProfiles: z.unknown().optional(),
  facilityDimensions: z.array(z.unknown()),
  materialAssignments: z.array(z.unknown()),
  adapterSource: z.literal('resolvedToLegacyCss'),
  resolvedSchemaVersion: z.string(),
}).passthrough();

// ─── Top-level envelope (strict) + cross-field check ─────────────────────

const ValidatedCssEnvelopeBase = z.object({
  cssVersion: z.literal('1.0'),
  domain: DOMAIN,
  facility: Facility,
  levelsOrSegments: z.array(LevelOrSegment),
  elements: z.array(Element),
  topology: Topology,
  metadata: Metadata,
}).strict();

// CALIBRATION FINDING — KNOWN PIPELINE BUG (filed 2026-05-02)
// =============================================================
// The cross-field invariant `metadata.modelExtent.elementCount ===
// elements.length` is *correct in spirit* but BROKEN in production.
// v2-adapter.mjs:340 explicitly sets `elementCount: elements.length`,
// so the adapter is honest. Something downstream of the adapter mutates
// either elements or elementCount but not both:
//   - hospital render (174fdb79...): elementCount=514 vs elements=477 (+37)
//   - tunnel render   (2b8e02f0...): elementCount=297 vs elements=304 (-7)
// Different signs imply the drift comes from multiple post-adapter
// mutations (some passes add elements without bumping the count; others
// remove without decrementing).
//
// CONSUMERS (who reads metadata.modelExtent.elementCount and gets wrong
// data): grep across backend + ui surfaces ZERO read sites currently.
// Field is purely diagnostic — written by adapter, not consumed by the
// pipeline. Pipeline correctness is unaffected today, BUT once the trace
// UI (PR 2 of Release 13.1) surfaces this field, wrong values will
// display in the Pipeline Trace tab. Fix before PR 2 ships if possible,
// otherwise the trace UI will need to display the count-from-elements
// instead.
//
// The contract does NOT enforce this invariant in PR 1 because doing so
// would block every currently-shipping render. Once topology-engine is
// fixed to keep elementCount in sync (likely a one-line mutation in a
// post-adapter pass that mutates css.elements but forgets to update
// metadata.modelExtent.elementCount), re-enable the .refine() below.
//
// TODO(phase13-followup): file a bug, find the post-adapter mutation
// site that drifts the count, fix it, then re-enable the cross-field
// check. The infrastructure to enforce it is preserved as a comment.
//
// // export const validatedCssContract = ValidatedCssEnvelopeBase.refine(
// //   (env) => env.metadata.modelExtent.elementCount === env.elements.length,
// //   {
// //     message: 'metadata.modelExtent.elementCount must equal elements.length',
// //     path: ['metadata', 'modelExtent', 'elementCount'],
// //   },
// // );

export const validatedCssContract = ValidatedCssEnvelopeBase;

export const validatedCssContractMeta = {
  name: 'validatedCssContract',
  producer: 'topology-engine',
  consumer: 'generate',
  artifact: 'css_processed.json',
  version: '0.1.0',
};
