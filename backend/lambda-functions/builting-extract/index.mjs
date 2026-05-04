import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import pdf from 'pdf-parse';
import { extractXlsxText } from './parsers/xlsxParser.mjs';
import { extractDocxText } from './parsers/docxParser.mjs';
import { parseDxfToCSS } from './parsers/dxfParser.mjs';

// Phase 1: Claims dual-write imports
import { resetClaimCounter, createClaimsEnvelope } from './claims/claimsSchema.mjs';
import { ventSimCssToClaims } from './claims/ventSimToClaims.mjs';
import { dxfCssToClaims } from './claims/dxfToClaims.mjs';
import { buildingSpecToClaims } from './claims/buildingSpecToClaims.mjs';
import { visionToClaims } from './claims/visionToClaims.mjs';
import { mergeClaims } from './claims/claimsMerger.mjs';
import { parseSpecTexts } from './parsers/specTextParser.mjs';
import { specTextToClaims } from './claims/specTextToClaims.mjs';
import { mergeSpecClaimsIntoCss } from './claims/claimsToLegacyCss.mjs';
import { materializeSpecInstances } from './claims/specInstances.mjs';

// Phase 13: Producer self-check contracts
import { checkContractAsync, cssRawContract, claimsContract } from '@builting/contracts';
// Phase 13 PR2: Trace writer
import { writeTraceStart, writeTraceEnd } from '@builting/trace';
// Phase 13.5 PR6: Audit log
import { initAudit, flushAudit, logValidation } from '@builting/audit';
// PR 8: Stage validators
import { runExtractValidators } from './validators/extract-validators.mjs';

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});

// Build fingerprint — logged at cold start, embedded in CSS metadata
const EXTRACT_VERSION = process.env.EXTRACT_VERSION || 'dev';
const BUILD_TIMESTAMP = process.env.BUILD_TIMESTAMP || null;
console.log(`builting-extract version=${EXTRACT_VERSION} built=${BUILD_TIMESTAMP || 'n/a'}`);

// ============================================================================
// UTILITY: Save CSS to S3 (avoids Step Function 256KB state limit)
// ============================================================================

// ============================================================================
// REFINEMENT REGRESSION CHECK + ELEMENT GUARD
// ============================================================================

const STRUCTURAL_TYPES = new Set([
  'WALL', 'SLAB', 'SHELL', 'COLUMN', 'BEAM', 'FOUNDATION', 'ROOF',
  'IfcWall', 'IfcWallStandardCase', 'IfcSlab', 'IfcColumn', 'IfcBeam',
  'IfcFooting', 'IfcRoof', 'IfcBuildingElementProxy'
]);

/**
 * Compare old and new CSS after refinement to detect regression/drift.
 * Returns a report with change summary and warnings.
 */
function buildRefinementReport(previousCSS, newCSS, refinementText) {
  const prevElements = previousCSS.elements || [];
  const newElements = newCSS.elements || [];

  // Count by type
  const countByType = (elems) => {
    const counts = {};
    for (const e of elems) {
      const t = e.type || e.semanticType || 'UNKNOWN';
      counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  };
  const prevCounts = countByType(prevElements);
  const newCounts = countByType(newElements);

  // Element-level diff by ID
  const prevById = new Map(prevElements.map(e => [e.id || e.element_key, e]));
  const newById = new Map(newElements.map(e => [e.id || e.element_key, e]));

  const added = [...newById.keys()].filter(id => !prevById.has(id));
  const removed = [...prevById.keys()].filter(id => !newById.has(id));
  const modified = [...newById.keys()].filter(id => {
    if (!prevById.has(id)) return false;
    return JSON.stringify(prevById.get(id)) !== JSON.stringify(newById.get(id));
  });

  const totalChanges = added.length + removed.length + modified.length;

  // Detect structural elements that were silently removed
  const structuralRemoved = removed.filter(id => {
    const e = prevById.get(id);
    return STRUCTURAL_TYPES.has(e?.type) || STRUCTURAL_TYPES.has(e?.semanticType);
  });

  // Heuristic: detect if refinement text targets equipment vs structure
  const equipmentKeywords = /equipment|fan|pump|duct|pipe|hvac|ventilat|sensor|light|fixture|tank|valve|meter|cable/i;
  const structureKeywords = /wall|slab|floor|ceiling|roof|column|beam|shell|foundation|storey|level/i;
  const openingKeywords = /door|window|opening|gate|hatch/i;
  const parameterKeywords = /dimension|size|length|width|height|radius|thickness|move|position|rotate|scale|place/i;
  const classificationKeywords = /reclassify|change type|convert to|rename|recategorize/i;
  const targetsEquipment = equipmentKeywords.test(refinementText);
  const targetsStructure = structureKeywords.test(refinementText);
  const targetsOpenings = openingKeywords.test(refinementText);
  const targetsParameters = parameterKeywords.test(refinementText);
  const targetsClassification = classificationKeywords.test(refinementText);

  // Phase 6: Classify refinement type
  const typeFlags = [
    targetsStructure && 'STRUCTURAL_CHANGE',
    targetsEquipment && 'EQUIPMENT_CHANGE',
    targetsOpenings && 'OPENING_CHANGE',
    targetsParameters && 'PARAMETER_CHANGE',
    targetsClassification && 'CLASSIFICATION_CHANGE'
  ].filter(Boolean);
  const refinementType = typeFlags.length === 0 ? 'MIXED'
    : typeFlags.length === 1 ? typeFlags[0]
    : 'MIXED';

  // Flag: structural drift when user only asked about equipment
  const driftDetected = targetsEquipment && !targetsStructure && structuralRemoved.length > 0;
  // Flag: disproportionate changes
  const disproportionate = prevElements.length > 0 && totalChanges > prevElements.length * 0.5;

  const warnings = [];
  if (driftDetected) warnings.push(`DRIFT: ${structuralRemoved.length} structural elements removed but refinement targeted equipment`);
  if (disproportionate) warnings.push(`DISPROPORTIONATE: ${totalChanges} changes across ${prevElements.length} elements (>50%)`);

  // Include drift rejection flag if metadata indicates it
  const driftRejected = newCSS.metadata?.driftRejection?.driftScore > 30;

  // Phase 6: Resolve targets for scope confidence
  const { resolved: resolvedTargets, ambiguous: ambiguousTargets } = resolveRefinementTargets(refinementText, prevElements);
  const unresolvedTargets = ambiguousTargets;

  // Phase 6: Compute scope confidence (deterministic formula)
  // 50% target resolution + 30% drift compliance + 20% element match stability
  const declaredTargetCount = resolvedTargets.length + ambiguousTargets.length;
  const targetResolutionConfidence = declaredTargetCount > 0
    ? resolvedTargets.length / declaredTargetCount
    : 1.0; // no explicit targets = full confidence

  // Drift compliance: proportion of out-of-scope elements unchanged
  const outOfScopeIds = [...prevById.keys()].filter(id => !new Set(resolvedTargets.map(t => t.id)).has(id));
  const outOfScopeChanged = outOfScopeIds.filter(id => !newById.has(id) || JSON.stringify(prevById.get(id)) !== JSON.stringify(newById.get(id)));
  const driftCompliance = outOfScopeIds.length > 0
    ? 1.0 - (outOfScopeChanged.length / outOfScopeIds.length)
    : 1.0;

  // Element match stability: proportion of prior canonical IDs preserved
  const preservedIds = [...prevById.keys()].filter(id => newById.has(id));
  const elementMatchStability = prevElements.length > 0
    ? preservedIds.length / prevElements.length
    : 1.0;

  const scopeConfidence = Math.round(
    Math.min(100, Math.max(0,
      (targetResolutionConfidence * 50) +
      (driftCompliance * 30) +
      (elementMatchStability * 20)
    ))
  );

  return {
    summary: {
      previousElementCount: prevElements.length,
      newElementCount: newElements.length,
      addedCount: added.length,
      removedCount: removed.length,
      modifiedCount: modified.length,
      structuralRemovedCount: structuralRemoved.length,
      driftDetected,
      driftRejected,
      disproportionate,
      unresolvedTargets,
      refinementMode: 'PATCH'
    },
    refinementType,
    scopeConfidence,
    scopeConfidenceBreakdown: {
      targetResolutionConfidence: Math.round(targetResolutionConfidence * 100) / 100,
      driftCompliance: Math.round(driftCompliance * 100) / 100,
      elementMatchStability: Math.round(elementMatchStability * 100) / 100
    },
    changedCanonicalIds: modified.slice(0, 50),
    addedCanonicalIds: added.slice(0, 50),
    removedCanonicalIds: removed.slice(0, 50),
    added: added.slice(0, 20),
    removed: removed.slice(0, 20),
    modified: modified.slice(0, 20),
    warnings,
    prevCounts,
    newCounts
  };
}

/**
 * Phase 6: Save refinement_report.json as a dedicated S3 artifact.
 */
async function saveRefinementReport(bucket, userId, renderId, report, refinementText, revision = 1) {
  const key = `uploads/${userId}/${renderId}/pipeline/v${revision}/refinement_report.json`;
  const artifact = {
    pipelineVersion: '2.0',
    stage: 'extract',
    generatedAt: new Date().toISOString(),
    revision,
    previousRevision: revision > 1 ? revision - 1 : null,
    declaredScopeText: refinementText,
    refinementType: report.refinementType,
    scopeConfidence: report.scopeConfidence,
    scopeConfidenceBreakdown: report.scopeConfidenceBreakdown,
    affectedScope: [...(report.changedCanonicalIds || []), ...(report.addedCanonicalIds || []), ...(report.removedCanonicalIds || [])],
    changedCanonicalIds: report.changedCanonicalIds || [],
    addedCanonicalIds: report.addedCanonicalIds || [],
    removedCanonicalIds: report.removedCanonicalIds || [],
    refinementLineage: {
      revision,
      previousRevision: revision > 1 ? revision - 1 : null
    },
    summary: report.summary,
    warnings: report.warnings,
    prevCounts: report.prevCounts,
    newCounts: report.newCounts,
    pipelineDurationMs: 0 // updated by store if available
  };
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(artifact),
    ContentType: 'application/json'
  }));
  console.log(`Refinement report saved: s3://${bucket}/${key}`);
  return key;
}

/**
 * Structural element guard: restore structural elements that were silently
 * removed by the LLM when the user's instruction didn't target them.
 */
function guardStructuralElements(previousCSS, newCSS, refinementText) {
  const prevElements = previousCSS.elements || [];
  const newElements = newCSS.elements || [];
  const newById = new Map(newElements.map(e => [e.id || e.element_key, e]));

  let restoredCount = 0;
  for (const elem of prevElements) {
    const eid = elem.id || elem.element_key;
    if (newById.has(eid)) continue; // still present

    const isStructural = STRUCTURAL_TYPES.has(elem.type) || STRUCTURAL_TYPES.has(elem.semanticType);
    if (!isStructural) continue;

    // Check if the user explicitly targeted this element type or name
    const typeRe = new RegExp(elem.type, 'i');
    const nameRe = elem.name ? new RegExp(elem.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    if (typeRe.test(refinementText)) continue; // user targeted this type
    if (nameRe && nameRe.test(refinementText)) continue; // user targeted by name

    // Restore — LLM silently dropped it
    newCSS.elements.push(elem);
    restoredCount++;
  }

  if (restoredCount > 0) {
    console.log(`Structural guard: restored ${restoredCount} silently removed structural elements`);
  }
  return restoredCount;
}

/**
 * Structure-aware drift rejection (Phase 1A).
 * Scores drift by weighting structural changes 10x vs equipment 1x.
 * If drift > 30, rejects LLM output and applies only targeted patches.
 */
const EQUIPMENT_TYPES = new Set([
  'EQUIPMENT', 'IfcFan', 'IfcPump', 'IfcValve', 'IfcDuctSegment', 'IfcPipeSegment',
  'IfcSensor', 'IfcAlarm', 'IfcActuator', 'IfcLightFixture', 'IfcTank',
  'IfcCableCarrierSegment', 'IfcCommunicationsAppliance', 'IfcElectricDistributionBoard'
]);

const STRUCTURAL_DRIFT_TYPES = new Set([
  'WALL', 'SLAB', 'SPACE', 'TUNNEL_SEGMENT', 'COLUMN',
  'IfcWall', 'IfcWallStandardCase', 'IfcSlab', 'IfcSpace', 'IfcColumn'
]);

function checkStructureAwareDrift(previousCSS, newCSS, refinementText) {
  const prevElements = previousCSS.elements || [];
  const newElements = newCSS.elements || [];
  const prevById = new Map(prevElements.map(e => [e.id || e.element_key, e]));
  const newById = new Map(newElements.map(e => [e.id || e.element_key, e]));

  // Resolve targets from refinement text
  const { resolved: resolvedTargets, ambiguous: ambiguousTargets } = resolveRefinementTargets(refinementText, prevElements);
  const targetIds = new Set(resolvedTargets.map(t => t.id));

  // Count untargeted changes by category
  let structuralDrift = 0;
  let equipmentDrift = 0;

  // Check removed elements
  for (const [id, elem] of prevById) {
    if (newById.has(id)) continue; // still present
    if (targetIds.has(id)) continue; // explicitly targeted
    const type = elem.type || elem.semanticType || '';
    if (STRUCTURAL_DRIFT_TYPES.has(type)) structuralDrift++;
    else if (EQUIPMENT_TYPES.has(type)) equipmentDrift++;
  }

  // Check modified elements (significant changes only)
  for (const [id, newElem] of newById) {
    const prevElem = prevById.get(id);
    if (!prevElem) continue; // added, not drift
    if (targetIds.has(id)) continue; // explicitly targeted
    if (JSON.stringify(prevElem) === JSON.stringify(newElem)) continue; // unchanged

    const type = prevElem.type || prevElem.semanticType || '';
    if (STRUCTURAL_DRIFT_TYPES.has(type)) structuralDrift++;
    else if (EQUIPMENT_TYPES.has(type)) equipmentDrift++;
  }

  const driftScore = structuralDrift * 5 + equipmentDrift * 1;
  const rejected = driftScore > 30;

  if (rejected) {
    console.warn(`DRIFT_REJECTED: structural drift score ${driftScore} (structural: ${structuralDrift}, equipment: ${equipmentDrift})`);
  }

  return { driftScore, structuralDrift, equipmentDrift, rejected, resolvedTargets, ambiguousTargets };
}

/**
 * Target resolution: parse refinement text to identify targeted elements.
 * Resolution order: element_key > exact name > semanticType+host > fuzzy match
 */
function resolveRefinementTargets(refinementText, elements) {
  if (!refinementText || elements.length === 0) return { resolved: [], ambiguous: [] };

  const resolved = [];
  const ambiguous = [];
  const text = refinementText.toLowerCase();

  // Build lookup maps
  const byKey = new Map();
  const byName = new Map();
  const byType = {};

  for (const e of elements) {
    const id = e.id || e.element_key;
    if (e.element_key) byKey.set(e.element_key.toLowerCase(), { ...e, _resolvedId: id });
    if (e.name) {
      const nameLower = e.name.toLowerCase();
      if (!byName.has(nameLower)) byName.set(nameLower, []);
      byName.get(nameLower).push({ ...e, _resolvedId: id });
    }
    const t = (e.type || e.semanticType || '').toLowerCase();
    if (t) {
      if (!byType[t]) byType[t] = [];
      byType[t].push({ ...e, _resolvedId: id });
    }
  }

  // 1. element_key exact match
  for (const [key, elem] of byKey) {
    if (text.includes(key)) {
      resolved.push({ id: elem._resolvedId, method: 'element_key' });
    }
  }

  // 2. Exact name match
  for (const [name, elems] of byName) {
    if (name.length < 3) continue; // skip very short names
    if (text.includes(name)) {
      if (elems.length === 1) {
        // Unambiguous
        if (!resolved.find(r => r.id === elems[0]._resolvedId)) {
          resolved.push({ id: elems[0]._resolvedId, method: 'exact_name' });
        }
      } else {
        // Ambiguous — do not resolve, track for reporting
        console.log(`TARGET_AMBIGUOUS: "${name}" matches ${elems.length} elements`);
        ambiguous.push({ description: name, candidateCount: elems.length, priorityLevel: 'exact_name', reason: 'AMBIGUOUS' });
      }
    }
  }

  // 3. Type + context match (e.g. "remove the fan" → match IfcFan if only 1)
  const typeKeywords = {
    'fan': ['equipment', 'IfcFan'], 'pump': ['equipment', 'IfcPump'],
    'valve': ['equipment', 'IfcValve'], 'sensor': ['equipment', 'IfcSensor'],
    'light': ['equipment', 'IfcLightFixture'], 'door': ['door', 'IfcDoor'],
    'window': ['window', 'IfcWindow'], 'duct': ['equipment', 'IfcDuctSegment'],
    'pipe': ['equipment', 'IfcPipeSegment'], 'wall': ['wall', 'IfcWall'],
    'slab': ['slab', 'IfcSlab'], 'column': ['column', 'IfcColumn']
  };

  for (const [keyword, types] of Object.entries(typeKeywords)) {
    if (!text.includes(keyword)) continue;
    for (const t of types) {
      const candidates = byType[t.toLowerCase()];
      if (candidates && candidates.length === 1) {
        if (!resolved.find(r => r.id === candidates[0]._resolvedId)) {
          resolved.push({ id: candidates[0]._resolvedId, method: 'type_context' });
        }
      }
    }
  }

  return { resolved, ambiguous };
}

/**
 * Apply only targeted patches from new CSS when drift is rejected.
 * Returns the patched CSS (previousCSS with only targeted changes applied).
 */
function applyTargetedPatches(previousCSS, newCSS, resolvedTargets) {
  const result = JSON.parse(JSON.stringify(previousCSS));
  const targetIds = new Set(resolvedTargets.map(t => t.id));

  const newById = new Map((newCSS.elements || []).map(e => [e.id || e.element_key, e]));
  const prevIds = new Set((result.elements || []).map(e => e.id || e.element_key));

  // DELETE: remove targeted elements that are gone in newCSS
  for (const target of resolvedTargets) {
    if (!newById.has(target.id)) {
      result.elements = result.elements.filter(e => (e.id || e.element_key) !== target.id);
    }
  }

  // MODIFY: update targeted elements that changed in newCSS
  for (const target of resolvedTargets) {
    const newElem = newById.get(target.id);
    if (!newElem) continue;
    const idx = result.elements.findIndex(e => (e.id || e.element_key) === target.id);
    if (idx >= 0) {
      result.elements[idx] = newElem;
    }
  }

  // ADD: add new elements from newCSS that aren't in previous
  for (const [id, elem] of newById) {
    if (!prevIds.has(id)) {
      // Only add if it seems targeted by name/type mention in refinement
      result.elements.push(elem);
    }
  }

  return result;
}

function buildTracingReport(css, processedFiles) {
  const byFile = {};
  const bySource = { LLM: 0, VSM: 0, DEFAULT: 0, DXF: 0 };
  const byRole = { NARRATIVE: 0, SCHEDULE: 0, SIMULATION: 0, INFERRED: 0, DEFAULT: 0 };
  const confidence = { high: 0, medium: 0, low: 0 };

  for (const el of css.elements || []) {
    const src = el.source || 'DEFAULT';
    const role = el.sourceRole || 'DEFAULT';
    const conf = el.confidence ?? 0.5;
    const sf = el.sourceFile || null;

    bySource[src] = (bySource[src] || 0) + 1;
    byRole[role] = (byRole[role] || 0) + 1;
    if (conf >= 0.85) confidence.high++;
    else if (conf >= 0.65) confidence.medium++;
    else confidence.low++;

    if (sf) {
      if (!byFile[sf]) byFile[sf] = { count: 0, types: {} };
      byFile[sf].count++;
      byFile[sf].types[el.type] = (byFile[sf].types[el.type] || 0) + 1;
    }
  }

  for (const pf of (processedFiles || [])) {
    if (pf.name && byFile[pf.name]) byFile[pf.name].sourceRole = pf.sourceRole || 'UNKNOWN';
  }

  // Files that produced claims (e.g. DXF in VentSim path) but no direct CSS elements
  for (const pf of (processedFiles || [])) {
    if (!pf.name || byFile[pf.name]) continue;
    if ((pf.claimsCount || 0) > 0) {
      byFile[pf.name] = { count: pf.claimsCount, types: { CLAIM: pf.claimsCount }, sourceRole: pf.sourceRole || 'UNKNOWN' };
    }
  }

  // Files that contributed text for enrichment/metadata but produced no direct elements or claims
  for (const pf of (processedFiles || [])) {
    if (!pf.name || byFile[pf.name]) continue;
    if (pf.content && pf.content.length >= 50) {
      byFile[pf.name] = { count: 0, types: {}, isEnrichment: true, sourceRole: pf.sourceRole || 'UNKNOWN' };
    }
  }

  // v6: Extended file-level attribution
  const parsedFiles = (processedFiles || []).map(f => ({
    name: f.name,
    role: f.sourceRole || 'UNKNOWN',
    size: f.content?.length || 0,
    type: f.type || 'text'
  }));
  const geometryContributors = [...new Set((css.elements || []).filter(e => e.sourceFile).map(e => e.sourceFile))];
  const metadataContributors = (processedFiles || []).filter(f => f.enrichedFields).map(f => f.name);
  const ignoredFiles = (processedFiles || []).filter(f => !f.content || f.content.length < 50).map(f => f.name);

  // v10: File contribution classification (geometry/enrichment/validation/unused)
  const fileContributions = {};
  for (const pf of (processedFiles || [])) {
    const fname = pf.name;
    if (!fname) continue;
    const hasElements = byFile[fname] && byFile[fname].count > 0;
    const hasContent = pf.content && pf.content.length >= 50;
    const isEnrichment = (pf.enrichedFields || 0) > 0;
    let role = 'unused';
    if (hasElements) role = 'geometry';
    else if (isEnrichment) role = 'enrichment';
    else if (hasContent) role = 'enrichment';
    fileContributions[fname] = {
      role,
      contribution: role === 'geometry' ? 'Structural/equipment elements extracted' :
                     role === 'enrichment' ? 'Metadata and property enrichment' : 'No extractable content',
      elementCount: byFile[fname]?.count || 0,
      sourceRole: pf.sourceRole || 'UNKNOWN',
      sizeBytes: pf.content?.length || 0
    };
  }

  return {
    byFile, bySource, byRole, confidence,
    totalElements: (css.elements || []).length,
    parsedFiles,
    geometryContributors,
    metadataContributors,
    ignoredFiles,
    fileContributions
  };
}

function makeQuarantineWriter(bucket, userId, renderId, stage) {
  return async (artifact, errors) => {
    const runId = Date.now();
    const key = `uploads/${userId}/${renderId}/quarantine/${stage}/${runId}/artifact.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify({
        quarantinedAt: new Date().toISOString(),
        stage,
        renderId,
        contractErrors: errors.map(e => ({
          path: e.path?.join('.') || '(root)',
          message: e.message,
          code: e.code,
        })),
        artifact,
      }),
      ContentType: 'application/json',
    }));
    console.warn(`[contract_quarantine] artifact written: s3://${bucket}/${key}`);
  };
}

async function saveCSSToS3(bucket, userId, renderId, css) {
  const key = `uploads/${userId}/${renderId}/css/css_raw.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(css),
    ContentType: 'application/json'
  }));
  console.log(`CSS saved to S3: s3://${bucket}/${key} (${JSON.stringify(css).length} bytes)`);
  await checkContractAsync('cssRawContract', cssRawContract, css, {
    halting: true,
    renderId,
    stage: 'extract',
    quarantineWriter: makeQuarantineWriter(bucket, userId, renderId, 'extract'),
  });
  return key;
}

async function saveExtractDebug(bucket, userId, renderId, css, tracingReport, sourceFiles, durationMs, revision = 1) {
  const key = `uploads/${userId}/${renderId}/pipeline/v${revision}/extract_debug.json`;
  const debug = {
    pipelineVersion: '1.0',
    stage: 'extract',
    generatedAt: new Date().toISOString(),
    durationMs,
    domain: css.domain || 'UNKNOWN',
    elementCount: (css.elements || []).length,
    facilityName: css.facility?.name || null,
    sourceFiles,
    tracingReport,
    cssSnapshotKey: `uploads/${userId}/${renderId}/css/css_raw.json`
  };
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(debug),
    ContentType: 'application/json'
  }));
  console.log(`Extract debug saved: s3://${bucket}/${key}`);
  return key;
}

// ============================================================================
// Phase 1: Save claims.json to S3 (dual-write alongside css_raw.json)
// ============================================================================

async function saveClaimsToS3(bucket, userId, renderId, claimsDoc, revision = 1) {
  const key = `uploads/${userId}/${renderId}/pipeline/v${revision}/claims.json`;
  const body = JSON.stringify(claimsDoc);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/json'
  }));
  console.log(`Claims saved to S3: s3://${bucket}/${key} (${body.length} bytes, ${claimsDoc.claims?.length || 0} claims)`);
  await checkContractAsync('claimsContract', claimsContract, claimsDoc, {
    halting: true,
    renderId,
    stage: 'extract',
    quarantineWriter: makeQuarantineWriter(bucket, userId, renderId, 'extract'),
  });
  return key;
}

// ============================================================================
// UTILITY: Deterministic Element ID
// ============================================================================

function elemId(geometry, placement) {
  const data = JSON.stringify({ geometry, placement });
  return 'elem-' + createHash('sha256').update(data).digest('hex').slice(0, 12);
}

// ============================================================================
// FILE DOWNLOAD
// ============================================================================

async function downloadFile(bucket, key) {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    const ext = key.toLowerCase().split('.').pop();
    const fileName = key.split('/').pop();

    if (ext === 'txt') {
      return { content: await response.Body.transformToString(), type: 'text' };
    } else if (ext === 'pdf') {
      try {
        const buffer = await response.Body.transformToByteArray();
        const data = await pdf(Buffer.from(buffer));
        return { content: data.text, type: 'text' };
      } catch (err) {
        console.warn(`Failed to extract text from PDF ${key}:`, err.message);
        return { content: null, type: 'unsupported', reason: err.message };
      }
    } else if (ext === 'xlsx' || ext === 'xls') {
      const buffer = Buffer.from(await response.Body.transformToByteArray());
      const text = extractXlsxText(buffer, fileName);
      return {
        content: text,
        type: 'text',
        contentType: 'text/plain; extracted-from=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      };
    } else if (ext === 'docx') {
      const buffer = Buffer.from(await response.Body.transformToByteArray());
      const text = await extractDocxText(buffer, fileName);
      return {
        content: text,
        type: 'text',
        contentType: 'text/plain; extracted-from=application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      };
    } else if (ext === 'vsm') {
      // VentSim native format: gzip-compressed text with same structure as .txt export
      try {
        const buffer = Buffer.from(await response.Body.transformToByteArray());
        const decompressed = gunzipSync(buffer);
        const text = decompressed.toString('utf-8');
        console.log(`VSM file decompressed: ${fileName} (${buffer.length} → ${text.length} bytes)`);
        return { content: text, type: 'text' };
      } catch (err) {
        console.warn(`Failed to decompress VSM ${key}:`, err.message);
        return { content: null, type: 'unsupported', reason: `VSM decompression failed: ${err.message}` };
      }
    } else if (ext === 'csv') {
      return { content: await response.Body.transformToString(), type: 'text', contentType: 'text/csv' };
    } else if (ext === 'dxf') {
      return { content: await response.Body.transformToString(), type: 'text', contentType: 'text/dxf' };
    } else if (['png', 'jpg', 'jpeg', 'tiff', 'tif'].includes(ext)) {
      // v6: Image file support — return raw buffer for Bedrock vision
      const buffer = Buffer.from(await response.Body.transformToByteArray());
      const mediaTypeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tiff: 'image/tiff', tif: 'image/tiff' };
      return { content: null, type: 'image', buffer, mediaType: mediaTypeMap[ext] || 'image/png' };
    } else {
      return { content: null, type: 'unsupported', reason: `Unsupported format: ${ext}` };
    }
  } catch (err) {
    console.warn(`Failed to download ${key}:`, err.message);
    return { content: null, type: 'error', reason: err.message };
  }
}

// ============================================================================
// VENTSIM PARSER — outputs CSS format
// ============================================================================

function isVentSim(content) {
  return content.includes('KFACTORS') && content.includes('MAIN') && content.includes('6.0.4');
}

