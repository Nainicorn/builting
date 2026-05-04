// cssRawContract — extract → topology (geometry-path direct, NOT via resolve).
// Validates css_raw.json. Documents the schema as currently produced; no
// cleanup.
//
// Important: extract emits cssRaw from MULTIPLE code paths (VSM parser at
// extract/index.mjs:1283, BuildingSpec converter at :1722, general building
// at :2947), and each path adds its own metadata fields. The contract therefore
// uses passthrough() on `metadata` and `element.metadata` so path-specific
// fields don't trigger spurious rejections. Top-level envelope is still strict.
//
// PR 1 captures the schema warts-included. Each TODO names a follow-up
// PR that will tighten the constraint. Do not "fix" anything in this file
// outside its named PR.
//
// Audit trail (where each constant came from):
//   write site            — extract/index.mjs:511 (saveCSSToS3)
//   VSM-parser css        — extract/index.mjs:1283
//   BuildingSpec css      — extract/index.mjs:1722
//   general-building css  — extract/index.mjs:2947
//   element shape         — extract/index.mjs:938 (representative push)

import { z } from 'zod';

// ─── Closed enums ────────────────────────────────────────────────────────

// VARIANT: 'ARCH' is legitimate (hospital render). See claims.mjs.
const DOMAIN = z.enum(['UNKNOWN', 'TUNNEL', 'BUILDING', 'CIVIL', 'MIXED', 'ARCH']);
// NOTE: claims/canonical default to 'UNKNOWN'; validatedCss defaults to
// 'BUILDING'. cssRaw can be either, depending on extraction path. See
// claims.mjs for the full footgun comment.

const VALIDATION_STATUS = z.enum(['PENDING', 'VALID', 'INVALID']);
// Observed only PENDING in extract output (validation runs in topology);
// other values reserved for future expansion.

const OUTPUT_MODE = z.enum(['HYBRID', 'METADATA_ONLY', 'GEOMETRY_ONLY']);
// TODO(phase13-cleanup): only HYBRID observed in extract output. Remaining
// modes are set in topology/generate. cssRaw probably only ever has HYBRID;
// if a future extract path emits a different value, tighten the enum.

const PARSE_STATUS = z.enum(['success', 'failed', 'low_confidence', 'unsupported']);

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

const Facility = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
  // TODO(phase13-cleanup): hardcoded 'M' here (and in claims). normalize
  // upstream is unreachable.
  units: z.literal('M'),
  // crs is `null` in every observed extract path (e.g. extract/index.mjs:1291).
  // Documented as nullable in case a future path populates it.
  crs: z.string().nullable(),
  origin: Vec3,
  axes: z.literal('RIGHT_HANDED_Z_UP'),
}).strict();

// DEBT: every element should carry a complete material (or none). Some
// extract paths emit `material: { name }` without color/transparency;
// downstream code fills defaults. Right cleanup is to populate defaults
// at extract time so all material objects are fully shaped.
// TODO(phase13-cleanup): fill material defaults in extract; tighten here.
const Material = z.object({
  name: z.string(),
  color: z.array(z.number()).length(3).optional(),
  transparency: z.number().min(0).max(1).optional(),
}).strict();

// VARIANT (axis/refDirection): some element types legitimately have only
// an origin point — no orientation needed. Optional permanently.
// DEBT (direction extra): spec-instance emitter adds an extra `direction`
// field to placement instead of using axis/refDirection. Right cleanup
// is to migrate the emitter to use the canonical {axis, refDirection}.
// TODO(phase13-cleanup): migrate spec-instance emitter; tighten to
// passthrough-removed once done.
const Placement = z.object({
  origin: Vec3,
  axis: Vec3.optional(),
  refDirection: Vec3.optional(),
}).passthrough();

// Geometry is path-shaped: extracted geometry for tunnel segments has
// {profile, depth, direction, ...}; building elements may have
// {profile, depth, vertices, faces}; etc. Many optional keys.
// passthrough is correct here.
const Geometry = z.object({
  // method is sometimes set by extract (e.g. 'EXTRUSION'), sometimes not
  // (filled by topology). Keep optional.
  method: z.string().optional(),
  profile: z.unknown().optional(),
  depth: z.number().nullable().optional(),
}).passthrough();
// TODO(phase13-cleanup): catalog observed geometry shapes per element type
// (TUNNEL_SEGMENT, DUCT, WALL, etc.) and tighten with discriminated unions.

const Relationship = z.object({
  type: z.string(),
  target: z.string(),
}).strict();
// TODO(phase13-cleanup): relationship types observed in resolve.mjs:454
// ('HOSTED_BY', 'FILLS', 'ADJACENT_TO', 'MEMBER_OF') but extract may emit
// others. Tighten when actual usage is catalogued.

