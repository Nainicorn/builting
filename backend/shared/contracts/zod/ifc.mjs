// ifcContract — validate the StoreIFC step's assembled input event.
//
// IMPORTANT: This does NOT validate generate's raw return value.
// The Step Function's StoreIFC state uses explicit Parameters to assemble
// the store input from multiple upstream stages:
//
//   $.renderId / $.userId / $.bucket        — initial input
//   $.ifcResult.*                           — generate output (ResultPath: "$.ifcResult")
//   $.specResult.*                          — extract output
//   $.topologyResult.*                      — topology-engine output
//   $.metadata.render.render_revision       — read output
//
// Only fields listed in StoreIFC.Parameters exist in the store event.
// Fields generate returns but does NOT forward: ifcGenerated, ifcValid,
// ifcSizeBytes, bbox, orientationWarnings, status, tunnelShellReport.
//
// Audit trail:
//   StoreIFC Parameters  — builting-state-machine definition
//   store destructure    — builting-store/index.mjs:18

import { z } from 'zod';

// ─── Sub-schemas ─────────────────────────────────────────────────────────

// VARIANT: generate emits {s3Key, sizeBytes} per export format.
const ExportFileEntry = z.object({
  s3Key: z.string(),
  sizeBytes: z.number().int().min(0),
}).strict();

const ValidationSummary = z.object({
  valid: z.boolean(),
  errorCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  proxyCount: z.number().int().min(0),
  proxyReasons: z.record(z.number().int().min(0)),
  styleTierTotals: z.record(z.number().int().min(0)),
  genericNameCount: z.number().int().min(0),
  totalElements: z.number().int().min(0),
  revitCompatScore: z.number().int().min(0).max(100),
}).strict();

// ─── Top-level envelope ───────────────────────────────────────────────────
// Not strict: pipeline version changes may add/remove Step Function parameters.

export const ifcContract = z.object({
  // From initial Step Function input
  renderId: z.string(),
  userId: z.string(),
  bucket: z.string(),

  // From generate ($.ifcResult.*)
  ifcS3Path: z.string().regex(/^s3:\/\/[^/]+\/.+$/, 'expected s3://bucket/key URI'),
  elementCounts: z.record(z.number().int().min(0)),
  outputMode: z.enum(['HYBRID', 'METADATA_ONLY', 'GEOMETRY_ONLY']),
  cssHash: z.string(),
  validationSummary: ValidationSummary,
  sourceFusion: z.unknown().nullable(),
  structuralWarnings: z.array(z.unknown()),
  exportFormats: z.array(z.string()),
  // VARIANT: values are {s3Key, sizeBytes} objects, not plain strings.
  exportFiles: z.record(ExportFileEntry),

  // From extract ($.specResult.*)
  ai_generated_title: z.string(),
  ai_generated_description: z.string(),
  tracingReport: z.record(z.unknown()),
  refinementReport: z.unknown().nullable(),
  refinementReportS3Key: z.string().nullish(),

  // From topology-engine ($.topologyResult.*)
  readinessScore: z.number().nullish(),
  exportReadiness: z.unknown().optional(),
  authoringSuitability: z.unknown().optional(),
  criticalIssueCount: z.number().int().min(0).nullish(),
  validationWarningCount: z.number().int().min(0).nullish(),
  validationProxyRatio: z.number().nullish(),
  validationReportS3Key: z.string().nullish(),
  generationModeRecommendation: z.string().nullish(),
  readinessDelta: z.unknown().optional(),
  geometryFidelity: z.unknown().optional(),

  // From metadata ($.metadata.render.render_revision)
  renderRevision: z.unknown().optional(),
});

export const ifcContractMeta = {
  name: 'ifcContract',
  producer: 'generate',
  consumer: 'store',
  artifact: 'event-payload',
  version: '0.2.0',
};