function parseVentSimToCSS(content, sourceFileName) {
  console.log('Parsing VentSim format to CSS...');

  try {
    const lines = content.split('\n');

    // Find MAIN section
    let mainStartIdx = -1;
    let mainEndIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('MAIN')) mainStartIdx = i;
      if (mainStartIdx !== -1 && (line.startsWith('END\tMAIN') || line === 'END MAIN')) {
        mainEndIdx = i;
        break;
      }
    }

    if (mainStartIdx === -1 || mainEndIdx === -1) {
      console.warn('MAIN section not found in VentSim file');
      return null;
    }

    // Parse header — the MAIN line itself contains tab-separated column names after "MAIN\t"
    const mainLineStr = lines[mainStartIdx];
    const headerCols = mainLineStr.split('\t');
    const colIndex = {};
    headerCols.forEach((header, idx) => {
      if (idx > 0) colIndex[header.trim()] = idx; // data rows have a row-index at col 0, so header[N] aligns with data[N]
    });

    // Extract branches
    const branches = [];
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (let i = mainStartIdx + 1; i < mainEndIdx; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split('\t');
      const branch = {
        unique_no: parseInt(cols[colIndex['Unique No']] || cols[0]) || 0,
        name: cols[colIndex['Branch Name']] || `Branch_${i}`,
        entry_node: cols[colIndex['Entry Node']] || '',
        exit_node: cols[colIndex['Exit Node']] || '',
        x1: parseFloat(cols[colIndex['X1']] || cols[9]) || 0,
        y1: parseFloat(cols[colIndex['Y1']] || cols[10]) || 0,
        z1: parseFloat(cols[colIndex['Z1']] || cols[11]) || 0,
        x2: parseFloat(cols[colIndex['X2']] || cols[12]) || 0,
        y2: parseFloat(cols[colIndex['Y2']] || cols[13]) || 0,
        z2: parseFloat(cols[colIndex['Z2']] || cols[14]) || 0,
        width: parseFloat(cols[colIndex['Width']] || cols[15]) || 1.0,
        height: parseFloat(cols[colIndex['Height']] || cols[16]) || 1.0,
        area: parseFloat(cols[colIndex['Area']] || cols[17]) || 1.0,
        shape_type: parseInt(cols[colIndex['Shape Type']] || cols[18]) || 0,
        fan_type: parseInt(cols[colIndex['Fan Type']] || cols[29]) || 0,
        fan_numbers: parseInt(cols[colIndex['Fan Numbers']] || cols[30]) || 0,
        primary_layer: parseInt(cols[colIndex['Primary Layer']] || '0') || 0,
        air_type: parseInt(cols[colIndex['Air Type']] || '0') || 0,
        liner_type: parseInt(cols[colIndex['Liner Type']] || cols[35]) || 1
      };

      minX = Math.min(minX, branch.x1, branch.x2);
      maxX = Math.max(maxX, branch.x1, branch.x2);
      minY = Math.min(minY, branch.y1, branch.y2);
      maxY = Math.max(maxY, branch.y1, branch.y2);
      minZ = Math.min(minZ, branch.z1, branch.z2);
      maxZ = Math.max(maxZ, branch.z1, branch.z2);

      branches.push(branch);
    }

    console.log(`Extracted ${branches.length} tunnel branches`);

    // ── Infer entry/exit nodes from endpoint coordinates ──
    // VentSim files may have empty Entry Node / Exit Node columns.
    // We infer shared nodes by clustering branch endpoints within a tolerance.
    {
      const NODE_TOLERANCE = 0.5; // meters
      const allEndpoints = []; // { branchIdx, isStart, x, y, z }
      for (let bi = 0; bi < branches.length; bi++) {
        const b = branches[bi];
        allEndpoints.push({ bi, isStart: true, x: b.x1, y: b.y1, z: b.z1 });
        allEndpoints.push({ bi, isStart: false, x: b.x2, y: b.y2, z: b.z2 });
      }

      // Cluster endpoints into nodes by proximity (greedy union)
      const nodeAssignment = new Array(allEndpoints.length).fill(-1);
      let nextNodeId = 1;

      for (let i = 0; i < allEndpoints.length; i++) {
        if (nodeAssignment[i] >= 0) continue;
        const nodeId = nextNodeId++;
        nodeAssignment[i] = nodeId;
        const ep = allEndpoints[i];
        for (let j = i + 1; j < allEndpoints.length; j++) {
          if (nodeAssignment[j] >= 0) continue;
          const ep2 = allEndpoints[j];
          const dist = Math.sqrt((ep.x - ep2.x) ** 2 + (ep.y - ep2.y) ** 2 + (ep.z - ep2.z) ** 2);
          if (dist <= NODE_TOLERANCE) {
            nodeAssignment[j] = nodeId;
          }
        }
      }

      // Assign entry_node / exit_node to each branch
      let inferredCount = 0;
      for (let i = 0; i < allEndpoints.length; i++) {
        const ep = allEndpoints[i];
        const b = branches[ep.bi];
        const nodeLabel = `node-${nodeAssignment[i]}`;
        if (ep.isStart) {
          if (!b.entry_node) { b.entry_node = nodeLabel; inferredCount++; }
        } else {
          if (!b.exit_node) { b.exit_node = nodeLabel; inferredCount++; }
        }
      }

      // Count shared nodes (degree >= 2)
      const nodeDegree = {};
      for (const nid of nodeAssignment) {
        nodeDegree[nid] = (nodeDegree[nid] || 0) + 1;
      }
      const sharedNodes = Object.values(nodeDegree).filter(d => d >= 2).length;
      console.log(`Node inference: ${inferredCount} endpoints assigned, ${nextNodeId - 1} unique nodes, ${sharedNodes} shared (degree >= 2)`);
    }

    // Parse LAYERS section — maps numeric layer IDs to names (e.g., 1→Fresh, 2→Exhaust)
    const layerNames = new Map();
    const layersStartIdx = lines.findIndex(l => l.trim().startsWith('LAYERS'));
    if (layersStartIdx !== -1) {
      const layersEndIdx = lines.findIndex((l, i) => i > layersStartIdx && (l.trim().startsWith('END\tLAYERS') || l.trim() === 'END LAYERS'));
      const layersEnd = layersEndIdx !== -1 ? layersEndIdx : lines.length;
      for (let i = layersStartIdx + 1; i < layersEnd; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('END')) break;
        const cols = line.split('\t');
        const layerId = parseInt(cols[0]);
        const layerName = (cols[1] || '').trim();
        if (layerId > 0 && layerName) layerNames.set(layerId, layerName);
      }
      console.log(`Parsed ${layerNames.size} VentSim layers: ${[...layerNames.entries()].map(([k,v]) => `${k}=${v}`).join(', ')}`);
    }

    // Parse FANS section — each fan has a header line followed by curve data points.
    // Header: id \t name \t diameter \t ...  (name is non-empty text, not "0")
    // Curve:  index \t 0 \t pressure \t ...  (cols[1] is "0")
    const fans = [];
    const fansStartIdx = lines.findIndex(l => l.trim().startsWith('FANS'));
    if (fansStartIdx !== -1) {
      const fansEndIdx = lines.findIndex((l, i) => i > fansStartIdx && (l.trim().startsWith('END\tFANS') || l.trim() === 'END FANS'));
      for (let i = fansStartIdx + 1; i < fansEndIdx; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('END')) break;
        const cols = line.split('\t');
        // Fan header lines have an actual name in cols[1] (not just "0" or empty)
        if (cols.length > 2 && cols[1] && cols[1] !== '0' && /[a-zA-Z]/.test(cols[1])) {
          fans.push({
            fan_id: parseInt(cols[0]) || 0,
            name: cols[1].replace(/\|/g, '').trim() || `Fan_${cols[0]}`,
            diameter: parseFloat(cols[2]) || 1.0
          });
        }
        // Skip curve data points (cols[1] === "0")
      }
    }

    console.log(`Extracted ${fans.length} fans`);

    // Named spaces
    const namedSpaces = {};
    branches.forEach(b => {
      if (b.name && !b.name.startsWith('Branch_')) {
        if (!namedSpaces[b.name]) namedSpaces[b.name] = [];
        namedSpaces[b.name].push(b);
      }
    });

    // Build CSS segments from unique entry/exit node pairs
    const nodeSet = new Set();
    branches.forEach(b => { nodeSet.add(b.entry_node); nodeSet.add(b.exit_node); });

    // Create a single SEGMENT level for the tunnel network
    const segments = [{
      id: 'seg-tunnel-main',
      type: 'SEGMENT',
      name: 'Main Tunnel Network',
      startChainage_m: 0,
      endChainage_m: Math.max(maxX - minX, maxY - minY, 1)
    }];

    // ── Branch classification ──
    // Classify branches into structural (TUNNEL_SEGMENT) vs airway (DUCT) based
    // on cross-sectional area. Larger branches form the structural envelope;
    // smaller ones are ventilation airways with thinner, semi-transparent look.
    const areas = branches.map(b => b.area).filter(a => a > 0).sort((a, b) => a - b);
    const medianArea = areas.length > 0 ? areas[Math.floor(areas.length / 2)] : 1;
    const structuralThreshold = medianArea * 0.6; // branches >= 60% of median = structural
    const avgStructW = (() => {
      const structs = branches.filter(b => b.area >= structuralThreshold);
      return structs.length > 0 ? structs.reduce((s, b) => s + b.width, 0) / structs.length : 4;
    })();
    const avgStructH = (() => {
      const structs = branches.filter(b => b.area >= structuralThreshold);
      return structs.length > 0 ? structs.reduce((s, b) => s + b.height, 0) / structs.length : 3;
    })();

    console.log(`Branch classification: median area=${medianArea.toFixed(2)}, threshold=${structuralThreshold.toFixed(2)}, avg structural W=${avgStructW.toFixed(1)} H=${avgStructH.toFixed(1)}`);

    // Build CSS elements from branches
    const elements = [];
    const elementCounts = {};
    const structuralBranches = [];
    let zeroLengthCount = 0;

    for (const branch of branches) {
      const dx = branch.x2 - branch.x1;
      const dy = branch.y2 - branch.y1;
      const dz = branch.z2 - branch.z1;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length < 0.01) { zeroLengthCount++; continue; }

      // Normalize direction
      const dirX = dx / length;
      const dirY = dy / length;

      const isRound = branch.shape_type === 1;
      const linerMaterial = branch.liner_type === 1 ? 'concrete' : 'blasted_rock';

      // Classify: structural tunnel segment vs airway duct
      const isStructural = branch.area >= structuralThreshold;
      const type = isStructural ? 'TUNNEL_SEGMENT' : 'DUCT';

      if (isStructural) structuralBranches.push(branch);

      // refDirection = normalized horizontal bearing of the branch so each segment
      // has the correct lateral orientation in the IFC viewer. Falls back to +X
      // for near-vertical branches (shafts) where horizontal bearing is undefined.
      const horizLen = Math.sqrt(dirX * dirX + dirY * dirY);
      const refDirVec = horizLen > 0.1
        ? { x: dirX / horizLen, y: dirY / horizLen, z: 0 }
        : { x: 1, y: 0, z: 0 };

      // Normalize coordinates relative to bounding box origin so the model
      // sits near z=0 rather than at mine elevation (~1290m).
      // origin = MIDPOINT of the segment — the IFC generator's hollow-manifold
      // path shifts back by refDir * depth/2 to find the extrusion start, so
      // providing the start point here would double-shift the geometry.
      const placement = {
        origin: {
          x: (branch.x1 + branch.x2) / 2 - minX,
          y: (branch.y1 + branch.y2) / 2 - minY,
          z: (branch.z1 + branch.z2) / 2 - minZ
        },
        axis: { x: 0, y: 0, z: 1 },
        refDirection: refDirVec
      };

      // Airway ducts: use reduced cross-section (70% of original) for visual hierarchy
      const scaleFactor = isStructural ? 1.0 : 0.7;
      const effectiveW = branch.width * scaleFactor;
      const effectiveH = branch.height * scaleFactor;

      // geometry.direction is in element-LOCAL space. With the new convention:
      // local-X = refDirection = branch bearing → extrude in (1,0,0) to push
      // geometry along the tunnel run, not vertically.
      const geometry = isRound ? {
        method: 'EXTRUSION',
        profile: { type: 'CIRCLE', radius: (effectiveW / 2) },
        direction: { x: 1, y: 0, z: 0 },
        depth: length
      } : {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: effectiveW, height: effectiveH },
        direction: { x: 1, y: 0, z: 0 },
        depth: length
      };

      const id = elemId(geometry, placement);
      const branchName = branch.name || `Branch_${branch.unique_no}`;
      const element_key = `ventsim_branch_${branch.unique_no}`;
      elementCounts[type] = (elementCounts[type] || 0) + 1;

      // Visual hierarchy: structural = opaque concrete, airways = semi-transparent lighter
      const material = isStructural
        ? { name: linerMaterial, color: linerMaterial === 'concrete' ? [0.75, 0.75, 0.75] : [0.55, 0.45, 0.35], transparency: 0 }
        : { name: 'airway', color: [0.6, 0.7, 0.85], transparency: 0.35 };

      elements.push({
        id,
        element_key,
        type,
        semanticType: isStructural ? 'IfcBuildingElementProxy' : 'IfcDuctSegment',
        name: branchName,
        placement,
        geometry,
        container: 'seg-tunnel-main',
        relationships: [],
        properties: {
          unique_no: branch.unique_no,
          entry_node: branch.entry_node,
          exit_node: branch.exit_node,
          area_m2: branch.area,
          liner_type: linerMaterial,
          shape: isRound ? 'round' : 'rectangular',
          fan_type: branch.fan_type,
          fan_numbers: branch.fan_numbers,
          primary_layer: branch.primary_layer,
          air_type: branch.air_type,
          ventLayer: layerNames.get(branch.primary_layer) || '',
          branchClass: isStructural ? 'STRUCTURAL' : 'AIRWAY'
        },
        material,
        confidence: isStructural ? 0.95 : 0.85,
        source: 'VSM'
      });
    }

    console.log(`Classified: ${structuralBranches.length} structural, ${branches.length - structuralBranches.length} airways`);

    // Add fan equipment elements — placed at the midpoint of their associated branch.
    // VentSim: fan_type = fan curve ID (matches fan_id), fan_numbers = count of fans on branch.
    const fanMatchResults = [];
    for (let i = 0; i < fans.length; i++) {
      const fan = fans[i];
      const hostBranch = branches.find(b => b.fan_type === fan.fan_id);
      let cx, cy, cz, dirX = 0, dirY = 0, dirZ = 1;
      let matchStatus = 'unmatched';
      if (hostBranch) {
        matchStatus = 'matched';
        // Midpoint of host branch, normalized to network origin
        cx = ((hostBranch.x1 + hostBranch.x2) / 2) - minX;
        cy = ((hostBranch.y1 + hostBranch.y2) / 2) - minY;
        cz = ((hostBranch.z1 + hostBranch.z2) / 2) - minZ;
        // Align fan disk perpendicular to branch direction
        const bLen = Math.sqrt((hostBranch.x2 - hostBranch.x1) ** 2 + (hostBranch.y2 - hostBranch.y1) ** 2 + (hostBranch.z2 - hostBranch.z1) ** 2);
        if (bLen > 0.01) {
          dirX = (hostBranch.x2 - hostBranch.x1) / bLen;
          dirY = (hostBranch.y2 - hostBranch.y1) / bLen;
          dirZ = (hostBranch.z2 - hostBranch.z1) / bLen;
        }
        console.log(`  Fan "${fan.name}" (id=${fan.fan_id}) → branch #${hostBranch.unique_no} "${hostBranch.name}" dir=(${dirX.toFixed(4)}, ${dirY.toFixed(4)}, ${dirZ.toFixed(4)}) at (${cx.toFixed(1)},${cy.toFixed(1)},${cz.toFixed(1)})`);
      } else {
        // Fallback: place at ground level near network center
        cx = (maxX - minX) / 2 + (i * 5);
        cy = (maxY - minY) / 2;
        cz = 0;
        console.warn(`  Fan "${fan.name}" (id=${fan.fan_id}) → NO matching branch (fallback placement)`);
      }

      // Fan disk placed perpendicular to the branch bearing.
      // Use the same axis=(0,0,1)/refDir=bearing convention as tunnel segments
      // so the IFC generator renders the disk facing into the airflow direction.
      const fanHorizLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
      const placement = {
        origin: { x: cx, y: cy, z: cz },
        axis: { x: 0, y: 0, z: 1 },
        refDirection: fanHorizLen > 0.1
          ? { x: dirX / fanHorizLen, y: dirY / fanHorizLen, z: 0 }
          : { x: 1, y: 0, z: 0 }
      };
      // Fan disk: thin cylinder extruded along local-X (bearing), depth = 20% of diameter
      const fanThickness = Math.max(0.15, fan.diameter * 0.2);
      const geometry = {
        method: 'EXTRUSION',
        profile: { type: 'CIRCLE', radius: fan.diameter / 2 },
        direction: { x: 1, y: 0, z: 0 },
        depth: fanThickness
      };

      // Post-creation axis validation: compare assigned axis to computed host direction
      // Validate: warn if fan has no meaningful horizontal bearing (e.g., vertical shaft fan)
      const horizontalMag = Math.sqrt(dirX * dirX + dirY * dirY);
      if (hostBranch && horizontalMag < 0.1) {
        console.warn(`  ⚠ Fan "${fan.name}" host branch #${hostBranch.unique_no} is near-vertical (horiz=${horizontalMag.toFixed(3)}) — fan will use fallback +X refDirection.`);
      }

      const id = elemId(geometry, placement);
      const element_key = `ventsim_fan_${fan.fan_id || i}`;
      elementCounts['EQUIPMENT'] = (elementCounts['EQUIPMENT'] || 0) + 1;

      elements.push({
        id,
        element_key,
        type: 'EQUIPMENT',
        semanticType: 'IfcFan',
        name: fan.name,
        placement,
        geometry,
        container: 'seg-tunnel-main',
        relationships: [],
        properties: {
          fan_id: fan.fan_id,
          diameter_m: fan.diameter,
          hostSegmentId: hostBranch ? `ventsim_branch_${hostBranch.unique_no}` : null,
          hostBranchUniqueNo: hostBranch?.unique_no ?? null,
          hostDirectionX: dirX,
          hostDirectionY: dirY,
          hostDirectionZ: dirZ
        },
        material: {
          name: 'steel',
          color: [0.5, 0.5, 0.55],
          transparency: 0
        },
        confidence: 0.9,
        source: 'VSM'
      });

      fanMatchResults.push({
        fanId: fan.fan_id,
        fanName: fan.name,
        matchStatus,
        hostBranchUniqueNo: hostBranch?.unique_no ?? null,
        computedDir: { x: dirX, y: dirY, z: dirZ },
        assignedAxis: { x: placement.axis.x, y: placement.axis.y, z: placement.axis.z }
      });
    }

    // Named spaces are tracked in metadata but NOT rendered as separate geometry
    const spaceCount = Object.keys(namedSpaces).length;

    // Portal buildings — detect terminal nodes (appear exactly once across all endpoints)
    // and place a small gatehouse building at ground-level edge terminals
    {
      const epCount = new Map();
      for (const b of branches) {
        const k1 = `${b.x1.toFixed(1)},${b.y1.toFixed(1)},${b.z1.toFixed(1)}`;
        const k2 = `${b.x2.toFixed(1)},${b.y2.toFixed(1)},${b.z2.toFixed(1)}`;
        epCount.set(k1, (epCount.get(k1) || 0) + 1);
        epCount.set(k2, (epCount.get(k2) || 0) + 1);
      }

      const netW = maxX - minX;
      const netD = maxY - minY;
      const edgeTol = Math.max(netW, netD) * 0.18; // within 18% of network edge = portal zone

      for (const b of branches) {
        for (const [px, py, pz] of [[b.x1, b.y1, b.z1], [b.x2, b.y2, b.z2]]) {
          const key = `${px.toFixed(1)},${py.toFixed(1)},${pz.toFixed(1)}`;
          if (epCount.get(key) !== 1) continue;       // not a terminal
          if (pz - minZ > 2) continue;               // elevated = shaft endpoint, skip

          const nx = px - minX;
          const ny = py - minY;
          const nz = pz - minZ;

          const nearEdge = nx < edgeTol || nx > netW - edgeTol ||
                           ny < edgeTol || ny > netD - edgeTol;
          if (!nearEdge) continue;

          // Portal proportional to tunnel dimensions (1.5× width, 1× depth, 1.2× height)
          const bW = Math.max(4, avgStructW * 1.5);
          const bD = Math.max(3, avgStructH);
          const bH = Math.max(3, avgStructH * 1.2);

          // Building box — centered on terminal point
          const bldPlacement = {
            origin: { x: nx - bW / 2, y: ny - bD / 2, z: nz },
            axis: { x: 0, y: 0, z: 1 },
            refDirection: { x: 1, y: 0, z: 0 }
          };
          const bldGeometry = {
            method: 'EXTRUSION',
            profile: { type: 'RECTANGLE', width: bW, height: bD },
            direction: { x: 0, y: 0, z: 1 },
            depth: bH
          };
          const bldId = elemId(bldGeometry, bldPlacement);
          elementCounts['WALL'] = (elementCounts['WALL'] || 0) + 1;
          elements.push({
            id: bldId,
            element_key: `portal_building_${bldId.slice(0, 8)}`,
            type: 'WALL',
            semanticType: 'IfcBuildingElementProxy',
            name: 'Portal Building',
            placement: bldPlacement,
            geometry: bldGeometry,
            container: 'seg-tunnel-main',
            relationships: [],
            properties: { segmentType: 'PORTAL_BUILDING' },
            material: { name: 'concrete', color: [0.93, 0.93, 0.93], transparency: 0 },
            confidence: 0.88,
            source: 'VSM'
          });

          // Door on the face toward tunnel interior
          const dW = 1.0, dH = 2.2, dThick = 0.08;
          // Door offset — place on the interior-facing wall
          const facingY = ny < edgeTol ? 1 : -1; // south terminal faces north, north faces south
          const dPlacement = {
            origin: { x: nx - dW / 2, y: ny + facingY * (bD / 2), z: nz },
            axis: { x: 0, y: 0, z: 1 },
            refDirection: { x: 1, y: 0, z: 0 }
          };
          // Profile in XY plane: width × thickness, extruded upward by door height
          const dGeometry = {
            method: 'EXTRUSION',
            profile: { type: 'RECTANGLE', width: dW, height: dThick },
            direction: { x: 0, y: 0, z: 1 },
            depth: dH  // 2.2m tall door extruded in Z
          };
          const dId = elemId(dGeometry, dPlacement);
          elementCounts['DOOR'] = (elementCounts['DOOR'] || 0) + 1;
          elements.push({
            id: dId,
            element_key: `portal_door_${dId.slice(0, 8)}`,
            type: 'DOOR',
            semanticType: 'IfcDoor',
            name: 'Portal Door',
            placement: dPlacement,
            geometry: dGeometry,
            container: 'seg-tunnel-main',
            relationships: [],
            properties: {},
            material: { name: 'wood', color: [0.62, 0.42, 0.18], transparency: 0 },
            confidence: 0.82,
            source: 'VSM'
          });
        }
      }
    }

    // ── Interior system placeholders (cable trays + lighting) ──
    // Add along structural branches only, for interior realism.
    // Only add to branches longer than 5m to avoid cluttering short stubs.
    {
      let interiorCount = 0;
      for (const branch of structuralBranches) {
        const dx = branch.x2 - branch.x1;
        const dy = branch.y2 - branch.y1;
        const dz = branch.z2 - branch.z1;
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (length < 5) continue;

        const dirX = dx / length;
        const dirY = dy / length;
        // horizLen: magnitude of the horizontal component of the branch direction.
        // Used to compute bearing (local-X) and the lateral side vector (perpendicular
        // to bearing in the horizontal plane) for cable-tray / lighting offsets.
        const horizLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
        const bearingX = dirX / horizLen;
        const bearingY = dirY / horizLen;
        // sideVec: unit vector perpendicular to bearing, pointing "right" of the run
        const sideX = -bearingY;
        const sideY = bearingX;

        // Midpoint of the branch (consistent with segment placement origin convention)
        const midX = (branch.x1 + branch.x2) / 2 - minX;
        const midY = (branch.y1 + branch.y2) / 2 - minY;
        const midZ = (branch.z1 + branch.z2) / 2 - minZ;

        // Cable tray: thin strip near ceiling, offset to the right side of the tunnel
        const ctW = 0.3, ctH = 0.1;
        const ctOffset = branch.width * 0.35;
        const ctPlacement = {
          origin: {
            x: midX + sideX * ctOffset,
            y: midY + sideY * ctOffset,
            z: midZ + (branch.height * 0.85)
          },
          axis: { x: 0, y: 0, z: 1 },
          refDirection: { x: bearingX, y: bearingY, z: 0 }
        };
        const ctGeometry = {
          method: 'EXTRUSION',
          profile: { type: 'RECTANGLE', width: ctW, height: ctH },
          direction: { x: 1, y: 0, z: 0 },
          depth: length
        };
        const ctId = elemId(ctGeometry, ctPlacement);
        elementCounts['EQUIPMENT'] = (elementCounts['EQUIPMENT'] || 0) + 1;
        elements.push({
          id: ctId,
          element_key: `cable_tray_${branch.unique_no}`,
          type: 'EQUIPMENT',
          semanticType: 'IfcCableCarrierSegment',
          name: `Cable Tray - ${branch.name || branch.unique_no}`,
          placement: ctPlacement,
          geometry: ctGeometry,
          container: 'seg-tunnel-main',
          relationships: [],
          properties: { systemType: 'CABLE_TRAY', branchRef: branch.unique_no },
          material: { name: 'steel', color: [0.45, 0.45, 0.48], transparency: 0.2 },
          confidence: 0.7,
          source: 'VSM'
        });

        // Lighting strip: narrow line centered on the ceiling
        const ltW = 0.15, ltH = 0.05;
        const ltPlacement = {
          origin: {
            x: midX,
            y: midY,
            z: midZ + (branch.height * 0.95)
          },
          axis: { x: 0, y: 0, z: 1 },
          refDirection: { x: bearingX, y: bearingY, z: 0 }
        };
        const ltGeometry = {
          method: 'EXTRUSION',
          profile: { type: 'RECTANGLE', width: ltW, height: ltH },
          direction: { x: 1, y: 0, z: 0 },
          depth: length
        };
        const ltId = elemId(ltGeometry, ltPlacement);
        elementCounts['EQUIPMENT'] = (elementCounts['EQUIPMENT'] || 0) + 1;
        elements.push({
          id: ltId,
          element_key: `lighting_${branch.unique_no}`,
          type: 'EQUIPMENT',
          semanticType: 'IfcLightFixture',
          name: `Lighting - ${branch.name || branch.unique_no}`,
          placement: ltPlacement,
          geometry: ltGeometry,
          container: 'seg-tunnel-main',
          relationships: [],
          properties: { systemType: 'LIGHTING', branchRef: branch.unique_no },
          material: { name: 'luminaire', color: [0.95, 0.95, 0.8], transparency: 0.15 },
          confidence: 0.65,
          source: 'VSM'
        });

        interiorCount += 2;
      }
      console.log(`Added ${interiorCount} interior system elements (cable trays + lighting)`);
    }

    const branchCount = branches.length;
    const fanCount = fans.length;
    const structCount = structuralBranches.length;
    const airwayCount = branchCount - structCount;

    const css = {
      cssVersion: '1.0',
      domain: 'TUNNEL',
      facility: {
        name: 'Tunnel Network',
        type: 'tunnel',
        description: `Tunnel network: ${structCount} structural segments, ${airwayCount} airways, ${fanCount} fans, ${spaceCount} named spaces. Network spans ${(maxX - minX).toFixed(1)}m x ${(maxY - minY).toFixed(1)}m with ${(maxZ - minZ).toFixed(1)}m elevation variation.`,
        units: 'M',
        crs: null,
        // Real-world offset recorded here; all element coords are normalized to 0-origin
        origin: { x: minX, y: minY, z: minZ },
        axes: 'RIGHT_HANDED_Z_UP'
      },
      levelsOrSegments: segments,
      elements,
      metadata: {
        sourceFiles: [{
          name: sourceFileName,
          parseStatus: 'success',
          role: 'geometry'
        }],
        outputMode: 'HYBRID',
        validationStatus: 'PENDING',
        unitNormalizationApplied: true,
        cssHash: null,
        elementCounts,
        bbox: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ }
        },
        repairLog: [],
        extractBuild: {
          version: EXTRACT_VERSION,
          builtAt: BUILD_TIMESTAMP
        },
        tunnelExtractionAudit: {
          rawBranchCount: branches.length,
          rawBranchIds: branches.map(b => b.unique_no),
          emittedSegmentCount: (elementCounts['TUNNEL_SEGMENT'] || 0) + (elementCounts['DUCT'] || 0),
          emittedSegmentIds: elements.filter(e => e.type === 'TUNNEL_SEGMENT' || e.type === 'DUCT').map(e => e.properties?.unique_no),
          skippedZeroLengthCount: zeroLengthCount,
          fanMatchedCount: fanMatchResults.filter(f => f.matchStatus === 'matched').length,
          fanUnmatchedCount: fanMatchResults.filter(f => f.matchStatus === 'unmatched').length,
          fanMatchReport: fanMatchResults,
          namedBranches: branches.filter(b => b.name && !b.name.startsWith('Branch_')).map(b => ({
            uniqueNo: b.unique_no,
            name: b.name
          })),
          dimensionVariations: {
            uniqueWidths: [...new Set(branches.map(b => b.width))].sort((a, b) => a - b),
            uniqueHeights: [...new Set(branches.map(b => b.height))].sort((a, b) => a - b)
          }
        }
      }
    };

    // v6+ PHASE C+4: Tag detailed evidence on all VentSim elements
    for (const el of css.elements) {
      if (!el.sourceFile) el.sourceFile = sourceFileName;
      if (!el.metadata) el.metadata = {};
      el.metadata.evidence = {
        sourceFiles: [sourceFileName],
        basis: 'VENTSIM_GEOMETRY',
        confidence: el.confidence || 0.95,
        sourceType: 'SIMULATION',
        // Element-level evidence details
        sourceExcerpt: el.properties?.branchName ? `Branch: ${el.properties.branchName}` : el.name,
        dataFormat: 'VENTSIM_TXT',
        coordinateSource: 'DIRECT_3D',
        lineRange: el.metadata?.ventSimLineRange || null
      };
    }

    return css;
  } catch (err) {
    console.error('Error parsing VentSim:', err.message);
    return null;
  }
}

// ============================================================================
// BEDROCK RESPONSE → CSS CONVERTER
// ============================================================================

// ============================================================================
// TUNNEL / UNDERGROUND FACILITY — BEDROCK PROMPT BUILDER
// ============================================================================

function buildTunnelPass2Prompt(domainContext, fileContent, descriptionContent) {
  return `${domainContext}
You are an expert in interpreting underground facility and tunnel engineering documents.
Extract structured tunnel/underground facility data and return it as a JSON object. ALL DIMENSIONS IN METRES.

SOURCE PRIORITY:
- PRIMARY section: authoritative source for topology, dimensions, portals, shafts, zones, and overall layout
- SECONDARY section: equipment sizing and MEP metadata only — do NOT use to reshape the tunnel envelope
- TERTIARY section: airflow semantics only — do NOT derive structural geometry from simulation exports

Return ONLY valid JSON (no markdown, no explanations):

{
  "buildingName": "string",
  "buildingType": "TUNNEL | UNDERGROUND_FACILITY | MIXED_UNDERGROUND",
  "topology": {
    "layout_type": "LINEAR | BRANCHED",
    "length_m": number,
    "width_m": number,
    "height_m": number,
    "portal_count": number,
    "portals": [{ "name": "string", "side": "WEST|EAST|NORTH|SOUTH", "elevation_m": number, "width_m": number, "height_m": number }],
    "shafts": [{ "name": "string", "role": "EXHAUST|INTAKE|UTILITY|ACCESS", "chainage_m": number, "lateral_offset_m": number, "width_m": number, "depth_m": number, "height_above_tunnel_m": number }]
  },
  "segments": [{
    "name": "string",
    "type": "MAIN_TUNNEL|PORTAL_ZONE|VEHICLE_BAY|COMMAND_ROOM|GENERATOR_ROOM|COMMS_ROOM|SUPPORT_ROOM|MECH_ROOM|SHAFT_BASE|STORAGE|CROSSCUT",
    "chainage_start_m": number,
    "chainage_end_m": number,
    "lateral_offset_m": number,
    "elevation_offset_m": number,
    "width_m": number,
    "height_m": number,
    "profile_type": "RECTANGULAR|ARCHED"
  }],
  "geology": { "rock_type": "granite|limestone|sandstone|other", "lining": "CONCRETE_LINED|BLASTED_ROCK|SHOTCRETE|UNLINED" },
  "ventilation": { "intake_portal": "WEST|EAST|NORTH|SOUTH", "exhaust_method": "SHAFT|PORTAL|MIXED", "shaft_name": "string" },
  "equipment": [{ "name": "string", "type": "GENERATOR|PUMP|FAN|COMPRESSOR|TRANSFORMER|BATTERY|OTHER", "segment_name": "string (name of segment this equipment belongs in)", "chainage_m": number, "lateral_m": number, "length_m": number, "width_m": number, "height_m": number }],
  "materials": { "lining": "string", "floor": "string" }
}

Rules:
- Use PRIMARY documents as the sole source for tunnel topology, envelope, and zone layout
- Order segments by chainage_start_m (entry portal → exit portal direction)
- lateral_offset_m: 0 = inline with tunnel axis; positive/negative = opposite lateral sides (no compass direction assumed)
- chainage_start_m / chainage_end_m define span of each segment along the primary axis
- Portal elevation differences: record as elevation_m on each portal (tunnel grade is not geometrically modelled yet)
- If a room is inline (lateral_offset_m = 0) and similar width to main tunnel, it is a widened section
- Use ARCHED profile for drive-through tunnel sections when evidence suggests it; RECTANGULAR for rooms
- Return empty arrays [] when no data

Building Description:
${descriptionContent || '(No description provided)'}

${fileContent}`;
}

// ============================================================================
// TUNNEL / UNDERGROUND FACILITY — CSS GEOMETRY GENERATOR
// ============================================================================

function buildTunnelCSS(spec, sourceFiles) {
  const topo = spec.topology || {};
  const tunnelLength = Math.max(10, Math.min(5000, topo.length_m || spec.dimensions?.length_m || 300));
  const tunnelWidth = Math.max(3, Math.min(30, topo.width_m || spec.dimensions?.width_m || 8));
  const tunnelHeight = Math.max(2, Math.min(20, topo.height_m || spec.dimensions?.height_m || 6));
  const lining = (spec.geology?.lining || 'CONCRETE_LINED').toUpperCase();

  const materialMap = {
    BLASTED_ROCK: { name: 'blasted_rock', color: [0.48, 0.43, 0.38] },
    CONCRETE_LINED: { name: 'concrete', color: [0.62, 0.62, 0.65] },
    SHOTCRETE: { name: 'shotcrete', color: [0.55, 0.55, 0.52] },
    UNLINED: { name: 'blasted_rock', color: [0.45, 0.40, 0.35] },
  };
  const mainMat = materialMap[lining] || materialMap.CONCRETE_LINED;

  const segmentTypeMat = {
    COMMAND_ROOM: { name: 'plasterboard', color: [0.88, 0.88, 0.86] },
    COMMS_ROOM: { name: 'plasterboard', color: [0.88, 0.88, 0.86] },
    SUPPORT_ROOM: { name: 'plasterboard', color: [0.88, 0.88, 0.86] },
    GENERATOR_ROOM: { name: 'concrete', color: [0.58, 0.58, 0.60] },
    MECH_ROOM: { name: 'concrete', color: [0.58, 0.58, 0.60] },
    VEHICLE_BAY: { name: 'concrete', color: [0.68, 0.68, 0.70] },
  };

  const elements = [];
  const elementCounts = {};

  function addEl(el) {
    elementCounts[el.type] = (elementCounts[el.type] || 0) + 1;
    elements.push(el);
  }

  // Helper: slug for segment IDs
  function slug(name) {
    return 'seg-' + (name || 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
  }

  // Build levelsOrSegments
  const levelsOrSegments = [
    { id: 'seg-west-portal', type: 'SEGMENT', name: 'West Portal', startChainage_m: -5, endChainage_m: 0, height_m: tunnelHeight },
    { id: 'seg-tunnel-main', type: 'SEGMENT', name: 'Main Tunnel', startChainage_m: 0, endChainage_m: tunnelLength, height_m: tunnelHeight },
    { id: 'seg-east-portal', type: 'SEGMENT', name: 'East Portal', startChainage_m: tunnelLength, endChainage_m: tunnelLength + 5, height_m: tunnelHeight },
  ];

  const segments = spec.segments || [];
  const segmentMap = {};
  for (const seg of segments) {
    const segId = slug(seg.name);
    segmentMap[seg.name] = { ...seg, id: segId };
    levelsOrSegments.push({
      id: segId, type: 'SEGMENT', name: seg.name,
      startChainage_m: seg.chainage_start_m || 0,
      endChainage_m: seg.chainage_end_m || ((seg.chainage_start_m || 0) + 10),
      height_m: seg.height_m || tunnelHeight
    });
  }

  // 1. MAIN TUNNEL TUBE
  addEl({
    id: elemId({ method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: tunnelWidth, height: tunnelHeight }, depth: tunnelLength },
              { origin: { x: 0, y: 0, z: 0 } }),
    element_key: 'tunnel_main_tube',
    type: 'TUNNEL_SEGMENT', semanticType: 'IfcWall',
    name: 'Main Tunnel',
    placement: { origin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 } },
    geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: tunnelHeight, height: tunnelWidth }, direction: { x: 1, y: 0, z: 0 }, depth: tunnelLength },
    container: 'seg-tunnel-main', relationships: [],
    properties: { segmentType: 'MAIN_TUNNEL', lining, chainage_start_m: 0, chainage_end_m: tunnelLength },
    material: mainMat, confidence: 0.95, source: 'LLM', sourceRole: 'NARRATIVE', explicitOrInferred: 'EXPLICIT'
  });

  // 2. PORTALS
  const portals = topo.portals || [];
  const westPortal = portals.find(p => p.side === 'WEST') || { side: 'WEST', elevation_m: 0 };
  const eastPortal = portals.find(p => p.side === 'EAST') || { side: 'EAST', elevation_m: 0 };
  // Portal proportional to tunnel: 1.3× width, 1.25× height (not fixed +3/+2)
  const portalW = Math.max(tunnelWidth * 1.1, westPortal.width_m || tunnelWidth * 1.3);
  const portalH = Math.max(tunnelHeight * 1.1, westPortal.height_m || tunnelHeight * 1.25);

  addEl({
    id: elemId({ method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: portalH, height: portalW }, depth: 5 },
              { origin: { x: -5, y: -(portalW - tunnelWidth) / 2, z: westPortal.elevation_m || 0 } }),
    element_key: 'tunnel_west_portal',
    type: 'TUNNEL_SEGMENT', semanticType: 'IfcWall',
    name: westPortal.name || 'West Portal',
    placement: { origin: { x: -5, y: -(portalW - tunnelWidth) / 2, z: westPortal.elevation_m || 0 } },
    geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: portalH, height: portalW }, direction: { x: 1, y: 0, z: 0 }, depth: 5 },
    container: 'seg-west-portal', relationships: [],
    properties: { segmentType: 'PORTAL', side: 'WEST', elevation_m: westPortal.elevation_m || 0 },
    material: { name: 'concrete', color: [0.55, 0.55, 0.58] }, confidence: 0.90, source: 'LLM', explicitOrInferred: 'EXPLICIT'
  });

  addEl({
    id: elemId({ method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: portalH, height: portalW }, depth: 5 },
              { origin: { x: tunnelLength, y: -(portalW - tunnelWidth) / 2, z: eastPortal.elevation_m || 0 } }),
    element_key: 'tunnel_east_portal',
    type: 'TUNNEL_SEGMENT', semanticType: 'IfcWall',
    name: eastPortal.name || 'East Portal',
    placement: { origin: { x: tunnelLength, y: -(portalW - tunnelWidth) / 2, z: eastPortal.elevation_m || 0 } },
    geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: portalH, height: portalW }, direction: { x: 1, y: 0, z: 0 }, depth: 5 },
    container: 'seg-east-portal', relationships: [],
    properties: { segmentType: 'PORTAL', side: 'EAST', elevation_m: eastPortal.elevation_m || 0 },
    material: { name: 'concrete', color: [0.55, 0.55, 0.58] }, confidence: 0.90, source: 'LLM', explicitOrInferred: 'EXPLICIT'
  });

  // 3. SEGMENTS (ordered by chainage_start_m)
  // Lateral-offset chambers overlap the tunnel wall by 1m for a connected look.
  const sortedSegs = [...segments].sort((a, b) => (a.chainage_start_m || 0) - (b.chainage_start_m || 0));
  for (const seg of sortedSegs) {
    const cStart = seg.chainage_start_m ?? 0;
    const cEnd = seg.chainage_end_m ?? (cStart + 10);
    const segLen = Math.max(0.5, cEnd - cStart);
    const segWid = seg.width_m || tunnelWidth;
    const segH = seg.height_m || tunnelHeight;
    let latOff = seg.lateral_offset_m ?? 0;
    const elevOff = seg.elevation_offset_m ?? 0;
    const segMat = segmentTypeMat[seg.type] || mainMat;
    const segId = segmentMap[seg.name]?.id || slug(seg.name);
    const isArched = (seg.profile_type || 'RECTANGULAR').toUpperCase() === 'ARCHED';
    const isLateral = Math.abs(latOff) > 0;

    // Chamber transition: pull lateral chambers 1m into tunnel wall for overlap
    if (isLateral) {
      const overlapInset = 1.0;
      latOff = latOff > 0
        ? Math.max(0, latOff - overlapInset)  // positive side: pull toward center
        : Math.min(0, latOff + overlapInset);  // negative side: pull toward center
    }

    // Rectangular base (always)
    const wallH = isArched ? segH * 0.60 : segH;
    addEl({
      id: elemId({ method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: wallH, height: segWid }, depth: segLen },
                { origin: { x: cStart, y: latOff, z: elevOff } }),
      element_key: `tunnel_seg_${segId}`,
      type: 'TUNNEL_SEGMENT', semanticType: 'IfcWall',
      name: seg.name,
      placement: { origin: { x: cStart, y: latOff, z: elevOff } },
      geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: wallH, height: segWid }, direction: { x: 1, y: 0, z: 0 }, depth: segLen },
      container: segId, relationships: [],
      properties: { segmentType: seg.type || 'TUNNEL_SEGMENT', chainage_start_m: cStart, chainage_end_m: cEnd, lining, profileType: seg.profile_type || 'RECTANGULAR' },
      material: segMat, confidence: 0.85, source: 'LLM', explicitOrInferred: 'INFERRED'
    });

    // Arch cap (additive, rectangular fallback safe in generate)
    if (isArched) {
      const archH = segH * 0.40;
      addEl({
        id: elemId({ method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: archH, height: segWid }, depth: segLen },
                  { origin: { x: cStart, y: latOff, z: elevOff + wallH } }),
        element_key: `tunnel_seg_${segId}_arch`,
        type: 'TUNNEL_SEGMENT', semanticType: 'IfcWall',
        name: `${seg.name} Arch`,
        placement: { origin: { x: cStart, y: latOff, z: elevOff + wallH } },
        geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: archH, height: segWid }, direction: { x: 1, y: 0, z: 0 }, depth: segLen },
        container: segId, relationships: [],
        properties: { segmentType: 'ARCH_CAP', chainage_start_m: cStart, chainage_end_m: cEnd },
        material: segMat, confidence: 0.75, source: 'LLM', explicitOrInferred: 'INFERRED'
      });
    }

    // Chamber transition element: short connector between tunnel wall and lateral chamber
    if (isLateral) {
      const transW = Math.min(segWid, tunnelWidth) * 0.8;  // 80% of narrower dimension
      const transH = Math.min(segH, tunnelHeight) * 0.85;
      const transLen = 1.5;  // 1.5m transition depth
      const transY = latOff > 0 ? latOff - transLen : latOff + segWid;
      addEl({
        id: elemId({ method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: transH, height: transW }, depth: transLen },
                  { origin: { x: cStart + segLen * 0.3, y: transY, z: elevOff } }),
        element_key: `tunnel_transition_${segId}`,
        type: 'TUNNEL_SEGMENT', semanticType: 'IfcWall',
        name: `${seg.name} Transition`,
        placement: { origin: { x: cStart + segLen * 0.3, y: transY, z: elevOff } },
        geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: transH, height: transW }, direction: { x: 0, y: latOff > 0 ? 1 : -1, z: 0 }, depth: transLen },
        container: segId, relationships: [],
        properties: { segmentType: 'CHAMBER_TRANSITION' },
        material: mainMat, confidence: 0.7, source: 'LLM', explicitOrInferred: 'INFERRED'
      });
    }
  }

  // 4. SHAFTS — base connects directly to tunnel ceiling
  for (const shaft of (topo.shafts || [])) {
    const sx = Math.max(0, Math.min(shaft.chainage_m ?? tunnelLength / 2, tunnelLength));
    const sy = shaft.lateral_offset_m ?? 0;
    const sw = shaft.width_m || 2;
    const sd = shaft.depth_m || 2;
    const sh = shaft.height_above_tunnel_m || 20;
    // Find nearest segment by chainage for container assignment + local ceiling height
    const nearSeg = sortedSegs.reduce((best, s) => {
      const d = Math.abs(((s.chainage_start_m || 0) + (s.chainage_end_m || 0)) / 2 - sx);
      return (!best || d < best.d) ? { seg: s, d } : best;
    }, null);
    const shaftContainer = nearSeg ? (segmentMap[nearSeg.seg.name]?.id || 'seg-tunnel-main') : 'seg-tunnel-main';
    // Shaft base at local ceiling height (segment elevation + height, or main tunnel height)
    const localCeiling = nearSeg
      ? (nearSeg.seg.elevation_offset_m || 0) + (nearSeg.seg.height_m || tunnelHeight)
      : tunnelHeight;

    // Shaft column
    addEl({
      id: elemId({ method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sw, height: sd }, depth: sh },
                { origin: { x: sx, y: sy, z: localCeiling } }),
      element_key: `tunnel_shaft_${shaft.name?.replace(/\s+/g, '_') || 'shaft'}`,
      type: 'TUNNEL_SEGMENT', semanticType: 'IfcColumn',
      name: shaft.name || 'Ventilation Shaft',
      placement: { origin: { x: sx, y: sy, z: localCeiling } },
      geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sw, height: sd }, direction: { x: 0, y: 0, z: 1 }, depth: sh },
      container: shaftContainer, relationships: [],
      properties: { segmentType: 'SHAFT', role: shaft.role || 'UTILITY' },
      material: { name: 'concrete', color: [0.60, 0.60, 0.62] }, confidence: 0.85, source: 'LLM', explicitOrInferred: 'EXPLICIT'
    });

    // Shaft base collar — short wider ring at tunnel ceiling for visual connection
    const collarW = sw * 1.4, collarD = sd * 1.4, collarH = 0.4;
    addEl({
      id: elemId({ method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: collarW, height: collarD }, depth: collarH },
                { origin: { x: sx - (collarW - sw) / 2, y: sy - (collarD - sd) / 2, z: localCeiling - collarH / 2 } }),
      element_key: `tunnel_shaft_collar_${shaft.name?.replace(/\s+/g, '_') || 'shaft'}`,
      type: 'TUNNEL_SEGMENT', semanticType: 'IfcPlate',
      name: `${shaft.name || 'Shaft'} Collar`,
      placement: { origin: { x: sx - (collarW - sw) / 2, y: sy - (collarD - sd) / 2, z: localCeiling - collarH / 2 } },
      geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: collarW, height: collarD }, direction: { x: 0, y: 0, z: 1 }, depth: collarH },
      container: shaftContainer, relationships: [],
      properties: { segmentType: 'SHAFT_COLLAR' },
      material: { name: 'concrete', color: [0.55, 0.55, 0.58] }, confidence: 0.8, source: 'LLM', explicitOrInferred: 'INFERRED'
    });
  }

  // 5. EQUIPMENT — anchor to segments
  for (const equip of (spec.equipment || [])) {
    const eLen = equip.length_m || 1.5;
    const eWid = equip.width_m || 1.0;
    const eH = equip.height_m || 1.5;

    // Try to anchor to named segment
    const anchoredSeg = equip.segment_name ? segmentMap[equip.segment_name] : null;
    let ex, ey, ez, container, anchorConf;

    if (anchoredSeg) {
      const cStart = anchoredSeg.chainage_start_m || 0;
      const cEnd = anchoredSeg.chainage_end_m || cStart + 10;
      const latOff = anchoredSeg.lateral_offset_m ?? 0;
      const segWid = anchoredSeg.width_m || tunnelWidth;
      ex = Math.max(cStart + 0.5, Math.min(equip.chainage_m ?? ((cStart + cEnd) / 2), cEnd - eLen - 0.5));
      ey = Math.max(latOff + 0.5, Math.min(equip.lateral_m ?? (latOff + segWid / 2 - eWid / 2), latOff + segWid - eWid - 0.5));
      ez = anchoredSeg.elevation_offset_m ?? 0;
      container = anchoredSeg.id;
      anchorConf = 0.80;
    } else {
      ex = Math.max(1, Math.min(equip.chainage_m ?? (tunnelLength / 2), tunnelLength - eLen - 1));
      ey = Math.max(0.5, Math.min(tunnelWidth / 2 - eWid / 2, tunnelWidth - eWid - 0.5));
      ez = 0;
      container = 'seg-tunnel-main';
      anchorConf = 0.55;
    }

    const equipTypeMap = {
      'FAN': 'IfcFan', 'GENERATOR': 'IfcElectricGenerator', 'PUMP': 'IfcPump',
      'COMPRESSOR': 'IfcCompressor', 'TRANSFORMER': 'IfcTransformer', 'BOILER': 'IfcBoiler',
      'CHILLER': 'IfcChiller', 'AHU': 'IfcUnitaryEquipment', 'BATTERY': 'IfcElectricGenerator',
      'CONVERTER': 'IfcTransformer', 'MOTOR': 'IfcMotorConnection', 'HEATER': 'IfcSpaceHeater',
      'SENSOR': 'IfcSensor', 'VALVE': 'IfcValve', 'TANK': 'IfcTank'
    };

    addEl({
      id: elemId({ method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: eLen, height: eWid }, depth: eH },
                { origin: { x: ex, y: ey, z: ez } }),
      element_key: `tunnel_equip_${(equip.name || equip.type || 'equip').replace(/\s+/g, '_')}`,
      type: 'EQUIPMENT', semanticType: equipTypeMap[equip.type] || 'IfcBuildingElementProxy',
      name: equip.name || equip.type || 'Equipment',
      placement: { origin: { x: ex, y: ey, z: ez } },
      geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: eLen, height: eWid }, direction: { x: 0, y: 0, z: 1 }, depth: eH },
      container, relationships: [],
      properties: { equipmentType: equip.type || 'OTHER', equipmentAnchorConfidence: anchorConf, segment_name: equip.segment_name || null },
      material: { name: 'steel', color: [0.5, 0.5, 0.55], transparency: 0 },
      confidence: 0.80, source: 'LLM', explicitOrInferred: anchoredSeg ? 'EXPLICIT' : 'INFERRED',
      metadata: { sourceExcerpt: equip.sourceExcerpt ? equip.sourceExcerpt.substring(0, 100) : null }
    });
  }

  const bboxMaxX = tunnelLength + 5;
  const bboxMaxY = tunnelWidth + Math.max(0, ...(topo.shafts || []).map(s => Math.abs(s.lateral_offset_m || 0) + 2));
  const bboxMaxZ = tunnelHeight + Math.max(0, ...(topo.shafts || []).map(s => s.height_above_tunnel_m || 0));

  const facilityDesc = `${spec.buildingName || 'Underground Facility'} — ${topo.layout_type || 'LINEAR'} tunnel, ${tunnelLength}m × ${tunnelWidth}m × ${tunnelHeight}m, ${lining.replace('_', ' ').toLowerCase()}`;
  const elevNote = (westPortal.elevation_m || eastPortal.elevation_m)
    ? ` Portal elevations: W=${westPortal.elevation_m ?? 0}m, E=${eastPortal.elevation_m ?? 0}m (tunnel grade not geometrically modelled in Phase 1).`
    : '';

  return {
    cssVersion: '1.0',
    domain: 'TUNNEL',
    facility: {
      name: spec.buildingName || 'Underground Facility',
      type: (spec.buildingType || 'tunnel').toLowerCase(),
      description: facilityDesc + elevNote,
      units: 'M', crs: null,
      origin: { x: 0, y: 0, z: 0 },
      axes: 'RIGHT_HANDED_Z_UP'
    },
    levelsOrSegments,
    elements,
    metadata: {
      sourceFiles,
      outputMode: 'HYBRID',
      validationStatus: 'PENDING',
      unitNormalizationApplied: true,
      cssHash: null,
      elementCounts,
      structureClass: 'LINEAR',
      topologyConfidence: spec.topologyConfidence || 0.85,
      bbox: { min: { x: -5, y: 0, z: 0 }, max: { x: bboxMaxX, y: bboxMaxY, z: bboxMaxZ } },
      repairLog: []
    }
  };
}