// Element shape varies across extract paths; the union of observed fields
// is large. Required fields are the structural minimum every path emits.
const Element = z.object({
  id: z.string(),
  element_key: z.string().optional(),
  type: z.string(),
  semanticType: z.string().optional(),
  name: z.string(),
  placement: Placement.nullable(),
  geometry: Geometry.nullable(),
  container: z.string().nullable().optional(),
  // VARIANT: relationships is genuinely sometimes-empty/sometimes-absent.
  // Many element types have no inherent relationships at extract time
  // (DOOR before host-wall is known, etc.). Topology fills empty arrays
  // for downstream uniformity. Optional permanently.
  relationships: z.array(Relationship).optional(),
  properties: z.record(z.unknown()),
  // DEBT: every element should carry material; DOOR elements omit it.
  // Topology fills a default at v2-adapter.mjs:308 for downstream stages,
  // but cssRaw is upstream of that and shows the gap. Right cleanup is
  // for extract to default a material on every element.
  material: Material.optional(),
  confidence: z.number().min(0).max(1),
  // `source` is a free string in extract: 'VSM', 'LLM', 'DXF', 'VISION', etc.
  // No closed enum because extract paths add their own values; tighten in
  // PR 3 along with the provenance migration.
  source: z.string(),
  sourceFile: z.string().nullable().optional(),
  // metadata.evidence and topology-engine annotations land here; passthrough.
  metadata: z.record(z.unknown()).optional(),
}).passthrough();
// DEBT: element extras 'description', 'psets', 'materials' come from
// extract paths that should be using the existing canonical fields
// (`metadata`, `material`, `properties`) instead of inventing new keys.
// Right cleanup is to migrate each extra to its canonical field.
// TODO(phase13-cleanup): migrate each extras source path; tighten Element
// to .strict() once migrated.

const SourceFileEntry = z.object({
  name: z.string(),
  parseStatus: PARSE_STATUS,
  // TODO(phase13-cleanup): `role` is not the same field as claims.json's
  // `sourceRole`. Two stages, two field names for similar concepts. PR 3
  // will reconcile during the provenance migration; for now the contract
  // documents the divergence.
  role: z.string(),
  reason: z.string().optional(),
  sourceRole: z.string().optional(),
  imageType: z.string().optional(),
  page: z.number().optional(),
}).strict();

const ElementCounts = z.record(z.number().int().min(0));

// LevelsOrSegments items vary: the segment shape (from VSM tunnel parser)
// vs the level shape (from BuildingSpec) have different fields entirely.
// passthrough. TODO(phase13-cleanup): split into a discriminated union.
const LevelOrSegment = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
}).passthrough();

// ─── Metadata: passthrough by design ─────────────────────────────────────

// metadata is genuinely extensible per extract code path. Required core
// fields are the intersection across all observed paths; passthrough allows
// path-specific additions:
//   - VSM path adds: tunnelExtractionAudit, extractBuild
//   - BuildingSpec path adds: structureClass, topologyConfidence
//   - general-building path adds: envelopeFallbackApplied, interiorSuppression,
//                                 skippedRooms, skippedOpenings
// TODO(phase13-cleanup): catalog all observed metadata fields and tighten
// to a discriminated union by extract-path tag.
const Metadata = z.object({
  sourceFiles: z.array(SourceFileEntry),
  outputMode: OUTPUT_MODE,
  validationStatus: VALIDATION_STATUS,
  unitNormalizationApplied: z.boolean(),
  cssHash: z.string().nullable(),
  elementCounts: ElementCounts,
  bbox: Bbox,
  // repairLog observed in 2/3 paths but not always — keep optional.
  repairLog: z.array(z.unknown()).optional(),
}).passthrough();

// ─── Top-level envelope (strict) ─────────────────────────────────────────

const CssRawEnvelopeBase = z.object({
  cssVersion: z.literal('1.0'),
  domain: DOMAIN,
  facility: Facility,
  levelsOrSegments: z.array(LevelOrSegment),
  elements: z.array(Element),
  metadata: Metadata,
}).strict();

// CALIBRATION FINDING — KNOWN PIPELINE BUG (filed 2026-05-02)
// =============================================================
// Same bug class as validatedCss elementCount drift. Extract emits
// metadata.elementCounts at one point in its run (e.g. index.mjs:1283),
// then later passes (spec-instance emitter, ifc_enrichment, etc.) add
// MORE elements without updating elementCounts. Tunnel cssRaw observed:
//   elementCounts sums to 160; elements.length=252; missing types
//   entirely (SPACE, DUCT_FITTING, SLAB).
// Hospital cssRaw is consistent — bug is path-specific to extract paths
// that run multi-stage element accumulation.
//
// CONSUMERS (who reads metadata.elementCounts and gets wrong data):
//   - topology-engine/validation.mjs:207 OVERWRITES it from elements,
//     so the stale value is masked within the pipeline (self-healing).
//   - Direct readers of cssRaw.json (debug tools, future PR 7 diagnostics
//     ZIP, manual S3 inspection, anything that displays "X elements
//     extracted by extract").
//   - extract/index.mjs:1321 reads `elementCounts` for tunnelExtractionAudit
//     (audit logs the wrong total).
// Net: pipeline correctness is unaffected because of the overwrite at
// validation.mjs; diagnostic and audit output is wrong.
//
// Cross-field check disabled until extract is fixed to recompute
// elementCounts at write time. Preserved as commented scaffolding.
//
// TODO(phase13-followup): file a bug, find each extract path that
// appends to css.elements after the initial elementCounts compute, then
// either move elementCounts compute to immediately-before-write OR have
// each appender update it. Re-enable check below.
//
// // export const cssRawContract = CssRawEnvelopeBase.refine(
// //   (env) => {
// //     const sum = Object.values(env.metadata.elementCounts).reduce((a, b) => a + b, 0);
// //     return sum === env.elements.length;
// //   },
// //   {
// //     message: 'sum(metadata.elementCounts) must equal elements.length',
// //     path: ['metadata', 'elementCounts'],
// //   },
// // );

export const cssRawContract = CssRawEnvelopeBase;

export const cssRawContractMeta = {
  name: 'cssRawContract',
  producer: 'extract',
  consumer: 'topology-engine',
  artifact: 'css_raw.json',
  version: '0.1.0',
};