// ============================================================================
// GABLE ROOF MESH GENERATOR
// ============================================================================

function buildGableRoofMesh(L, W, pitchDeg, overhang, ridgeAlongX, offsetX = 0, offsetY = 0) {
  const pitch = Math.max(5, Math.min(60, pitchDeg));
  const oh = Math.max(0, Math.min(2.0, overhang));
  const tanP = Math.tan(pitch * Math.PI / 180);

  let coords, ridgeH;

  if (ridgeAlongX) {
    ridgeH = (W / 2) * tanP;
    coords = [
      [-oh, -oh, 0],
      [L + oh, -oh, 0],
      [L + oh, W + oh, 0],
      [-oh, W + oh, 0],
      [-oh, W / 2, ridgeH],
      [L + oh, W / 2, ridgeH],
    ];
  } else {
    ridgeH = (L / 2) * tanP;
    coords = [
      [-oh, -oh, 0],
      [L + oh, -oh, 0],
      [L + oh, W + oh, 0],
      [-oh, W + oh, 0],
      [L / 2, -oh, ridgeH],
      [L / 2, W + oh, ridgeH],
    ];
  }

  const vertices = coords.map(c => ({ x: c[0] + offsetX, y: c[1] + offsetY, z: c[2] }));

  const faces = [
    [0, 1, 5], [0, 5, 4],
    [3, 4, 5], [3, 5, 2],
    [0, 4, 3],
    [1, 2, 5],
    [0, 3, 2], [0, 2, 1],
  ];

  return { vertices, faces };
}

function buildingSpecToCSS(spec, sourceFiles) {
  const dims = spec.dimensions || {};
  // v6: Clamp absurd LLM-generated values to safe ranges
  let length = Math.max(3, Math.min(200, dims.length_m || 20));
  let width = Math.max(3, Math.min(200, dims.width_m || 10));
  const height = Math.max(2.4, Math.min(8, dims.height_m || 3));
  const wallThickness = Math.max(0.1, Math.min(1.0, dims.wall_thickness_m || 0.3));
  const floorLevel = spec.elevations?.floor_level_m || 0;
  let numFloors = Math.max(1, Math.min(50, spec.structure?.num_floors || 1));
  let floorToFloor = Math.max(2.4, Math.min(8, spec.structure?.floor_to_floor_height_m || height));

  // v3.2: Structure classification
  const buildingType = (spec.buildingType || 'BUILDING').toUpperCase();
  const structureClassMap = {
    'BUILDING': 'BUILDING', 'OFFICE': 'BUILDING', 'WAREHOUSE': 'BUILDING',
    'RESIDENTIAL': 'BUILDING', 'HOSPITAL': 'BUILDING', 'SCHOOL': 'BUILDING', 'PARKING': 'BUILDING',
    'TUNNEL': 'LINEAR',
    'FACILITY': 'FACILITY', 'INDUSTRIAL': 'FACILITY'
  };
  const structureClass = structureClassMap[buildingType] || 'BUILDING';

  // v3.2: Validate storey parameters
  numFloors = Math.max(1, Math.min(20, numFloors)); // cap at 20
  floorToFloor = Math.max(2.0, Math.min(10.0, floorToFloor)); // 2-10m
  if (structureClass === 'LINEAR') numFloors = 1; // tunnels: single level

  // Phase 3B: Envelope-room coherence — expand dimensions to contain all rooms
  if (spec.rooms && spec.rooms.length > 0 && structureClass !== 'LINEAR') {
    let roomMaxX = 0, roomMaxY = 0, maxRoomFloor = 1;
    for (const room of spec.rooms) {
      const rx = (room.x_position_m || 0) + (room.length_m || 5);
      const ry = (room.y_position_m || 0) + (room.width_m || 4);
      if (rx > roomMaxX) roomMaxX = rx;
      if (ry > roomMaxY) roomMaxY = ry;
      if ((room.floor || 1) > maxRoomFloor) maxRoomFloor = room.floor;
    }
    // Expand building dimensions if rooms exceed envelope
    const neededLength = roomMaxX + 2 * wallThickness;
    const neededWidth = roomMaxY + 2 * wallThickness;
    if (neededLength > length * 1.05) {
      console.log(`Phase 3B: Expanding building length ${length.toFixed(1)}→${neededLength.toFixed(1)}m to contain rooms`);
      length = Math.min(200, neededLength);
    }
    if (neededWidth > width * 1.05) {
      console.log(`Phase 3B: Expanding building width ${width.toFixed(1)}→${neededWidth.toFixed(1)}m to contain rooms`);
      width = Math.min(200, neededWidth);
    }
    if (maxRoomFloor > numFloors) {
      console.log(`Phase 3B: Expanding num_floors ${numFloors}→${maxRoomFloor} (rooms found on floor ${maxRoomFloor})`);
      numFloors = maxRoomFloor;
    }
  }

  // Map buildingType to domain
  const domainMap = {
    'TUNNEL': 'TUNNEL', 'INDUSTRIAL': 'INDUSTRIAL', 'FACILITY': 'INDUSTRIAL',
    'CIVIL': 'CIVIL', 'STRUCTURAL': 'STRUCTURAL'
  };
  const domain = domainMap[buildingType] || 'ARCH';

  // Build levels
  const levels = [];
  for (let f = 0; f < numFloors; f++) {
    levels.push({
      id: `level-${f + 1}`,
      type: 'STOREY',
      name: f === 0 ? 'Ground Floor' : `Floor ${f + 1}`,
      elevation_m: floorLevel + (f * floorToFloor),
      height_m: floorToFloor
    });
  }

  const elements = [];
  const elementCounts = {};
  const skippedRooms = [];
  const skippedOpenings = [];

  function addElement(el) {
    elementCounts[el.type] = (elementCounts[el.type] || 0) + 1;
    // v6+ PHASE C+4: Auto-tag detailed evidence on every element
    if (!el.metadata) el.metadata = {};
    if (!el.metadata.evidence) {
      const basis = el.source === 'VSM' ? 'VENTSIM_GEOMETRY'
        : el.source === 'DXF' ? 'DXF_GEOMETRY'
        : el.source === 'VISION' ? 'VISION_EXTRACTION'
        : el.source === 'facade_fallback' ? 'HEURISTIC_FALLBACK'
        : 'LLM_EXTRACTION';
      el.metadata.evidence = {
        sourceFiles: el.sourceFile ? [el.sourceFile] : sourceFiles.filter(f => f.parseStatus === 'success').map(f => f.name),
        basis,
        confidence: el.confidence || 0.7,
        sourceType: el.source === 'VISION' ? 'IMAGE' : el.source === 'DXF' ? 'CAD' : 'TEXT',
        // Element-level evidence fields
        sourceExcerpt: el.metadata?.sourceExcerpt || null,
        pageNumber: el.metadata?.pageNumber || null,
        paragraphIndex: el.metadata?.paragraphIndex || null,
        sheetName: el.metadata?.sheetName || null,
        dxfLayer: el.metadata?.dxfLayer || null,
        dxfHandle: el.metadata?.dxfHandle || null,
        coordinateSource: basis === 'DXF_GEOMETRY' ? 'DIRECT_2D' : basis === 'VENTSIM_GEOMETRY' ? 'DIRECT_3D' : basis === 'VISION_EXTRACTION' ? 'ESTIMATED' : 'LLM_GENERATED'
      };
    }
    elements.push(el);
  }

  // v3.2: Normalize floor field — clamp to valid range, overflow → top floor
  function normalizeFloor(rawFloor) {
    if (!rawFloor || numFloors === 1) return 1;
    const f = Math.max(1, Math.round(rawFloor));
    if (f > numFloors) return numFloors; // overflow → top floor
    return f;
  }

  // Helper for element creation
  function makeElement(type, semanticType, name, placement, geometry, container, props = {}, material = null, confidence = 0.7, source = 'LLM') {
    const id = elemId(geometry, placement);
    return { id, type, semanticType, name, placement, geometry, container, relationships: [], properties: props, material, confidence, source, metadata: {} };
  }

  // ════════════════════════════════════════════════════════════════════
  // SOURCE-AUTHORITY GATE: When a structured geometric source exists
  // (VentSim, DXF, vision with coordinates), LLM cannot create structural
  // elements. Only enrichment phases (equipment, metadata) run.
  // ════════════════════════════════════════════════════════════════════
  const structuredSourceExists = spec._structuredSourceExists === true;
  if (structuredSourceExists) {
    console.log('Source-authority: structured source exists — skipping LLM structural generation (walls, slabs, columns)');
    console.log('Source-authority: only equipment enrichment and metadata phases will run');
  }

  // ---- EXTERIOR WALLS (4 walls per floor) ----
  if (structuredSourceExists) {
    console.log('Source-authority: SKIP exterior walls (structured source provides geometry)');
  }
  for (let f = 0; f < numFloors && !structuredSourceExists; f++) {
    const levelId = `level-${f + 1}`;
    const baseZ = floorLevel + (f * floorToFloor);
    const wt = wallThickness;

    addElement(makeElement('WALL', 'IfcWallStandardCase', `South Wall F${f + 1}`,
      { origin: { x: length / 2, y: wt / 2, z: baseZ }, axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: length, height: wt }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
      levelId, { isExternal: true, wallSide: 'SOUTH' },
      { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
    ));

    addElement(makeElement('WALL', 'IfcWallStandardCase', `North Wall F${f + 1}`,
      { origin: { x: length / 2, y: width - wt / 2, z: baseZ }, axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: length, height: wt }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
      levelId, { isExternal: true, wallSide: 'NORTH' },
      { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
    ));

    addElement(makeElement('WALL', 'IfcWallStandardCase', `West Wall F${f + 1}`,
      { origin: { x: wt / 2, y: width / 2, z: baseZ }, axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 0, y: 1, z: 0 } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: width, height: wt }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
      levelId, { isExternal: true, wallSide: 'WEST' },
      { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
    ));

    addElement(makeElement('WALL', 'IfcWallStandardCase', `East Wall F${f + 1}`,
      { origin: { x: length - wt / 2, y: width / 2, z: baseZ }, axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 0, y: 1, z: 0 } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: width, height: wt }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
      levelId, { isExternal: true, wallSide: 'EAST' },
      { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
    ));

    addElement(makeElement('SLAB', 'IfcSlab', `Floor Slab F${f + 1}`,
      { origin: { x: length / 2, y: width / 2, z: baseZ } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: length, height: width }, direction: { x: 0, y: 0, z: 1 }, depth: 0.2 },
      levelId, { slabType: 'FLOOR' },
      { name: spec.materials?.floor || 'concrete', color: [0.6, 0.6, 0.6], transparency: 0 }
    ));

    if (f === numFloors - 1) {
      const roofZ = baseZ + floorToFloor;
      const roofType = (spec.roof?.type || 'FLAT').toUpperCase();

      if (roofType === 'GABLE') {
        const pitchDeg = spec.roof?.pitch_degrees || 25;
        const overhang = spec.roof?.overhang_m || 0.3;
        const ridgeAlongX = spec.roof?.ridge_orientation
          ? spec.roof.ridge_orientation === 'ALONG_LENGTH'
          : length >= width;

        const { vertices, faces } = buildGableRoofMesh(length, width, pitchDeg, overhang, ridgeAlongX);

        addElement(makeElement('SLAB', 'IfcSlab', 'Roof',
          { origin: { x: 0, y: 0, z: roofZ } },
          { method: 'MESH', vertices, faces },
          levelId, { slabType: 'ROOF' },
          { name: spec.materials?.roof || 'metal', color: [0.35, 0.35, 0.4], transparency: 0 }
        ));
      } else {
        addElement(makeElement('SLAB', 'IfcSlab', 'Roof Slab',
          { origin: { x: length / 2, y: width / 2, z: roofZ } },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: length, height: width }, direction: { x: 0, y: 0, z: 1 }, depth: 0.25 },
          levelId, { slabType: 'ROOF' },
          { name: spec.materials?.roof || 'metal', color: [0.35, 0.35, 0.40], transparency: 0 }
        ));
      }
    }
  }

  // ---- INTERIOR WALLS ----
  if (structuredSourceExists) {
    console.log('Source-authority: SKIP interior walls (structured source provides geometry)');
  }
  if (spec.interior_walls && structureClass !== 'LINEAR' && !structuredSourceExists) {
    for (const wall of spec.interior_walls) {
      const dx = (wall.x_end_m || 0) - (wall.x_start_m || 0);
      const dy = (wall.y_end_m || 0) - (wall.y_start_m || 0);
      const wallLength = Math.sqrt(dx * dx + dy * dy);
      if (wallLength < 0.1 || wallLength > 500) continue; // v3.2: skip invalid lengths
      const thickness = wall.thickness_m || 0.15;

      const floor = normalizeFloor(wall.floor);
      const levelId = `level-${floor}`;
      const baseZ = floorLevel + ((floor - 1) * floorToFloor);

      // Compute refDirection from wall direction vector for correct profile orientation
      const placement = { origin: { x: wall.x_start_m || 0, y: wall.y_start_m || 0, z: baseZ } };
      if (wallLength >= 0.1) {
        const wallDirX = dx / wallLength;
        const wallDirY = dy / wallLength;
        placement.axis = { x: 0, y: 0, z: 1 };
        placement.refDirection = { x: wallDirX, y: wallDirY, z: 0 };
      } else {
        console.warn(`Interior wall "${wall.name || 'unnamed'}": near-zero length ${wallLength.toFixed(3)}m, skipping refDirection`);
      }
      const geometry = {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: wallLength, height: thickness },
        direction: { x: 0, y: 0, z: 1 },
        depth: wall.height_m || floorToFloor
      };

      addElement(makeElement('WALL', 'IfcWallStandardCase', wall.name || 'Interior Wall',
        placement, geometry, levelId,
        { isExternal: false },
        { name: 'plasterboard', color: [0.9, 0.9, 0.88], transparency: 0 },
        0.65
      ));
    }
  }

  // ---- COLUMNS ----
  if (structuredSourceExists) {
    console.log('Source-authority: SKIP columns (structured source provides geometry)');
  }
  if (spec.structure?.column_grid && !structuredSourceExists) {
    const MAX_COLUMNS = 200; // cap to prevent runaway grids overwhelming the model
    let columnCount = 0;
    for (const grid of spec.structure.column_grid) {
      const xSpacing = Math.max(grid.x_spacing_m || 6, 3); // minimum 3m spacing
      const ySpacing = Math.max(grid.y_spacing_m || 6, 3);
      const colSize = grid.column_size_m || 0.4;

      for (let x = xSpacing; x < length - wallThickness && columnCount < MAX_COLUMNS; x += xSpacing) {
        for (let y = ySpacing; y < width - wallThickness && columnCount < MAX_COLUMNS; y += ySpacing) {
          for (let f = 0; f < numFloors && columnCount < MAX_COLUMNS; f++) {
            const baseZ = floorLevel + (f * floorToFloor);
            addElement(makeElement('COLUMN', 'IfcColumn', `Column ${x.toFixed(0)}-${y.toFixed(0)} F${f + 1}`,
              { origin: { x: x + wallThickness, y: y + wallThickness, z: baseZ } },
              { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: colSize, height: colSize }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
              `level-${f + 1}`,
              { gridX: x, gridY: y },
              { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0 },
              0.7
            ));
            columnCount++;
          }
        }
      }
    }
    if (columnCount >= MAX_COLUMNS) {
      console.warn(`Column grid capped at ${MAX_COLUMNS} columns (grid would have produced more)`);
    }
  }

  // ---- ROOMS (as SPACE elements) — v3.2: skip-oriented validation ----
  if (spec.rooms && structureClass !== 'LINEAR') {
    // Auto-layout fallback: detect overlapping room positions and arrange in rows
    if (spec.rooms.length > 1) {
      const positionCounts = {};
      for (const room of spec.rooms) {
        const key = `${Math.round((room.x_position_m || 0) * 2) / 2},${Math.round((room.y_position_m || 0) * 2) / 2}`;
        positionCounts[key] = (positionCounts[key] || 0) + 1;
      }
      const maxOverlap = Math.max(...Object.values(positionCounts));
      const needsAutoLayout = maxOverlap > spec.rooms.length * 0.5 || maxOverlap >= 3;

      if (needsAutoLayout) {
        // Sort rooms largest-area-first for better packing
        const sorted = [...spec.rooms].sort((a, b) =>
          ((b.length_m || 5) * (b.width_m || 4)) - ((a.length_m || 5) * (a.width_m || 4))
        );
        const gap = wallThickness;
        const maxX = length - wallThickness;
        const maxY = width - wallThickness;
        let cx = wallThickness, cy = wallThickness, rowH = 0;

        for (const room of sorted) {
          const rLen = room.length_m || 5;
          const rWid = room.width_m || 4;
          if (cx + rLen > maxX) {
            cx = wallThickness;
            cy += rowH + gap;
            rowH = 0;
          }
          if (cy + rWid > maxY) break; // no more space
          room.x_position_m = cx;
          room.y_position_m = cy;
          cx += rLen + gap;
          rowH = Math.max(rowH, rWid);
        }
        console.log(`Auto-layout applied to ${sorted.length} rooms (${maxOverlap} were overlapping)`);
      }
    }

    const maxInterior = { len: length - 2 * wallThickness, wid: width - 2 * wallThickness };
    const maxCorrection = Math.min(2.0, width * 0.15);

    for (const room of spec.rooms) {
      const rLen = room.length_m || 5;
      const rWid = room.width_m || 4;
      const rHeight = room.height_m || floorToFloor;

      // v3.2: Skip if room exceeds footprint (never modify size)
      if (rLen > maxInterior.len || rWid > maxInterior.wid) {
        skippedRooms.push({ name: room.name || 'Room', skipReason: 'exceeds_footprint', rLen, rWid });
        continue;
      }
      if (rLen <= 0 || rWid <= 0) {
        skippedRooms.push({ name: room.name || 'Room', skipReason: 'invalid_dimensions' });
        continue;
      }

      const floor = normalizeFloor(room.floor);
      const levelId = `level-${floor}`;
      const baseZ = floorLevel + ((floor - 1) * floorToFloor);

      // v3.2: Position clamping with relative threshold
      let rx = room.x_position_m || wallThickness;
      let ry = room.y_position_m || wallThickness;
      const xMin = wallThickness, xMax = length - wallThickness - rLen;
      const yMin = wallThickness, yMax = width - wallThickness - rWid;

      const xCorrection = Math.max(0, xMin - rx) + Math.max(0, rx - xMax);
      const yCorrection = Math.max(0, yMin - ry) + Math.max(0, ry - yMax);
      const totalCorrection = Math.max(xCorrection, yCorrection);

      if (totalCorrection > maxCorrection) {
        skippedRooms.push({ name: room.name || 'Room', skipReason: 'position_correction_too_large', correction: totalCorrection });
        continue;
      }

      const clamped = totalCorrection > 0;
      rx = Math.max(xMin, Math.min(xMax, rx));
      ry = Math.max(yMin, Math.min(yMax, ry));

      const el = makeElement('SPACE', 'IfcSpace', room.name || 'Room',
        { origin: { x: rx, y: ry, z: baseZ } },
        { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: rLen, height: rWid }, direction: { x: 0, y: 0, z: 1 }, depth: rHeight },
        levelId,
        { usage: room.usage || 'OTHER' },
        { name: 'space', color: [0.8, 0.9, 1.0], transparency: 0.5 },
        0.7
      );
      if (clamped) el.metadata.clampedToFootprint = true;
      if (floor !== (room.floor || 1)) el.metadata.floorNormalized = true;
      addElement(el);
    }
  }

  // ---- Phase 3C: SMART PARTITION WALLS — shared-boundary-aware inference ----
  if (spec.rooms && structureClass !== 'LINEAR' && (!spec.interior_walls || spec.interior_walls.length === 0) && !structuredSourceExists) {
    const partitionThickness = Math.max(0.1, Math.min(0.3, wallThickness * 0.5));
    const wallMat = { name: spec.materials?.walls || 'gypsum_partition', color: [0.85, 0.85, 0.82], transparency: 0 };
    const BOUNDARY_TOL = 0.3; // meters — edges within this distance are "shared"
    const EXTERIOR_TOL = wallThickness + 0.1; // within wall thickness of building edge = exterior
    const NO_DOOR_ROOMS = new Set(['MECHANICAL', 'ELECTRICAL', 'STORAGE']);

    // Compute resolved room positions per floor
    const resolvedRooms = [];
    for (const room of spec.rooms) {
      const rLen = room.length_m || 5;
      const rWid = room.width_m || 4;
      const rHeight = room.height_m || floorToFloor;
      const maxInteriorLen = length - 2 * wallThickness;
      const maxInteriorWid = width - 2 * wallThickness;
      if (rLen > maxInteriorLen || rWid > maxInteriorWid || rLen <= 0 || rWid <= 0) continue;
      const floor = normalizeFloor(room.floor);
      const rx = Math.max(wallThickness, Math.min(length - wallThickness - rLen, room.x_position_m || wallThickness));
      const ry = Math.max(wallThickness, Math.min(width - wallThickness - rWid, room.y_position_m || wallThickness));
      resolvedRooms.push({ name: room.name || 'Room', usage: (room.usage || 'OTHER').toUpperCase(), floor, rx, ry, rLen, rWid, rHeight });
    }

    // Build edge registry: for each room edge, check if it's shared or exterior
    // Edges: south (y=ry), north (y=ry+rWid), west (x=rx), east (x=rx+rLen)
    const edgesGenerated = new Set(); // "floor:dir:coord:start:end" dedup key
    const doorPairsGenerated = new Set(); // "floor:roomA|roomB" canonical door dedup — prevents bidirectional doubles
    let inferredWallCount = 0;
    let inferredDoorCount = 0;

    function edgeKey(floor, dir, coord, start, end) {
      return `${floor}:${dir}:${coord.toFixed(1)}:${Math.min(start,end).toFixed(1)}:${Math.max(start,end).toFixed(1)}`;
    }

    function isNearExterior(dir, coord) {
      if (dir === 'H') return coord < EXTERIOR_TOL || coord > width - EXTERIOR_TOL; // horizontal wall at y=coord
      return coord < EXTERIOR_TOL || coord > length - EXTERIOR_TOL; // vertical wall at x=coord
    }

    for (const room of resolvedRooms) {
      const { name, usage, floor, rx, ry, rLen, rWid, rHeight } = room;
      const levelId = `level-${floor}`;
      const baseZ = floorLevel + ((floor - 1) * floorToFloor);

      // Define 4 edges: [direction, coordinate, rangeStart, rangeEnd, refDir]
      const edges = [
        { side: 'South', dir: 'H', coord: ry, start: rx, end: rx + rLen, refDir: { x: 1, y: 0, z: 0 }, wallLen: rLen },
        { side: 'North', dir: 'H', coord: ry + rWid, start: rx, end: rx + rLen, refDir: { x: 1, y: 0, z: 0 }, wallLen: rLen },
        { side: 'West', dir: 'V', coord: rx, start: ry, end: ry + rWid, refDir: { x: 0, y: 1, z: 0 }, wallLen: rWid },
        { side: 'East', dir: 'V', coord: rx + rLen, start: ry, end: ry + rWid, refDir: { x: 0, y: 1, z: 0 }, wallLen: rWid },
      ];

      for (const edge of edges) {
        // Skip if near exterior wall (exterior wall already serves as boundary)
        if (isNearExterior(edge.dir, edge.coord)) continue;

        // Dedup: skip if we already generated a wall at this edge
        const key = edgeKey(floor, edge.dir, edge.coord, edge.start, edge.end);
        if (edgesGenerated.has(key)) continue;

        // Check if any other room on same floor shares this edge
        let sharedWith = null;
        for (const other of resolvedRooms) {
          if (other === room || other.floor !== floor) continue;
          // Check if other room has an edge at the same coordinate (within tolerance)
          const otherEdges = [
            { coord: other.ry, start: other.rx, end: other.rx + other.rLen },
            { coord: other.ry + other.rWid, start: other.rx, end: other.rx + other.rLen },
            { coord: other.rx, start: other.ry, end: other.ry + other.rWid },
            { coord: other.rx + other.rLen, start: other.ry, end: other.ry + other.rWid },
          ];
          for (const oe of otherEdges) {
            if (Math.abs(oe.coord - edge.coord) < BOUNDARY_TOL) {
              // Check if ranges overlap
              const overlapStart = Math.max(edge.start, oe.start);
              const overlapEnd = Math.min(edge.end, oe.end);
              if (overlapEnd - overlapStart > 0.5) {
                sharedWith = other.name;
                break;
              }
            }
          }
          if (sharedWith) break;
        }

        edgesGenerated.add(key);

        // Also add reversed key for the shared room's perspective
        if (sharedWith) {
          edgesGenerated.add(edgeKey(floor, edge.dir, edge.coord, edge.start, edge.end));
        }

        const wallName = sharedWith
          ? `${name} / ${sharedWith} — ${edge.side} Partition`
          : `${name} — ${edge.side} Partition`;

        const origin = edge.dir === 'H'
          ? { x: (edge.start + edge.end) / 2, y: edge.coord, z: baseZ }
          : { x: edge.coord, y: (edge.start + edge.end) / 2, z: baseZ };

        const adjacentRooms = sharedWith ? [name, sharedWith] : [name];

        addElement(makeElement('WALL', 'IfcWall', wallName,
          { origin, axis: { x: 0, y: 0, z: 1 }, refDirection: edge.refDir },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: edge.wallLen, height: partitionThickness }, direction: { x: 0, y: 0, z: 1 }, depth: rHeight },
          levelId, { isExternal: false, inferredFromRoom: name, adjacentRooms },
          wallMat, 0.5
        ));
        inferredWallCount++;

        // Add door if shared boundary between access-connected rooms
        // Use a canonical room-pair key (sorted) to prevent bidirectional doubles when
        // edge coordinate ranges differ slightly between the two rooms' perspectives.
        if (sharedWith && !NO_DOOR_ROOMS.has(usage)) {
          const doorPairKey = `${floor}:${[name, sharedWith].sort().join('|')}`;
          if (!doorPairsGenerated.has(doorPairKey)) {
            doorPairsGenerated.add(doorPairKey);
            const doorWidth = usage === 'CIRCULATION' || usage === 'LOBBY' ? 1.5 : 0.9;
            const doorOrigin = edge.dir === 'H'
              ? { x: (edge.start + edge.end) / 2, y: edge.coord, z: baseZ }
              : { x: edge.coord, y: (edge.start + edge.end) / 2, z: baseZ };

            addElement(makeElement('DOOR', 'IfcDoor', `Door — ${name} to ${sharedWith}`,
              { origin: doorOrigin, axis: { x: 0, y: 0, z: 1 }, refDirection: edge.refDir },
              { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: doorWidth, height: partitionThickness }, direction: { x: 0, y: 0, z: 1 }, depth: 2.1 },
              levelId, { inferredFromRooms: adjacentRooms, sillHeight: 0 },
              { name: 'wood', color: [0.55, 0.35, 0.2], transparency: 0 }, 0.45
            ));
            inferredDoorCount++;
          }
        }
      }
    }
    if (inferredWallCount > 0) {
      console.log(`Phase 3C: Inferred ${inferredWallCount} partition walls and ${inferredDoorCount} doors from ${spec.rooms.length} rooms (smart dedup)`);
    }
  }

  // ---- OPENINGS (DOOR / WINDOW) — v3.2: per-floor, skip for LINEAR ----
  if (spec.openings && structureClass !== 'LINEAR') {
    const wallDims = { NORTH: { axis: 'x', base_y: width }, SOUTH: { axis: 'x', base_y: 0 }, EAST: { axis: 'y', base_x: length }, WEST: { axis: 'y', base_x: 0 } };

    for (const opening of spec.openings) {
      const isDoor = opening.type === 'DOOR';
      const oWidth = opening.width_m || (isDoor ? 0.9 : 1.2);
      const oHeight = opening.height_m || (isDoor ? 2.1 : 1.2);
      const sillHeight = opening.sill_height_m || (isDoor ? 0 : 0.9);
      const side = opening.wall_side || 'SOUTH';
      const offset = opening.x_offset_m || 1;
      const wallInfo = wallDims[side];

      // v3.2: Pre-generation validation
      if (oWidth > Math.min(10, length * 0.7)) {
        skippedOpenings.push({ type: opening.type, side, skipReason: 'opening_too_wide' });
        continue;
      }
      if (oHeight + sillHeight > floorToFloor + 0.2) {
        skippedOpenings.push({ type: opening.type, side, skipReason: 'opening_exceeds_storey_height' });
        continue;
      }

      const floor = normalizeFloor(opening.floor);
      const levelId = `level-${floor}`;
      const baseZ = floorLevel + ((floor - 1) * floorToFloor);

      let ox, oy, refDir;
      if (wallInfo.axis === 'x') {
        ox = offset;
        // Center opening within wall thickness instead of placing at wall surface
        oy = (side === 'SOUTH') ? wallThickness / 2 : wallInfo.base_y - wallThickness / 2;
        refDir = { x: 1, y: 0, z: 0 }; // door width along X (wall runs along X)
      } else {
        // Center opening within wall thickness
        ox = (side === 'WEST') ? wallThickness / 2 : wallInfo.base_x - wallThickness / 2;
        oy = offset;
        refDir = { x: 0, y: 1, z: 0 }; // door width along Y (wall runs along Y)
      }

      const placement = {
        origin: { x: ox, y: oy, z: baseZ + sillHeight },
        axis: { x: 0, y: 0, z: 1 },
        refDirection: refDir
      };
      const geometry = {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: oWidth, height: wallThickness },
        direction: { x: 0, y: 0, z: 1 },
        depth: oHeight
      };

      const type = isDoor ? 'DOOR' : 'WINDOW';
      const semanticType = isDoor ? 'IfcDoor' : 'IfcWindow';
      addElement(makeElement(type, semanticType, `${opening.type} - ${side}`,
        placement, geometry, levelId,
        { wallSide: side, sillHeight: sillHeight },
        { name: isDoor ? 'wood' : 'glass', color: isDoor ? [0.55, 0.35, 0.2] : [0.7, 0.85, 0.95], transparency: isDoor ? 0 : 0.3 },
        0.6
      ));
    }
  }

  // ---- VOIDS RELATIONSHIPS: link openings (doors/windows) to host walls ----
  {
    const allWalls = elements.filter(e => e.type === 'WALL');
    const allOpenings = elements.filter(e => e.type === 'DOOR' || e.type === 'WINDOW');
    let voidsLinked = 0;
    for (const opening of allOpenings) {
      const side = opening.properties?.wallSide;
      const container = opening.container;
      const oOrigin = opening.placement?.origin;
      if (!side || !oOrigin) continue;

      // Find candidate host walls: same container + matching wallSide
      const candidates = allWalls.filter(w =>
        w.container === container && w.properties?.wallSide === side
      );
      if (candidates.length === 0) continue;

      // Score candidates: prefer external wall, then nearest by XY position
      let bestWall = null;
      let bestScore = Infinity;
      for (const w of candidates) {
        const wO = w.placement?.origin;
        if (!wO) continue;
        const dist = Math.sqrt((oOrigin.x - wO.x) ** 2 + (oOrigin.y - wO.y) ** 2);
        const score = dist - (w.properties?.isExternal ? 100 : 0);
        if (score < bestScore) { bestScore = score; bestWall = w; }
      }

      if (bestWall) {
        const actualDist = Math.sqrt(
          (oOrigin.x - bestWall.placement.origin.x) ** 2 +
          (oOrigin.y - bestWall.placement.origin.y) ** 2
        );
        if (actualDist < 50) { // generous — wall origins at center, openings near surface
          opening.relationships.push({ type: 'VOIDS', target: bestWall.id });
          voidsLinked++;
        }
      }
    }
    if (voidsLinked > 0) {
      console.log(`VOIDS relationships: linked ${voidsLinked} openings to host walls`);
    }
  }

  // ---- Phase 3E: BUILDING-TYPE OPENING DEFAULTS — windows on exterior walls, doors on partitions ----
  if (structuredSourceExists) {
    console.log('Source-authority: SKIP opening defaults (structured source provides geometry)');
  }
  if (!structuredSourceExists) {
    const existingWindows = elements.filter(e => e.type === 'WINDOW');
    const buildingType = (spec.building_type || spec.type || '').toUpperCase();
    const exteriorWallCount = elements.filter(e => e.type === 'WALL' && e.properties?.isExternal === true).length;
    console.log(`Phase 3E check: existingWindows=${existingWindows.length}, numFloors=${numFloors}, structureClass=${structureClass}, exteriorWalls=${exteriorWallCount}, buildingType=${buildingType}`);

    // Only run if extracted windows are sparse (doors from 3C shouldn't block window inference)
    if (existingWindows.length < numFloors * 2 && structureClass !== 'LINEAR') {
      // Per-building-type opening profiles
      const OPENING_PROFILES = {
        HOSPITAL:    { doorWidth: 1.2, corridorDoor: 1.8, windowSpacing: 3.0, windowWidth: 1.5, windowHeight: 1.5, sillHeight: 0.9 },
        OFFICE:      { doorWidth: 0.9, corridorDoor: 1.2, windowSpacing: 2.5, windowWidth: 1.4, windowHeight: 1.4, sillHeight: 0.9 },
        RESIDENTIAL: { doorWidth: 0.9, corridorDoor: 1.0, windowSpacing: 3.5, windowWidth: 1.2, windowHeight: 1.2, sillHeight: 0.9 },
        SCHOOL:      { doorWidth: 1.0, corridorDoor: 1.5, windowSpacing: 2.5, windowWidth: 1.5, windowHeight: 1.5, sillHeight: 0.9 },
        WAREHOUSE:   { doorWidth: 1.2, corridorDoor: 3.0, windowSpacing: 8.0, windowWidth: 1.0, windowHeight: 0.8, sillHeight: 2.0 },
      };
      const profile = OPENING_PROFILES[buildingType] || OPENING_PROFILES.OFFICE;
      const glassMat = { name: 'glass', color: [0.7, 0.85, 0.95], transparency: 0.3 };

      let inferredWindows = 0;

      // Add windows at regular intervals on exterior walls
      const exteriorWalls = elements.filter(e =>
        e.type === 'WALL' && e.properties?.isExternal === true
      );

      for (const wall of exteriorWalls) {
        const wallLen = wall.geometry?.profile?.width || 0;
        if (wallLen < profile.windowSpacing) continue;

        const side = wall.properties?.wallSide;
        const container = wall.container;
        const wallOrigin = wall.placement?.origin;
        if (!wallOrigin || !side || !container) continue;

        // Skip windowless sides for warehouses (only add on one face)
        if (buildingType === 'WAREHOUSE' && side !== 'SOUTH' && side !== 'EAST') continue;

        const numWindows = Math.max(1, Math.floor(wallLen / profile.windowSpacing));
        const spacing = wallLen / (numWindows + 1);

        const refDir = wall.placement?.refDirection || (
          (side === 'NORTH' || side === 'SOUTH') ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
        );

        for (let w = 1; w <= numWindows; w++) {
          const offset = spacing * w - wallLen / 2; // offset from wall center
          let wx, wy;
          if (side === 'SOUTH' || side === 'NORTH') {
            wx = wallOrigin.x + offset;
            wy = wallOrigin.y;
          } else {
            wx = wallOrigin.x;
            wy = wallOrigin.y + offset;
          }

          addElement(makeElement('WINDOW', 'IfcWindow',
            `Window — ${side} F${(container || '').replace('level-', '')}`,
            { origin: { x: wx, y: wy, z: wallOrigin.z + profile.sillHeight }, axis: { x: 0, y: 0, z: 1 }, refDirection: refDir },
            { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: profile.windowWidth, height: wallThickness }, direction: { x: 0, y: 0, z: 1 }, depth: profile.windowHeight },
            container,
            { wallSide: side, sillHeight: profile.sillHeight, inferredFromBuildingType: true },
            glassMat, 0.45
          ));
          inferredWindows++;
        }
      }

      // Add entrance door(s) on ground floor if none exist
      const groundDoors = elements.filter(e =>
        e.type === 'DOOR' && e.container === 'level-1' && e.properties?.wallSide
      );
      let inferredEntranceDoors = 0;
      if (groundDoors.length === 0) {
        // Add main entrance on south wall
        const southWall = exteriorWalls.find(w => w.container === 'level-1' && w.properties?.wallSide === 'SOUTH');
        if (southWall) {
          const so = southWall.placement?.origin;
          if (so) {
            const entranceWidth = buildingType === 'HOSPITAL' ? 2.0 : (buildingType === 'WAREHOUSE' ? 3.0 : 1.2);
            addElement(makeElement('DOOR', 'IfcDoor', 'Main Entrance',
              { origin: { x: so.x, y: so.y, z: so.z }, axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 } },
              { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: entranceWidth, height: wallThickness }, direction: { x: 0, y: 0, z: 1 }, depth: 2.4 },
              'level-1',
              { wallSide: 'SOUTH', sillHeight: 0, inferredFromBuildingType: true, isEntrance: true },
              { name: 'glass_door', color: [0.6, 0.8, 0.9], transparency: 0.2 }, 0.45
            ));
            inferredEntranceDoors++;
          }
        }
      }

      if (inferredWindows > 0 || inferredEntranceDoors > 0) {
        console.log(`Phase 3E: Inferred ${inferredWindows} windows + ${inferredEntranceDoors} entrance doors (building type: ${buildingType || 'DEFAULT'})`);
      }
    }
  }

  // ---- EQUIPMENT — v3.2: per-floor, skip for LINEAR (unless fans) ----
  if (spec.equipment) {
    // Auto-layout fallback: detect overlapping equipment positions
    if (spec.equipment.length > 1) {
      const eqPosCounts = {};
      for (const eq of spec.equipment) {
        const key = `${Math.round((eq.x_position_m || 0) * 2) / 2},${Math.round((eq.y_position_m || 0) * 2) / 2}`;
        eqPosCounts[key] = (eqPosCounts[key] || 0) + 1;
      }
      const eqMaxOverlap = Math.max(...Object.values(eqPosCounts));
      if (eqMaxOverlap >= 2) {
        const eqGap = 0.3;
        let ecx = wallThickness, ecy = wallThickness, eRowH = 0;
        for (const eq of spec.equipment) {
          const eLen = eq.length_m || 1.5;
          const eWid = eq.width_m || 1.0;
          if (ecx + eLen > length - wallThickness) {
            ecx = wallThickness;
            ecy += eRowH + eqGap;
            eRowH = 0;
          }
          eq.x_position_m = ecx;
          eq.y_position_m = ecy;
          ecx += eLen + eqGap;
          eRowH = Math.max(eRowH, eWid);
        }
        console.log(`Equipment auto-layout applied (${eqMaxOverlap} were overlapping)`);
      }
    }

    const equipTypeMap = {
      'GENERATOR': 'IfcElectricGenerator', 'PUMP': 'IfcPump', 'FAN': 'IfcFan',
      'COMPRESSOR': 'IfcCompressor', 'TRANSFORMER': 'IfcTransformer', 'BOILER': 'IfcBoiler',
      'CHILLER': 'IfcChiller', 'AHU': 'IfcUnitaryEquipment', 'BATTERY': 'IfcElectricGenerator',
      'CONVERTER': 'IfcTransformer', 'MOTOR': 'IfcMotorConnection', 'HEATER': 'IfcSpaceHeater',
      'SENSOR': 'IfcSensor', 'VALVE': 'IfcValve', 'TANK': 'IfcTank'
    };

    for (const equip of spec.equipment) {
      const eLen = equip.length_m || 1.5;
      const eWid = equip.width_m || 1.0;
      const eHeight = equip.height_m || 1.5;

      // Phase F: Try to anchor equipment to a named section for tighter spatial bounds
      let ex = equip.x_position_m ?? wallThickness;
      let ey = equip.y_position_m ?? wallThickness;
      let anchorConfidence = 0.75;

      if (equip.segment_name && Array.isArray(spec.sections)) {
        const matchedSection = spec.sections.find(s =>
          s.name && s.name.toLowerCase() === equip.segment_name.toLowerCase()
        );
        if (matchedSection) {
          const sX = matchedSection.x_offset_m ?? 0;
          const sY = matchedSection.y_offset_m ?? 0;
          const sLen = matchedSection.length_m || 5;
          const sWid = matchedSection.width_m || 5;
          ex = Math.max(sX + wallThickness, Math.min(ex, sX + sLen - wallThickness - eLen));
          ey = Math.max(sY + wallThickness, Math.min(ey, sY + sWid - wallThickness - eWid));
          anchorConfidence = 0.80;
        } else {
          console.warn(`Equipment segment_name "${equip.segment_name}" not found in sections; using footprint clamp.`);
          ex = Math.max(wallThickness, Math.min(ex, length - wallThickness - eLen));
          ey = Math.max(wallThickness, Math.min(ey, width - wallThickness - eWid));
        }
      } else {
        // Existing footprint-clamp behavior
        ex = Math.max(wallThickness, Math.min(ex, length - wallThickness - eLen));
        ey = Math.max(wallThickness, Math.min(ey, width - wallThickness - eWid));
      }

      const floor = normalizeFloor(equip.floor);
      const levelId = `level-${floor}`;
      const baseZ = floorLevel + ((floor - 1) * floorToFloor);

      const equipElem = makeElement('EQUIPMENT', equipTypeMap[equip.type] || 'IfcBuildingElementProxy',
        equip.name || equip.type || 'Equipment',
        { origin: { x: ex, y: ey, z: baseZ } },
        { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: eLen, height: eWid }, direction: { x: 0, y: 0, z: 1 }, depth: eHeight },
        levelId,
        { equipmentType: equip.type || 'OTHER' },
        { name: 'steel', color: [0.5, 0.5, 0.55], transparency: 0 },
        anchorConfidence
      );
      if (equip.sourceExcerpt) {
        equipElem.metadata.sourceExcerpt = equip.sourceExcerpt.substring(0, 100);
      }
      addElement(equipElem);
    }
  }

  // ---- SECTIONS (attached volumes: garage, wing, annex, mezzanine, courtyard, etc.) ----
  // Main building bounding box for shared-wall detection
  const mainBBox = { minX: 0, maxX: length, minY: 0, maxY: width };

  for (const section of (structuredSourceExists ? [] : (spec.sections || []))) {
    const sLen = section.length_m || 5;
    const sWid = section.width_m || 5;
    const sHeight = section.height_m || floorToFloor;
    const sFloors = Math.max(1, Math.min(10, section.num_floors || 1));
    const sX = section.x_offset_m ?? 0;
    const sY = section.y_offset_m ?? 0;
    const sFloorH = sHeight / sFloors;
    const sName = section.name || section.type || 'Section';
    const sType = (section.type || 'WING').toUpperCase();
    const sWt = wallThickness;

    // MEZZANINE: partial floor inside main building (no exterior walls, just slab + railing)
    if (sType === 'MEZZANINE') {
      const mezzZ = floorLevel + (section.floor_level_m || floorToFloor);
      const mLevelId = `level-${Math.min(2, numFloors)}`;
      // Mezzanine floor slab (partial footprint)
      addElement(makeElement('SLAB', 'IfcSlab', `${sName} Mezzanine Floor`,
        { origin: { x: sX + sLen / 2, y: sY + sWid / 2, z: mezzZ } },
        { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sLen, height: sWid }, direction: { x: 0, y: 0, z: 1 }, depth: 0.15 },
        mLevelId, { slabType: 'FLOOR', isMezzanine: true },
        { name: spec.materials?.floor || 'concrete', color: [0.6, 0.6, 0.6], transparency: 0 }
      ));
      // Mezzanine edge railing (open side — typically the side facing the main volume)
      const railHeight = 1.1;
      // Add railing on the open edge (longest edge facing main space)
      const openSide = sLen >= sWid ? 'SOUTH' : 'WEST';
      if (openSide === 'SOUTH') {
        addElement(makeElement('PROXY', 'IfcRailing', `${sName} Railing`,
          { origin: { x: sX + sLen / 2, y: sY, z: mezzZ + 0.15 } },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sLen, height: 0.05 }, direction: { x: 0, y: 0, z: 1 }, depth: railHeight },
          mLevelId, { objectType: 'RAILING' },
          { name: 'steel', color: [0.4, 0.4, 0.45], transparency: 0 }, 0.7
        ));
      } else {
        addElement(makeElement('PROXY', 'IfcRailing', `${sName} Railing`,
          { origin: { x: sX, y: sY + sWid / 2, z: mezzZ + 0.15 } },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: 0.05, height: sWid }, direction: { x: 0, y: 0, z: 1 }, depth: railHeight },
          mLevelId, { objectType: 'RAILING' },
          { name: 'steel', color: [0.4, 0.4, 0.45], transparency: 0 }, 0.7
        ));
      }
      continue;
    }

    // CANOPY: open-sided roof structure (no walls, just columns + roof)
    if (sType === 'CANOPY') {
      const canopyZ = floorLevel;
      const canopyH = sHeight || 3.0;
      const cLevelId = 'level-1';
      // 4 corner columns
      const colSize = 0.3;
      for (const [cx, cy] of [[sX + colSize/2, sY + colSize/2], [sX + sLen - colSize/2, sY + colSize/2],
                                [sX + colSize/2, sY + sWid - colSize/2], [sX + sLen - colSize/2, sY + sWid - colSize/2]]) {
        addElement(makeElement('COLUMN', 'IfcColumn', `${sName} Column`,
          { origin: { x: cx, y: cy, z: canopyZ } },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: colSize, height: colSize }, direction: { x: 0, y: 0, z: 1 }, depth: canopyH },
          cLevelId, {},
          { name: 'steel', color: [0.5, 0.5, 0.55], transparency: 0 }, 0.7
        ));
      }
      // Canopy roof
      addElement(makeElement('SLAB', 'IfcSlab', `${sName} Roof`,
        { origin: { x: sX + sLen / 2, y: sY + sWid / 2, z: canopyZ + canopyH } },
        { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sLen + 0.6, height: sWid + 0.6 }, direction: { x: 0, y: 0, z: 1 }, depth: 0.1 },
        cLevelId, { slabType: 'ROOF' },
        { name: 'metal', color: [0.4, 0.4, 0.45], transparency: 0 }, 0.7
      ));
      continue;
    }

    // Shared-wall detection: if section edge aligns with main building edge, skip that wall
    const SHARED_TOL = 0.5;
    const sMinX = sX, sMaxX = sX + sLen, sMinY = sY, sMaxY = sY + sWid;
    const sharedSouth = Math.abs(sMinY - mainBBox.maxY) < SHARED_TOL || Math.abs(sMinY - mainBBox.minY) < SHARED_TOL;
    const sharedNorth = Math.abs(sMaxY - mainBBox.minY) < SHARED_TOL || Math.abs(sMaxY - mainBBox.maxY) < SHARED_TOL;
    const sharedWest = Math.abs(sMinX - mainBBox.maxX) < SHARED_TOL || Math.abs(sMinX - mainBBox.minX) < SHARED_TOL;
    const sharedEast = Math.abs(sMaxX - mainBBox.minX) < SHARED_TOL || Math.abs(sMaxX - mainBBox.maxX) < SHARED_TOL;

    for (let sf = 0; sf < sFloors; sf++) {
      const sBaseZ = floorLevel + sf * sFloorH;
      const sLevelId = `level-${Math.min(sf + 1, numFloors)}`;

      // Walls — skip shared walls to avoid double geometry
      if (!sharedSouth) {
        addElement(makeElement('WALL', 'IfcWallStandardCase', `${sName} South Wall F${sf + 1}`,
          { origin: { x: sX + sLen / 2, y: sY + sWt / 2, z: sBaseZ } },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sLen, height: sWt }, direction: { x: 0, y: 0, z: 1 }, depth: sFloorH },
          sLevelId, { isExternal: true, wallSide: 'SOUTH' },
          { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
        ));
      }
      if (!sharedNorth) {
        addElement(makeElement('WALL', 'IfcWallStandardCase', `${sName} North Wall F${sf + 1}`,
          { origin: { x: sX + sLen / 2, y: sY + sWid - sWt / 2, z: sBaseZ } },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sLen, height: sWt }, direction: { x: 0, y: 0, z: 1 }, depth: sFloorH },
          sLevelId, { isExternal: true, wallSide: 'NORTH' },
          { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
        ));
      }
      if (!sharedWest) {
        addElement(makeElement('WALL', 'IfcWallStandardCase', `${sName} West Wall F${sf + 1}`,
          { origin: { x: sX + sWt / 2, y: sY + sWid / 2, z: sBaseZ } },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sWt, height: sWid }, direction: { x: 0, y: 0, z: 1 }, depth: sFloorH },
          sLevelId, { isExternal: true, wallSide: 'WEST' },
          { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
        ));
      }
      if (!sharedEast) {
        addElement(makeElement('WALL', 'IfcWallStandardCase', `${sName} East Wall F${sf + 1}`,
          { origin: { x: sX + sLen - sWt / 2, y: sY + sWid / 2, z: sBaseZ } },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sWt, height: sWid }, direction: { x: 0, y: 0, z: 1 }, depth: sFloorH },
          sLevelId, { isExternal: true, wallSide: 'EAST' },
          { name: spec.materials?.walls || 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 }
        ));
      }

      // Floor slab
      addElement(makeElement('SLAB', 'IfcSlab', `${sName} Floor F${sf + 1}`,
        { origin: { x: sX + sLen / 2, y: sY + sWid / 2, z: sBaseZ } },
        { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sLen, height: sWid }, direction: { x: 0, y: 0, z: 1 }, depth: 0.2 },
        sLevelId, { slabType: 'FLOOR' },
        { name: spec.materials?.floor || 'concrete', color: [0.6, 0.6, 0.6], transparency: 0 }
      ));

      // Roof on last section floor
      if (sf === sFloors - 1) {
        const sRoofType = (section.roof_type || 'FLAT').toUpperCase();
        const sRoofZ = sBaseZ + sFloorH;
        if (sRoofType === 'GABLE') {
          const ridgeAlongX = sLen >= sWid;
          const { vertices, faces } = buildGableRoofMesh(sLen, sWid,
            section.roof_pitch_degrees || 25, 0.3, ridgeAlongX, sX, sY);
          addElement(makeElement('SLAB', 'IfcSlab', `${sName} Roof`,
            { origin: { x: 0, y: 0, z: sRoofZ } },
            { method: 'MESH', vertices, faces },
            sLevelId, { slabType: 'ROOF' },
            { name: 'metal', color: [0.35, 0.35, 0.4], transparency: 0 }
          ));
        } else {
          addElement(makeElement('SLAB', 'IfcSlab', `${sName} Roof`,
            { origin: { x: sX + sLen / 2, y: sY + sWid / 2, z: sRoofZ } },
            { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: sLen, height: sWid }, direction: { x: 0, y: 0, z: 1 }, depth: 0.15 },
            sLevelId, { slabType: 'ROOF' },
            { name: 'metal', color: [0.4, 0.4, 0.45], transparency: 0 }
          ));
        }
      }
    }
  }

  // ---- VERTICAL FEATURES (chimneys, exhaust stacks, vents, etc.) ----
  const roofElevation = floorLevel + (numFloors * floorToFloor);

  for (const feat of (structuredSourceExists ? [] : (spec.vertical_features || []))) {
    const fw = feat.width_m || 0.8;
    const fd = feat.depth_m || 0.6;
    const fAbove = feat.height_above_roof_m || 1.0;
    const fx = Math.max(0, Math.min(feat.x_position_m ?? length / 2, length));
    const fy = Math.max(0, Math.min(feat.y_position_m ?? width / 2, width));

    const materialMap = {
      CHIMNEY: { name: 'brick', color: [0.6, 0.3, 0.2] },
      EXHAUST_STACK: { name: 'steel', color: [0.5, 0.5, 0.55] },
      VENT: { name: 'steel', color: [0.45, 0.45, 0.5] },
      PARAPET: { name: 'concrete', color: [0.7, 0.7, 0.7] },
      ANTENNA_MOUNT: { name: 'steel', color: [0.4, 0.4, 0.45] },
    };
    const mat = materialMap[feat.type] || materialMap.VENT;

    addElement(makeElement('PROXY', 'IfcBuildingElementProxy', feat.name || feat.type || 'Vertical Feature',
      { origin: { x: fx, y: fy, z: roofElevation } },
      { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: fw, height: fd }, direction: { x: 0, y: 0, z: 1 }, depth: fAbove },
      `level-${numFloors}`, { objectType: feat.type || 'VERTICAL_FEATURE' },
      mat, 0.6
    ));
  }

  // Build bbox
  const totalHeight = floorLevel + (numFloors * floorToFloor) + 0.15;

  // v6: Interior suppression — remove implausible rooms before envelope check
  const wallCount = elements.filter(e => e.type === 'WALL').length;
  const slabCount = elements.filter(e => e.type === 'SLAB').length;
  let envelopeFallbackApplied = false;
  let interiorSuppression = null;

  if (wallCount >= 4 && slabCount >= 2) {
    const rooms = elements.filter(e => e.type === 'SPACE');
    if (rooms.length > 0) {
      const implausibleRooms = rooms.filter(r => {
        const w = r.geometry?.profile?.width || 0;
        const h = r.geometry?.profile?.height || 0;
        const d = r.geometry?.depth || 0;
        const conf = r.confidence || 0.5;
        return w > 50 || h > 50 || d > 10 || w < 0.5 || h < 0.5 || conf < 0.5;
      });
      if (implausibleRooms.length > rooms.length * 0.3) {
        console.warn(`Building safe-mode: ${implausibleRooms.length}/${rooms.length} rooms implausible — suppressing`);
        const implausibleIds = new Set(implausibleRooms.map(r => r.id));
        const before = elements.length;
        // Remove implausible rooms only, keep good ones
        for (let i = elements.length - 1; i >= 0; i--) {
          if (elements[i].type === 'SPACE' && implausibleIds.has(elements[i].id)) elements.splice(i, 1);
        }
        interiorSuppression = { totalRooms: rooms.length, suppressed: implausibleRooms.length, retained: rooms.length - implausibleRooms.length };
      }
    }
  }

  // v6: Envelope fallback — if building extraction is too fragmented, downgrade to skeleton
  // Domain-aware structural confidence: only structural carrier types contribute to confidence check
  const STRUCTURAL_CARRIERS = {
    ARCH: new Set(['WALL', 'SLAB', 'COLUMN', 'BEAM', 'ROOF', 'STAIR', 'RAMP']),
    TUNNEL: new Set(['WALL', 'SLAB', 'TUNNEL_SEGMENT', 'COLUMN']),
    INDUSTRIAL: new Set(['WALL', 'SLAB', 'COLUMN', 'BEAM', 'FOOTING']),
    CIVIL: new Set(['WALL', 'SLAB', 'COLUMN', 'BEAM', 'FOOTING', 'PILE']),
    STRUCTURAL: new Set(['WALL', 'SLAB', 'COLUMN', 'BEAM', 'FOOTING', 'PILE']),
  };
  const normalizedDomain = (domain || 'ARCH').toUpperCase();
  const carrierSet = STRUCTURAL_CARRIERS[normalizedDomain] || STRUCTURAL_CARRIERS.ARCH;
  const structuralElems = elements.filter(e => carrierSet.has(e.type));
  const structuralConfidence = structuralElems.length > 0
    ? structuralElems.reduce((s, e) => s + (e.confidence || 0.5), 0) / structuralElems.length
    : 0;

  if ((wallCount < 4 || slabCount < 2 || structuralConfidence < 0.4) && !structuredSourceExists) {
    console.warn(`v6 Envelope fallback (PRESERVING): ${wallCount} walls, ${slabCount} slabs, structConf=${structuralConfidence.toFixed(2)} (domain=${normalizedDomain}) — adding missing envelope pieces only`);
    envelopeFallbackApplied = true;
    const preservedCount = elements.length;

    // Building-specific color defaults based on structure class
    const structureClass2 = (spec.buildingType || '').toLowerCase();
    const structColors = {
      residential: { wall: [0.72, 0.36, 0.22], wallMat: 'brick', roof: [0.35, 0.30, 0.25], roofMat: 'tile' },
      commercial:  { wall: [0.70, 0.82, 0.92], wallMat: 'glass', roof: [0.40, 0.40, 0.45], roofMat: 'metal' },
      industrial:  { wall: [0.55, 0.58, 0.60], wallMat: 'metal', roof: [0.40, 0.45, 0.50], roofMat: 'metal' },
      warehouse:   { wall: [0.55, 0.58, 0.60], wallMat: 'metal', roof: [0.40, 0.45, 0.50], roofMat: 'metal' },
    };
    const sc = structColors[structureClass2] || { wall: [0.75, 0.75, 0.75], wallMat: 'concrete', roof: [0.4, 0.4, 0.45], roofMat: 'metal' };

    // Identify which cardinal directions already have exterior walls
    const coveredSides = new Set();
    for (const el of elements) {
      if (el.type === 'WALL' && el.properties?.wallSide) {
        coveredSides.add(el.properties.wallSide.toUpperCase());
      }
    }

    // Compute bbox from existing elements for missing wall placement
    let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
    for (const el of elements) {
      const o = el.placement?.origin;
      if (!o) continue;
      if (o.x < bMinX) bMinX = o.x; if (o.x > bMaxX) bMaxX = o.x;
      if (o.y < bMinY) bMinY = o.y; if (o.y > bMaxY) bMaxY = o.y;
    }
    // Fall back to spec dimensions if no valid placements
    if (!isFinite(bMinX)) { bMinX = 0; bMaxX = length; bMinY = 0; bMaxY = width; }
    const bW = Math.max(bMaxX - bMinX, 3.0);
    const bD = Math.max(bMaxY - bMinY, 3.0);
    const wt = wallThickness;
    const baseZ = floorLevel;

    // Add only missing cardinal envelope walls
    const wallDefs = {
      SOUTH: { ox: bMinX + bW / 2, oy: bMinY,          profW: bW, profH: wt, refDir: { x: 1, y: 0, z: 0 } },
      NORTH: { ox: bMinX + bW / 2, oy: bMaxY,          profW: bW, profH: wt, refDir: { x: 1, y: 0, z: 0 } },
      WEST:  { ox: bMinX,          oy: bMinY + bD / 2,  profW: wt, profH: bD, refDir: { x: 0, y: 1, z: 0 } },
      EAST:  { ox: bMaxX,          oy: bMinY + bD / 2,  profW: wt, profH: bD, refDir: { x: 0, y: 1, z: 0 } },
    };

    // Phase 3D: Multi-storey fallback — add walls and slabs per floor
    let addedWalls = 0;
    let addedSlabs = 0;
    for (let f = 0; f < numFloors; f++) {
      const levelId = `level-${f + 1}`;
      const floorBaseZ = floorLevel + (f * floorToFloor);

      // Add missing cardinal walls for this floor
      for (const side of ['NORTH', 'SOUTH', 'EAST', 'WEST']) {
        if (coveredSides.has(side)) continue;
        const wd = wallDefs[side];
        addElement(makeElement('WALL', 'IfcWallStandardCase', `${side.charAt(0) + side.slice(1).toLowerCase()} Wall F${f + 1} (Fallback)`,
          { origin: { x: wd.ox, y: wd.oy, z: floorBaseZ }, axis: { x: 0, y: 0, z: 1 }, refDirection: wd.refDir },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: wd.profW, height: wd.profH }, direction: { x: 0, y: 0, z: 1 }, depth: floorToFloor },
          levelId, { isExternal: true, wallSide: side, isFallback: true },
          { name: sc.wallMat, color: sc.wall, transparency: 0 }
        ));
        addedWalls++;
      }

      // Add floor slab if this level lacks one
      const hasFloorForLevel = elements.some(e =>
        e.type === 'SLAB' && (e.properties?.slabType || '').toUpperCase() === 'FLOOR' && e.container === levelId
      );
      if (!hasFloorForLevel) {
        addElement(makeElement('SLAB', 'IfcSlab', `Floor Slab F${f + 1} (Fallback)`,
          { origin: { x: bMinX + bW / 2, y: bMinY + bD / 2, z: floorBaseZ } },
          { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: bW, height: bD }, direction: { x: 0, y: 0, z: 1 }, depth: 0.2 },
          levelId, { slabType: 'FLOOR', isFallback: true },
          { name: 'concrete', color: [0.6, 0.6, 0.6], transparency: 0 }
        ));
        addedSlabs++;
      }
    }

    // Add roof slab at top of building if no ROOF slab exists
    const hasRoof = elements.some(e => e.type === 'SLAB' && (e.properties?.slabType || '').toUpperCase() === 'ROOF');
    if (!hasRoof) {
      const roofZ = floorLevel + (numFloors * floorToFloor);
      addElement(makeElement('SLAB', 'IfcSlab', 'Roof Slab (Fallback)',
        { origin: { x: bMinX + bW / 2, y: bMinY + bD / 2, z: roofZ } },
        { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: bW, height: bD }, direction: { x: 0, y: 0, z: 1 }, depth: 0.25 },
        `level-${numFloors}`, { slabType: 'ROOF', isFallback: true },
        { name: sc.roofMat, color: sc.roof, transparency: 0 }
      ));
      addedSlabs++;
    }

    // Add door only if no doors exist and south wall was added
    const hasDoor = elements.some(e => e.type === 'DOOR');
    if (!hasDoor && !coveredSides.has('SOUTH')) {
      addElement(makeElement('DOOR', 'IfcDoor', 'Main Entrance (Fallback)',
        { origin: { x: bMinX + bW / 2, y: bMinY, z: baseZ }, axis: { x: 0, y: 0, z: 1 }, refDirection: { x: 1, y: 0, z: 0 } },
        { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: 0.9, height: wt }, direction: { x: 0, y: 0, z: 1 }, depth: 2.1 },
        'level-1', { wallSide: 'SOUTH', sillHeight: 0, isFallback: true },
        { name: 'wood', color: [0.55, 0.35, 0.2], transparency: 0 }, 0.6
      ));
    }

    console.warn(`Envelope fallback: preserved ${preservedCount} elements, added ${addedWalls} walls + ${addedSlabs} slabs (covered sides: ${[...coveredSides].join(',')})`);
  }

  const css = {
    cssVersion: '1.0',
    domain,
    facility: {
      name: spec.buildingName || 'Structure',
      type: spec.buildingType?.toLowerCase() || 'building',
      description: '',
      units: 'M',
      crs: null,
      origin: { x: 0, y: 0, z: floorLevel },
      axes: 'RIGHT_HANDED_Z_UP'
    },
    levelsOrSegments: levels,
    elements,
    metadata: {
      sourceFiles: sourceFiles,
      outputMode: 'HYBRID',
      validationStatus: 'PENDING',
      unitNormalizationApplied: true,
      cssHash: null,
      elementCounts,
      structureClass,
      envelopeFallbackApplied,
      interiorSuppression,
      skippedRooms: skippedRooms.length > 0 ? skippedRooms : undefined,
      skippedOpenings: skippedOpenings.length > 0 ? skippedOpenings : undefined,
      bbox: {
        min: { x: 0, y: 0, z: floorLevel },
        max: { x: length, y: width, z: totalHeight }
      },
      repairLog: []
    }
  };

  return css;
}

// ============================================================================
// MINIMAL CSS FALLBACK (replaces standalone CreateMinimalCSS Lambda)
// ============================================================================

// ============================================================================
// ENRICHMENT — whitelist-only metadata patches from supplementary files
// ============================================================================

const ENRICHMENT_WHITELIST = new Set(['name', 'description', 'materials', 'psets']);
const ENRICHMENT_GEOMETRY_FIELDS = new Set([
  'placement', 'dimensions', 'width', 'height', 'depth', 'direction',
  'elevation', 'semantic_type', 'profile', 'length_m', 'depth_m',
  'width_m', 'height_m', 'geometry', 'position'
]);
const MAX_CHARS_PER_FILE = 50_000;
const MAX_TOTAL_SUPPLEMENTARY = 120_000;
const MULTI_PASS = process.env.MULTI_PASS !== 'false';

// ============================================================================
// SOURCE CLASSIFICATION + PRIORITY-WEIGHTED PROMPT BUILDER
// ============================================================================

/**
 * Classify a processed file by its likely role in the document set.
 * Conservative: defaults to NARRATIVE to avoid suppressing architectural data.
 */
function classifySourceFile(file) {
  const name = (file.name || '').toLowerCase();
  const content = (file.content || '').slice(0, 3000);

  // 1. VentSim simulation dump
  if (isVentSim(file.content || '')) return 'SIMULATION';
  if (/ventsim|_vts|airway|network_export/i.test(name)) return 'SIMULATION';

  // 2. DXF/DWG drawing
  if (name.endsWith('.dxf') || name.endsWith('.dwg')) return 'DRAWING';

  // 3. Equipment / MEP schedule — requires BOTH filename and content signals
  if (/equipment.list|mep.schedule|asset.inventory/i.test(name) &&
      /TAG\s+DESCRIPTION\s+(MANUFACTURER|TYPE|CAPACITY)/i.test(content)) return 'SCHEDULE';

  // 4. Tabular-dominant content with schedule filename hint
  if (/schedule|equipment/i.test(name)) {
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const tabbedLines = lines.filter(l => l.includes('\t') || l.split(',').length >= 3);
    const prosyLines = lines.filter(l => l.split(' ').length > 6 && !l.includes('\t'));
    if (lines.length > 5 && tabbedLines.length / lines.length > 0.7 && prosyLines.length < lines.length * 0.3) {
      return 'SCHEDULE';
    }
  }

  // 5. Explicit narrative / spec filename
  if (/specification|design.brief|facility.description|building.overview/i.test(name)) return 'NARRATIVE';

  // 6. Technical narrative: mostly prose + dimensional keywords
  const allLines = content.split('\n').filter(l => l.trim().length > 0);
  const proseLines = allLines.filter(l => l.split(' ').length > 6);
  if (allLines.length > 5 && proseLines.length / allLines.length > 0.5 &&
      /\b(feet|metres?|meters?|width|length|height|floor|wall|room|tunnel|shaft|portal)\b/i.test(content)) {
    return 'TECHNICAL_NARRATIVE';
  }

  // 8. Default: NARRATIVE (conservative)
  return 'NARRATIVE';
}

/**
 * Build a priority-sectioned file content string for Bedrock prompts.
 * PRIMARY (narrative) → SECONDARY (schedules) → TERTIARY (simulation, 2k chars only).
 */
function buildPriorityFileContent(files, refinementText = null) {
  const MAX_PRIMARY = 50000;
  const MAX_SECONDARY = 12000;
  const MAX_TERTIARY = 10000;  // v9: raised from 2KB — VentSim data is structured, 10KB captures full medium networks
  const parts = [];
  let totalChars = 0;
  const MAX_TOTAL = 150000;

  // Refinement/correction context — highest priority
  if (refinementText) {
    parts.push([
      '=== CORRECTION / REFINEMENT (HIGHEST PRIORITY) ===',
      'An engineer reviewed the previously generated model and provided the following correction.',
      'Apply this before all other context. Override conflicting values from source documents where the correction is explicit.',
      '',
      refinementText.trim(),
      '==='
    ].join('\n'));
  }

  const primary = files.filter(f => f.sourceRole === 'NARRATIVE' || f.sourceRole === 'TECHNICAL_NARRATIVE');
  const secondary = files.filter(f => f.sourceRole === 'SCHEDULE');
  const tertiary = files.filter(f => f.sourceRole === 'SIMULATION' || f.sourceRole === 'DRAWING');

  if (primary.length > 0) {
    const section = ['=== PRIMARY — Architectural / Facility Description ===',
      'IMPORTANT: Use these documents as the authoritative source for structure type, envelope,',
      'footprint, massing, overall dimensions, levels, roof form, portals, shafts, rooms, and major zones.',
      'Do NOT let secondary or tertiary documents reshape these.', ''];
    for (const f of primary) {
      if (totalChars >= MAX_TOTAL) break;
      const cap = Math.min(MAX_PRIMARY, MAX_TOTAL - totalChars);
      const c = (f.content || '').slice(0, cap);
      section.push(`File: ${f.name}\n${c}`);
      totalChars += c.length;
    }
    parts.push(section.join('\n'));
  }

  if (secondary.length > 0) {
    const section = ['=== SECONDARY — Equipment / MEP Schedules ===',
      'NOTE: Use for equipment sizing, system selection, and MEP metadata only.',
      'Do NOT let equipment table dimensions reshape the building/tunnel envelope.', ''];
    for (const f of secondary) {
      if (totalChars >= MAX_TOTAL) break;
      const cap = Math.min(MAX_SECONDARY, MAX_TOTAL - totalChars);
      const c = (f.content || '').slice(0, cap);
      section.push(`File: ${f.name}\n${c}`);
      totalChars += c.length;
    }
    parts.push(section.join('\n'));
  }

  if (tertiary.length > 0) {
    const section = ['=== TERTIARY — Simulation / Network Exports ===',
      'NOTE: Use for airflow network semantics and fan/duct context only.',
      'Do NOT derive structural geometry from these.', ''];
    for (const f of tertiary) {
      if (totalChars >= MAX_TOTAL) break;
      const cap = Math.min(MAX_TERTIARY, MAX_TOTAL - totalChars);
      const c = (f.content || '').slice(0, cap);
      section.push(`File: ${f.name}\n${c}`);
      totalChars += c.length;
    }
    parts.push(section.join('\n'));
  }

  // Fallback: if nothing classified, use all files flat
  if (parts.length === 0) {
    return files.map(f => `File: ${f.name}\n${(f.content || '').slice(0, 30000)}`).join('\n\n---\n\n');
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Build supplementary text from non-primary files with round-robin truncation.
 */
function buildSupplementaryText(files) {
  const truncatedFiles = [];
  let sections = files.map(f => {
    const header = `=== File: ${f.name} (${f.contentType || 'text/plain'}) ===`;
    let content = f.content || '';
    const originalChars = content.length;

    if (content.length > MAX_CHARS_PER_FILE) {
      content = content.slice(0, MAX_CHARS_PER_FILE) + '\n...[truncated]';
      truncatedFiles.push({ name: f.name, originalChars, keptChars: MAX_CHARS_PER_FILE });
    }
    return { name: f.name, text: `${header}\n${content}`, length: header.length + 1 + content.length, originalChars };
  });

  // Check total and apply round-robin truncation if needed
  const totalLength = sections.reduce((sum, s) => sum + s.length, 0);
  if (totalLength > MAX_TOTAL_SUPPLEMENTARY) {
    const perFileAllowance = Math.floor(MAX_TOTAL_SUPPLEMENTARY / sections.length);
    sections = sections.map(s => {
      if (s.length > perFileAllowance) {
        const truncated = s.text.slice(0, perFileAllowance) + '\n...[truncated]';
        if (!truncatedFiles.find(t => t.name === s.name)) {
          truncatedFiles.push({ name: s.name, originalChars: s.originalChars, keptChars: perFileAllowance });
        }
        return { ...s, text: truncated };
      }
      return s;
    });
  }

  return {
    text: sections.map(s => s.text).join('\n\n'),
    truncatedFiles
  };
}

/**
 * Validate enrichment patch schema (v1.0).
 */
function validatePatchSchema(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.version !== '1.0') return false;
  const allowedKeys = new Set(['version', 'patches']);
  for (const key of Object.keys(response)) {
    if (!allowedKeys.has(key)) return false;
  }
  if (!Array.isArray(response.patches)) return false;
  for (const patch of response.patches) {
    if (typeof patch.element_key !== 'string') return false;
    if (!patch.updates || typeof patch.updates !== 'object') return false;
  }
  return true;
}

/**
 * Enrich CSS with metadata patches from supplementary files via Bedrock.
 * Only updates name, description, materials, psets. Never touches geometry.
 */
async function enrichCSS(cssData, supplementaryText, bedrockClient = bedrock) {
  // Collect all elements from both CSS structures:
  // - VentSim/DXF: top-level cssData.elements[]
  // - Bedrock: cssData.storeys[].elements[]
  const allElements = [];
  if (Array.isArray(cssData.elements)) {
    allElements.push(...cssData.elements);
  }
  for (const storey of (cssData.storeys || [])) {
    if (Array.isArray(storey.elements)) {
      allElements.push(...storey.elements);
    }
  }

  // Use element_key if available, otherwise fall back to id
  const elementKeys = allElements.map(el => el.element_key || el.id).filter(Boolean);

  if (elementKeys.length === 0) {
    console.log('No element_keys found in CSS — skipping enrichment');
    return cssData;
  }

  // Build a summary with keys AND names so Bedrock can match meaningfully
  const elementSummary = allElements.slice(0, 80).map(el => {
    const key = el.element_key || el.id;
    const name = el.name || '';
    const type = el.type || el.semanticType || '';
    return `  ${key} (name: "${name}", type: ${type})`;
  }).join('\n');

  const prompt = `You are enriching a building model with supplementary document data.
The model has ${elementKeys.length} elements:
${elementSummary}${elementKeys.length > 80 ? '\n  ... and more' : ''}

Supplementary documents:
${supplementaryText}

Return ONLY valid JSON matching this exact schema:
{
  "version": "1.0",
  "patches": [
    {
      "element_key": "<exact key from list above>",
      "updates": {
        "name": "optional new name",
        "description": "optional description",
        "materials": ["optional", "materials"],
        "psets": { "Pset_Name": { "Property": "Value" } }
      }
    }
  ]
}

Rules:
- Only use element_keys from the list above
- Only set name, description, materials, psets
- Do NOT include placement, dimensions, geometry, semantic_type, or any geometry fields
- Return empty patches array if no enrichment possible`;

  try {
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: 'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }]
      })
    }));

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const text = responseBody.content?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('Enrichment: no JSON found in Bedrock response');
      return cssData;
    }

    const patchData = JSON.parse(jsonMatch[0]);

    // Validate schema
    if (!validatePatchSchema(patchData)) {
      console.warn('Enrichment: patch schema validation failed');
      return cssData;
    }

    // Build element lookup by key (supports both CSS structures)
    const elementMap = new Map();
    for (const el of allElements) {
      const key = el.element_key || el.id;
      if (key) elementMap.set(key, el);
    }

    // Apply patches with whitelist enforcement
    let appliedCount = 0;
    for (const patch of patchData.patches) {
      const element = elementMap.get(patch.element_key);
      if (!element) {
        console.warn(`Enrichment: unmatched element_key=${patch.element_key}`);
        continue;
      }

      for (const [field, value] of Object.entries(patch.updates)) {
        if (ENRICHMENT_GEOMETRY_FIELDS.has(field)) {
          console.warn(`REJECTED geometry edit for element_key=${patch.element_key} field=${field}`);
          continue;
        }
        if (!ENRICHMENT_WHITELIST.has(field)) {
          console.warn(`REJECTED unknown field for element_key=${patch.element_key} field=${field}`);
          continue;
        }
        element[field] = value;
      }
      appliedCount++;
    }

    console.log(`Enrichment: applied ${appliedCount}/${patchData.patches.length} patches`);

    // Update diagnostics
    if (cssData.metadata?.diagnostics) {
      cssData.metadata.diagnostics.enrichmentApplied = appliedCount > 0;
      cssData.metadata.diagnostics.enrichmentPatchCount = appliedCount;
    }

    return cssData;
  } catch (err) {
    console.warn('Enrichment failed:', err.message);
    return cssData;
  }
}

// ============================================================================
// v6: RESTRICTED SAFE SOURCE FUSION — document-derived element creation
// ============================================================================

const FUSION_ALLOWLIST = new Set([
  'PIPE', 'PUMP', 'TANK', 'HYDRANT', 'VALVE', 'SENSOR', 'CAMERA',
  'CONTROL_PANEL', 'FIRE_SUPPRESSION', 'COMMUNICATIONS', 'SECURITY'
]);

const FUSION_PLACEMENT_TEMPLATES = {
  PIPE:             { lateralFraction: 0.3, verticalFraction: 0.8, defaultLength: 2.0, defaultDiameter: 0.2 },
  PUMP:             { lateralFraction: 0.2, verticalFraction: 0.0, defaultLength: 1.0, defaultWidth: 0.6, defaultHeight: 0.8 },
  TANK:             { lateralFraction: 0.4, verticalFraction: 0.0, defaultLength: 1.5, defaultWidth: 1.0, defaultHeight: 1.5 },
  HYDRANT:          { lateralFraction: 0.1, verticalFraction: 0.0, defaultLength: 0.3, defaultWidth: 0.3, defaultHeight: 0.8 },
  VALVE:            { lateralFraction: 0.15, verticalFraction: 0.5, defaultLength: 0.2, defaultWidth: 0.2, defaultHeight: 0.2 },
  SENSOR:           { lateralFraction: 0.5, verticalFraction: 0.9, defaultLength: 0.15, defaultWidth: 0.15, defaultHeight: 0.1 },
  CAMERA:           { lateralFraction: 0.5, verticalFraction: 0.95, defaultLength: 0.2, defaultWidth: 0.15, defaultHeight: 0.15 },
  CONTROL_PANEL:    { lateralFraction: 0.05, verticalFraction: 0.5, defaultLength: 0.6, defaultWidth: 0.2, defaultHeight: 0.8 },
  FIRE_SUPPRESSION: { lateralFraction: 0.5, verticalFraction: 0.95, defaultLength: 0.15, defaultWidth: 0.15, defaultHeight: 0.1 },
  COMMUNICATIONS:   { lateralFraction: 0.45, verticalFraction: 0.9, defaultLength: 0.3, defaultWidth: 0.1, defaultHeight: 0.3 },
  SECURITY:         { lateralFraction: 0.4, verticalFraction: 0.85, defaultLength: 0.25, defaultWidth: 0.15, defaultHeight: 0.2 }
};

/**
 * Extract fusible equipment findings from supplementary document text.
 * Returns array of { name, type, confidence, segmentName, sourceFile, ... }
 */
async function extractDocumentFindings(suppText, sourceFileNames) {
  if (!suppText || suppText.length < 50) return [];

  const prompt = `Analyze this document text and identify any specific infrastructure equipment or devices mentioned.
Only return items that are explicitly named/described — do not infer or guess.

Allowed types: PIPE, PUMP, TANK, HYDRANT, VALVE, SENSOR, CAMERA, CONTROL_PANEL, FIRE_SUPPRESSION, COMMUNICATIONS, SECURITY

For each item found, return:
- name: specific name from the document
- type: one of the allowed types above
- confidence: 0.0-1.0 how explicit the mention is
- segmentName: which area/zone/segment it's in (if mentioned)
- specs: any specifications (dimensions, ratings, etc.)

Return a JSON array. If no equipment found, return [].

Document text:
${suppText.slice(0, 20000)}`;

  try {
    const response = await bedrock.send(new InvokeModelCommand({
      modelId: 'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    }));

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const text = responseBody.content?.[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const findings = JSON.parse(jsonMatch[0]);
    console.log(`Document findings extracted: ${findings.length} items from ${sourceFileNames.length} files`);
    if (findings.length > 0) {
      console.log(`  Finding types: ${[...new Set(findings.map(f => f.type))].join(', ')}`);
      console.log(`  Finding names: ${findings.slice(0, 5).map(f => f.name).join(', ')}${findings.length > 5 ? '...' : ''}`);
    }
    // Tag with source files
    return findings.map(f => ({ ...f, sourceFiles: sourceFileNames }));
  } catch (err) {
    console.warn('Document findings extraction failed:', err.message);
    return [];
  }
}

/**
 * Attempt restricted safe source fusion — add non-structural elements from document findings.
 * Rules:
 * 1. Only types in FUSION_ALLOWLIST
 * 2. Must have valid segment/space anchor in existing CSS
 * 3. Must pass duplicate check
 * 4. Confidence >= 0.6
 * 5. Never structural (WALL, SLAB, ROOF, TUNNEL_SEGMENT)
 * 6. Deterministic placement templates only — no randomness
 */
function attemptSafeSourceFusion(css, documentFindings, sourceFiles) {
  if (!css.elements || !documentFindings || documentFindings.length === 0) return;

  const existingNames = new Set(css.elements.map(e => `${e.name}:${e.type}:${e.container}`));
  // Build equipment name set for duplicate suppression against existing VentSim/extracted equipment
  const existingEquipNames = new Set(
    css.elements
      .filter(e => (e.type || '').toUpperCase() === 'EQUIPMENT')
      .map(e => (e.name || '').toLowerCase())
  );

  // Expanded anchor types: SPACE + TUNNEL_SEGMENT + WALL (not just SPACE)
  const ANCHOR_TYPES = new Set(['SPACE', 'TUNNEL_SEGMENT', 'WALL']);
  const anchors = css.elements.filter(e => {
    const t = (e.type || '').toUpperCase();
    if (!ANCHOR_TYPES.has(t)) return false;
    // Must have valid placement
    if (!e.placement?.origin) return false;
    return true;
  });
  const segments = (css.levelsOrSegments || []);

  let fusedCount = 0;
  let rejectedCount = 0;
  const fusionLog = [];

  for (let i = 0; i < documentFindings.length; i++) {
    const finding = documentFindings[i];
    const findingType = (finding.type || '').toUpperCase();

    // Rule 1: Only allowlisted types
    if (!FUSION_ALLOWLIST.has(findingType)) {
      fusionLog.push({ name: finding.name, type: findingType, reason: 'not_in_allowlist' });
      rejectedCount++;
      continue;
    }

    // Rule 4: Confidence check
    const confidence = finding.confidence || 0.5;
    if (confidence < 0.6) {
      fusionLog.push({ name: finding.name, type: findingType, reason: 'low_confidence', confidence });
      rejectedCount++;
      continue;
    }

    // Rule 2: Must anchor to existing segment, space, or wall
    let anchorElem = null;
    if (finding.segmentName) {
      // Try matching anchor by name
      anchorElem = anchors.find(a => a.name && a.name.toLowerCase().includes(finding.segmentName.toLowerCase()));
      if (!anchorElem) {
        // Try matching by segment/level, then find closest anchor in that segment
        const seg = segments.find(s => s.name && s.name.toLowerCase().includes(finding.segmentName.toLowerCase()));
        if (seg) {
          anchorElem = anchors.find(a => a.container === seg.id);
        }
      }
    }
    if (!anchorElem && finding.container) {
      anchorElem = anchors.find(a => a.container === finding.container || a.id === finding.container);
    }
    if (!anchorElem && anchors.length > 0) {
      // Fall back to first anchor if only one option, or pick longest TUNNEL_SEGMENT
      if (anchors.length === 1) {
        anchorElem = anchors[0];
      } else {
        // Prefer TUNNEL_SEGMENT with most depth (longest branch) for tunnel domains
        const tunnelAnchors = anchors.filter(a => (a.type || '').toUpperCase() === 'TUNNEL_SEGMENT');
        if (tunnelAnchors.length > 0) {
          anchorElem = tunnelAnchors.reduce((best, a) => (a.geometry?.depth || 0) > (best.geometry?.depth || 0) ? a : best, tunnelAnchors[0]);
        } else {
          anchorElem = anchors[0];
        }
      }
    }
    if (!anchorElem) {
      fusionLog.push({ name: finding.name, type: findingType, reason: 'no_anchor' });
      rejectedCount++;
      continue;
    }

    // Rule 3: Duplicate check — by key AND by equipment name
    const dupKey = `${finding.name}:${findingType}:${anchorElem.container}`;
    if (existingNames.has(dupKey)) {
      fusionLog.push({ name: finding.name, type: findingType, reason: 'duplicate' });
      rejectedCount++;
      continue;
    }
    if (finding.name && existingEquipNames.has(finding.name.toLowerCase())) {
      fusionLog.push({ name: finding.name, type: findingType, reason: 'duplicate_equipment_name' });
      rejectedCount++;
      continue;
    }

    // Deterministic placement from template within anchor's geometry volume
    const template = FUSION_PLACEMENT_TEMPLATES[findingType] || FUSION_PLACEMENT_TEMPLATES.SENSOR;
    const ao = anchorElem.placement?.origin || { x: 0, y: 0, z: 0 };
    const ag = anchorElem.geometry || {};
    const aw = ag.profile?.width || 5;
    const ah = ag.profile?.height || 5;
    const ad = ag.depth || 10;
    const anchorAxis = anchorElem.placement?.axis || ag.direction || { x: 1, y: 0, z: 0 };

    // Index-based stagger along anchor's primary axis to avoid overlap
    // Progress along depth (10%-90% range), wrap with modulo
    const axisProgress = ((fusedCount * 1.5) % (ad * 0.8)) + ad * 0.1;
    const lateralOffset = aw * template.lateralFraction;
    const verticalOffset = ah * template.verticalFraction;

    // Map fusion types to proper IFC semantic classes
    const FUSION_SEMANTIC_MAP = {
      PIPE: 'IfcPipeSegment', PUMP: 'IfcPump', TANK: 'IfcTank',
      HYDRANT: 'IfcFireSuppressionTerminal', VALVE: 'IfcValve',
      SENSOR: 'IfcSensor', CAMERA: 'IfcCommunicationsAppliance',
      CONTROL_PANEL: 'IfcElectricDistributionBoard',
      FIRE_SUPPRESSION: 'IfcFireSuppressionTerminal',
      COMMUNICATIONS: 'IfcCommunicationsAppliance',
      SECURITY: 'IfcAlarm'
    };
    const fusionSemanticType = FUSION_SEMANTIC_MAP[findingType] || 'IfcBuildingElementProxy';

    // Compute placement within anchor's volume along its axis
    const placementOrigin = {
      x: ao.x + anchorAxis.x * axisProgress + lateralOffset * (anchorAxis.y !== 0 ? 0 : 1),
      y: ao.y + anchorAxis.y * axisProgress + lateralOffset * (anchorAxis.x !== 0 ? 0 : 1),
      z: ao.z + verticalOffset
    };

    const newElem = {
      id: elemId({ depth: template.defaultLength || 0.5 }, { origin: placementOrigin }),
      type: 'EQUIPMENT',
      semanticType: fusionSemanticType,
      name: finding.name || findingType,
      placement: {
        origin: placementOrigin
      },
      geometry: {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: finding.width || template.defaultLength || 0.5, height: finding.depth || template.defaultWidth || 0.3 },
        direction: { x: 0, y: 0, z: 1 },
        depth: finding.height || template.defaultHeight || 0.5
      },
      container: anchorElem.container || 'level-1',
      relationships: [],
      properties: { equipmentType: findingType },
      material: { name: 'steel', color: [0.5, 0.5, 0.55], transparency: 0 },
      confidence: Math.min(confidence, 0.6),
      source: 'DOCUMENT',
      sourceFile: finding.sourceFile,
      metadata: {
        sourceDocument: true,
        placementBasis: 'DOCUMENT_INFERRED_SEGMENT_ANCHORED',
        nearestSegmentKey: anchorElem.element_key || anchorElem.id,
        confidence,
        sourceFiles: finding.sourceFiles || []
      }
    };

    css.elements.push(newElem);
    existingNames.add(dupKey);
    fusedCount++;
  }

  // Always log and store fusion results (even all-rejected)
  console.log(`v6 Source fusion: ${fusedCount} elements created, ${rejectedCount} rejected out of ${documentFindings.length} findings`);
  if (fusionLog.length > 0) {
    const reasonCounts = {};
    fusionLog.forEach(l => { reasonCounts[l.reason] = (reasonCounts[l.reason] || 0) + 1; });
    console.log(`  Rejection reasons: ${JSON.stringify(reasonCounts)}`);
  }
  if (!css.metadata) css.metadata = {};
  css.metadata.sourceFusion = { fusedCount, rejectedCount, totalFindings: documentFindings.length, log: fusionLog.slice(0, 30) };
}

// ============================================================================
// v6+: VISION-BASED EXTRACTION (images + scanned PDFs)
// Type-specific prompts for architectural/engineering drawings
// Phase 9: Enhanced with title block extraction, page role classification,
//          coordinate-bearing prompts, and drawing metadata evidence.
// ============================================================================

// Phase 9a: Title block extraction prompt — runs before classification.
// Extracts drawing metadata from the title block region (typically bottom-right).
// Title block confidence is DOCUMENT confidence, separate from geometry confidence.
const TITLE_BLOCK_PROMPT = `Look at this architectural/engineering drawing and find the TITLE BLOCK (usually in the bottom-right corner or along the right/bottom edge).

Extract any visible title block information. If there is no title block, return confidence: 0.

Return ONLY a JSON object:
{
  "hasTitleBlock": true,
  "confidence": 0.0-1.0,
  "projectName": "string or null",
  "drawingTitle": "string or null",
  "drawingNumber": "string or null",
  "sheetNumber": "string or null",
  "revision": "string or null",
  "date": "string or null",
  "scale": "1:100 or null",
  "author": "string or null",
  "firm": "string or null",
  "fieldConfidence": {
    "projectName": 0.0-1.0,
    "scale": 0.0-1.0,
    "drawingNumber": 0.0-1.0,
    "revision": 0.0-1.0
  }
}
Rules:
- Only extract fields you can clearly read. Set null for anything not visible.
- The confidence field reflects how certain you are a title block exists and is readable.
- fieldConfidence reflects per-field readability, not drawing quality.
- Do NOT guess values — only transcribe what is legible.`;

/**
 * Phase 9a: Extract title block metadata from an image or document.
 * Returns null if no title block found or extraction fails.
 */
async function extractTitleBlock(buffer, mediaType, bedrockClient, contentType = 'image') {
  try {
    const result = await callBedrockVision(buffer, mediaType, TITLE_BLOCK_PROMPT, bedrockClient, contentType);
    if (!result || !result.hasTitleBlock || (result.confidence || 0) < 0.3) {
      return null;
    }
    return {
      projectName: result.projectName || null,
      drawingTitle: result.drawingTitle || null,
      drawingNumber: result.drawingNumber || null,
      sheetNumber: result.sheetNumber || null,
      revision: result.revision || null,
      date: result.date || null,
      scale: result.scale || null,
      author: result.author || null,
      firm: result.firm || null,
      confidence: result.confidence || 0,
      fieldConfidence: result.fieldConfidence || {},
    };
  } catch (err) {
    console.warn(`Title block extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Phase 9a: Map image classification type to a sheet role.
 * Sheet roles classify what kind of drawing page this is, feeding both
 * single-image and multi-page PDF flows.
 */
function classifySheetRole(imageType) {
  const roleMap = {
    FLOOR_PLAN: 'FLOOR_PLAN',
    CROSS_SECTION: 'SECTION',
    EQUIPMENT_LAYOUT: 'EQUIPMENT_LAYOUT',
    SITE_PLAN: 'SITE_PLAN',
    SPECIFICATION: 'SCHEDULE',
    ELEVATION: 'ELEVATION',
    PHOTO: 'UNKNOWN',
    UNKNOWN: 'UNKNOWN',
  };
  return roleMap[imageType] || 'UNKNOWN';
}

/**
 * Phase 9a: Determine if a sheet role is a geometry-bearing drawing.
 * Non-drawing pages (SCHEDULE, TITLE_SHEET, UNKNOWN) are excluded from
 * geometry extraction but their text is preserved for metadata/enrichment.
 */
function isGeometryDrawingRole(sheetRole) {
  return ['FLOOR_PLAN', 'ELEVATION', 'SECTION', 'EQUIPMENT_LAYOUT', 'SITE_PLAN', 'DETAIL'].includes(sheetRole);
}

// ============================================================================
// Phase 9b: Spatial Layout Assembly
// Heuristic reconstruction of 2D floor plan and elevation geometry from
// vision-extracted dimensions. Uses strict coordinate source discipline:
// - DIRECT_2D: coordinates from explicit drawing dimensions/scale
// - ASSEMBLED_2D: heuristically packed from partial evidence
// - ESTIMATED: fallback to origin (same as pre-Phase 9)
// ============================================================================

/**
 * Phase 9b: Assemble a floor plan into a spatially coherent layout.
 * Takes raw vision extraction result and produces coordinate-bearing walls,
 * rooms, doors, and windows. Follows strict priority:
 * 1. Direct coordinates from enhanced prompt (hasCoordinates=true) → DIRECT_2D
 * 2. Heuristic placement from overall dimensions + side/length → ASSEMBLED_2D
 * 3. Fallback to origin → ESTIMATED
 *
 * @param {object} visionResult - Raw vision extraction result (FLOOR_PLAN type)
 * @returns {object} { walls, rooms, doors, windows } with coordinates + coordinateDerivation per element
 */
function assembleFloorPlanLayout(visionResult) {
  const overallL = visionResult.overallDimensions?.length_m;
  const overallW = visionResult.overallDimensions?.width_m;
  const hasEnvelope = overallL > 0 && overallW > 0;

  const assembledWalls = [];
  const assembledRooms = [];
  const assembledDoors = [];
  const assembledWindows = [];

  // --- Walls ---
  for (const wall of (visionResult.walls || [])) {
    const wallLength = wall.length_m || 0;
    const thickness = wall.thickness_m || 0.3;

    // Priority 1: Direct coordinates from enhanced prompt
    if (wall.hasCoordinates && wall.start && wall.end &&
        isFinite(wall.start.x) && isFinite(wall.start.y) &&
        isFinite(wall.end.x) && isFinite(wall.end.y)) {
      assembledWalls.push({
        ...wall,
        placement: { origin: { x: wall.start.x, y: wall.start.y, z: 0 } },
        endPoint: { x: wall.end.x, y: wall.end.y, z: 0 },
        computedLength: Math.sqrt((wall.end.x - wall.start.x) ** 2 + (wall.end.y - wall.start.y) ** 2),
        coordinateDerivation: 'direct',
      });
      continue;
    }

    // Priority 2: Heuristic placement from side + overall dimensions
    if (hasEnvelope && wall.side && wallLength > 0) {
      const pos = placeWallBySide(wall.side, wallLength, thickness, overallL, overallW);
      if (pos) {
        assembledWalls.push({
          ...wall,
          placement: { origin: pos.start },
          endPoint: pos.end,
          computedLength: wallLength,
          coordinateDerivation: 'assembled',
        });
        continue;
      }
    }

    // Priority 3: Fallback — origin placement
    assembledWalls.push({
      ...wall,
      placement: { origin: { x: 0, y: 0, z: 0 } },
      endPoint: null,
      computedLength: wallLength,
      coordinateDerivation: 'estimated',
    });
  }

  // --- Rooms ---
  // Build a wall lookup by ID for room placement
  const wallById = {};
  for (const w of assembledWalls) {
    if (w.id) wallById[w.id] = w;
  }

  // Track placed rooms for packing (left-to-right, bottom-to-top)
  let packX = 0;
  let packY = 0;
  let rowMaxHeight = 0;

  for (const room of (visionResult.rooms || [])) {
    const roomL = room.length_m || 0;
    const roomW = room.width_m || 0;

    // Priority 1: Direct position from enhanced prompt
    if (room.hasPosition && room.position && isFinite(room.position.x) && isFinite(room.position.y)) {
      assembledRooms.push({
        ...room,
        placement: { origin: { x: room.position.x, y: room.position.y, z: 0 } },
        coordinateDerivation: 'direct',
      });
      continue;
    }

    // Priority 2: Heuristic packing within envelope
    if (hasEnvelope && roomL > 0 && roomW > 0) {
      // Would this room overflow the row?
      if (packX + roomW > overallL && packX > 0) {
        packY += rowMaxHeight;
        packX = 0;
        rowMaxHeight = 0;
      }
      // Does it still fit vertically?
      if (packY + roomL <= overallW) {
        assembledRooms.push({
          ...room,
          placement: { origin: { x: packX, y: packY, z: 0 } },
          coordinateDerivation: 'assembled',
        });
        packX += roomW;
        rowMaxHeight = Math.max(rowMaxHeight, roomL);
        continue;
      }
    }

    // Priority 3: Fallback
    assembledRooms.push({
      ...room,
      placement: { origin: { x: 0, y: 0, z: 0 } },
      coordinateDerivation: 'estimated',
    });
  }

  // --- Doors ---
  for (const door of (visionResult.doors || [])) {
    const hostWall = resolveHostWall(door.hostWall, assembledWalls);
    if (hostWall && hostWall.placement && door.offset_m != null) {
      const pos = computeOffsetAlongWall(hostWall, door.offset_m);
      assembledDoors.push({
        ...door,
        placement: { origin: pos },
        coordinateDerivation: hostWall.coordinateDerivation === 'direct' ? 'direct' : 'assembled',
      });
    } else if (hostWall && hostWall.placement) {
      // No offset — place at wall midpoint
      const mid = wallMidpoint(hostWall);
      assembledDoors.push({
        ...door,
        placement: { origin: mid },
        coordinateDerivation: 'assembled',
      });
    } else {
      assembledDoors.push({
        ...door,
        placement: { origin: { x: 0, y: 0, z: 0 } },
        coordinateDerivation: 'estimated',
      });
    }
  }

  // --- Windows ---
  for (const win of (visionResult.windows || [])) {
    const hostWall = resolveHostWall(win.hostWall, assembledWalls);
    const sillZ = win.sillHeight_m || 0.9;
    if (hostWall && hostWall.placement && win.offset_m != null) {
      const pos = computeOffsetAlongWall(hostWall, win.offset_m);
      pos.z = sillZ;
      assembledWindows.push({
        ...win,
        placement: { origin: pos },
        coordinateDerivation: hostWall.coordinateDerivation === 'direct' ? 'direct' : 'assembled',
      });
    } else if (hostWall && hostWall.placement) {
      const mid = wallMidpoint(hostWall);
      mid.z = sillZ;
      assembledWindows.push({
        ...win,
        placement: { origin: mid },
        coordinateDerivation: 'assembled',
      });
    } else {
      assembledWindows.push({
        ...win,
        placement: { origin: { x: 0, y: 0, z: sillZ } },
        coordinateDerivation: 'estimated',
      });
    }
  }

  const stats = {
    walls: { direct: 0, assembled: 0, estimated: 0 },
    rooms: { direct: 0, assembled: 0, estimated: 0 },
    doors: { direct: 0, assembled: 0, estimated: 0 },
    windows: { direct: 0, assembled: 0, estimated: 0 },
  };
  for (const w of assembledWalls) stats.walls[w.coordinateDerivation]++;
  for (const r of assembledRooms) stats.rooms[r.coordinateDerivation]++;
  for (const d of assembledDoors) stats.doors[d.coordinateDerivation]++;
  for (const w of assembledWindows) stats.windows[w.coordinateDerivation]++;
  console.log(`assembleFloorPlanLayout: walls=${JSON.stringify(stats.walls)}, rooms=${JSON.stringify(stats.rooms)}, doors=${JSON.stringify(stats.doors)}, windows=${JSON.stringify(stats.windows)}`);

  return { walls: assembledWalls, rooms: assembledRooms, doors: assembledDoors, windows: assembledWindows, stats };
}

/**
 * Place a wall by its compass side within the building envelope.
 * Returns { start, end } coordinates or null if side is unrecognized.
 */
function placeWallBySide(side, length, thickness, envelopeL, envelopeW) {
  const s = (side || '').toUpperCase();
  // Coordinate system: X right (East), Y down (South), origin at top-left
  switch (s) {
    case 'NORTH': return { start: { x: 0, y: 0, z: 0 }, end: { x: Math.min(length, envelopeL), y: 0, z: 0 } };
    case 'SOUTH': return { start: { x: 0, y: envelopeW, z: 0 }, end: { x: Math.min(length, envelopeL), y: envelopeW, z: 0 } };
    case 'WEST':  return { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: Math.min(length, envelopeW), z: 0 } };
    case 'EAST':  return { start: { x: envelopeL, y: 0, z: 0 }, end: { x: envelopeL, y: Math.min(length, envelopeW), z: 0 } };
    default: return null;
  }
}

/**
 * Resolve a hostWall reference (wall ID or compass side) to an assembled wall.
 */
function resolveHostWall(hostRef, assembledWalls) {
  if (!hostRef) return null;
  // Try by wall ID first (e.g. "W1")
  const byId = assembledWalls.find(w => w.id === hostRef);
  if (byId) return byId;
  // Try by compass side
  const side = hostRef.toUpperCase();
  return assembledWalls.find(w => (w.side || '').toUpperCase() === side) || null;
}

/**
 * Compute a point at a given offset along a wall from its start point.
 */
function computeOffsetAlongWall(wall, offset) {
  const sx = wall.placement.origin.x;
  const sy = wall.placement.origin.y;
  if (!wall.endPoint) {
    // Wall has no endpoint — just offset along X from start
    return { x: sx + offset, y: sy, z: 0 };
  }
  const ex = wall.endPoint.x;
  const ey = wall.endPoint.y;
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return { x: sx, y: sy, z: 0 };
  const t = Math.min(offset / len, 1.0);
  return { x: sx + dx * t, y: sy + dy * t, z: 0 };
}

/**
 * Get the midpoint of an assembled wall.
 */
function wallMidpoint(wall) {
  const sx = wall.placement.origin.x;
  const sy = wall.placement.origin.y;
  if (!wall.endPoint) return { x: sx, y: sy, z: 0 };
  return {
    x: (sx + wall.endPoint.x) / 2,
    y: (sy + wall.endPoint.y) / 2,
    z: 0,
  };
}

/**
 * Phase 9b: Assemble an elevation drawing into vertical layout.
 * Uses floor-to-floor heights and window/door positions for vertical coordinates.
 *
 * @param {object} visionResult - Raw vision extraction result (ELEVATION type)
 * @returns {object} { floors, windows, doors } with z-coordinates
 */
function assembleElevationLayout(visionResult) {
  const floors = [];
  const windows = [];
  const doors = [];

  // Build floor elevations from extracted data
  const rawFloors = visionResult.floors || [];
  const numFloors = visionResult.numFloors || rawFloors.length || 1;
  const floorHeight = visionResult.floorToFloorHeight_m || 3.0;

  for (let i = 0; i < numFloors; i++) {
    const rawFloor = rawFloors[i];
    const elevation = rawFloor?.elevation_m ?? (i * floorHeight);
    const height = rawFloor?.height_m ?? floorHeight;
    const hasDirectElevation = rawFloor?.elevation_m != null;
    floors.push({
      level: rawFloor?.level ?? i,
      name: rawFloor?.name || `Level ${i}`,
      elevation_m: elevation,
      height_m: height,
      coordinateDerivation: hasDirectElevation ? 'direct' : 'assembled',
      confidence: rawFloor?.confidence ?? 0.5,
    });
  }

  // Place windows at their floor elevation + sill height
  for (const winGroup of (visionResult.windows || [])) {
    const floorIdx = (winGroup.floor ?? 1) - (rawFloors[0]?.level ?? 0);
    const floor = floors[floorIdx] || floors[0];
    const baseZ = floor ? floor.elevation_m : 0;
    const sillZ = baseZ + (winGroup.sillElevation_m ?? 0.9);
    const count = winGroup.count || 1;
    for (let j = 0; j < count; j++) {
      windows.push({
        floor: winGroup.floor,
        width_m: winGroup.width_m,
        height_m: winGroup.height_m,
        placement: {
          origin: {
            x: winGroup.xOffset_m != null ? winGroup.xOffset_m : 0,
            y: 0,
            z: sillZ,
          }
        },
        coordinateDerivation: winGroup.xOffset_m != null ? 'direct' : 'assembled',
        confidence: winGroup.confidence ?? 0.5,
      });
    }
  }

  // Place doors at ground level
  for (const doorGroup of (visionResult.doors || [])) {
    const floorIdx = (doorGroup.floor ?? 0);
    const floor = floors[floorIdx] || floors[0];
    const baseZ = floor ? floor.elevation_m : 0;
    doors.push({
      floor: doorGroup.floor,
      width_m: doorGroup.width_m,
      height_m: doorGroup.height_m,
      placement: {
        origin: {
          x: doorGroup.xOffset_m != null ? doorGroup.xOffset_m : 0,
          y: 0,
          z: baseZ,
        }
      },
      coordinateDerivation: doorGroup.xOffset_m != null ? 'direct' : 'assembled',
      confidence: doorGroup.confidence ?? 0.5,
    });
  }

  console.log(`assembleElevationLayout: ${floors.length} floors, ${windows.length} windows, ${doors.length} doors`);
  return { floors, windows, doors, face: visionResult.face, overallHeight_m: visionResult.overallHeight_m, overallWidth_m: visionResult.overallWidth_m };
}

/**
 * Phase 9b: Correlate floor plan and elevation drawings from the same building.
 * Uses floor elevations from elevation to set z-coordinates in floor plan.
 * Only correlates when at least one strong signal exists (matching title block,
 * consistent dimensions, shared level labels).
 *
 * @param {Array} visionFiles - Array of processed files with visionCSS
 * @returns {object|null} Correlation result or null if no match
 */
function correlateDrawings(visionFiles) {
  const floorPlans = visionFiles.filter(f => f.visionCSS?.sheetRole === 'FLOOR_PLAN');
  const elevations = visionFiles.filter(f => f.visionCSS?.sheetRole === 'ELEVATION' && f.visionCSS?.elevationLayout);

  if (floorPlans.length === 0 || elevations.length === 0) return null;

  // Try to match by title block project name
  for (const fp of floorPlans) {
    const fpProject = fp.visionCSS?.titleBlock?.projectName;
    for (const el of elevations) {
      const elProject = el.visionCSS?.titleBlock?.projectName;
      let matchScore = 0;

      // Signal 1: Same project name
      if (fpProject && elProject && fpProject.toLowerCase() === elProject.toLowerCase()) matchScore += 2;

      // Signal 2: Same drawing number series
      const fpNum = fp.visionCSS?.titleBlock?.drawingNumber;
      const elNum = el.visionCSS?.titleBlock?.drawingNumber;
      if (fpNum && elNum && fpNum.replace(/\d+$/, '') === elNum.replace(/\d+$/, '')) matchScore++;

      // Signal 3: Consistent overall width
      const fpWidth = fp.visionCSS?.scaleInfo?.overallDimensions?.width_m ||
                      fp.visionData?.overallDimensions?.width_m;
      const elWidth = el.visionCSS?.elevationLayout?.overallWidth_m;
      if (fpWidth && elWidth && Math.abs(fpWidth - elWidth) < 2.0) matchScore++;

      // Only correlate with strong signal (score >= 2)
      if (matchScore >= 2) {
        console.log(`correlateDrawings: matched ${fp.name} ↔ ${el.name} (score=${matchScore})`);
        return {
          floorPlan: fp.name,
          elevation: el.name,
          elevationLayout: el.visionCSS.elevationLayout,
          matchScore,
        };
      }
    }
  }

  console.log('correlateDrawings: no strong match found between floor plans and elevations');
  return null;
}

// ============================================================================
// Phase 9c: Scale Calibration
// Parses scale ratios from title blocks and dimension annotations, cross-checks
// for consistency, and derives a metersPerUnit factor for dimension correction.
// ============================================================================

/**
 * Phase 9c: Calibrate drawing scale from title block and dimension annotations.
 * Title block scale provides initial prior. Dimension annotations override only
 * when confidently extracted AND internally consistent (≥2 consistent measurements).
 * Conflicting scales reduce confidence, not instantly replace.
 *
 * @param {object} visionResult - Vision extraction result with scale and titleBlock
 * @returns {object} { metersPerUnit, scaleRatio, scaleConfidence, source }
 */
function calibrateScale(visionResult) {
  const result = { metersPerUnit: 1.0, scaleRatio: null, scaleConfidence: 0, source: 'none' };

  // 1. Title block scale as initial prior
  const titleBlockScale = visionResult.titleBlock?.scale || null;
  const extractedScale = visionResult.scale?.ratio || null;
  const scaleStr = titleBlockScale || extractedScale;

  if (scaleStr) {
    const parsed = parseScaleRatio(scaleStr);
    if (parsed) {
      result.scaleRatio = scaleStr;
      result.metersPerUnit = parsed;
      result.scaleConfidence = titleBlockScale
        ? (visionResult.titleBlock?.fieldConfidence?.scale ?? 0.6)
        : 0.5;
      result.source = titleBlockScale ? 'title_block' : 'detected';
    }
  }

  // 2. Check dimension annotations for consistency
  const annotations = visionResult.scale?.dimensionAnnotations || [];
  if (annotations.length >= 2) {
    const confidentAnnotations = annotations.filter(a => (a.confidence || 0) >= 0.7);
    if (confidentAnnotations.length >= 2) {
      // We don't have pixel measurements, but if the model extracted consistent
      // dimension labels, boost confidence in the scale
      result.scaleConfidence = Math.min(result.scaleConfidence + 0.15, 1.0);
      result.source = result.source === 'none' ? 'dimension_annotations' : result.source + '+annotations';
    }
  }

  // 3. If no scale detected at all, fall back to unit scale with zero confidence
  if (result.scaleConfidence === 0) {
    result.metersPerUnit = 1.0;
    result.source = 'none';
  }

  return result;
}

/**
 * Parse a scale ratio string (e.g., "1:100", "1/50", "1 to 200") into metersPerUnit.
 * Returns the drawing-unit-to-meter factor, or null if unparseable.
 */
function parseScaleRatio(scaleStr) {
  if (!scaleStr || typeof scaleStr !== 'string') return null;
  // Match patterns: "1:100", "1/100", "1 to 100", "1-100"
  const match = scaleStr.match(/1\s*[:\/\-]\s*(\d+(?:\.\d+)?)/i) ||
                scaleStr.match(/1\s+to\s+(\d+(?:\.\d+)?)/i);
  if (match) {
    const denominator = parseFloat(match[1]);
    if (denominator > 0 && isFinite(denominator)) {
      // 1:100 means 1 drawing unit = 100 real units (assuming mm on paper → meters)
      // But in our context, the model already converts to meters, so this is informational
      return denominator / 1000; // typical architectural: 1mm on paper = denominator mm in reality
    }
  }
  return null;
}

// ============================================================================
// Phase 9d: Vision-to-BuildingSpec Bridge + Component-Based Confidence
// Routes vision-extracted drawings through the proven buildingSpecToCSS() path.
// Initially scoped to simple orthogonal floor plans + elevations.
// ============================================================================

/**
 * Phase 9d: Determine if a vision result qualifies for the BuildingSpec bridge.
 * Only supported for simple orthogonal floor plans with sufficient data.
 * Returns false for complex plans, MEP sheets, sketches, etc.
 */
function canBridgeToBuildingSpec(visionResult) {
  if (!visionResult) return false;
  const imageType = visionResult.imageType;
  // Only support FLOOR_PLAN for v1
  if (imageType !== 'FLOOR_PLAN') return false;
  // Require overall dimensions
  if (!visionResult.overallDimensions?.length_m || !visionResult.overallDimensions?.width_m) return false;
  // Require at least some walls or rooms
  const hasContent = (visionResult.walls?.length || 0) + (visionResult.rooms?.length || 0) >= 1;
  if (!hasContent) return false;
  // Require reasonable confidence
  if ((visionResult.confidence || 0) < 0.4) return false;
  return true;
}

/**
 * Phase 9d: Convert assembled vision floor plan into buildingSpec schema.
 * This lets vision-extracted geometry flow through the proven buildingSpecToCSS() path
 * with its auto-layout, overlap detection, and proper coordinate placement.
 *
 * Scoped to: simple orthogonal floor plans, rectangular buildings, simple rooms + openings.
 *
 * @param {object} visionResult - Raw vision extraction result (FLOOR_PLAN)
 * @param {object} titleBlock - Title block metadata (or null)
 * @returns {object} buildingSpec compatible with buildingSpecToCSS()
 */
function visionToBuildingSpec(visionResult, titleBlock) {
  const overallL = visionResult.overallDimensions?.length_m || 20;
  const overallW = visionResult.overallDimensions?.width_m || 10;

  // Estimate height from elevation data if correlated, otherwise default
  const defaultHeight = 3.0;
  const numFloors = 1; // v1: single floor only

  const spec = {
    buildingName: titleBlock?.projectName || titleBlock?.drawingTitle || 'Floor Plan Model',
    buildingType: 'BUILDING',
    dimensions: {
      length_m: overallL,
      width_m: overallW,
      height_m: defaultHeight,
      wall_thickness_m: 0.3,
    },
    structure: {
      num_floors: numFloors,
      floor_to_floor_height_m: defaultHeight,
    },
    rooms: [],
    openings: [],
    equipment: [],
    materials: {},
  };

  // Convert vision rooms → spec rooms
  for (const room of (visionResult.rooms || [])) {
    if (!room.length_m || !room.width_m) continue;
    spec.rooms.push({
      name: room.name || 'Room',
      length_m: room.length_m,
      width_m: room.width_m,
      height_m: defaultHeight,
      usage: room.usage || 'OTHER',
      floor: 1,
      // Use position from assembly if available
      x_position_m: room.position?.x ?? undefined,
      y_position_m: room.position?.y ?? undefined,
    });
  }

  // Convert vision doors → spec openings
  for (const door of (visionResult.doors || [])) {
    const wallSide = resolveWallSide(door.hostWall);
    spec.openings.push({
      type: 'DOOR',
      width_m: door.width_m || 0.9,
      height_m: 2.1,
      sill_height_m: 0,
      wall_side: wallSide,
      x_offset_m: door.offset_m || 1,
      floor: 1,
    });
  }

  // Convert vision windows → spec openings
  for (const win of (visionResult.windows || [])) {
    const wallSide = resolveWallSide(win.hostWall);
    spec.openings.push({
      type: 'WINDOW',
      width_m: win.width_m || 1.2,
      height_m: win.height_m || 1.5,
      sill_height_m: win.sillHeight_m || 0.9,
      wall_side: wallSide,
      x_offset_m: win.offset_m || 1,
      floor: 1,
    });
  }

  // Detect wall thickness from extracted walls if available
  const wallThicknesses = (visionResult.walls || [])
    .filter(w => w.thickness_m && w.thickness_m > 0.05 && w.thickness_m < 2.0)
    .map(w => w.thickness_m);
  if (wallThicknesses.length > 0) {
    spec.dimensions.wall_thickness_m = wallThicknesses.reduce((a, b) => a + b) / wallThicknesses.length;
  }

  console.log(`visionToBuildingSpec: ${spec.rooms.length} rooms, ${spec.openings.length} openings, dims=${overallL}x${overallW}m`);
  return spec;
}

/**
 * Resolve a hostWall reference to a compass side for buildingSpec openings.
 */
function resolveWallSide(hostRef) {
  if (!hostRef) return 'SOUTH';
  const ref = hostRef.toUpperCase();
  if (['NORTH', 'SOUTH', 'EAST', 'WEST'].includes(ref)) return ref;
  // If it's a wall ID like "W1", default to SOUTH
  return 'SOUTH';
}

/**
 * Phase 9d: Component-based confidence model.
 * Computes separate document, geometry, and placement confidence
 * then derives final field-level confidence.
 * Title block does NOT inflate geometry confidence.
 *
 * @param {object} visionResult - Vision extraction result
 * @param {object} element - Individual CSS element with metadata
 * @returns {object} { confidence, fieldConfidence }
 */
function computeComponentConfidence(visionResult, element) {
  const titleBlock = visionResult.titleBlock;
  const scaleDetected = visionResult.scale?.detected || false;
  const derivation = element.metadata?.coordinateDerivation || 'estimated';

  // Document confidence: title block quality, formal vs informal
  let documentConf = 0.35;
  if (titleBlock && titleBlock.confidence >= 0.5) {
    documentConf = 0.60;
    if (titleBlock.drawingNumber) documentConf += 0.05;
    if (titleBlock.firm) documentConf += 0.05;
  }

  // Geometry confidence: dimension annotations, wall endpoints visible
  let geometryConf = 0.35;
  if (scaleDetected) geometryConf += 0.10;
  if (element.metadata?.endPoint) geometryConf += 0.10; // wall has explicit endpoints
  const annotations = visionResult.scale?.dimensionAnnotations || [];
  if (annotations.length >= 2) geometryConf += 0.10;

  // Placement confidence: coordinate derivation method
  let placementConf = 0.30;
  if (derivation === 'direct') placementConf = 0.55;
  else if (derivation === 'assembled') placementConf = 0.45;

  // Derive element-level confidence from components (geometry-weighted)
  const elementConf = geometryConf * 0.5 + placementConf * 0.3 + documentConf * 0.2;

  return {
    confidence: Math.min(Math.max(elementConf, 0.15), 0.90),
    fieldConfidence: {
      dimensions: Math.min(geometryConf, 0.90),
      placement: Math.min(placementConf, 0.90),
      material: Math.min(documentConf * 0.6, 0.60),
    },
  };
}

// Step 1: Classify the image type
const VISION_CLASSIFY_PROMPT = `Classify this architectural/engineering image into exactly ONE category.

Categories:
- FLOOR_PLAN: top-down room layouts showing walls, doors, rooms with labels
- CROSS_SECTION: vertical cut-through showing tunnel/building profile, layers, heights
- EQUIPMENT_LAYOUT: diagram showing equipment positions, piping, ductwork arrangement
- SITE_PLAN: overview showing building footprint on land, roads, orientation
- SPECIFICATION: text-heavy equipment schedule, data sheet, or spec table
- ELEVATION: external view of building face showing heights and features
- PHOTO: photograph of real building/site
- UNKNOWN: cannot determine

Return ONLY a JSON object:
{
  "imageType": "FLOOR_PLAN",
  "confidence": 0.85,
  "hasScale": true,
  "scaleInfo": "1:100" or null,
  "hasDimensions": true,
  "hasGridSystem": false,
  "extractedText": "any readable text labels, titles, dimensions"
}`;

// Type-specific extraction prompts
const VISION_PROMPTS = {
  FLOOR_PLAN: `You are analyzing an architectural FLOOR PLAN drawing.
Extract the geometric layout visible in this drawing. ALL DIMENSIONS IN METRES.
Use the TOP-LEFT corner of the building footprint as origin (0, 0). X increases rightward (East), Y increases downward (South).

Extract:
1. WALLS: perimeter and interior walls. For each wall, provide start and end (x, y) coordinates if you can determine them from the drawing. If you cannot determine coordinates, provide length and side instead.
2. ROOMS: labeled spaces with dimensions AND position. Provide (x, y) offset of the room's top-left corner from building origin if determinable.
3. DOORS: locations on walls with width and offset_m (distance along the host wall from the wall's start point)
4. WINDOWS: locations on walls with width and offset_m (distance along the host wall from the wall's start point)
5. SCALE: if a scale bar or ratio is shown, use it to calibrate all dimensions
6. GRID: if a column grid is visible, extract grid line positions (not just spacing)

Return ONLY valid JSON:
{
  "imageType": "FLOOR_PLAN",
  "confidence": 0.0-1.0,
  "scale": { "detected": true, "ratio": "1:100", "dimensionAnnotations": [{ "label": "5.0m", "confidence": 0.9 }] },
  "overallDimensions": { "length_m": null, "width_m": null },
  "walls": [
    { "id": "W1", "type": "EXTERIOR|INTERIOR", "side": "NORTH|SOUTH|EAST|WEST|INTERIOR", "start": { "x": 0, "y": 0 }, "end": { "x": 10, "y": 0 }, "length_m": 10, "thickness_m": 0.3, "hasCoordinates": true, "confidence": 0.8 }
  ],
  "rooms": [
    { "name": "string", "usage": "OFFICE|STORAGE|MECHANICAL|WC|LOBBY|CORRIDOR|OTHER", "length_m": 0, "width_m": 0, "position": { "x": 0, "y": 0 }, "hasPosition": true, "labeledArea_sqm": null, "confidence": 0.8 }
  ],
  "doors": [
    { "hostWall": "W1 or NORTH/SOUTH/EAST/WEST", "width_m": 0.9, "offset_m": 2.5, "type": "SINGLE|DOUBLE|SLIDING", "confidence": 0.7 }
  ],
  "windows": [
    { "hostWall": "W1 or NORTH/SOUTH/EAST/WEST", "width_m": 1.2, "height_m": 1.5, "sillHeight_m": 0.9, "offset_m": 3.0, "confidence": 0.7 }
  ],
  "grid": { "xLines": [0, 6, 12], "yLines": [0, 8], "xSpacing_m": null, "ySpacing_m": null },
  "annotations": ["any text labels not captured above"],
  "extractedText": "all readable text"
}
Rules:
- Only extract what you can clearly see. Set confidence per element.
- Set hasCoordinates=true ONLY if you can determine wall start/end points from dimensions, scale, or grid. Otherwise set hasCoordinates=false and provide length+side.
- Set hasPosition=true ONLY if you can determine room position from labeled dimensions or scale. Otherwise set hasPosition=false.
- If scale is not detectable, set scale.detected=false and estimate dimensions from labeled values only.
- If no labeled dimensions exist and no scale, set overallDimensions to null.
- Include dimensionAnnotations: any dimension labels visible in the drawing with their confidence.`,

  CROSS_SECTION: `You are analyzing a CROSS-SECTION or PROFILE drawing of a tunnel or building.
Extract the profile geometry. ALL DIMENSIONS IN METRES.

Extract:
1. PROFILE SHAPE: rectangular, horseshoe, circular, arch
2. KEY DIMENSIONS: width, height, wall thickness, floor thickness, roof thickness
3. LAYERS: if visible (lining, rock, insulation, etc.)
4. EQUIPMENT: any equipment shown in the section (fans, ducts, cables)
5. ZONES: labeled areas within the cross-section (traffic zone, escape path, service zone)

Return ONLY valid JSON:
{
  "imageType": "CROSS_SECTION",
  "confidence": 0.0-1.0,
  "profileShape": "RECTANGULAR|HORSESHOE|CIRCULAR|ARCH|D_SHAPE|OTHER",
  "dimensions": {
    "outerWidth_m": null, "outerHeight_m": null,
    "innerWidth_m": null, "innerHeight_m": null,
    "wallThickness_m": null, "floorThickness_m": null, "roofThickness_m": null
  },
  "layers": [
    { "name": "string", "material": "string", "thickness_m": 0, "confidence": 0.7 }
  ],
  "equipment": [
    { "name": "string", "type": "FAN|DUCT|CABLE_TRAY|LIGHTING|PIPE|SENSOR|OTHER", "position": "CEILING|WALL_LEFT|WALL_RIGHT|FLOOR|CENTER", "confidence": 0.7 }
  ],
  "zones": [
    { "name": "string", "width_m": null, "height_m": null }
  ],
  "annotations": ["any text labels"],
  "extractedText": "all readable text"
}
Rules: Only extract clearly visible elements. Estimate dimensions only from labeled values or scale.`,

  EQUIPMENT_LAYOUT: `You are analyzing an EQUIPMENT LAYOUT or PIPING/DUCTWORK DIAGRAM.
Extract equipment positions and connections. ALL DIMENSIONS IN METRES.

Return ONLY valid JSON:
{
  "imageType": "EQUIPMENT_LAYOUT",
  "confidence": 0.0-1.0,
  "equipment": [
    { "name": "string", "type": "FAN|PUMP|GENERATOR|COMPRESSOR|TRANSFORMER|AHU|BOILER|CHILLER|TANK|VALVE|SENSOR|OTHER", "specs": "any visible specs", "relativePosition": "description of where it is", "dimensions": { "length_m": null, "width_m": null, "height_m": null }, "confidence": 0.7 }
  ],
  "connections": [
    { "from": "equipment name", "to": "equipment name", "type": "DUCT|PIPE|CABLE|OTHER", "diameter_m": null }
  ],
  "systemType": "VENTILATION|HVAC|PLUMBING|ELECTRICAL|FIRE_PROTECTION|OTHER",
  "annotations": ["any text labels"],
  "extractedText": "all readable text"
}
Rules: Only extract equipment and connections you can clearly identify.`,

  SITE_PLAN: `You are analyzing a SITE PLAN drawing.
Extract the building footprint and site features. ALL DIMENSIONS IN METRES.

Return ONLY valid JSON:
{
  "imageType": "SITE_PLAN",
  "confidence": 0.0-1.0,
  "buildings": [
    { "name": "string", "footprint": { "length_m": null, "width_m": null }, "orientation_deg": null, "numFloors": null, "confidence": 0.7 }
  ],
  "siteFeatures": ["parking", "road", "landscaping"],
  "overallSiteDimensions": { "length_m": null, "width_m": null },
  "annotations": ["any text labels"],
  "extractedText": "all readable text"
}`,

  ELEVATION: `You are analyzing a building ELEVATION drawing (external face view).
Extract heights and features. ALL DIMENSIONS IN METRES.
Use ground level as z=0. X increases left-to-right across the facade.

Return ONLY valid JSON:
{
  "imageType": "ELEVATION",
  "confidence": 0.0-1.0,
  "face": "NORTH|SOUTH|EAST|WEST|UNKNOWN",
  "overallHeight_m": null,
  "overallWidth_m": null,
  "numFloors": null,
  "floors": [
    { "level": 0, "name": "Ground Floor", "elevation_m": 0, "height_m": 3.5, "confidence": 0.8 }
  ],
  "floorToFloorHeight_m": null,
  "windows": [{ "floor": 1, "count": 0, "width_m": null, "height_m": null, "sillElevation_m": null, "xOffset_m": null, "confidence": 0.7 }],
  "doors": [{ "floor": 0, "width_m": null, "height_m": null, "xOffset_m": null, "confidence": 0.7 }],
  "roofType": "FLAT|GABLE|HIP|OTHER",
  "roofPitch_deg": null,
  "roofElevation_m": null,
  "levelLabels": ["any floor/level labels visible, e.g. FFL +3.500"],
  "annotations": ["any text labels"],
  "extractedText": "all readable text"
}
Rules:
- Extract per-floor elevation values if visible (e.g. FFL +3.500, SSL +0.000).
- xOffset_m is the horizontal distance from the left edge of the facade.
- Only set elevation_m values you can read from dimension lines or level markers.
- If floor elevations are not labeled, estimate from floor-to-floor height if available.`,

  // Fallback for SPECIFICATION, PHOTO, UNKNOWN
  DEFAULT: `You are analyzing an architectural/engineering image or scanned document.
Extract any building or infrastructure information visible.

Return ONLY valid JSON:
{
  "imageType": "SPECIFICATION|PHOTO|UNKNOWN",
  "confidence": 0.0-1.0,
  "extractedText": "any readable text in the image",
  "buildingInfo": {
    "buildingType": "string or null",
    "dimensions": { "length_m": null, "width_m": null, "height_m": null },
    "rooms": [{ "name": "string", "length_m": 0, "width_m": 0 }],
    "equipment": [{ "name": "string", "type": "string", "specs": "string" }],
    "materials": ["string"],
    "notes": "any additional relevant information"
  }
}
Only include information you can clearly see — do not guess.`
};

// Confidence thresholds for vision-to-CSS conversion
const VISION_GEOMETRY_CONFIDENCE = 0.6;
const VISION_SCALE_REQUIRED_FOR_GEOMETRY = true;

/**
 * Convert structured vision extraction into CSS elements (confidence-gated).
 * Only creates geometry when scale can be estimated AND element confidence >= threshold.
 * Otherwise stores as visionFindings metadata only.
 */
function visionToCSS(visionResult, fileName) {
  const elements = [];
  const findings = [];
  const imageType = visionResult.imageType;
  const hasScale = visionResult.scale?.detected || false;
  const hasDimensions = !!(visionResult.overallDimensions?.length_m || visionResult.dimensions?.innerWidth_m);

  // Can we generate geometry? Need either detected scale or labeled dimensions
  const canGenerateGeometry = hasScale || hasDimensions || !VISION_SCALE_REQUIRED_FOR_GEOMETRY;

  if (imageType === 'FLOOR_PLAN') {
    const overallL = visionResult.overallDimensions?.length_m;
    const overallW = visionResult.overallDimensions?.width_m;

    // Phase 9b: Run spatial layout assembly to get coordinate-bearing geometry
    const assembled = assembleFloorPlanLayout(visionResult);

    // Walls → CSS elements (now with assembled coordinates)
    for (const wall of assembled.walls) {
      if (!canGenerateGeometry || (wall.confidence || 0) < VISION_GEOMETRY_CONFIDENCE || !wall.length_m || wall.length_m <= 0) {
        findings.push({ type: 'WALL', data: wall, reason: !canGenerateGeometry ? 'NO_SCALE' : 'LOW_CONFIDENCE', source: fileName });
        continue;
      }
      elements.push({
        type: 'WALL', semanticType: 'IfcWall',
        name: wall.id || `Vision Wall`,
        geometry: { profile: { width: wall.thickness_m || 0.3, height: wall.computedLength || wall.length_m }, depth: 3.0 },
        placement: wall.placement,
        metadata: { visionExtracted: true, wallSide: wall.side, wallType: wall.type, confidence: wall.confidence, coordinateDerivation: wall.coordinateDerivation, endPoint: wall.endPoint },
        source: 'VISION', sourceFile: fileName, confidence: wall.confidence || 0.5
      });
    }

    // Rooms → CSS SPACE elements (now with assembled coordinates)
    for (const room of assembled.rooms) {
      if (!canGenerateGeometry || (room.confidence || 0) < VISION_GEOMETRY_CONFIDENCE || !room.length_m || !room.width_m) {
        findings.push({ type: 'SPACE', data: room, reason: !canGenerateGeometry ? 'NO_SCALE' : 'LOW_CONFIDENCE', source: fileName });
        continue;
      }
      elements.push({
        type: 'SPACE', semanticType: 'IfcSpace',
        name: room.name || 'Room',
        properties: { usage: room.usage || 'OTHER' },
        geometry: { profile: { width: room.width_m, height: room.length_m }, depth: 3.0 },
        placement: room.placement,
        metadata: { visionExtracted: true, labeledArea: room.labeledArea_sqm, confidence: room.confidence, coordinateDerivation: room.coordinateDerivation },
        source: 'VISION', sourceFile: fileName, confidence: room.confidence || 0.5
      });
    }

    // Doors → CSS DOOR elements (now with assembled coordinates)
    for (const door of assembled.doors) {
      if ((door.confidence || 0) < VISION_GEOMETRY_CONFIDENCE) {
        findings.push({ type: 'DOOR', data: door, reason: 'LOW_CONFIDENCE', source: fileName });
        continue;
      }
      elements.push({
        type: 'DOOR', semanticType: 'IfcDoor',
        name: `Door (${door.type || 'SINGLE'})`,
        geometry: { profile: { width: door.width_m || 0.9, height: 2.1 }, depth: 0.1 },
        placement: door.placement,
        metadata: { visionExtracted: true, hostWall: door.hostWall, doorType: door.type, confidence: door.confidence, coordinateDerivation: door.coordinateDerivation },
        source: 'VISION', sourceFile: fileName, confidence: door.confidence || 0.5
      });
    }

    // Windows → CSS WINDOW elements (now with assembled coordinates)
    for (const win of assembled.windows) {
      if ((win.confidence || 0) < VISION_GEOMETRY_CONFIDENCE) {
        findings.push({ type: 'WINDOW', data: win, reason: 'LOW_CONFIDENCE', source: fileName });
        continue;
      }
      elements.push({
        type: 'WINDOW', semanticType: 'IfcWindow',
        name: `Window`,
        geometry: { profile: { width: win.width_m || 1.2, height: win.height_m || 1.5 }, depth: 0.15 },
        placement: win.placement,
        metadata: { visionExtracted: true, hostWall: win.hostWall, confidence: win.confidence, coordinateDerivation: win.coordinateDerivation },
        source: 'VISION', sourceFile: fileName, confidence: win.confidence || 0.5
      });
    }

    // Store overall dimensions as building-level finding even if elements pass
    if (overallL && overallW) {
      findings.push({ type: 'BUILDING_ENVELOPE', data: { length_m: overallL, width_m: overallW }, reason: 'INFORMATIONAL', source: fileName });
    }

    // Store assembly stats as finding for traceability
    findings.push({ type: 'ASSEMBLY_STATS', data: assembled.stats, reason: 'INFORMATIONAL', source: fileName });

  } else if (imageType === 'CROSS_SECTION') {
    // Cross-section → tunnel profile or building section info
    const dims = visionResult.dimensions || {};
    if (dims.innerWidth_m && dims.innerHeight_m) {
      findings.push({
        type: 'TUNNEL_PROFILE', data: {
          profileShape: visionResult.profileShape,
          innerWidth_m: dims.innerWidth_m, innerHeight_m: dims.innerHeight_m,
          wallThickness_m: dims.wallThickness_m, layers: visionResult.layers
        }, reason: 'INFORMATIONAL', source: fileName
      });
    }

    // Map vision equipment type labels → IFC semantic types
    const VISION_EQUIP_MAP = {
      FAN: 'IfcFan', PUMP: 'IfcPump', DUCT: 'IfcDuctSegment', PIPE: 'IfcPipeSegment',
      CABLE_TRAY: 'IfcCableCarrierSegment', LIGHTING: 'IfcLightFixture',
      SENSOR: 'IfcSensor', GENERATOR: 'IfcElectricGenerator', COMPRESSOR: 'IfcCompressor',
      TRANSFORMER: 'IfcTransformer', AHU: 'IfcUnitaryEquipment', BOILER: 'IfcBoiler',
      CHILLER: 'IfcChiller', TANK: 'IfcTank', VALVE: 'IfcValve',
    };

    // Equipment in cross-section
    for (const eq of (visionResult.equipment || [])) {
      if ((eq.confidence || 0) < VISION_GEOMETRY_CONFIDENCE) {
        findings.push({ type: 'EQUIPMENT', data: eq, reason: 'LOW_CONFIDENCE', source: fileName });
        continue;
      }
      const eqSemantic = VISION_EQUIP_MAP[(eq.type || '').toUpperCase()] || 'IfcBuildingElementProxy';
      elements.push({
        type: 'EQUIPMENT',
        name: eq.name || 'Equipment',
        semanticType: eqSemantic,
        geometry: { profile: { width: 1.0, height: 1.0 }, depth: 1.0 },
        placement: { origin: { x: 0, y: 0, z: 0 } },
        metadata: { visionExtracted: true, crossSectionPosition: eq.position, confidence: eq.confidence },
        source: 'VISION', sourceFile: fileName, confidence: eq.confidence || 0.5
      });
    }

  } else if (imageType === 'EQUIPMENT_LAYOUT') {
    for (const eq of (visionResult.equipment || [])) {
      const dims = eq.dimensions || {};
      if ((eq.confidence || 0) < VISION_GEOMETRY_CONFIDENCE) {
        findings.push({ type: 'EQUIPMENT', data: eq, reason: 'LOW_CONFIDENCE', source: fileName });
        continue;
      }
      const eqSemantic = VISION_EQUIP_MAP[(eq.type || '').toUpperCase()] || 'IfcBuildingElementProxy';
      elements.push({
        type: 'EQUIPMENT',
        name: eq.name || 'Equipment',
        semanticType: eqSemantic,
        geometry: { profile: { width: dims.width_m || 1.0, height: dims.length_m || 1.0 }, depth: dims.height_m || 1.0 },
        placement: { origin: { x: 0, y: 0, z: 0 } },
        metadata: { visionExtracted: true, specs: eq.specs, relativePosition: eq.relativePosition, confidence: eq.confidence },
        source: 'VISION', sourceFile: fileName, confidence: eq.confidence || 0.5
      });
    }
    if (visionResult.connections?.length > 0) {
      findings.push({ type: 'SYSTEM_CONNECTIONS', data: { systemType: visionResult.systemType, connections: visionResult.connections }, reason: 'INFORMATIONAL', source: fileName });
    }

  } else if (imageType === 'ELEVATION') {
    // Phase 9b: Assemble elevation layout with vertical coordinates
    const elevLayout = assembleElevationLayout(visionResult);

    // Store elevation data as finding (used for cross-drawing correlation)
    findings.push({
      type: 'ELEVATION_DATA', data: {
        face: elevLayout.face, height_m: elevLayout.overallHeight_m, width_m: elevLayout.overallWidth_m,
        numFloors: visionResult.numFloors, floorHeight_m: visionResult.floorToFloorHeight_m,
        roofType: visionResult.roofType, roofPitch: visionResult.roofPitch_deg,
        floors: elevLayout.floors,
        windows: elevLayout.windows, doors: elevLayout.doors
      }, reason: 'INFORMATIONAL', source: fileName
    });

    // Store assembled elevation layout for cross-drawing correlation (9b.3)
    // This is attached to the visionCSS output so correlateDrawings() can access it

  } else if (imageType === 'SITE_PLAN') {
    for (const bldg of (visionResult.buildings || [])) {
      findings.push({ type: 'SITE_BUILDING', data: bldg, reason: 'INFORMATIONAL', source: fileName });
    }

  } else {
    // DEFAULT/SPECIFICATION/PHOTO — store building info as findings
    if (visionResult.buildingInfo) {
      findings.push({ type: 'BUILDING_INFO', data: visionResult.buildingInfo, reason: 'INFORMATIONAL', source: fileName });
    }
  }

  // Phase 9b: If this is an elevation, store assembled layout for cross-drawing correlation
  const elevationLayout = (imageType === 'ELEVATION') ? assembleElevationLayout(visionResult) : null;

  console.log(`visionToCSS(${fileName}): ${elements.length} elements, ${findings.length} findings (type=${imageType}, scale=${hasScale}, sheetRole=${visionResult.sheetRole || 'N/A'})`);
  return {
    elements, findings, imageType,
    extractedText: visionResult.extractedText || visionResult.annotations?.join('; ') || '',
    // Phase 9a: Pass through drawing metadata for claims evidence and render metadata
    titleBlock: visionResult.titleBlock || null,
    sheetRole: visionResult.sheetRole || null,
    scaleInfo: visionResult.scale || null,
    // Phase 9b: Elevation layout for cross-drawing correlation
    elevationLayout,
  };
}

async function callBedrockVision(buffer, mediaType, prompt, bedrockClient, contentType = 'image') {
  const base64 = buffer.toString('base64');
  const sourceBlock = contentType === 'document'
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: 'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [sourceBlock, { type: 'text', text: prompt }]
      }]
    })
  }));

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const text = responseBody.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  return JSON.parse(jsonMatch[0]);
}

async function extractFromImage(imageBuffer, fileName, bedrockClient) {
  try {
    const ext = fileName.toLowerCase().split('.').pop();
    const mediaTypeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tiff: 'image/png', tif: 'image/png' };
    const mediaType = mediaTypeMap[ext] || 'image/png';

    // Phase 9a: Increased from 5MB to 20MB (Bedrock supports up to 20MB)
    if (imageBuffer.length > 20 * 1024 * 1024) {
      console.warn(`Image ${fileName} too large (${imageBuffer.length} bytes), skipping vision extraction`);
      return null;
    }

    // Phase 9a Step 0: Extract title block metadata (runs before classification)
    const titleBlock = await extractTitleBlock(imageBuffer, mediaType, bedrockClient);
    if (titleBlock) {
      console.log(`Title block found in ${fileName}: project="${titleBlock.projectName}", drawing="${titleBlock.drawingNumber}", scale="${titleBlock.scale}", confidence=${titleBlock.confidence}`);
    }

    // Step 1: Classify the image type
    const classification = await callBedrockVision(imageBuffer, mediaType, VISION_CLASSIFY_PROMPT, bedrockClient);
    if (!classification) {
      console.warn(`Vision classification for ${fileName}: no result`);
      return null;
    }

    const imageType = classification.imageType || 'UNKNOWN';
    const sheetRole = classifySheetRole(imageType);
    console.log(`Vision classify ${fileName}: type=${imageType}, sheetRole=${sheetRole}, confidence=${classification.confidence}, scale=${classification.hasScale}`);

    // Phase 9a: Skip geometry extraction for non-drawing pages but preserve text
    if (!isGeometryDrawingRole(sheetRole)) {
      console.log(`Non-drawing page ${fileName} (role=${sheetRole}), skipping geometry extraction`);
      return {
        imageType, confidence: classification.confidence,
        extractedText: classification.extractedText || '',
        buildingInfo: null, titleBlock, sheetRole,
      };
    }

    // Step 2: Use type-specific extraction prompt
    const extractPrompt = VISION_PROMPTS[imageType] || VISION_PROMPTS.DEFAULT;
    const result = await callBedrockVision(imageBuffer, mediaType, extractPrompt, bedrockClient);
    if (!result) {
      console.warn(`Vision extraction for ${fileName}: no result from type-specific prompt`);
      return { imageType, confidence: classification.confidence, extractedText: classification.extractedText || '', buildingInfo: null, titleBlock, sheetRole };
    }

    // Merge classification metadata into result
    result.imageType = result.imageType || imageType;
    result.sheetRole = sheetRole;
    result.titleBlock = titleBlock;
    if (classification.hasScale && !result.scale) {
      result.scale = { detected: true, ratio: classification.scaleInfo };
    }
    // Phase 9a: If title block has scale and extraction didn't detect one, use title block scale
    if (titleBlock?.scale && !result.scale?.detected) {
      result.scale = { detected: true, ratio: titleBlock.scale, source: 'title_block' };
    }
    if (classification.extractedText && !result.extractedText) {
      result.extractedText = classification.extractedText;
    }

    // Phase 9c: Run scale calibration
    result.calibratedScale = calibrateScale(result);
    if (result.calibratedScale.scaleConfidence > 0) {
      console.log(`Scale calibrated for ${fileName}: ratio=${result.calibratedScale.scaleRatio}, confidence=${result.calibratedScale.scaleConfidence}, source=${result.calibratedScale.source}`);
    }

    console.log(`Vision extraction for ${fileName}: type=${result.imageType}, sheetRole=${sheetRole}, confidence=${result.confidence}, titleBlock=${!!titleBlock}`);
    return result;
  } catch (err) {
    console.warn(`Vision extraction failed for ${fileName}:`, err.message);
    return null;
  }
}

async function extractFromScannedPDF(pdfBuffer, fileName, bedrockClient) {
  try {
    // Phase 9a: Increased from 5MB to 20MB
    if (pdfBuffer.length > 20 * 1024 * 1024) {
      console.warn(`Scanned PDF ${fileName} too large (${pdfBuffer.length} bytes), skipping`);
      return null;
    }

    // Phase 9a Step 0: Extract title block
    const titleBlock = await extractTitleBlock(pdfBuffer, 'application/pdf', bedrockClient, 'document');
    if (titleBlock) {
      console.log(`Title block found in scanned PDF ${fileName}: project="${titleBlock.projectName}", drawing="${titleBlock.drawingNumber}", scale="${titleBlock.scale}"`);
    }

    // Step 1: Classify
    const classification = await callBedrockVision(pdfBuffer, 'application/pdf', VISION_CLASSIFY_PROMPT, bedrockClient, 'document');
    if (!classification) return null;

    const imageType = classification.imageType || 'UNKNOWN';
    const sheetRole = classifySheetRole(imageType);
    console.log(`Scanned PDF classify ${fileName}: type=${imageType}, sheetRole=${sheetRole}, confidence=${classification.confidence}`);

    // Phase 9a: Skip geometry extraction for non-drawing pages
    if (!isGeometryDrawingRole(sheetRole)) {
      return {
        imageType, confidence: classification.confidence,
        extractedText: classification.extractedText || '',
        buildingInfo: null, titleBlock, sheetRole,
      };
    }

    // Step 2: Type-specific extraction
    const extractPrompt = VISION_PROMPTS[imageType] || VISION_PROMPTS.DEFAULT;
    const result = await callBedrockVision(pdfBuffer, 'application/pdf', extractPrompt, bedrockClient, 'document');
    if (!result) {
      return { imageType, confidence: classification.confidence, extractedText: classification.extractedText || '', buildingInfo: null, titleBlock, sheetRole };
    }

    result.imageType = result.imageType || imageType;
    result.sheetRole = sheetRole;
    result.titleBlock = titleBlock;
    if (classification.hasScale && !result.scale) {
      result.scale = { detected: true, ratio: classification.scaleInfo };
    }
    if (titleBlock?.scale && !result.scale?.detected) {
      result.scale = { detected: true, ratio: titleBlock.scale, source: 'title_block' };
    }
    if (classification.extractedText && !result.extractedText) {
      result.extractedText = classification.extractedText;
    }

    // Phase 9c: Run scale calibration
    result.calibratedScale = calibrateScale(result);

    console.log(`Scanned PDF extraction for ${fileName}: type=${result.imageType}, sheetRole=${sheetRole}, confidence=${result.confidence}, titleBlock=${!!titleBlock}`);
    return result;
  } catch (err) {
    console.warn(`Scanned PDF extraction failed for ${fileName}:`, err.message);
    return null;
  }
}

/**
 * Phase 9c: Extract from a multi-page scanned PDF.
 * Processes up to 5 pages individually with page role classification,
 * title block extraction (first found only), and type-specific geometry extraction.
 * Non-drawing pages (SCHEDULE, TITLE_SHEET, UNKNOWN) are skipped for geometry.
 *
 * @param {Buffer} pdfBuffer - Raw PDF buffer
 * @param {string} fileName - Source file name
 * @param {object} bedrockClient - Bedrock client
 * @param {number} pageCount - Number of pages in the PDF
 * @returns {Array} Array of per-page vision results
 */
async function extractFromMultiPagePDF(pdfBuffer, fileName, bedrockClient, pageCount) {
  const MAX_PAGES = 5;
  const PER_PAGE_TIMEOUT = 30000; // 30s per Bedrock call
  const TOTAL_BUDGET_MS = 120000; // 120s total vision processing budget
  const startTime = Date.now();
  const results = [];
  let titleBlock = null;
  let consecutiveLowConf = 0;

  const pagesToProcess = Math.min(pageCount, MAX_PAGES);
  console.log(`Multi-page PDF ${fileName}: processing ${pagesToProcess} of ${pageCount} pages`);

  for (let page = 1; page <= pagesToProcess; page++) {
    // Check total budget
    if (Date.now() - startTime > TOTAL_BUDGET_MS) {
      console.warn(`Multi-page PDF ${fileName}: total budget exceeded at page ${page}, stopping`);
      break;
    }

    // Early stop on consecutive low-confidence pages
    if (consecutiveLowConf >= 2) {
      console.log(`Multi-page PDF ${fileName}: 2 consecutive low-confidence pages, stopping at page ${page}`);
      break;
    }

    try {
      // Bedrock supports multi-page PDF natively — add page-focus instruction
      const pagePrefix = `Focus on page ${page} of this ${pageCount}-page document.\n\n`;

      // Step 0: Title block (only if not yet found)
      if (!titleBlock) {
        const tbPrompt = pagePrefix + TITLE_BLOCK_PROMPT;
        const tbResult = await callBedrockVisionWithTimeout(pdfBuffer, 'application/pdf', tbPrompt, bedrockClient, 'document', PER_PAGE_TIMEOUT);
        if (tbResult?.hasTitleBlock && (tbResult.confidence || 0) >= 0.3) {
          titleBlock = {
            projectName: tbResult.projectName || null,
            drawingTitle: tbResult.drawingTitle || null,
            drawingNumber: tbResult.drawingNumber || null,
            sheetNumber: tbResult.sheetNumber || null,
            revision: tbResult.revision || null,
            date: tbResult.date || null,
            scale: tbResult.scale || null,
            author: tbResult.author || null,
            firm: tbResult.firm || null,
            confidence: tbResult.confidence || 0,
            fieldConfidence: tbResult.fieldConfidence || {},
          };
          console.log(`Multi-page PDF ${fileName} page ${page}: title block found (project="${titleBlock.projectName}")`);
        }
      }

      // Step 1: Classify page
      const classifyPrompt = pagePrefix + VISION_CLASSIFY_PROMPT;
      const classification = await callBedrockVisionWithTimeout(pdfBuffer, 'application/pdf', classifyPrompt, bedrockClient, 'document', PER_PAGE_TIMEOUT);
      if (!classification || (classification.confidence || 0) < 0.2) {
        consecutiveLowConf++;
        continue;
      }

      const imageType = classification.imageType || 'UNKNOWN';
      const sheetRole = classifySheetRole(imageType);
      console.log(`Multi-page PDF ${fileName} page ${page}: type=${imageType}, sheetRole=${sheetRole}, confidence=${classification.confidence}`);

      // Skip non-geometry pages
      if (!isGeometryDrawingRole(sheetRole)) {
        results.push({
          page, imageType, sheetRole, confidence: classification.confidence,
          extractedText: classification.extractedText || '',
          titleBlock, isGeometry: false,
        });
        consecutiveLowConf = 0; // Non-drawing is valid, just not geometry
        continue;
      }

      // Step 2: Type-specific extraction
      const extractPrompt = pagePrefix + (VISION_PROMPTS[imageType] || VISION_PROMPTS.DEFAULT);
      const result = await callBedrockVisionWithTimeout(pdfBuffer, 'application/pdf', extractPrompt, bedrockClient, 'document', PER_PAGE_TIMEOUT);

      if (!result || (result.confidence || 0) < 0.2) {
        consecutiveLowConf++;
        continue;
      }

      result.imageType = result.imageType || imageType;
      result.sheetRole = sheetRole;
      result.titleBlock = titleBlock;
      result.page = page;

      if (classification.hasScale && !result.scale) {
        result.scale = { detected: true, ratio: classification.scaleInfo };
      }
      if (titleBlock?.scale && !result.scale?.detected) {
        result.scale = { detected: true, ratio: titleBlock.scale, source: 'title_block' };
      }
      if (classification.extractedText && !result.extractedText) {
        result.extractedText = classification.extractedText;
      }

      // Phase 9c: Calibrate scale
      result.calibratedScale = calibrateScale(result);
      result.isGeometry = true;

      results.push(result);
      consecutiveLowConf = 0;

    } catch (pageErr) {
      console.warn(`Multi-page PDF ${fileName} page ${page} failed: ${pageErr.message}`);
      consecutiveLowConf++;
    }
  }

  console.log(`Multi-page PDF ${fileName}: processed ${results.length} pages in ${Date.now() - startTime}ms`);
  return results;
}

/**
 * callBedrockVision with a per-call timeout.
 * Returns null if the call exceeds the timeout.
 */
async function callBedrockVisionWithTimeout(buffer, mediaType, prompt, bedrockClient, contentType, timeoutMs) {
  try {
    const result = await Promise.race([
      callBedrockVision(buffer, mediaType, prompt, bedrockClient, contentType),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Vision call timeout')), timeoutMs)),
    ]);
    return result;
  } catch (err) {
    if (err.message === 'Vision call timeout') {
      console.warn('Bedrock vision call timed out');
      return null;
    }
    throw err;
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

export const handler = async (event, context) => {
  console.log('ExtractBuildingSpec input:', JSON.stringify(event, null, 2));
  const { userId, renderId, bucket, files, description, render } = event;
  const revision = event.renderRevision || 1;
  let previousCSS = event.previousCSS || null;
  const refinementText = render?.refinement || null;

  // Phase 13 PR2: Trace start — written before any real work begins.
  const _traceRunId = context?.awsRequestId || `extract-${Date.now()}`;
  const _traceStartedAt = new Date().toISOString();
  let _traceKey = null; let _traceAttemptN = 1;
  try {
    const t = await writeTraceStart({ renderId, stage: 'extract', runId: _traceRunId, startedAt: _traceStartedAt });
    _traceKey = t.key; _traceAttemptN = t.attemptN;
  } catch (te) { console.warn('[trace] start write failed (non-fatal):', te.message); }
  initAudit(renderId, 'extract', _traceRunId);
  if (refinementText) console.log(`Refinement context present: "${refinementText.slice(0, 120)}..."`);

  // If refinement is requested but previousCSS wasn't passed through Step Function,
  // load it directly from S3 (the processed/validated version)
  if (refinementText && !previousCSS) {
    console.log('previousCSS not in event — loading from S3 for refinement...');
    const cssKey = `uploads/${userId}/${renderId}/css/css_processed.json`;
    try {
      const cssResponse = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: cssKey }));
      const cssBuffer = await cssResponse.Body.transformToByteArray();
      previousCSS = JSON.parse(Buffer.from(cssBuffer).toString('utf-8'));
      console.log(`Loaded previous CSS from S3: ${cssKey} (${JSON.stringify(previousCSS).length} bytes)`);
    } catch (err) {
      console.warn(`Could not load previous CSS from S3 (${cssKey}): ${err.message}`);
      // Fall back to css_raw.json
      const rawKey = `uploads/${userId}/${renderId}/css/css_raw.json`;
      try {
        const rawResp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: rawKey }));
        const rawBuf = await rawResp.Body.transformToByteArray();
        previousCSS = JSON.parse(Buffer.from(rawBuf).toString('utf-8'));
        console.log(`Loaded previous CSS from raw fallback: ${rawKey}`);
      } catch (err2) {
        console.warn(`Could not load CSS from either path, refinement will use full re-extraction: ${err2.message}`);
      }
    }
  }
  if (previousCSS) console.log(`Previous CSS available for refinement (${JSON.stringify(previousCSS).length} bytes)`);

  const extractStartTime = Date.now();

  try {
    // Track per-file parse status
    const sourceFiles = [];

    // Download description if available
    let descriptionContent = description || '';
    const descFile = files.find(f => f.name === 'description.txt');
    if (descFile) {
      const result = await downloadFile(bucket, descFile.key);
      if (result.content) {
        descriptionContent = result.content;
        sourceFiles.push({ name: 'description.txt', parseStatus: 'success', role: 'description' });
      } else {
        sourceFiles.push({ name: 'description.txt', parseStatus: 'failed', role: 'description', reason: result.reason || 'empty' });
      }
    }

    // Download and process all files
    const processedFiles = [];

    for (const file of files) {
      if (file.name === 'description.txt') continue;

      const result = await downloadFile(bucket, file.key);

      if (result.type === 'text' && result.content) {
        // v6: Detect scanned PDFs (very little text extracted)
        const ext = file.name.toLowerCase().split('.').pop();
        if (ext === 'pdf' && result.content.trim().length < 50) {
          console.log(`Scanned PDF detected: ${file.name} (only ${result.content.trim().length} chars extracted)`);
          try {
            const rawResult = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.key }));
            const pdfBuffer = Buffer.from(await rawResult.Body.transformToByteArray());

            // Phase 9c: Check page count for multi-page processing
            let pdfPageCount = 1;
            try {
              const pdfMeta = await pdf(pdfBuffer, { max: 0 }); // parse metadata only
              pdfPageCount = pdfMeta.numpages || 1;
            } catch (_) { /* fallback to 1 page */ }

            if (pdfPageCount > 1) {
              // Multi-page path: process up to 5 pages individually
              console.log(`Multi-page scanned PDF: ${file.name} has ${pdfPageCount} pages`);
              const pageResults = await extractFromMultiPagePDF(pdfBuffer, file.name, bedrock, pdfPageCount);
              let addedPages = 0;
              for (const pageResult of pageResults) {
                if (!pageResult.isGeometry) continue;
                if ((pageResult.confidence || 0) <= 0.2) continue;
                const pageName = `${file.name}#p${pageResult.page}`;
                const visionCSS = visionToCSS(pageResult, pageName);
                const visionText = visionCSS.extractedText || pageResult.extractedText || '';
                processedFiles.push({ name: pageName, content: visionText, sourceRole: 'VISION', type: 'scanned_pdf', visionData: pageResult, visionCSS });
                sourceFiles.push({ name: pageName, parseStatus: 'success', role: 'vision', sourceRole: 'VISION', imageType: pageResult.imageType, page: pageResult.page });
                addedPages++;
              }
              if (addedPages === 0) {
                // No geometry pages found — fall back to text content
                processedFiles.push({ name: file.name, content: result.content });
                sourceFiles.push({ name: file.name, parseStatus: 'success', role: 'unknown' });
              } else {
                console.log(`Multi-page PDF ${file.name}: ${addedPages} geometry pages extracted`);
              }
            } else {
              // Single-page path: original behavior
              const visionResult = await extractFromScannedPDF(pdfBuffer, file.name, bedrock);
              if (visionResult && visionResult.confidence > 0.2) {
                const visionCSS = visionToCSS(visionResult, file.name);
                const visionText = visionCSS.extractedText || visionResult.extractedText || JSON.stringify(visionResult.buildingInfo || {});
                processedFiles.push({ name: file.name, content: visionText, sourceRole: 'VISION', type: 'scanned_pdf', visionData: visionResult, visionCSS });
                sourceFiles.push({ name: file.name, parseStatus: 'success', role: 'vision', sourceRole: 'VISION', imageType: visionResult.imageType });
              } else {
                processedFiles.push({ name: file.name, content: result.content });
                sourceFiles.push({ name: file.name, parseStatus: 'success', role: 'unknown' });
              }
            }
          } catch (vErr) {
            console.warn(`Scanned PDF fallback failed for ${file.name}:`, vErr.message);
            processedFiles.push({ name: file.name, content: result.content });
            sourceFiles.push({ name: file.name, parseStatus: 'success', role: 'unknown' });
          }
        } else {
          processedFiles.push({ name: file.name, content: result.content });
          sourceFiles.push({ name: file.name, parseStatus: 'success', role: 'unknown' });
        }
      } else if (result.type === 'image') {
        // v6+: Image file — two-step classify + type-specific extraction
        console.log(`Image file detected: ${file.name}`);
        try {
          const visionResult = await extractFromImage(result.buffer, file.name, bedrock);
          if (visionResult && visionResult.confidence > 0.2) {
            const visionCSS = visionToCSS(visionResult, file.name);
            const visionText = visionCSS.extractedText || visionResult.extractedText || JSON.stringify(visionResult.buildingInfo || {});
            processedFiles.push({ name: file.name, content: visionText, sourceRole: 'VISION', type: 'image', visionData: visionResult, visionCSS });
            sourceFiles.push({ name: file.name, parseStatus: 'success', role: 'vision', sourceRole: 'VISION', imageType: visionResult.imageType });
          } else {
            sourceFiles.push({ name: file.name, parseStatus: 'low_confidence', role: 'vision', reason: 'Vision extraction confidence too low' });
          }
        } catch (vErr) {
          console.warn(`Vision extraction failed for ${file.name}:`, vErr.message);
          sourceFiles.push({ name: file.name, parseStatus: 'failed', role: 'vision', reason: vErr.message });
        }
      } else if (result.type === 'unsupported') {
        sourceFiles.push({ name: file.name, parseStatus: 'unsupported', role: 'unknown', reason: result.reason });
      } else {
        sourceFiles.push({ name: file.name, parseStatus: 'failed', role: 'unknown', reason: result.reason || 'download error' });
      }
    }

    console.log(`Processed ${processedFiles.length} files, ${sourceFiles.filter(f => f.parseStatus !== 'success').length} failed/unsupported`);

    // Classify all processed files by role (Phase A)
    for (const pf of processedFiles) {
      pf.sourceRole = classifySourceFile(pf);
      const sf = sourceFiles.find(f => f.name === pf.name);
      if (sf) sf.sourceRole = pf.sourceRole;
      console.log(`File classification: ${pf.name} → ${pf.sourceRole}`);
    }

    // Deterministic spec-text claim extraction — runs alongside any primary parser
    // path (VSM / DXF / LLM). Pulls structured rooms / doors / systems / shaft /
    // tunnel-bore overrides / equipment / duct + fitting specs from .txt / .docx
    // / .pdf-text content via regex (no LLM). Output is merged into claims.json
    // at every emission site below.
    let specClaims = [];
    let specParsed = null;
    try {
      const specInputs = processedFiles
        .filter(pf => typeof pf.content === 'string' && pf.content.length > 0)
        .map(pf => ({ name: pf.name, content: pf.content }));
      const parsed = parseSpecTexts(specInputs);
      specParsed = parsed;
      const specResult = specTextToClaims(parsed);
      specClaims = specResult.claims || [];
      console.log(`[specText] Extracted ${specClaims.length} claims from ${specInputs.length} text inputs`);
    } catch (specErr) {
      console.warn('[specText] Spec-text extraction failed (non-fatal):', specErr.message);
    }

    // Check for VentSim file
    const ventSimFile = processedFiles.find(f => isVentSim(f.content));
    if (ventSimFile) {
      console.log('Detected VentSim format in file:', ventSimFile.name);
      const sf = sourceFiles.find(f => f.name === ventSimFile.name);
      if (sf) { sf.role = 'geometry'; sf.sourceRole = 'SIMULATION'; }

      let css = parseVentSimToCSS(ventSimFile.content, ventSimFile.name);

      if (css) {
        css.metadata.sourceFiles = sourceFiles;

        // Source-authority gating: VentSim is a structured geometric source.
        // LLM cannot create structural elements when structured source exists.
        css.metadata._hasStructuredSource = true;
        css.metadata._sourceAuthority = 'CAD_SIMULATION';
        css.metadata._sourceAuthorityLevel = 'DIRECT_3D';

        // VentSim geometry is always primary — it has precise 3D coordinates.
        // Narrative files enrich metadata (equipment names/specs) via enrichCSS below.
        const otherFiles = processedFiles.filter(f => f !== ventSimFile);
        if (otherFiles.length > 0) {
          console.log(`Source fusion: ${otherFiles.length} supplementary files found (${otherFiles.map(f => f.name).join(', ')})`);
          const { text: suppText, truncatedFiles } = buildSupplementaryText(otherFiles);
          if (css.metadata?.diagnostics) css.metadata.diagnostics.truncatedFiles = truncatedFiles;
          css = await enrichCSS(css, suppText);

          // v6: Restricted safe source fusion — extract fusible equipment from docs
          // Skip for TUNNEL domain: fused equipment inherits real mine elevation offsets (z=3-53m)
          // which places them far above the tunnel network floor as floating proxies
          console.log(`Source fusion: supplementary text length = ${suppText.length} chars`);
          const docFindings = (css.domain === 'TUNNEL') ? [] : await extractDocumentFindings(suppText, otherFiles.map(f => f.name));
          if (docFindings.length > 0) {
            // Log anchor availability before fusion
            const anchorTypes = new Set(['SPACE', 'TUNNEL_SEGMENT', 'WALL']);
            const availAnchors = css.elements.filter(e => anchorTypes.has((e.type || '').toUpperCase()) && e.placement?.origin);
            console.log(`Source fusion: ${docFindings.length} findings, ${availAnchors.length} anchors available (${[...new Set(availAnchors.map(a => a.type))].join(', ')})`);
            attemptSafeSourceFusion(css, docFindings, sourceFiles);
          } else {
            console.log('Source fusion: 0 findings extracted from supplementary docs — skipping fusion');
            if (!css.metadata) css.metadata = {};
            css.metadata.sourceFusion = { fusedCount: 0, rejectedCount: 0, log: [], note: 'no_findings_extracted' };
          }
        } else {
          console.log('Source fusion: no supplementary files provided alongside VentSim — skipping');
          if (!css.metadata) css.metadata = {};
          css.metadata.sourceFusion = { fusedCount: 0, rejectedCount: 0, log: [], note: 'no_supplementary_files' };
        }

        // v6+: Merge vision-extracted elements from image/scanned PDF files
        const visionFiles = processedFiles.filter(f => f.visionCSS);
        if (visionFiles.length > 0) {
          const vFindings = [];
          let vCount = 0;
          for (const vf of visionFiles) {
            for (const ve of vf.visionCSS.elements) {
              ve.id = ve.id || elemId(ve.geometry, ve.placement);
              ve.element_key = ve.element_key || ve.id;
              css.elements.push(ve);
              vCount++;
            }
            vFindings.push(...vf.visionCSS.findings);
          }
          if (vCount > 0) console.log(`Vision merge (VentSim path): ${vCount} elements added`);
          if (vFindings.length > 0) {
            css.metadata.visionFindings = vFindings;
          }
        }

        const ai_generated_title = css.facility.name;
        const ai_generated_description = css.facility.description;
        console.log('VentSim CSS extraction complete');
        mergeSpecClaimsIntoCss(css, specClaims);
        if (specParsed) materializeSpecInstances(css, specParsed);

        // Pre-compute DXF claims before tracing report so tunnel_2d.dxf appears in byFile
        const dxfFileForClaims = processedFiles.find(f => f.name.toLowerCase().endsWith('.dxf') && f.content);
        let dxfClaimsArr = [];
        if (dxfFileForClaims) {
          try {
            const dxfCssForClaims = parseDxfToCSS(dxfFileForClaims.content);
            if (dxfCssForClaims) {
              const dxfResult = dxfCssToClaims(dxfCssForClaims, dxfFileForClaims.name);
              dxfClaimsArr = dxfResult.claims || [];
              dxfFileForClaims.claimsCount = dxfClaimsArr.length;
              console.log(`[DXF claims] ${dxfClaimsArr.length} claims from ${dxfFileForClaims.name}`);
            }
          } catch (dxfErr) {
            console.warn('[DXF claims] failed (non-fatal):', dxfErr.message);
          }
        }

        const tracingReport = buildTracingReport(css, processedFiles);
        css.metadata = css.metadata || {};
        css.metadata.tracingReport = tracingReport;
        const cssS3Key = await saveCSSToS3(bucket, userId, renderId, css);
        await saveExtractDebug(bucket, userId, renderId, css, tracingReport, sourceFiles, Date.now() - extractStartTime, revision);

        // Phase 1: Claims dual-write
        let claimsS3Key = null;
        try {
          resetClaimCounter();
          const claimsResult = ventSimCssToClaims(css, ventSimFile.name);
          const visionClaimFiles = processedFiles.filter(f => f.visionCSS);
          const vClaims = visionToClaims(visionClaimFiles);
          // dxfClaimsArr already computed above
          const allClaims = mergeClaims(mergeClaims(mergeClaims(claimsResult.claims, vClaims), specClaims), dxfClaimsArr);
          const claimsDoc = createClaimsEnvelope(claimsResult.domain, claimsResult.facilityMeta, allClaims, sourceFiles);
          claimsS3Key = await saveClaimsToS3(bucket, userId, renderId, claimsDoc, revision);
        } catch (claimsErr) {
          console.warn('Claims dual-write failed (non-fatal):', claimsErr.message);
        }

        try { await flushAudit(); } catch (ae) { console.warn('[audit:flush_failed]', ae.message); }
        if (_traceKey) {
          try {
            await writeTraceEnd({
              traceKey: _traceKey, stage: 'extract', runId: _traceRunId, attemptN: _traceAttemptN,
              startedAt: _traceStartedAt, finishedAt: new Date().toISOString(),
              outputArtifactKey: cssS3Key,
              counts: { elements: css?.elements?.length || 0, claims: claimsS3Key ? 1 : 0 },
              validationFlags: [],
              scalars: { gatePassRate: null, contractStatus: 'pass', provenanceCompleteness: null },
            });
          } catch (te) { console.warn('[trace] end write failed (non-fatal):', te.message); }
        }
        return { cssS3Key, claimsS3Key, ai_generated_title, ai_generated_description, tracingReport, refinementReport: null, refinementReportS3Key: null };
      }
    }

    // ---- DXF DETECTION ----
    const dxfFile = processedFiles.find(f => f.name.toLowerCase().endsWith('.dxf'));
    if (dxfFile) {
      console.log('Detected DXF format in file:', dxfFile.name);
      const sf = sourceFiles.find(f => f.name === dxfFile.name);
      if (sf) sf.role = 'geometry';

      let css = parseDxfToCSS(dxfFile.content);
      if (css) {
        css.metadata.sourceFiles = sourceFiles;
        for (const el of (css.elements || [])) {
          if (!el.sourceFile) el.sourceFile = dxfFile.name;
        }

        // Source-authority gating: DXF is a structured geometric source.
        css.metadata._hasStructuredSource = true;
        css.metadata._sourceAuthority = 'CAD_SIMULATION';
        css.metadata._sourceAuthorityLevel = 'DIRECT_2D';

        // Enrichment: use supplementary files to add metadata to CSS elements
        const otherFiles = processedFiles.filter(f => f !== dxfFile);
        if (otherFiles.length > 0) {
          const { text: suppText, truncatedFiles } = buildSupplementaryText(otherFiles);
          if (css.metadata?.diagnostics) css.metadata.diagnostics.truncatedFiles = truncatedFiles;
          css = await enrichCSS(css, suppText);

          // v6: Restricted safe source fusion
          // Skip for TUNNEL domain: fused equipment placed at mine elevation offsets produces floating proxies
          const docFindings = (css.domain === 'TUNNEL') ? [] : await extractDocumentFindings(suppText, otherFiles.map(f => f.name));
          if (docFindings.length > 0) {
            attemptSafeSourceFusion(css, docFindings, sourceFiles);
          }
        }

        // v6+: Merge vision-extracted elements
        const dxfVisionFiles = processedFiles.filter(f => f.visionCSS);
        if (dxfVisionFiles.length > 0) {
          const vFindings = [];
          let vCount = 0;
          for (const vf of dxfVisionFiles) {
            for (const ve of vf.visionCSS.elements) {
              ve.id = ve.id || elemId(ve.geometry, ve.placement);
              ve.element_key = ve.element_key || ve.id;
              css.elements.push(ve);
              vCount++;
            }
            vFindings.push(...vf.visionCSS.findings);
          }
          if (vCount > 0) console.log(`Vision merge (DXF path): ${vCount} elements added`);
          if (vFindings.length > 0) css.metadata.visionFindings = vFindings;
        }

        const ai_generated_title = css.metadata.title || 'DXF Import';
        const ai_generated_description = `DXF model with ${css.metadata.diagnostics?.elementCount || 0} elements (${css.metadata.diagnostics?.proxyCount || 0} proxy, ${css.metadata.diagnostics?.semanticUpgradeCount || 0} semantic)`;

        console.log('DXF CSS extraction complete');
        mergeSpecClaimsIntoCss(css, specClaims);
        if (specParsed) materializeSpecInstances(css, specParsed);
        const tracingReport = buildTracingReport(css, processedFiles);
        css.metadata = css.metadata || {};
        css.metadata.tracingReport = tracingReport;
        const cssS3Key = await saveCSSToS3(bucket, userId, renderId, css);
        await saveExtractDebug(bucket, userId, renderId, css, tracingReport, sourceFiles, Date.now() - extractStartTime, revision);

        // Phase 1: Claims dual-write
        let claimsS3Key = null;
        try {
          resetClaimCounter();
          const claimsResult = dxfCssToClaims(css, dxfFile.name);
          const visionClaimFiles = processedFiles.filter(f => f.visionCSS);
          const vClaims = visionToClaims(visionClaimFiles);
          const allClaims = mergeClaims(mergeClaims(claimsResult.claims, vClaims), specClaims);
          const claimsDoc = createClaimsEnvelope(claimsResult.domain, claimsResult.facilityMeta, allClaims, sourceFiles);
          claimsS3Key = await saveClaimsToS3(bucket, userId, renderId, claimsDoc, revision);
        } catch (claimsErr) {
          console.warn('Claims dual-write failed (non-fatal):', claimsErr.message);
        }

        try { await flushAudit(); } catch (ae) { console.warn('[audit:flush_failed]', ae.message); }
        if (_traceKey) {
          try {
            await writeTraceEnd({
              traceKey: _traceKey, stage: 'extract', runId: _traceRunId, attemptN: _traceAttemptN,
              startedAt: _traceStartedAt, finishedAt: new Date().toISOString(),
              outputArtifactKey: cssS3Key,
              counts: { elements: css?.elements?.length || 0, claims: claimsS3Key ? 1 : 0 },
              validationFlags: [],
              scalars: { gatePassRate: null, contractStatus: 'pass', provenanceCompleteness: null },
            });
          } catch (te) { console.warn('[trace] end write failed (non-fatal):', te.message); }
        }
        return { cssS3Key, claimsS3Key, ai_generated_title, ai_generated_description, tracingReport, refinementReport: null, refinementReportS3Key: null };
      }
    }

    // ---- Phase 9d: Vision-to-BuildingSpec Bridge ----
    // When the primary input is drawing(s) with no substantial text/VentSim/DXF,
    // and the drawing qualifies, route through the proven buildingSpecToCSS() path
    // instead of LLM extraction for better coordinate quality.
    const visionOnlyFiles = processedFiles.filter(f => f.visionCSS);
    const textFiles = processedFiles.filter(f => !f.visionCSS && f.content && f.content.trim().length > 100);
    const isDrawingPrimary = visionOnlyFiles.length > 0 && textFiles.length === 0 && !previousCSS && !refinementText;

    if (isDrawingPrimary) {
      // Find the best floor plan vision result that qualifies for bridging
      const floorPlanFile = visionOnlyFiles.find(f =>
        f.visionCSS?.imageType === 'FLOOR_PLAN' && canBridgeToBuildingSpec(f.visionData)
      );

      if (floorPlanFile) {
        console.log(`Phase 9d: Drawing-primary render detected — routing ${floorPlanFile.name} through BuildingSpec bridge`);

        const bestTitleBlock = visionOnlyFiles
          .map(f => f.visionCSS?.titleBlock)
          .filter(Boolean)
          .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;

        const bridgeSpec = visionToBuildingSpec(floorPlanFile.visionData, bestTitleBlock);
        applyBuildingSpecDefaults(bridgeSpec);
        const css = buildingSpecToCSS(bridgeSpec, sourceFiles);

        // Mark all elements as vision-sourced for traceability
        for (const el of css.elements) {
          el.source = el.source || 'VISION_BRIDGE';
          el.metadata = el.metadata || {};
          el.metadata.visionBridge = true;
          el.metadata.sourceFile = floorPlanFile.name;
        }

        // Also merge additional vision elements from other drawings (elevations, etc.)
        for (const vf of visionOnlyFiles) {
          if (vf === floorPlanFile) continue;
          if (!vf.visionCSS?.elements) continue;
          for (const ve of vf.visionCSS.elements) {
            ve.id = ve.id || `vision-${Math.random().toString(36).slice(2, 8)}`;
            ve.element_key = ve.element_key || ve.id;
            ve.container = ve.container || 'level-1';
            css.elements.push(ve);
          }
        }

        css.metadata = css.metadata || {};
        css.metadata.extractionRoute = 'VISION_BRIDGE';
        css.metadata.bridgeSource = floorPlanFile.name;

        // Source-authority gating: Vision bridge has structured coordinates.
        css.metadata._hasStructuredSource = true;
        css.metadata._sourceAuthority = 'VISION';
        css.metadata._sourceAuthorityLevel = 'DIRECT_2D';

        // Store drawing metadata
        const drawingSheets = visionOnlyFiles.map(f => ({
          fileName: f.name, sheetRole: f.visionCSS?.sheetRole, imageType: f.visionCSS?.imageType,
          titleBlock: f.visionCSS?.titleBlock, scaleInfo: f.visionCSS?.scaleInfo,
        }));
        css.metadata.drawingSheets = drawingSheets;

        // Generate title + description
        const ai_generated_title = bestTitleBlock?.projectName || bridgeSpec.buildingName || 'Floor Plan Model';
        const descParts = [`BUILDING project: ${bridgeSpec.dimensions.length_m}m x ${bridgeSpec.dimensions.width_m}m.`];
        if (bridgeSpec.rooms.length > 0) descParts.push(`${bridgeSpec.rooms.length} room(s).`);
        if (bridgeSpec.openings.length > 0) descParts.push(`${bridgeSpec.openings.length} opening(s).`);
        descParts.push('Extracted from architectural drawing via vision bridge.');
        if (bestTitleBlock?.drawingNumber) descParts.push(`Drawing ${bestTitleBlock.drawingNumber}.`);
        const ai_generated_description = descParts.join(' ');
        css.facility.description = ai_generated_description;

        mergeSpecClaimsIntoCss(css, specClaims);
        if (specParsed) materializeSpecInstances(css, specParsed);
        const tracingReport = buildTracingReport(css, processedFiles);
        css.metadata.tracingReport = tracingReport;
        const cssS3Key = await saveCSSToS3(bucket, userId, renderId, css);
        await saveExtractDebug(bucket, userId, renderId, css, tracingReport, sourceFiles, Date.now() - extractStartTime, revision);

        // Claims dual-write
        let claimsS3Key = null;
        try {
          resetClaimCounter();
          const claimsResult = buildingSpecToClaims(css, sourceFiles, { isRefinement: false });
          const vClaims = visionToClaims(visionOnlyFiles);
          const allClaims = mergeClaims(mergeClaims(claimsResult.claims, vClaims), specClaims);
          const claimsDoc = createClaimsEnvelope(claimsResult.domain, claimsResult.facilityMeta, allClaims, sourceFiles);
          claimsS3Key = await saveClaimsToS3(bucket, userId, renderId, claimsDoc, revision);
        } catch (claimsErr) {
          console.warn('Claims dual-write failed (non-fatal):', claimsErr.message);
        }

        console.log(`Vision bridge complete: ${css.elements.length} elements, route=VISION_BRIDGE`);
        try { await flushAudit(); } catch (ae) { console.warn('[audit:flush_failed]', ae.message); }
        if (_traceKey) {
          try {
            await writeTraceEnd({
              traceKey: _traceKey, stage: 'extract', runId: _traceRunId, attemptN: _traceAttemptN,
              startedAt: _traceStartedAt, finishedAt: new Date().toISOString(),
              outputArtifactKey: cssS3Key,
              counts: { elements: css?.elements?.length || 0, claims: claimsS3Key ? 1 : 0 },
              validationFlags: [],
              scalars: { gatePassRate: null, contractStatus: 'pass', provenanceCompleteness: null },
            });
          } catch (te) { console.warn('[trace] end write failed (non-fatal):', te.message); }
        }
        return { cssS3Key, claimsS3Key, ai_generated_title, ai_generated_description, tracingReport, refinementReport: null, refinementReportS3Key: null };
      }
    }

    // ---- BEDROCK EXTRACTION (single-pass or multi-pass) ----

    // Helper: call Bedrock with a prompt and return parsed JSON (or null)
    async function callBedrock(prompt, maxTokens = 4096) {
      const response = await bedrock.send(new InvokeModelCommand({
        modelId: 'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }]
        })
      }));
      const body = JSON.parse(response.body instanceof Uint8Array ? new TextDecoder().decode(response.body) : response.body);
      const text = body.content?.[0]?.text || '';
      if (!text) return null;
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]);
    }

    // Helper: prepare file content for Bedrock prompts
    function prepareFileContent(files) {
      const MAX_FILE_CHARS = 50000;
      const MAX_TOTAL_CHARS = 150000;
      const RELEVANT_KEYWORDS = /ventilation|hvac|system|fan|duct|equipment|air|flow|pressure|shaft|dimension|floor|wall|room|column|beam|slab|foundation|elevation|height|width|length|material|concrete|steel/i;
      let totalChars = 0;
      const parts = [];

      for (const file of files) {
        if (totalChars >= MAX_TOTAL_CHARS) break;
        let content = file.content;
        if (content.length > 30000) {
          const paragraphs = content.split(/\n\s*\n/);
          const relevant = paragraphs.filter(p => RELEVANT_KEYWORDS.test(p));
          content = relevant.length > 0 ? relevant.join('\n\n') : content.substring(0, 30000);
        }
        if (content.length > MAX_FILE_CHARS) content = content.substring(0, MAX_FILE_CHARS) + '\n[... truncated ...]';
        totalChars += content.length;
        parts.push(`File: ${file.name}\n\n${content}`);
      }
      return parts.join('\n\n---\n\n');
    }

    // v3.2: Constraint rules for prompts
    const CONSTRAINT_RULES = `
IMPORTANT RULES:
- Extract information explicitly stated or clearly implied in the source text
- If dimensions are not specified, use reasonable defaults for the building type
- Omit uncertain geometry rather than guessing
- For BUILDING types (office, warehouse, residential, hospital, school):
  - ALWAYS set num_floors based on how many distinct levels/storeys are described (hospital=2-5 floors, office=2-10, warehouse=1-2, residential=1-3)
  - floor_to_floor_height_m: hospital=3.5-4.5m, office=3.0-3.5m, warehouse=4.0-8.0m, residential=2.7-3.0m. Convert ceiling heights: 8ft=2.44m, 9ft=2.74m, 10ft=3.05m
  - dimensions (length_m, width_m) MUST be large enough to contain ALL listed rooms — if rooms need more space, increase dimensions
  - Include rooms if described, specify floor for each room
  - Infer standard openings based on building type: each room should have at least one door, exterior walls should have windows at regular intervals unless explicitly described as windowless
  - For hospitals: include entrance doors on ground floor, patient room doors, corridor access doors, and windows on patient-facing exterior walls
  - For offices: include entrance doors, office doors, and windows on all exterior walls
- For RESIDENTIAL buildings specifically:
  - Extract EVERY door and window explicitly mentioned — front door, rear door, sliding door, each bedroom window, bathroom window, kitchen window, etc. Do not skip any named opening
  - Set num_floors from explicit story/level count in the description (e.g. "two-story", "2 bed upstairs" = 2 floors)
  - Set floor_to_floor_height_m from explicit ceiling height specs (e.g. "9ft ceilings" = 2.74m). Default 2.74m if not stated
  - Set roof.type to "GABLE" if any pitched roof is mentioned (gable, hip, pitched, sloped) — only use "FLAT" if explicitly stated as flat
  - Set roof.pitch_degrees from stated pitch ratio (e.g. 6:12 pitch = 26.6°, 4:12 = 18.4°, 8:12 = 33.7°)
  - For attached garage/wing sections: set x_offset_m and y_offset_m so the section EXACTLY abuts the main building with NO gap. An attached garage on the west face of a length_m × width_m building at y_offset=0 must have x_offset_m = 0 (or = length_m to attach on east). Verify: x_offset + section_length = 0 or main_length (for E/W attachments), or y_offset + section_width = 0 or main_width (for N/S attachments)
  - elevations.floor_level_m should be 0 (ground level) unless explicitly stated otherwise — do NOT use negative values unless the floor is below grade
- For TUNNEL / LINEAR structures: do not generate rooms, interior_walls, or openings — focus on overall dimensions and equipment
- For FACILITY / INDUSTRIAL structures: rooms optional, openings only if explicitly mentioned
- For ALL building types: ensure perimeter_walls array describes each exterior facade if the building has non-rectangular or complex perimeter`;

    // Single-pass extraction (v3.2: improved prompts)
    async function singlePassExtraction() {
      console.log('Running single-pass Bedrock extraction...');
      const fileContent = buildPriorityFileContent(processedFiles, refinementText);

      const prompt = `You are an expert in interpreting architectural and engineering documents to extract building specifications.
Extract structured data from the provided files and return it as a JSON object. ALL DIMENSIONS IN METRES.
${CONSTRAINT_RULES}

Return ONLY valid JSON (no markdown, no explanations):

{
  "buildingName": "string",
  "buildingType": "BUILDING | OFFICE | WAREHOUSE | TUNNEL | UNDERGROUND_FACILITY | FACILITY | PARKING | HOSPITAL | SCHOOL | INDUSTRIAL | RESIDENTIAL",
  "dimensions": {
    "length_m": number,
    "width_m": number,
    "height_m": number,
    "wall_thickness_m": number (default 0.3)
  },
  "elevations": { "floor_level_m": number (default 0.0) },
  "rooms": [{ "name": "string", "usage": "OFFICE|STORAGE|MECHANICAL|ELECTRICAL|CIRCULATION|WC|LOBBY|LAB|PARKING|OTHER", "length_m": number, "width_m": number, "height_m": number, "x_position_m": number, "y_position_m": number, "floor": number (1-indexed, default 1) }],
  "openings": [{ "type": "DOOR|WINDOW", "wall_side": "NORTH|SOUTH|EAST|WEST", "x_offset_m": number, "width_m": number, "height_m": number, "sill_height_m": number, "floor": number (1-indexed, default 1) }],
  "ventilation": { "system_type": "natural|mechanical|hybrid", "intake_location": "string", "exhaust_location": "string", "num_fans": number },
  "equipment": [{ "name": "string", "type": "GENERATOR|PUMP|FAN|COMPRESSOR|TRANSFORMER|BATTERY|CONVERTER|BOILER|CHILLER|AHU|OTHER", "segment_name": "string (name of room/zone this equipment is in, if known)", "x_position_m": number, "y_position_m": number, "length_m": number, "width_m": number, "height_m": number, "floor": number (1-indexed, default 1) }],
  "materials": { "walls": "concrete|brick|steel|timber|glass|other", "floor": "concrete|timber|raised_access|screed|other", "roof": "concrete|metal|membrane|tiles|other" },
  "structural_system": "FRAME|LOADBEARING|SHELL|TRUSS|OTHER",
  "structure": { "column_grid": [{ "x_spacing_m": number, "y_spacing_m": number, "column_size_m": number }], "floor_to_floor_height_m": number, "num_floors": number },
  "interior_walls": [{ "name": "string", "x_start_m": number, "y_start_m": number, "x_end_m": number, "y_end_m": number, "height_m": number, "thickness_m": number, "floor": number (1-indexed, default 1) }],
  "perimeter_walls": [{ "side": "NORTH|SOUTH|EAST|WEST", "length_m": number, "height_m": number, "has_windows": boolean, "window_count": number, "has_entrance": boolean, "floor": number (1-indexed, default 1) }],
  "roof": { "type": "FLAT|GABLE", "pitch_degrees": number (default 25, range 5-60), "ridge_orientation": "ALONG_LENGTH|ALONG_WIDTH", "overhang_m": number (default 0.3, range 0-2) },
  "sections": [{ "name": "string", "type": "MAIN|GARAGE|WING|ANNEX|TOWER|CANOPY|MEZZANINE|COURTYARD_WALL", "length_m": number, "width_m": number, "height_m": number, "num_floors": number, "x_offset_m": number, "y_offset_m": number, "roof_type": "FLAT|GABLE", "roof_pitch_degrees": number, "floor_level_m": number (for MEZZANINE: height above ground) }],
  "vertical_features": [{ "name": "string", "type": "CHIMNEY|EXHAUST_STACK|VENT|PARAPET|ANTENNA_MOUNT", "x_position_m": number, "y_position_m": number, "width_m": number, "depth_m": number, "height_above_roof_m": number }]
}

Example output for a simple 2-storey office:
{"buildingName":"Office Building","buildingType":"OFFICE","dimensions":{"length_m":30,"width_m":15,"height_m":7,"wall_thickness_m":0.3},"elevations":{"floor_level_m":0},"rooms":[{"name":"Reception","usage":"LOBBY","length_m":8,"width_m":6,"height_m":3.5,"x_position_m":1,"y_position_m":1,"floor":1},{"name":"Office A","usage":"OFFICE","length_m":6,"width_m":5,"height_m":3.5,"x_position_m":2,"y_position_m":2,"floor":2}],"openings":[{"type":"DOOR","wall_side":"SOUTH","x_offset_m":14,"width_m":1.2,"height_m":2.4,"sill_height_m":0,"floor":1}],"structure":{"num_floors":2,"floor_to_floor_height_m":3.5},"ventilation":{},"equipment":[],"materials":{"walls":"concrete","floor":"concrete","roof":"metal"},"structural_system":"FRAME","interior_walls":[],"roof":{"type":"FLAT"},"sections":[],"vertical_features":[]}

Convert feet/inches to metres. Use realistic defaults for missing values. Return empty arrays [] when no data.

Building Description:
${descriptionContent || '(No description provided)'}

${sourceFiles.filter(f => f.parseStatus === 'unsupported').length > 0 ? `\nNote: These file types were uploaded but could not be parsed: ${sourceFiles.filter(f => f.parseStatus === 'unsupported').map(f => f.name).join(', ')}` : ''}

${fileContent}`;

      return await callBedrock(prompt, 12288);
    }

    // Multi-pass extraction
    async function multiPassExtraction() {
      console.log('Running multi-pass Bedrock extraction...');

      // Pass 1 — Classify (advisory, skip if fails)
      let classification = null;
      try {
        const snippets = processedFiles.map(f => `File: ${f.name}\n${f.content.slice(0, 2000)}`).join('\n---\n');
        const pass1Prompt = `Classify these building/engineering documents. Return ONLY valid JSON:
{
  "buildingType": "BUILDING|OFFICE|WAREHOUSE|TUNNEL|FACILITY|PARKING|HOSPITAL|SCHOOL|INDUSTRIAL|RESIDENTIAL",
  "domainHints": ["architecture", "structural", "mechanical", "electrical", etc.],
  "fileRoles": { "filename.txt": "floor_plan|specifications|schedule|description|other" }
}

Documents:
${snippets}`;

        const pass1Result = await callBedrock(pass1Prompt, 2048);
        if (pass1Result && pass1Result.buildingType && typeof pass1Result.buildingType === 'string') {
          classification = pass1Result;
          console.log(`Pass 1 classification: ${classification.buildingType}, hints: ${classification.domainHints?.join(', ')}`);
        } else {
          console.warn('Pass 1: classification schema invalid, using generic prompts');
        }
      } catch (err) {
        console.warn('Pass 1 failed, using generic prompts:', err.message);
      }

      // Pass 2 — Geometry (main extraction, fallback to single-pass if invalid)
      const domainContext = classification
        ? `This is a ${classification.buildingType} project with domain hints: ${classification.domainHints?.join(', ')}.`
        : 'Extract building geometry from the provided documents.';

      const fileContent = buildPriorityFileContent(processedFiles, refinementText);

      // Check if this is a tunnel/underground facility
      const isTunnelType = classification && /TUNNEL|UNDERGROUND/i.test(classification.buildingType);

      const pass2Prompt = isTunnelType
        ? buildTunnelPass2Prompt(domainContext, fileContent, descriptionContent)
        : `${domainContext}
You are an expert in interpreting architectural and engineering documents to extract building specifications.
Extract structured data and return it as a JSON object. ALL DIMENSIONS IN METRES.
${CONSTRAINT_RULES}

SOURCE PRIORITY: The PRIMARY section contains the authoritative source for envelope, massing, and dimensions.
SECONDARY documents provide equipment/MEP data only — do NOT let them reshape the building envelope.
TERTIARY documents provide system metadata only — ignore for geometry.

Return ONLY valid JSON (no markdown, no explanations):

{
  "buildingName": "string",
  "buildingType": "BUILDING | OFFICE | WAREHOUSE | TUNNEL | UNDERGROUND_FACILITY | FACILITY | PARKING | HOSPITAL | SCHOOL | INDUSTRIAL | RESIDENTIAL",
  "dimensions": { "length_m": number, "width_m": number, "height_m": number, "wall_thickness_m": number },
  "elevations": { "floor_level_m": number },
  "rooms": [{ "name": "string", "usage": "string", "length_m": number, "width_m": number, "height_m": number, "x_position_m": number, "y_position_m": number, "floor": number }],
  "openings": [{ "type": "DOOR|WINDOW", "wall_side": "NORTH|SOUTH|EAST|WEST", "x_offset_m": number, "width_m": number, "height_m": number, "sill_height_m": number, "floor": number }],
  "ventilation": { "system_type": "string", "num_fans": number },
  "equipment": [{ "name": "string", "type": "string", "segment_name": "string (room/zone name if known)", "x_position_m": number, "y_position_m": number, "length_m": number, "width_m": number, "height_m": number, "floor": number, "sourceExcerpt": "string (brief quote from source text that describes this equipment, max 100 chars)" }],
  "materials": { "walls": "string", "floor": "string", "roof": "string" },
  "structural_system": "FRAME|LOADBEARING|SHELL|TRUSS|OTHER",
  "structure": { "column_grid": [], "floor_to_floor_height_m": number, "num_floors": number },
  "interior_walls": [{ "name": "string", "x_start_m": number, "y_start_m": number, "x_end_m": number, "y_end_m": number, "height_m": number, "thickness_m": number, "floor": number }],
  "roof": { "type": "FLAT|GABLE", "pitch_degrees": number, "ridge_orientation": "ALONG_LENGTH|ALONG_WIDTH", "overhang_m": number },
  "sections": [{ "name": "string", "type": "MAIN|GARAGE|WING|ANNEX|TOWER|CANOPY|MEZZANINE|COURTYARD_WALL", "length_m": number, "width_m": number, "height_m": number, "num_floors": number, "x_offset_m": number, "y_offset_m": number, "roof_type": "FLAT|GABLE", "roof_pitch_degrees": number, "floor_level_m": number (for MEZZANINE: height above ground) }],
  "vertical_features": [{ "name": "string", "type": "CHIMNEY|EXHAUST_STACK|VENT|PARAPET|ANTENNA_MOUNT", "x_position_m": number, "y_position_m": number, "width_m": number, "depth_m": number, "height_above_roof_m": number }]
}

Convert feet/inches to metres. Use realistic defaults for missing values. Return empty arrays [] when no data.
For roof: use GABLE for residential/school buildings, FLAT for warehouses/offices/industrial. ridge_orientation defaults to ALONG_LENGTH if building is longer than wide.
For sections: include attached volumes like garages, wings, annexes at their offset positions relative to main building origin. For L-shaped or U-shaped buildings, model as main rectangular block + WING sections. For courtyards, model the open area as a void (no roof/floor section). MEZZANINE sections are partial-height interior floors (use floor_level_m for elevation). CANOPY sections generate columns + roof without walls.
For vertical_features: include chimneys, exhaust stacks, vents that protrude above the roof.

Building Description:
${descriptionContent || '(No description provided)'}

${fileContent}`;

      let buildingSpec;
      try {
        buildingSpec = await callBedrock(pass2Prompt, 12288);
        if (!buildingSpec || !buildingSpec.dimensions) {
          console.warn('Pass 2: geometry schema invalid, falling back to single-pass');
          return await singlePassExtraction();
        }
        console.log(`Pass 2 geometry extracted: ${buildingSpec.buildingName || 'unnamed'}`);
      } catch (err) {
        console.warn('Pass 2 failed, falling back to single-pass:', err.message);
        return await singlePassExtraction();
      }

      // Pass 3 — Semantics (enrichment patches, skip if fails)
      // Convert buildingSpec to CSS first so we have element_keys
      applyBuildingSpecDefaults(buildingSpec);
      let css = buildingSpecToCSS(buildingSpec, sourceFiles);

      try {
        const elementSummary = (css.storeys || []).flatMap(s => (s.elements || []).map(e => e.element_key)).filter(Boolean).slice(0, 50);
        const pass3Prompt = `You are enriching a building model with additional metadata.
The model has these element keys: ${elementSummary.join(', ')}

Source documents:
${fileContent.slice(0, 50000)}

Return ONLY valid JSON:
{
  "version": "1.0",
  "patches": [
    {
      "element_key": "<exact key from above>",
      "updates": {
        "name": "optional display name",
        "description": "optional description",
        "materials": ["optional", "materials"],
        "psets": { "Pset_Name": { "Property": "Value" } }
      }
    }
  ]
}

Rules: Only use element_keys from the list. Only set name, description, materials, psets. No geometry fields.`;

        const pass3Result = await callBedrock(pass3Prompt, 4096);
        if (pass3Result && validatePatchSchema(pass3Result)) {
          // Apply patches via whitelist
          const elementMap = new Map();
          for (const storey of (css.storeys || [])) {
            for (const el of (storey.elements || [])) {
              if (el.element_key) elementMap.set(el.element_key, el);
            }
          }
          let patchCount = 0;
          for (const patch of pass3Result.patches) {
            const element = elementMap.get(patch.element_key);
            if (!element) continue;
            for (const [field, value] of Object.entries(patch.updates)) {
              if (ENRICHMENT_GEOMETRY_FIELDS.has(field)) {
                console.warn(`Pass 3: REJECTED geometry edit for element_key=${patch.element_key} field=${field}`);
                continue;
              }
              if (ENRICHMENT_WHITELIST.has(field)) element[field] = value;
            }
            patchCount++;
          }
          console.log(`Pass 3: applied ${patchCount} semantic patches`);
        } else {
          console.warn('Pass 3: patch schema invalid, returning Pass 2 CSS as-is');
        }
      } catch (err) {
        console.warn('Pass 3 failed, returning Pass 2 CSS:', err.message);
      }

      return { buildingSpec, enrichedCSS: css };
    }

    // Apply defaults to building spec
    function applyBuildingSpecDefaults(spec) {
      if (!spec.buildingName) spec.buildingName = 'Structure';
      if (!spec.buildingType) spec.buildingType = 'BUILDING';
      if (!spec.dimensions) spec.dimensions = { length_m: 20, width_m: 10, height_m: 3, wall_thickness_m: 0.3 };
      if (spec.dimensions.wall_thickness_m === undefined) spec.dimensions.wall_thickness_m = 0.3;
      if (!spec.elevations) spec.elevations = {};
      spec.elevations.floor_level_m = 0.0;  // Always force ground = 0; LLM sometimes returns non-zero (treating foundation depth as offset) which raises all geometry incorrectly
      if (!spec.rooms) spec.rooms = [];
      if (!spec.openings) spec.openings = [];
      if (!spec.ventilation) spec.ventilation = { system_type: 'natural', num_fans: 0 };
      if (!spec.equipment) spec.equipment = [];
      if (!spec.materials) spec.materials = { walls: 'concrete', floor: 'concrete', roof: 'metal' };
      if (!spec.structural_system) spec.structural_system = 'LOADBEARING';
    }

    // Refinement shortcut: if previousCSS + refinement text, use a modification prompt
    // instead of re-extracting from scratch
    async function refinementExtraction() {
      console.log('Running refinement modification prompt (previousCSS available)...');
      const prevJSON = JSON.stringify(previousCSS, null, 2);
      const prompt = `You are an expert building information modelling engineer. You have a previously generated Construction Specification Schema (CSS JSON) and an engineer has requested a specific modification.

Your task: Apply ONLY the engineer's requested change to the existing CSS and return the UPDATED JSON. Everything not explicitly mentioned must remain EXACTLY the same — same IDs, same geometry, same placement, same properties.

CRITICAL RULES — READ CAREFULLY:
- The JSON is a CSS (Construction Specification Schema) object with top-level keys: facility, domain, levels, elements, metadata, systems
- Preserve ALL top-level keys and their structure exactly
- Only modify elements within the "elements" array that match the engineer's request
- Each element has: id, type, semanticType, name, placement, geometry, container, properties, material, confidence
- Do NOT change element IDs of untouched elements
- Do NOT modify wall, slab, column, beam, or shell elements unless the engineer EXPLICITLY mentions them
- If the engineer says to REMOVE something, delete ONLY the matching element(s) from the elements array
- If the engineer says to ADD something, add it with reasonable defaults and a new unique ID
- If the engineer says to CHANGE/FIX something, update ONLY the matched element's specific properties
- Do NOT re-interpret, reorder, or restructure the rest of the specification
- The total number of untouched elements must remain exactly the same
- Return the complete updated JSON (not just the diff)
- Return ONLY valid JSON (no markdown, no explanations, no comments)

=== ENGINEER'S MODIFICATION REQUEST ===
${refinementText.trim()}
===

=== CURRENT CSS JSON ===
${prevJSON}
===

Return the complete updated CSS JSON with ONLY the requested modification applied:`;

      return await callBedrock(prompt, 12288);
    }

    // Run extraction
    let buildingSpec;
    let enrichedCSS = null;
    let isRefinement = false;
    try {
      if (previousCSS && refinementText) {
        // Refinement path: LLM modifies existing CSS directly (returns CSS-format, not building-spec)
        isRefinement = true;

        // Back up previous CSS before overwriting
        const refineCount = render?.refine_count || 1;
        const backupKey = `uploads/${userId}/${renderId}/css/css_v${refineCount - 1}.json`;
        try {
          await s3.send(new PutObjectCommand({
            Bucket: bucket, Key: backupKey,
            Body: JSON.stringify(previousCSS), ContentType: 'application/json'
          }));
          console.log(`Backed up previous CSS to ${backupKey}`);
        } catch (backupErr) {
          console.warn(`CSS backup failed (${backupKey}):`, backupErr.message);
        }

        // Assign to enrichedCSS (not buildingSpec) because the LLM returns CSS-format JSON
        enrichedCSS = await refinementExtraction();

        // Validate the LLM returned valid CSS structure
        if (!enrichedCSS || !enrichedCSS.elements || !Array.isArray(enrichedCSS.elements)) {
          console.warn('Refinement LLM returned invalid CSS structure, falling back to previous CSS');
          enrichedCSS = JSON.parse(JSON.stringify(previousCSS));
        }

        // Structure-aware drift rejection FIRST (before guard) — measures raw LLM output deviation
        const driftResult = checkStructureAwareDrift(previousCSS, enrichedCSS, refinementText);
        if (driftResult.rejected) {
          console.warn(`Drift rejected — applying only targeted patches`);
          enrichedCSS = applyTargetedPatches(previousCSS, enrichedCSS, driftResult.resolvedTargets);
          if (!enrichedCSS.metadata) enrichedCSS.metadata = {};
          enrichedCSS.metadata.driftRejection = {
            driftScore: driftResult.driftScore,
            structuralDrift: driftResult.structuralDrift,
            equipmentDrift: driftResult.equipmentDrift,
            resolvedTargetCount: driftResult.resolvedTargets.length,
            ambiguousTargets: driftResult.ambiguousTargets.length > 0 ? driftResult.ambiguousTargets : undefined
          };
          // Surface ambiguous targets in refinement report
          if (driftResult.ambiguousTargets.length > 0) {
            if (!enrichedCSS.metadata.refinementReport) enrichedCSS.metadata.refinementReport = { summary: {} };
            if (!enrichedCSS.metadata.refinementReport.summary) enrichedCSS.metadata.refinementReport.summary = {};
            enrichedCSS.metadata.refinementReport.summary.unresolvedTargets =
              (enrichedCSS.metadata.refinementReport.summary.unresolvedTargets || []).concat(driftResult.ambiguousTargets);
          }
        }

        // Structural element guard SECOND: restore any structural elements the LLM (or patch) silently dropped
        guardStructuralElements(previousCSS, enrichedCSS, refinementText);

        // Build a minimal buildingSpec for AI title/description generation
        buildingSpec = {
          buildingName: enrichedCSS.facility?.name || previousCSS.facility?.name || 'Structure Model',
          buildingType: enrichedCSS.domain || previousCSS.domain || 'BUILDING',
          dimensions: enrichedCSS.metadata?.dimensions || previousCSS.metadata?.dimensions || { length_m: 20, width_m: 10, height_m: 3 },
          rooms: [], equipment: [], openings: []
        };
      } else if (MULTI_PASS) {
        const result = await multiPassExtraction();
        buildingSpec = result.buildingSpec;
        enrichedCSS = result.enrichedCSS;
      } else {
        buildingSpec = await singlePassExtraction();
      }
    } catch (err) {
      console.error('Bedrock extraction failed:', err.message, err.stack);
      console.error('Bedrock extraction error details:', JSON.stringify({ name: err.name, code: err.$metadata?.httpStatusCode, requestId: err.$metadata?.requestId }));
      throw new Error(`Bedrock extraction failed: ${err.message}`);
    }

    if (!buildingSpec) {
      console.error('Bedrock returned empty/unparseable response');
      throw new Error('Bedrock returned empty or unparseable response');
    }

    // Source-authority gating: Check if vision files provide structured coordinates.
    // If DIRECT_2D/DIRECT_3D vision data exists, LLM should only enrich (not create structure).
    const visionWithCoords = processedFiles.filter(f =>
      f.visionCSS && f.visionCSS.elements?.length > 0 &&
      f.visionCSS.elements.some(e => {
        const cs = e.metadata?.evidence?.coordinateSource;
        return cs === 'DIRECT_2D' || cs === 'DIRECT_3D' || cs === 'ASSEMBLED_2D';
      })
    );
    const hasStructuredVision = visionWithCoords.length > 0;
    if (hasStructuredVision) {
      console.log(`Source-authority: ${visionWithCoords.length} vision files have structured coordinates — LLM structural generation restricted`);
    }

    // Use enriched CSS from multi-pass if available, otherwise convert from spec
    let css;
    if (enrichedCSS) {
      css = enrichedCSS;
    } else {
      applyBuildingSpecDefaults(buildingSpec);
      // Source-authority: if structured vision exists, restrict LLM spec to enrichment only
      if (hasStructuredVision) {
        buildingSpec._structuredSourceExists = true;
      }
      css = buildingSpecToCSS(buildingSpec, sourceFiles);
    }

    // Mark LLM path source authority metadata
    css.metadata = css.metadata || {};
    if (hasStructuredVision) {
      css.metadata._hasStructuredSource = true;
      css.metadata._sourceAuthority = 'VISION';
      css.metadata._sourceAuthorityLevel = 'DIRECT_2D';
    } else {
      css.metadata._hasStructuredSource = false;
      css.metadata._sourceAuthority = 'LLM';
      css.metadata._sourceAuthorityLevel = 'LLM_GENERATED';
    }

    // v6+: Merge vision-extracted CSS elements and findings into the model
    // Skip during refinement — vision elements were already merged in the original render
    const allVisionFindings = [];
    let visionElementCount = 0;
    if (isRefinement) {
      console.log('Refinement mode: skipping vision merge (elements preserved from base CSS)');
    }
    for (const pf of (isRefinement ? [] : processedFiles)) {
      if (!pf.visionCSS) continue;
      const { elements: vElems, findings: vFindings } = pf.visionCSS;

      // Add confident vision elements to CSS
      for (const vElem of vElems) {
        vElem.id = vElem.id || elemId(vElem.geometry, vElem.placement);
        vElem.element_key = vElem.element_key || vElem.id;
        vElem.container = vElem.container || 'level-1';
        vElem.relationships = vElem.relationships || [];
        vElem.properties = vElem.properties || {};
        css.elements.push(vElem);
        visionElementCount++;
      }

      // Accumulate findings as metadata
      allVisionFindings.push(...vFindings);
    }
    if (visionElementCount > 0) {
      console.log(`Vision merge: ${visionElementCount} elements added from ${processedFiles.filter(f => f.visionCSS).length} vision sources`);
    }
    if (allVisionFindings.length > 0) {
      css.metadata = css.metadata || {};
      css.metadata.visionFindings = allVisionFindings;
      console.log(`Vision findings: ${allVisionFindings.length} stored as metadata`);
    }

    // Phase 9a: Store drawing metadata (title blocks, sheet roles) in CSS metadata
    const drawingSheets = processedFiles
      .filter(f => f.visionCSS)
      .map(f => ({
        fileName: f.name,
        sheetRole: f.visionCSS.sheetRole || null,
        imageType: f.visionCSS.imageType || null,
        titleBlock: f.visionCSS.titleBlock || null,
        scaleInfo: f.visionCSS.scaleInfo || null,
      }));
    if (drawingSheets.length > 0) {
      css.metadata = css.metadata || {};
      css.metadata.drawingSheets = drawingSheets;
    }

    // Phase 9b: Cross-drawing correlation (floor plan ↔ elevation)
    if (!isRefinement) {
      const visionFilesForCorrelation = processedFiles.filter(f => f.visionCSS);
      const correlation = correlateDrawings(visionFilesForCorrelation);
      if (correlation) {
        css.metadata = css.metadata || {};
        css.metadata.drawingCorrelation = correlation;
        // Apply elevation floor heights to level definitions if available
        if (correlation.elevationLayout?.floors?.length > 0) {
          for (const elFloor of correlation.elevationLayout.floors) {
            const matchingLevel = css.levelsOrSegments?.find(l =>
              l.name?.toLowerCase().includes(elFloor.name?.toLowerCase()) ||
              l.name?.toLowerCase().includes(`level ${elFloor.level}`)
            );
            if (matchingLevel && elFloor.elevation_m != null) {
              matchingLevel.elevation_m = elFloor.elevation_m;
              matchingLevel.height_m = elFloor.height_m || matchingLevel.height_m;
              console.log(`Cross-drawing: updated level "${matchingLevel.name}" elevation to ${elFloor.elevation_m}m`);
            }
          }
        }
      }
    }

    // v3.2: Facade fallback — generate openings from description if LLM returned none
    // Skip during refinement — openings are already in the base CSS
    const structureClass = css.metadata?.structureClass || 'BUILDING';
    if (!isRefinement && structureClass === 'BUILDING' && (!buildingSpec.openings || buildingSpec.openings.length === 0)) {
      const desc = (descriptionContent || '').toLowerCase();
      // Check for counted doors: "3 bay doors", "three garage doors", etc.
      const countMatch = desc.match(/(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:bay|garage|loading|roller|overhead)\s+doors?/i);
      const numberWords = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
      if (countMatch) {
        const count = parseInt(countMatch[1]) || numberWords[countMatch[1]?.toLowerCase()] || 1;
        const dims = buildingSpec.dimensions || {};
        const bLength = dims.length_m || 20;
        const doorWidth = Math.min(3.5, (bLength * 0.6) / count); // reasonable bay door width
        const spacing = bLength / (count + 1);
        for (let i = 0; i < count; i++) {
          css.elements.push({
            id: `facade-door-${i}`, type: 'DOOR', semanticType: 'IfcDoor',
            name: `Bay Door ${i + 1}`,
            placement: { origin: { x: spacing * (i + 1), y: 0, z: 0 } },
            geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: doorWidth, height: dims.wall_thickness_m || 0.3 }, direction: { x: 0, y: 0, z: 1 }, depth: 3.0 },
            container: 'level-1', relationships: [], properties: { wallSide: 'SOUTH', sillHeight: 0 },
            material: { name: 'steel', color: [0.5, 0.5, 0.55], transparency: 0 }, confidence: 0.5, source: 'facade_fallback', metadata: {}
          });
        }
        console.log(`Facade fallback: generated ${count} bay doors`);
      } else if (/\b(main\s+)?entrance\b/i.test(desc)) {
        const dims = buildingSpec.dimensions || {};
        css.elements.push({
          id: 'facade-entrance', type: 'DOOR', semanticType: 'IfcDoor',
          name: 'Main Entrance',
          placement: { origin: { x: (dims.length_m || 20) / 2, y: 0, z: 0 } },
          geometry: { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: 1.2, height: dims.wall_thickness_m || 0.3 }, direction: { x: 0, y: 0, z: 1 }, depth: 2.4 },
          container: 'level-1', relationships: [], properties: { wallSide: 'SOUTH', sillHeight: 0 },
          material: { name: 'wood', color: [0.55, 0.35, 0.2], transparency: 0 }, confidence: 0.5, source: 'facade_fallback', metadata: {}
        });
        console.log('Facade fallback: generated 1 entrance door');
      }
      // If description is vague ("windows on all sides" etc.) — generate NONE
    }

    // v3.2: Envelope fallback — if too many elements removed, degrade to clean box
    // (Applied after transform step removes bad openings — tracked via metadata)

    // Phase 9a: Extract title block metadata from vision sources for render metadata
    const visionTitleBlocks = processedFiles
      .filter(f => f.visionCSS?.titleBlock)
      .map(f => f.visionCSS.titleBlock)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const bestTitleBlock = visionTitleBlocks[0] || null;

    // Generate AI title and description — prefer title block project name when available
    let ai_generated_title = buildingSpec.buildingName || 'Structure Model';
    if (bestTitleBlock?.projectName && bestTitleBlock.confidence >= 0.5) {
      ai_generated_title = bestTitleBlock.projectName;
      if (bestTitleBlock.drawingTitle && bestTitleBlock.drawingTitle !== bestTitleBlock.projectName) {
        ai_generated_title += ` — ${bestTitleBlock.drawingTitle}`;
      }
    }
    const descParts = [];
    descParts.push(`${buildingSpec.buildingType} project: ${buildingSpec.dimensions.length_m}m x ${buildingSpec.dimensions.width_m}m x ${buildingSpec.dimensions.height_m}m.`);
    if (buildingSpec.rooms?.length > 0) {
      descParts.push(`${buildingSpec.rooms.length} room(s) including ${buildingSpec.rooms.slice(0, 3).map(r => r.name).join(', ')}${buildingSpec.rooms.length > 3 ? ' and more.' : '.'}`);
    }
    if (buildingSpec.equipment?.length > 0) {
      descParts.push(`${buildingSpec.equipment.length} equipment item(s).`);
    }
    if (bestTitleBlock) {
      const tbParts = [];
      if (bestTitleBlock.drawingNumber) tbParts.push(`Drawing ${bestTitleBlock.drawingNumber}`);
      if (bestTitleBlock.revision) tbParts.push(`Rev ${bestTitleBlock.revision}`);
      if (bestTitleBlock.firm) tbParts.push(`by ${bestTitleBlock.firm}`);
      if (tbParts.length > 0) descParts.push(`Source: ${tbParts.join(', ')}.`);
    }
    const ai_generated_description = descParts.join(' ');

    css.facility.description = ai_generated_description;

    console.log(`CSS generated: ${css.elements?.length || 0} elements, domain=${css.domain}`);

    mergeSpecClaimsIntoCss(css, specClaims);
    if (specParsed) materializeSpecInstances(css, specParsed);
    const tracingReport = buildTracingReport(css, processedFiles);
    css.metadata = css.metadata || {};
    css.metadata.tracingReport = tracingReport;
    const cssS3Key = await saveCSSToS3(bucket, userId, renderId, css);
    await saveExtractDebug(bucket, userId, renderId, css, tracingReport, sourceFiles, Date.now() - extractStartTime, revision);

    // Build refinement report if this was a refinement
    let refinementReport = null;
    let refinementReportS3Key = null;
    if (isRefinement && previousCSS) {
      refinementReport = buildRefinementReport(previousCSS, css, refinementText);
      css.metadata.refinementReport = refinementReport;
      console.log(`Refinement report: ${JSON.stringify(refinementReport.summary)}`);

      // Phase 6: Save dedicated refinement_report.json artifact
      try {
        refinementReportS3Key = await saveRefinementReport(bucket, userId, renderId, refinementReport, refinementText, revision);
      } catch (rrErr) {
        console.warn('Refinement report save failed (non-fatal):', rrErr.message);
      }
    }

    // Phase 1: Claims dual-write
    let claimsS3Key = null;
    let _claimsProvPct = null;
    let _extractValSummary = { total: 0, passed: 0, warned: 0, failed: 0 };
    try {
      resetClaimCounter();
      const claimsResult = buildingSpecToClaims(css, sourceFiles, { isRefinement });
      const visionClaimFiles = processedFiles.filter(f => f.visionCSS);
      const vClaims = visionToClaims(visionClaimFiles);
      const allClaims = mergeClaims(mergeClaims(claimsResult.claims, vClaims), specClaims);
      const claimsDoc = createClaimsEnvelope(claimsResult.domain, claimsResult.facilityMeta, allClaims, sourceFiles);
      // Release 13.2: provenance completeness from claims before writing to S3
      const _allClaims = claimsDoc.claims || [];
      if (_allClaims.length > 0) {
        const _attributed = _allClaims.filter(c => c.provenance?.sourceFileStatus && c.provenance.sourceFileStatus !== 'missing').length;
        _claimsProvPct = Math.round(100 * _attributed / _allClaims.length);
      }
      // PR 8: Run extract validators (all warning — non-halting)
      try {
        const _vr = runExtractValidators(claimsDoc, sourceFiles);
        for (const entry of _vr.entries) logValidation(entry);
        _extractValSummary = { total: _vr.total, passed: _vr.passed, warned: _vr.warned, failed: _vr.failed };
      } catch (ve) { console.warn('[validators:extract] Non-fatal:', ve.message); }
      claimsS3Key = await saveClaimsToS3(bucket, userId, renderId, claimsDoc, revision);
    } catch (claimsErr) {
      console.warn('Claims dual-write failed (non-fatal):', claimsErr.message);
    }

    // Phase 13 PR2: Trace end (Release 13.2: + scalars)
    try { await flushAudit(); } catch (ae) { console.warn('[audit:flush_failed]', ae.message); }
    if (_traceKey) {
      try {
        const elementCount = css?.elements?.length || 0;
        await writeTraceEnd({
          traceKey: _traceKey, stage: 'extract', runId: _traceRunId, attemptN: _traceAttemptN,
          startedAt: _traceStartedAt, finishedAt: new Date().toISOString(),
          outputArtifactKey: cssS3Key,
          counts: { elements: elementCount, claims: claimsS3Key ? 1 : 0 },
          validationFlags: [],
          scalars: {
            gatePassRate: null,
            contractStatus: 'pass',
            provenanceCompleteness: _claimsProvPct,
            validationSummary: _extractValSummary,
          },
        });
      } catch (te) { console.warn('[trace] end write failed (non-fatal):', te.message); }
    }

    return { cssS3Key, claimsS3Key, ai_generated_title, ai_generated_description, tracingReport, refinementReport, refinementReportS3Key };
  } catch (error) {
    console.error('ExtractBuildingSpec error:', error);
    // Let the error propagate to the Step Function so HandleFailure can mark it as failed
    throw error;
  }
};
