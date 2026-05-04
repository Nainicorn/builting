// Phase 13: Consumer + producer contract checks
import { checkContractAsync, cssRawContract, validatedCssContract } from '@builting/contracts';
// Phase 13 PR2: Trace writer
import { writeTraceStart, writeTraceEnd } from '@builting/trace';
// Phase 13.5 PR6: Audit log
import { initAudit, flushAudit, logValidation } from '@builting/audit';
// PR 8: Stage validators
import { runTopologyValidators } from './validators/topology-validators.mjs';

/**
 * Topology Engine Lambda (builting-topology-engine)
 *
 * Consolidated from builting-structure + builting-geometry + builting-validate.
 * Runs the entire structural inference, geometry build, and validation pipeline
 * in a single memory context — no intermediate S3 serialization. The topology
 * graph (connectivity graph) is passed by reference through all stages.
 *
 * Pipeline:
 *   ValidateCSS → RepairCSS → NormalizeGeometry →
 *   [TUNNEL] DecomposeTunnelShell pipeline →
 *   [TUNNEL] SplitTunnelSubSegments (main/upper Z-grouping) →
 *   SnapWallEndpoints (tiered: 50mm → 150mm) →
 *   [TUNNEL] BridgeVSMNodes (close coordinate gaps between VSM branches) →
 *   [BUILDING] MergeWalls → CleanWallAxes → BuildTopology →
 *   InferOpenings → CreateOpeningRelationships → InferSlabs →
 *   DeriveRoofElevation → AlignSlabsToWalls → GuaranteeBuildingEnvelope →
 *   ClampDimensions →
 *   BuildPathConnections → EquipmentMounting → AnnotateSweepGeometry →
 *   [TUNNEL] FixRampOrientation (slope axis for segments with |ΔZ| > 0.5m) →
 *   CSSValidation → SafetyChecks → ValidateTopology →
 *   RunFullModelValidation →
 *   v2 Adapter (inferred.json + resolved.json + css_processed.json) →
 *   Write all artifacts to S3
 *
 * Input:  { cssS3Key, userId, renderId, bucket, renderRevision, previousValidationReportS3Key }
 * Output: { cssS3Key, resolvedS3Key, validationReportS3Key, readinessScore, ... }
 */

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

// ── Structure modules ──
import { validateCSS, repairCSS, normalizeGeometry } from './validation.mjs';
import {
  decomposeTunnelShell, buildCenterlineSkeleton, identifyAndMergeRuns,
  validateTunnelGeometry,
  auditGeometryGaps, auditVisualGeometryQuality, auditOrphansAndBridgeGaps,
  generatePortalEndWalls
} from './tunnel-shell.mjs';
import { buildTopologyGraph } from './topology-graph.mjs';
import {
  mergeWalls, inferOpenings, createOpeningRelationships,
  validateOpeningPlacement, inferSlabs, guaranteeBuildingEnvelope,
  cleanBuildingWallAxes, checkEnvelopeFallback, validateBuildingStructure,
  clampAbsurdDimensions, clampWallsToEnvelope, snapWallEndpoints, alignSlabsToWalls,
  countAmbiguousProfiles, resetAmbiguousProfileCount, getAmbiguousProfileCount,
  deduplicateRoofs, deriveRoofElevation, snapSlabsToWallBases, snapWallsToStoreyFloor,
  mergeShortTunnelSegments, validateSpaceContainment, inferSpaces,
  synthesizeAncillaryRoomSlabs, snapSpecSlabsToLevels, synthesizeCoveringElements,
  deduplicateOverlappingTunnelSegments, snapTunnelSegmentEndpoints,
  solveJunctionPositions, trimSegmentsAtJunctions
} from './building-envelope.mjs';

// ── Geometry modules ──
import { buildPathConnections } from './path-connections.mjs';
import { synthesizeDuctFittings } from './duct-fittings.mjs';
import { applyEquipmentMounting } from './equipment.mjs';
import { buildDimensionLookup, applyTextDerivedHeights, applyDuctZDefaults, applyStoreyHeightFromProfile, synthesizePortalStoreys, normalizeDxfWallGeometry, applyPortalElevations, synthesizeVerticalShaft, synthesizeBuildingStoreys } from './dimension-apply.mjs';
import { validateCSSElements, runSafetyChecks } from './safety.mjs';
import { validateTopology } from './topology-validate.mjs';

// ── Validation modules ──
import { runFullValidation } from './model-validate.mjs';
import { runRuleAssertions } from './rule-assertions.mjs';

// ── Engineer-intent resolver (Phase 6 — see PLAN.md) ──
import { inferEngineerIntent } from './intent-resolver.mjs';
import { reconcileElementEvidence } from './evidence-reconciler.mjs';
import { INTENT_RESOLVER_MODES } from './config.mjs';

// ── Phase 6A.5 — Space classification (planning-only, no element mutation) ──
import { classifySpacesAndPlanDoors } from './space-classifier.mjs';

// ── Phase 6A.5 — Plan-driven acceptance override (mutates reconciliationStatus) ──
import { applyPlanDrivenAcceptance } from './acceptance-override.mjs';

// ── Phase 6B — Wall and Portal Structure Reconstruction (planning-only) ──
import { reconstructWalls } from './wall-reconstructor.mjs';

// ── Phase 6C — Connectivity gap diagnostics (planning-only, no element mutation) ──
import { buildConnectivityGapReport } from './connectivity-gap-report.mjs';
import {
  applyShellConnectivityFixes,
  applyVentilationFixes,
  addPortalDoorDiagnostics
} from './connectivity-fixes.mjs';

// ── Phase 8 — Spatial Placement Engine (universal positioning intelligence) ──
import { applySpatialPlacement } from './spatial-placement.mjs';

// ── Phase 9 — Tunnel-Anchored Spatial Layout (refinement layer) ──
import { applyTunnelAnchoredLayout } from './tunnel-anchored-layout.mjs';

// ── Phase 10 — Source Coordinate Normalization (frame alignment, runs first) ──
import { applyCoordinateNormalization } from './coordinate-normalize.mjs';

// ── Phase 11 — Structural Integration (boolean-cut descriptors) ──
import { applyStructuralIntegration } from './structural-integration.mjs';

// ── v2 Adapters ──
import { cssToInferred, cssToResolved, resolvedToLegacyCss } from './v2-adapter.mjs';

// ── VSM / Tunnel bridge steps (TUNNEL domain only) ──
import { splitTunnelSubSegments, bridgeVSMNodes, fixRampOrientation } from './vsm-bridge.mjs';

const s3 = new S3Client({});

function buildTypeHistogram(elements) {
  if (!elements) return {};
  const counts = {};
  for (const e of elements) {
    const t = e.type || 'UNKNOWN';
    counts[t] = (counts[t] || 0) + 1;
    if (t === 'SLAB' && e.properties?.slabType === 'ROOF') {
      counts['_SLAB_ROOF'] = (counts['_SLAB_ROOF'] || 0) + 1;
    }
  }
  return counts;
}

// ============================================================================
// UNIVERSAL GEOMETRY CONTRACT
// ============================================================================

/**
 * Classify every element's geometry behavior. This is the backbone of the
 * universal geometry contract — behavior-based, not element-name-based.
 *
 * Behaviors:
 *   PATH_SWEEP         — path-authored: directrix centerline + cross-section profile
 *   PROFILE_EXTRUSION  — profile extruded along a single direction
 *   TESSELLATED        — triangulated/faceted mesh
 *   OPENING_HOSTED     — void-cut element hosted in a parent
 *   SPATIAL            — bounding volume only (no physical geometry)
 *   DISCRETE_SOLID     — standalone solid with identity placement
 */
function classifyGeometryBehavior(css) {
  if (!css.elements) return;

  const PATH_SWEEP_TYPES = new Set(['DUCT', 'PIPE', 'CABLE_TRAY']);
  const PATH_SWEEP_SEMANTICS = new Set(['IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment']);
  const SURFACE_TYPES = new Set(['WALL', 'SLAB', 'COLUMN', 'BEAM']);
  let counts = {};

  for (const elem of css.elements) {
    const geom = elem.geometry;
    if (!geom) continue;

    const type = (elem.type || '').toUpperCase();
    const st = elem.semanticType || '';
    const props = elem.properties || {};
    const meta = elem.metadata || {};
    const method = (geom.method || '').toUpperCase();
    const pp = geom.pathPoints;
    const hasValidPath = Array.isArray(pp) && pp.length >= 2;

    let behavior;

    // 1. TUNNEL_SEGMENT (structural) → PATH_SWEEP with _isTunnelShell flag
    if (type === 'TUNNEL_SEGMENT' && props.branchClass === 'STRUCTURAL') {
      behavior = 'PATH_SWEEP';
      geom._isTunnelShell = true;
    }
    // 2. Explicit linear MEP types → PATH_SWEEP
    else if (PATH_SWEEP_TYPES.has(type) || PATH_SWEEP_SEMANTICS.has(st)) {
      behavior = 'PATH_SWEEP';
    }
    // 3. WALL/SLAB/COLUMN/BEAM with pathPoints → PATH_SWEEP (curved walls, ramps)
    else if (SURFACE_TYPES.has(type) && hasValidPath) {
      // Check pathLength > profile_max_dimension * 2
      const profile = geom.profile || {};
      const maxDim = Math.max(profile.width || 0, profile.height || 0, (profile.radius || 0) * 2, 0.1);
      const pathLen = _computePathLength(pp);
      if (pathLen > maxDim * 2) {
        behavior = 'PATH_SWEEP';
      } else {
        behavior = 'PROFILE_EXTRUSION';
      }
    }
    // 4. Standard surface types → PROFILE_EXTRUSION
    else if (SURFACE_TYPES.has(type)) {
      behavior = 'PROFILE_EXTRUSION';
    }
    // 5. Doors/windows with host → OPENING_HOSTED
    else if ((type === 'DOOR' || type === 'WINDOW') && (meta.hostWallKey || props.hostWallKey)) {
      behavior = 'OPENING_HOSTED';
    }
    // 6. Spaces → SPATIAL
    else if (type === 'SPACE') {
      behavior = 'SPATIAL';
    }
    // 7. Mesh/BREP → TESSELLATED
    else if (method === 'MESH' || method === 'BREP') {
      behavior = 'TESSELLATED';
    }
    // 8. Default → DISCRETE_SOLID
    else {
      behavior = 'DISCRETE_SOLID';
    }

    geom._geoBehavior = behavior;
    counts[behavior] = (counts[behavior] || 0) + 1;
  }

  console.log(`classifyGeometryBehavior: ${JSON.stringify(counts)}`);
}

/** Compute total path length from an array of {x,y,z} points. */
function _computePathLength(pathPoints) {
  let len = 0;
  for (let i = 1; i < pathPoints.length; i++) {
    const p0 = pathPoints[i - 1], p1 = pathPoints[i];
    const dx = (p1.x || 0) - (p0.x || 0);
    const dy = (p1.y || 0) - (p0.y || 0);
    const dz = (p1.z || 0) - (p0.z || 0);
    len += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return len;
}

/**
 * [TUNNEL] After decomposeTunnelShell assigns elem-* keys to TUNNEL_SEGMENT
 * elements, remap stale VSM branch ID container refs on ALL elements to the
 * new element_key values.
 *
 * VentSim equipment/child elements may arrive with container refs pointing to
 * the original VentSim branch ID (e.g. "ventsim_branch_260") rather than the
 * canonical levelsOrSegments entry or the resolved element_key. After
 * decomposeTunnelShell assigns element_key via elemId(), the old branch ID
 * no longer matches anything in buildSegmentIndex — causing findParentSegment
 * to fall through to projection-only matching, and leaving stale refs that
 * trigger invalid_container_ref in model-validate.
 *
 * Reverse-lookup sources (all checked):
 *   • elem.id → elem.element_key          (original id before key assignment)
 *   • properties.vsm_id → element_key     (explicit VSM ID field, if present)
 *   • "ventsim_branch_N" → element_key    (constructed from properties.unique_no)
 */
function remapVSMContainerRefs(css) {
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;
  if (!css.elements) return;

  // Build reverse lookup: old VSM id → new element_key
  const vsmIdToElemKey = new Map();
  for (const e of css.elements) {
    if (e.type !== 'TUNNEL_SEGMENT') continue;
    if (!e.element_key) continue;
    // Map original id → element_key (covers hash-based ids that were renamed)
    if (e.id && e.id !== e.element_key) vsmIdToElemKey.set(e.id, e.element_key);
    // Map explicit vsm_id property (if present in properties)
    if (e.properties?.vsm_id) vsmIdToElemKey.set(e.properties.vsm_id, e.element_key);
    // Map ventsim_branch_N alias constructed from unique_no
    if (e.properties?.unique_no != null) {
      vsmIdToElemKey.set(`ventsim_branch_${e.properties.unique_no}`, e.element_key);
    }
  }

  if (vsmIdToElemKey.size === 0) return;

  const validContainerIds = new Set((css.levelsOrSegments || []).map(l => l.id));

  let remapped = 0, unresolved = 0;
  for (const e of css.elements) {
    const cb = e.container;
    if (!cb || validContainerIds.has(cb)) continue; // already valid or absent
    const newKey = vsmIdToElemKey.get(cb);
    if (newKey) {
      e.container = newKey;
      remapped++;
    } else {
      // Stale ref that couldn't be resolved — warn for inspection
      unresolved++;
      console.warn(`CONTAINER_REF_REMAP: unresolved ref "${cb}" on ${e.type} ${e.id || e.element_key || 'unknown'}`);
    }
  }

  console.log(`CONTAINER_REF_REMAP: remapped=${remapped}, unresolved=${unresolved}`);
}

/**
 * Path-author all PATH_SWEEP elements: ensure they have validated pathPoints,
 * _runAxis, and _pathLength. Does NOT force geometry.method = 'SWEEP' —
 * the generator chooses the best IFC representation.
 */
function annotateSweepGeometry(css) {
  if (!css.elements) return;

  let annotated = 0;
  let depthFallbackCount = 0;
  const MAX_PATH_POINTS = 200;

  // Derive default up-axis from facilityMeta rather than hardcoding Z-up
  const facilityUp = css.facilityMeta?.upAxis || css.metadata?.facilityMeta?.upAxis;
  const _defaultAxis = facilityUp === 'Y' ? { x: 0, y: 1, z: 0 }
                     : facilityUp === 'X' ? { x: 1, y: 0, z: 0 }
                     : { x: 0, y: 0, z: 1 };
  if (!facilityUp) console.log('annotateSweepGeometry: no upAxis in facilityMeta — defaulting to Z-up');

  for (const elem of css.elements) {
    const geom = elem.geometry;
    if (!geom) continue;
    if (geom._geoBehavior !== 'PATH_SWEEP') continue;
    if (geom._isTunnelShell) continue; // tunnel shell placement handled by generate

    // Already path-authored with valid data — skip
    if (geom._pathAuthored && Array.isArray(geom.pathPoints) && geom.pathPoints.length >= 2) continue;

    const placement = elem.placement || {};
    const origin = placement.origin || { x: 0, y: 0, z: 0 };

    // Determine run axis: refDirection (CSS convention: axis=world-up, refDirection=bearing)
    // upAxis from facilityMeta drives the default — fall back to Z-up only if unspecified.
    const MEP_TYPES = new Set(['DUCT', 'PIPE', 'CABLE_TRAY']);
    let runDir = placement.refDirection || geom.direction || placement.axis;
    if (!runDir && MEP_TYPES.has((elem.type || '').toUpperCase())
        && Array.isArray(geom.pathPoints) && geom.pathPoints.length >= 2) {
      const p0 = geom.pathPoints[0], p1 = geom.pathPoints[geom.pathPoints.length - 1];
      const dx = (p1.x || 0) - (p0.x || 0), dy = (p1.y || 0) - (p0.y || 0), dz = (p1.z || 0) - (p0.z || 0);
      const pLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (pLen > 0.001) runDir = { x: dx / pLen, y: dy / pLen, z: dz / pLen };
    }
    if (!runDir) runDir = _defaultAxis;
    const typicalDepth = css.facilityMeta?.typicalElementDepth || css.metadata?.facilityMeta?.typicalElementDepth;
    const depth = geom.depth || typicalDepth || 1.0;
    if (!geom.depth) depthFallbackCount++;
    if (depth <= 0) continue;

    const ax = runDir.x || 0, ay = runDir.y || 0, az = runDir.z || 0;
    const len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-10) continue;
    const nx = ax / len, ny = ay / len, nz = az / len;

    // Generate pathPoints if missing
    if (!Array.isArray(geom.pathPoints) || geom.pathPoints.length < 2) {
      geom.pathPoints = [
        { x: origin.x - nx * depth / 2, y: origin.y - ny * depth / 2, z: origin.z - nz * depth / 2 },
        { x: origin.x + nx * depth / 2, y: origin.y + ny * depth / 2, z: origin.z + nz * depth / 2 }
      ];
      geom._previousMethod = geom.method || 'EXTRUSION';
    }

    // Validate and clean pathPoints
    geom.pathPoints = _validatePathPoints(geom.pathPoints, MAX_PATH_POINTS);

    if (geom.pathPoints.length < 2) continue; // validation removed all points

    // Check minimum path length
    const profile = geom.profile || {};
    const maxDim = Math.max(profile.width || 0, profile.height || 0, (profile.radius || 0) * 2, 0.1);
    const pathLen = _computePathLength(geom.pathPoints);
    if (pathLen <= maxDim * 2) {
      // Too short — downgrade to DISCRETE_SOLID
      geom._geoBehavior = 'DISCRETE_SOLID';
      geom._pathAuthored = false;
      continue;
    }

    // Store path metadata
    geom._pathAuthored = true;
    geom._runAxis = { x: nx, y: ny, z: nz };
    geom._pathLength = pathLen;
    annotated++;
  }

  if (annotated > 0 || depthFallbackCount > 0) {
    const typicalDepth = css.facilityMeta?.typicalElementDepth || css.metadata?.facilityMeta?.typicalElementDepth;
    const fallbackSrc = typicalDepth ? `facilityMeta.typicalElementDepth=${typicalDepth}` : '1.0m constant (no facilityMeta.typicalElementDepth)';
    console.log(`annotateSweepGeometry: ${annotated} PATH_SWEEP elements path-authored; ${depthFallbackCount} used depth fallback → ${fallbackSrc}`);
  }
}

/**
 * Validate and clean pathPoints: sort along dominant axis, dedupe,
 * remove zero-length segments, enforce max count.
 */
function _validatePathPoints(points, maxPoints) {
  if (!Array.isArray(points) || points.length < 2) return points;

  // Remove non-finite points
  let clean = points.filter(p =>
    Number.isFinite(p.x || 0) && Number.isFinite(p.y || 0) && Number.isFinite(p.z || 0)
  );

  if (clean.length < 2) return clean;

  // Sort along dominant axis (ensure consistent start→end direction)
  // Determine dominant axis from first-to-last vector
  const p0 = clean[0], pN = clean[clean.length - 1];
  const dx = Math.abs((pN.x || 0) - (p0.x || 0));
  const dy = Math.abs((pN.y || 0) - (p0.y || 0));
  const dz = Math.abs((pN.z || 0) - (p0.z || 0));
  // Only sort if points might be unordered (more than 2 points)
  if (clean.length > 2) {
    if (dx >= dy && dx >= dz) {
      clean.sort((a, b) => (a.x || 0) - (b.x || 0));
    } else if (dy >= dx && dy >= dz) {
      clean.sort((a, b) => (a.y || 0) - (b.y || 0));
    } else {
      clean.sort((a, b) => (a.z || 0) - (b.z || 0));
    }
  }

  // Remove duplicate points (within 1mm tolerance)
  const DEDUP_TOL = 0.001;
  const deduped = [clean[0]];
  for (let i = 1; i < clean.length; i++) {
    const prev = deduped[deduped.length - 1];
    const cur = clean[i];
    const dist = Math.sqrt(
      ((cur.x || 0) - (prev.x || 0)) ** 2 +
      ((cur.y || 0) - (prev.y || 0)) ** 2 +
      ((cur.z || 0) - (prev.z || 0)) ** 2
    );
    if (dist > DEDUP_TOL) {
      deduped.push(cur);
    }
  }

  // Remove zero-length segments (min 10mm)
  const MIN_SEG = 0.01;
  const filtered = [deduped[0]];
  for (let i = 1; i < deduped.length; i++) {
    const prev = filtered[filtered.length - 1];
    const cur = deduped[i];
    const dist = Math.sqrt(
      ((cur.x || 0) - (prev.x || 0)) ** 2 +
      ((cur.y || 0) - (prev.y || 0)) ** 2 +
      ((cur.z || 0) - (prev.z || 0)) ** 2
    );
    if (dist >= MIN_SEG) {
      filtered.push(cur);
    }
  }

  // Enforce max pathPoints (performance guard)
  if (filtered.length > maxPoints) {
    // Subsample evenly
    const step = filtered.length / maxPoints;
    const sampled = [filtered[0]];
    for (let i = 1; i < maxPoints - 1; i++) {
      sampled.push(filtered[Math.round(i * step)]);
    }
    sampled.push(filtered[filtered.length - 1]);
    return sampled;
  }

  return filtered;
}

export const handler = async (event, context) => {
  console.log('TopologyEngine Lambda invoked — unified structure + geometry + validate');
  resetAmbiguousProfileCount();
  const startTime = Date.now();
  const stepTimings = [];
  // Phase 13 PR2: Trace state — populated after idempotency guard.
  const _traceRunId = context?.awsRequestId || `topology-${Date.now()}`;
  const _traceStartedAt = new Date().toISOString();
  let _traceKey = null; let _traceAttemptN = 1;

  // The CSS object is passed by reference through ALL stages — no serialization.
  let css;

  function timedStep(name, fn) {
    const t0 = Date.now();
    const elementsBefore = css?.elements?.length || 0;
    const typesBefore = buildTypeHistogram(css?.elements);
    fn();
    const ms = Date.now() - t0;
    const elementsAfter = css?.elements?.length || 0;
    const typesAfter = buildTypeHistogram(css?.elements);
    stepTimings.push({ step: name, durationMs: ms, elementsBefore, elementsAfter, typesBefore, typesAfter });
    if (ms > 50 || elementsBefore !== elementsAfter) {
      console.log(`Step ${name}: ${ms}ms (${elementsBefore}→${elementsAfter} elements)`);
    }
  }

  const { cssS3Key, userId, renderId, bucket, renderRevision, previousValidationReportS3Key } = event;
  const revision = renderRevision || 1;

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 1: LOAD CSS FROM S3
  // ════════════════════════════════════════════════════════════════════════

  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: cssS3Key }));
    css = JSON.parse(await response.Body.transformToString());
    console.log(`Loaded CSS from S3: ${cssS3Key} (${css.elements?.length || 0} elements)`);
  } catch (err) {
    console.error('Failed to load CSS from S3:', err.message);
    throw new Error(`Failed to load CSS from S3: ${err.message}`);
  }

  if (!css || !css.elements) {
    throw new Error('CSS loaded from S3 has no elements');
  }

  // Consumer contract check: validate css_raw.json on entry (halting).
  await checkContractAsync('cssRawContract', cssRawContract, css, {
    halting: true,
    renderId,
    stage: 'topology-entry',
  });

  // Idempotency: if output artifacts already exist, return cached result
  const _processedKey = `uploads/${userId}/${renderId}/css/css_processed.json`;
  const _engineReportKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/topology_engine_report.json`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: _processedKey }));
    console.log(`[idempotency] css_processed.json exists — returning cached result`);
    const engineObj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: _engineReportKey }));
    const engineReport = JSON.parse(await engineObj.Body.transformToString());
    const mv = engineReport.modelValidation || {};
    return {
      cssS3Key: _processedKey,
      resolvedS3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/resolved.json`,
      validationReportS3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/validation_report.json`,
      readinessScore: mv.readinessScore || 0,
      exportReadiness: mv.exportReadiness || 'NOT_READY',
      authoringSuitability: mv.authoringSuitability || null,
      criticalIssueCount: mv.errorCount || 0,
      warningCount: mv.warningCount || 0,
      proxyRatio: mv.proxyRatio || 0,
      generationModeRecommendation: mv.generationMode || null,
      readinessDelta: 0,
      geometryFidelity: mv.geometryFidelity || null,
      inferredS3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/inferred.json`,
      elementCount: engineReport.elementCountOut || 0,
      domain: engineReport.domain || 'UNKNOWN',
      validationResult: {
        valid: engineReport.cssValidation?.valid || false,
        errorCount: engineReport.cssValidation?.errorCount || 0,
        warningCount: engineReport.cssValidation?.warningCount || 0,
        errors: [],
        warnings: [],
      },
      topology_report: null,
    };
  } catch (err) {
    if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) throw err;
  }

  // Phase 13 PR2: Trace start — after idempotency/cache guard.
  try {
    ({ key: _traceKey, attemptN: _traceAttemptN } = await writeTraceStart({
      renderId, stage: 'topology', runId: _traceRunId, startedAt: _traceStartedAt,
      artifactKey: cssS3Key,
    }));
  } catch (te) { console.warn('[trace] start write failed (non-fatal):', te.message); }
  initAudit(renderId, 'topology', _traceRunId);

  const elementCountIn = css.elements.length;
  const domain = (css.domain || '').toUpperCase();
  // Data-driven: pipeline branching is determined by element types, not the domain string.
  // This correctly handles hybrid structures and cases where domain is missing or wrong.
  const hasTunnelSegs = css.elements.some(e => e.type === 'TUNNEL_SEGMENT');
  console.log(`TopologyEngine: domain=${domain}, hasTunnelSegs=${hasTunnelSegs}, elementCount=${elementCountIn}`);
  if (hasTunnelSegs && !css.metadata?.facilityDimensions?.length) {
    console.warn('TopologyEngine: WARN hasTunnelSegs=true but css.metadata.facilityDimensions is absent or empty — dist patch may be missing from extract lambda or DOCX was not present');
  } else if (hasTunnelSegs) {
    console.log(`TopologyEngine: facilityDimensions present — ${css.metadata.facilityDimensions.length} entries, sources=[${[...new Set(css.metadata.facilityDimensions.map(d => d._source || 'unknown'))].join(',')}]`);
  }
  // Portal elevation diagnostic
  if (hasTunnelSegs) {
    const portalCount = (css.metadata?.portals || []).length;
    const portalElevs = (css.metadata?.portals || []).filter(p => p.elevation_msl != null);
    console.log(`TopologyEngine: metadata.portals=${portalCount} (${portalElevs.length} with elevation_msl)${portalElevs.length > 0 ? ' → ' + portalElevs.map(p => `${p.name}=${p.elevation_msl}m`).join(', ') : ''}`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 1.5: PROVENANCE INITIALIZATION
  // Stamp every element that arrives without a provenance field so that
  // modification-tracking guards (topology:snap, topology:inferOpenings, etc.)
  // have an object to append to. Must run before any structural pass.
  // ════════════════════════════════════════════════════════════════════════
  let provenanceInitCount = 0;
  for (const elem of css.elements) {
    if (!elem.provenance) {
      const sf = elem.sourceFile || null;
      elem.provenance = {
        sourceFile: sf,
        sourceFileStatus: sf ? 'direct' : 'missing',
        sourceFiles: sf ? [sf] : [],
        stage: 'topology:init',
        modifications: [],
      };
      provenanceInitCount++;
    }
  }
  if (provenanceInitCount > 0) {
    console.log(`ProvenanceInit: stamped ${provenanceInitCount} elements with baseline provenance`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 2: STRUCTURE RESOLVE (formerly builting-structure)
  // ════════════════════════════════════════════════════════════════════════

  // Step 1: Validate CSS
  let validationResult;
  timedStep('validate', () => { validationResult = validateCSS(css); });
  console.log(`Validation: valid=${validationResult.valid}, errors=${validationResult.errors.length}, warnings=${validationResult.warnings.length}`);

  // Step 2: Repair if needed
  if (!validationResult.valid && validationResult.repairable) {
    timedStep('repair', () => repairCSS(css));
    console.log(`Repair complete: ${css.metadata.repairLog?.length || 0} repairs applied`);
  }

  // Step 2.5: Phase 10 — Source Coordinate Normalization.
  // Detects per-source coordinate frames (VSM, DXF, SPEC_TEXT, …), picks
  // the VSM tunnel frame as canonical, and translates non-canonical
  // elements so every downstream pass operates on a single project frame.
  // SPACEs that still carry a default origin after the transform are
  // tagged NEEDS_COORDINATE_RESOLUTION + FLOATING (placement.origin=null)
  // so they're never emitted as geometry.  Runs BEFORE normalizeGeometry
  // so origin-shift / clamping doesn't run against a frame mismatch.
  if (css.featureFlags?.PHASE_10_NORMALIZE !== false) {
    timedStep('applyCoordinateNormalization', () => applyCoordinateNormalization(css));
  }

  // Step 3: Normalize geometry (origin shift, coordinate clamping)
  timedStep('normalizeGeometry', () => normalizeGeometry(css));

  // Step 3B: Tunnel semantic pipeline (runs when TUNNEL_SEGMENT elements are present)
  // Topology defines structure — generate creates geometry.
  // decomposeTunnelShell annotates segments with shell metadata (thickness, path).
  // Shell rendering: applyTextDerivedHeights (Step G1.5) sets profile.type='ARCH' for horseshoe
  // tunnels; the generate lambda renders each TUNNEL_SEGMENT as a single hollow arch tube.
  // decomposeMergedRuns (4-panel shell decomposition) is NOT called — it creates LEFT_WALL/
  // RIGHT_WALL/FLOOR/ROOF shell pieces that duplicate the arch tube geometry, causing 3× element
  // inflation. Arch tube rendering (already working for all structural segments) replaces it.
  if (hasTunnelSegs) {
    console.log('Tunnel segments detected: arch hollow tube pipeline');
    // Junction solver BEFORE shell annotation — so shellThickness uses junction-solved positions.
    timedStep('solveJunctionPositions', () => solveJunctionPositions(css));
    timedStep('decomposeTunnelShell', () => decomposeTunnelShell(css));
    // Dedup BEFORE skeleton — duplicate segments produce doubled geometry
    timedStep('earlyDedup', () => deduplicateOverlappingTunnelSegments(css));
    // Build skeleton and runs for audit/path-connection reference (no shell pieces emitted).
    timedStep('buildCenterlineSkeleton', () => buildCenterlineSkeleton(css));
    timedStep('identifyAndMergeRuns', () => identifyAndMergeRuns(css));
    // decomposeMergedRuns intentionally skipped — arch tube rendering handles structural geometry.
    timedStep('generatePortalEndWalls', () => generatePortalEndWalls(css));
    // mergeShortTunnelSegments operates on segments, not fragments — keep it
    timedStep('mergeShortTunnelSegments', () => mergeShortTunnelSegments(css));
    // After decomposeTunnelShell assigns elem-* keys to TUNNEL_SEGMENT elements,
    // remap any stale VSM branch ID container refs on child elements (FAN, PUMP, etc.)
    // to match the new element_key values. Must run before splitTunnelSubSegments
    // so container refs are clean before Z-based splitting reassigns them.
    timedStep('remapVSMContainerRefs', () => remapVSMContainerRefs(css));
    // Split flat segment into main/upper sub-segments by Z range (before bridges are created)
    timedStep('splitTunnelSubSegments', () => splitTunnelSubSegments(css));
    // Detect disconnected orphan segments
    timedStep('auditOrphansAndBridgeGaps', () => auditOrphansAndBridgeGaps(css));
    // Validation passes
    timedStep('validateTunnelGeometry', () => validateTunnelGeometry(css));
    timedStep('auditGeometryGaps', () => auditGeometryGaps(css));
    timedStep('auditVisualGeometryQuality', () => auditVisualGeometryQuality(css));
  }

  // Step 3C: Snap wall endpoints (tiered: 50mm → 150mm)
  timedStep('snapWallEndpoints', () => snapWallEndpoints(css));

  // Step 3C-T: Snap tunnel segment endpoints (tiered: 50mm → 150mm)
  // snapWallEndpoints skips tunnels, so this dedicated pass handles TUNNEL_SEGMENT alignment.
  // Runs BEFORE bridgeVSMNodes so bridges are only created for real gaps, not snap-fixable ones.
  if (hasTunnelSegs) {
    timedStep('snapTunnelSegmentEndpoints', () => snapTunnelSegmentEndpoints(css));

    // Step 3C-T2 (Phase 6D.1 P2): trim segment ends at multi-way junctions so
    // CSG filler hulls (in the generate lambda) replace local shell instead of
    // sitting on top of it. Trim radius defaults to 0.5m; tune via the
    // TUNNEL_JUNCTION_TRIM_M env var. Set to 0 to disable.
    const trimRadiusRaw = process.env.TUNNEL_JUNCTION_TRIM_M;
    const trimRadiusM = trimRadiusRaw == null
      ? 0.5
      : Number.parseFloat(trimRadiusRaw);
    if (Number.isFinite(trimRadiusM) && trimRadiusM > 0) {
      timedStep('trimSegmentsAtJunctions',
        () => trimSegmentsAtJunctions(css, trimRadiusM));
    }
  }

  // Step 3D: Bridge VSM node coordinate gaps (tunnel structures only).
  // Inserts TUNNEL_SEGMENT bridge elements between topologically connected branches
  // whose endpoints are not coincident after snapping (gaps > 50mm, < 100m).
  if (hasTunnelSegs) {
    timedStep('bridgeVSMNodes', () => bridgeVSMNodes(css));
  }

  // Step 3E: Build topology graph — tunnel structures build before wall merge (no walls to merge);
  // building structures build after merge so topology reflects merged wall endpoints.
  if (hasTunnelSegs) {
    timedStep('buildTopologyGraph', () => buildTopologyGraph(css));
  }

  // Step 4: Merge walls
  timedStep('mergeWalls', () => mergeWalls(css));

  // Step 4B: Wall axis cleanup
  timedStep('cleanBuildingWallAxes', () => cleanBuildingWallAxes(css));

  // Step 4C: Rebuild topology after merge (building structures — no TUNNEL_SEGMENT elements)
  if (!hasTunnelSegs) {
    timedStep('buildTopologyGraph', () => buildTopologyGraph(css));
  }

  // Step 4C-R: Evidence Reconciliation — runs before the intent resolver so
  // the resolver only processes authoritative door candidates.  Compares raw
  // extracted door/window elements against the authoritative spec constraints
  // (count, types, sizes) and marks excess/weak candidates as 'rejected'.
  // Rejected elements are stripped from css_processed.json in the
  // preGenerateExportValidation pass so they never reach the generate lambda.
  timedStep('reconcileElementEvidence', () => { reconcileElementEvidence(css); });

  // Step 4D: Engineer-intent resolver (Phase 6) — runs after topology graph
  // is stable so door host candidates (TUNNEL_SEGMENT, PORTAL_END_WALL, WALL)
  // are settled. In Phase 6A (mode='report') this is observation-only:
  // the resolver computes what an engineer would have meant for each door
  // and writes engineer_intent_report.json, but does NOT annotate elements.
  // Modes 'consume-doors' and beyond switch on per-element annotation in 6B+.
  // Phase 6C — default to consume-doors so the plan-driven acceptance
  // override actually drops MAIN_TUNNEL / ROOM_INTERIOR doors and surfaces
  // unresolved main-portal entrances. The space-classifier + override stack
  // (Phase 6A.5) is the source of truth for door placement; leaving the
  // default at 'report' silently let mis-zoned doors through to generate.
  const intentMode = (() => {
    const raw = (process.env.INTENT_RESOLVER_MODE || 'consume-doors').toLowerCase();
    return INTENT_RESOLVER_MODES.includes(raw) ? raw : 'consume-doors';
  })();
  css.metadata = css.metadata || {};
  css.metadata.featureFlags = css.metadata.featureFlags || {};
  css.metadata.featureFlags.intentMode = intentMode;
  let intentReport = null;
  if (intentMode !== 'off') {
    timedStep('inferEngineerIntent', () => {
      intentReport = inferEngineerIntent(css, { phase: 'structural', mode: intentMode });
    });
  }

  // Step 4E: Phase 6A.5 — Space classification + semantic door plan.
  // Planning-only pass: classifies tunnel segments/nodes into functional zones,
  // derives rooms, applies architectural door rules, and emits a diff against
  // the current intent/reconciliation selection. Does NOT mutate elements.
  let spaceReport = null;
  let doorPlan    = null;
  timedStep('classifySpacesAndPlanDoors', () => {
    const result = classifySpacesAndPlanDoors(css);
    spaceReport = result.spaceReport;
    doorPlan    = result.doorPlan;
  });
  if (spaceReport && doorPlan) {
    console.log(`SpaceClassifier: segments=${spaceReport.counts.segments} ` +
                `rooms=${spaceReport.counts.rooms} ` +
                `mainCorridor=${spaceReport.counts.mainCorridorSegments} ` +
                `junctions=${spaceReport.counts.junctionNodes} ` +
                `shafts=${spaceReport.counts.shaftElements}`);
    console.log(`DoorPlan: candidates=${doorPlan.summary.totalCandidates} ` +
                `currentAccepted=${doorPlan.summary.currentAccepted} ` +
                `expectedTotal=${doorPlan.summary.expectedTotal} ` +
                `deviations=${doorPlan.deviations.length}`);
  }

  // Step 4F: Phase 6A.5 — Plan-driven acceptance override.
  // Reads spaceReport + doorPlan, mutates each DOOR element's
  // reconciliationStatus + intent.skipReason per architectural rules.
  // Only activates when intent mode is consume-doors (or stronger) — under
  // 'report' mode the classifier still runs but acceptance is left untouched.
  let overrideReport = null;
  if (spaceReport && doorPlan
      && (intentMode === 'consume-doors' || intentMode === 'consume-mep' || intentMode === 'consume-all')) {
    timedStep('applyPlanDrivenAcceptance', () => {
      overrideReport = applyPlanDrivenAcceptance(css, spaceReport, doorPlan);
    });
    if (overrideReport) {
      console.log(`AcceptanceOverride: ` +
                  `pre=${overrideReport.summary.preAccepted}→post=${overrideReport.summary.postAccepted} accepted, ` +
                  `emittable=${overrideReport.summary.postEmittable}, ` +
                  `acceptedNoHost=${overrideReport.summary.postAcceptedNoHost}, ` +
                  `portalReanchored=${overrideReport.summary.portalReanchored || 0}, ` +
                  `decisions=${overrideReport.summary.decisions}, ` +
                  `unresolved=${overrideReport.summary.unresolved}`);
      // Attach to the existing evidence reconciliation report so it persists
      // through to S3 alongside the original reconciler audit.
      css.metadata = css.metadata || {};
      css.metadata.evidenceReconciliation = css.metadata.evidenceReconciliation || {};
      css.metadata.evidenceReconciliation.planDrivenOverride = overrideReport;
    }
  }

  // Step 4G: Phase 6B — Wall and Portal Structure Reconstruction (planning-only).
  // Derives planar portal entrance walls (per mainPortalPair) and room
  // partition walls (where rooms branch off the corridor at junction nodes)
  // and writes the plans into css.metadata.wallReconstruction. The Python
  // generate lambda consumes the plans and emits IfcWallStandardCase. Does
  // NOT mutate elements, doors, the reconciler, or intent metadata.
  let wallReconReport = null;
  if (spaceReport) {
    timedStep('reconstructWalls', () => {
      wallReconReport = reconstructWalls(css, spaceReport);
    });
    if (wallReconReport) {
      const s = wallReconReport.summary || {};
      console.log(`WallReconstructor: portalWalls=${s.portalWalls} ` +
                  `junctionWalls=${s.junctionWalls ?? '-'} ` +
                  `terminalWalls=${s.terminalWalls ?? '-'} ` +
                  `roomPartitionWalls=${s.roomPartitionWalls} ` +
                  `total=${s.totalWalls} expected=${s.expectedTotal ?? '-'}`);
    }
  }

  // Step 5: Infer openings
  timedStep('inferOpenings', () => inferOpenings(css));

  // Step 5B: Create opening relationships (VOIDS)
  timedStep('createOpeningRelationships', () => createOpeningRelationships(css));

  // Step 5C: Opening placement validation
  timedStep('validateOpeningPlacement', () => validateOpeningPlacement(css));

  // Step 6: Infer slabs
  timedStep('inferSlabs', () => inferSlabs(css));

  // Step 6-DEDUP: Roof deduplication
  timedStep('deduplicateRoofs', () => deduplicateRoofs(css));

  // Step 6A: Align slabs to walls
  timedStep('alignSlabsToWalls', () => alignSlabsToWalls(css));

  // Step 6A-2: Derive roof elevation from wall heights (parametric height chain)
  timedStep('deriveRoofElevation', () => deriveRoofElevation(css));

  // Step 6A-3: Snap floor slabs to wall bases (gravity check)
  timedStep('snapSlabsToWallBases', () => snapSlabsToWallBases(css));

  // Step 6B: Building envelope guarantee
  timedStep('guaranteeBuildingEnvelope', () => guaranteeBuildingEnvelope(css));

  // Step 6B-DEDUP: Post-envelope roof deduplication
  timedStep('deduplicateRoofsPostEnvelope', () => deduplicateRoofs(css));

  // Step 6B-CLIP: Re-clip any envelope-generated slabs to wall footprint
  timedStep('alignSlabsToWallsPostEnvelope', () => alignSlabsToWalls(css));

  // Step 6C: Snap wall bases to storey floor (close wall-to-floor gaps)
  timedStep('snapWallsToStoreyFloor', () => snapWallsToStoreyFloor(css));

  // Step 7: Envelope fallback check
  timedStep('checkEnvelopeFallback', () => checkEnvelopeFallback(css));

  // Step 7A-2: Infer spaces from wall footprints (buildings only)
  timedStep('inferSpaces', () => inferSpaces(css));

  // Step 7A-3: Space/room container alignment
  timedStep('validateSpaceContainment', () => validateSpaceContainment(css));

  // Step 7B: Building structural validation
  timedStep('validateBuildingStructure', () => validateBuildingStructure(css));

  // Step 7C: Wall envelope clamping
  timedStep('clampWallsToEnvelope', () => clampWallsToEnvelope(css));

  // Step 7D: Dimension validation (universal)
  timedStep('clampAbsurdDimensions', () => clampAbsurdDimensions(css));

  // Track ambiguous wall profiles
  countAmbiguousProfiles(css);
  const ambiguousProfileCount = getAmbiguousProfileCount();
  if (ambiguousProfileCount > 0) {
    console.log(`TopologyEngine: ${ambiguousProfileCount} wall(s) had ambiguous profiles`);
    if (!css.metadata) css.metadata = {};
    css.metadata.ambiguousWallProfiles = ambiguousProfileCount;
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 3: GEOMETRY BUILD (formerly builting-geometry)
  // The topology graph is STILL IN MEMORY — no serialization needed.
  // ════════════════════════════════════════════════════════════════════════

  console.log('GeometryBuild phase — topology graph in memory, no S3 round-trip');

  // Step G0.5: Deduplicate overlapping structural tunnel segments
  // Handles: exact node matches, reversed-node pairs, and spatial proximity overlaps.
  if (hasTunnelSegs) {
    timedStep('deduplicateOverlappingTunnelSegments', () => deduplicateOverlappingTunnelSegments(css));
  }

  // Step G0.6: Rebuild topology graph after dedup so runs reference surviving segments only.
  // Without this, buildPathConnections creates connections to removed elements
  // that fail IFC resolution in generate (no IFC entity for deduplicated segments).
  if (hasTunnelSegs && (css.metadata?.overlappingSegmentsRemoved || 0) > 0) {
    timedStep('rebuildTopologyPostDedup', () => buildTopologyGraph(css));
  }

  // Step G1: Build path connections (uses topology by reference)
  timedStep('buildPathConnections', () => buildPathConnections(css));

  // Step G1.1: Synthesize DUCT_FITTING elements at duct junction nodes
  timedStep('synthesizeDuctFittings', () => synthesizeDuctFittings(css));

  // Step G1.5: Apply text-derived facility dimensions (DOCX/structured extraction → element geometry)
  // Runs before equipment mounting so corrected tunnel bore dimensions propagate into Z placement.
  if (css.metadata?.facilityDimensions?.length > 0) {
    const dimLookup = buildDimensionLookup(css.metadata.facilityDimensions);
    timedStep('applyTextDerivedHeights',     () => applyTextDerivedHeights(css, dimLookup));
    timedStep('normalizeDxfWallGeometry',    () => normalizeDxfWallGeometry(css, dimLookup));
    timedStep('applyDuctZDefaults',          () => applyDuctZDefaults(css, dimLookup));
    // Backfill height_m onto tunnel levelsOrSegments so storey_height_map in the
    // generate lambda gets a real bore height for DXF wall extrusion (not the 3.5m default).
    timedStep('applyStoreyHeightFromProfile', () => applyStoreyHeightFromProfile(css, dimLookup));
    // Step G1.5b: Synthesize vertical shaft from SHAFT facilityDimension (tunnel only).
    if (hasTunnelSegs) {
      timedStep('synthesizeVerticalShaft', () => synthesizeVerticalShaft(css, dimLookup));
    }
  }

  // Step G1.6: Synthesize Portal_Roof storey for portal-building walls (tunnel only).
  // Runs after splitTunnelSubSegments has created seg-*-upper and after
  // generatePortalEndWalls has emitted PORTAL_BUILDING elements.
  if (hasTunnelSegs) {
    timedStep('synthesizePortalStoreys', () => synthesizePortalStoreys(css));
  }

  // Step G1.7: Apply portal elevation grade (tunnel only).
  // Reads css.metadata.portals (from DOCX extraction) and interpolates Z along
  // the tunnel path so segments between portals reflect the real-world grade.
  // Must run BEFORE equipment mounting (Z placement depends on host segment Z).
  if (hasTunnelSegs) {
    timedStep('applyPortalElevations', () => applyPortalElevations(css));
  }

  // Step G1.8: Synthesize STOREY-type levelsOrSegments from portal elevations (tunnel only).
  // Creates separate IfcBuildingStorey entries for portal buildings at distinct MSL elevations.
  // Must run AFTER applyPortalElevations (Z values set) and generatePortalEndWalls.
  if (hasTunnelSegs) {
    timedStep('synthesizeBuildingStoreys', () => synthesizeBuildingStoreys(css));
  }

  // Step G1.9: Synthesize floor+roof slabs for ancillary rooms (portal buildings, crosscuts).
  // Must run AFTER synthesizeBuildingStoreys — portal walls are not in storey containers until
  // that step reassigns them. Running earlier causes all portal walls to be seen in structural
  // containers (tunnel segment containers) and skipped, producing 0 slabs.
  if (hasTunnelSegs) {
    timedStep('snapSpecSlabsToLevels', () => snapSpecSlabsToLevels(css));
    timedStep('synthesizeAncillaryRoomSlabs', () => synthesizeAncillaryRoomSlabs(css));
    // Step G1.10: Synthesize ceiling coverings (IfcCovering) for the same rooms that got slabs.
    // Must run after synthesizeAncillaryRoomSlabs so the roof slabs it uses as anchors exist.
    timedStep('synthesizeCoveringElements', () => synthesizeCoveringElements(css));
  }

  // Step G2: Equipment mounting
  timedStep('applyEquipmentMounting', () => applyEquipmentMounting(css));

  // Step G2.4: Phase 8 — Spatial Placement Engine.
  // Universal positioning pass: SPACE bbox inference from connected
  // tunnel-segment clusters, slab/covering placement against SPACE bounds,
  // wall snapping to tunnel centerlines, door host-wall binding, shaft
  // junction snap.  Runs after equipment mounting (which already places
  // EQUIPMENT origins) and before classify/annotate so downstream geometry
  // sees corrected placements.
  if (css.featureFlags?.PHASE_8_SPATIAL !== false) {
    timedStep('applySpatialPlacement', () => applySpatialPlacement(css));
  }

  // Step G2.4b: Phase 9 — Tunnel-Anchored Spatial Layout.
  // Layout correction pass that runs AFTER Phase 8: snaps SPACEs to the
  // primary tunnel network, builds 4-wall enclosures around each SPACE,
  // realigns doors to sit at the SPACE↔tunnel midpoint with a tunnel-shell
  // cut flag, snaps the shaft strictly to a junction with a ceiling-cut
  // flag, and tags floating elements for emit-skip.
  if (css.featureFlags?.PHASE_9_LAYOUT !== false) {
    timedStep('applyTunnelAnchoredLayout', () => applyTunnelAnchoredLayout(css));
  }

  // Step G2.4c: Phase 11 — Structural Integration (boolean cuts).
  // Runs AFTER Phase 9 layout: stamps tunnelOpening descriptors on every
  // attached SPACE, verifies door/wall/tunnel intersection (rejecting doors
  // that do not), forces shaft penetration of the tunnel crown, removes
  // walls that sit inside the tunnel volume, and tags any unintegrated
  // SPACE for emit-skip.  Generate consumes the descriptors to perform
  // real IfcOpeningElement / IfcRelVoidsElement boolean subtractions.
  if (css.featureFlags?.PHASE_11_INTEGRATION !== false) {
    timedStep('applyStructuralIntegration', () => applyStructuralIntegration(css));
  }

  // Step G2.5: Classify geometry behavior (universal geometry contract)
  timedStep('classifyGeometryBehavior', () => classifyGeometryBehavior(css));

  // Step G2.6: Path-author PATH_SWEEP elements (ensure pathPoints, _runAxis, _pathLength)
  timedStep('annotateSweepGeometry', () => annotateSweepGeometry(css));

  // Step G2.6B: Ramp orientation fix (tunnel structures only).
  // For TUNNEL_SEGMENTs where |path ΔZ| > 0.5m, override the flat horizontal
  // axis with the true 3D slope vector so generate extrudes along the incline.
  if (hasTunnelSegs) {
    timedStep('fixRampOrientation', () => fixRampOrientation(css));
  }

  // Step G2.7: Guard invalid sweeps — use _geoBehavior for smarter decisions.
  // PATH_SWEEP elements missing pathPoints → flag for path generation (all domains).
  // Non-PATH_SWEEP elements with SWEEP method + no pathPoints → downgrade to EXTRUSION.
  timedStep('guardInvalidSweeps', () => {
    let downgraded = 0;
    let flaggedLinear = 0;

    for (const elem of css.elements) {
      const geom = elem.geometry;
      if (!geom || geom.method !== 'SWEEP') continue;
      if (Array.isArray(geom.pathPoints) && geom.pathPoints.length >= 2) continue;

      const behavior = geom._geoBehavior || '';

      geom._failedSweep = true;
      geom._previousMethod = geom.method;

      if (behavior === 'PATH_SWEEP') {
        // PATH_SWEEP without pathPoints: flag for path generation (universal, all domains)
        geom._needsGeneratedPath = true;
        if (!elem.metadata) elem.metadata = {};
        elem.metadata.sweepPathMissing = true;
        flaggedLinear++;
        continue;
      }

      // Non-PATH_SWEEP with SWEEP method + no pathPoints: downgrade to EXTRUSION
      geom.method = 'EXTRUSION';
      delete geom.pathPoints;
      if (geom.profile?.type === 'CIRCLE' && geom.profile.radius) {
        const d = geom.profile.radius * 2;
        geom.profile = { type: 'RECTANGLE', width: d, height: d };
      }
      if (!elem.metadata) elem.metadata = {};
      elem.metadata.sweepDowngraded = true;
      downgraded++;
    }
    console.log(`guardInvalidSweeps: ${downgraded} downgraded, ${flaggedLinear} PATH_SWEEP flagged for path generation`);
  });

  // Step G2.8: Rule assertion pass — physical correctness gates
  // Runs after wall snapping (Phase 2) and MEP path routing (G1). Removes zero-height
  // and floating elements, warns on wall connection gaps and MEP zone containment.
  // Aborts pipeline with a structured error if > 20% of elements are removed.
  let topologyReport = null;
  timedStep('ruleAssertions', () => { topologyReport = runRuleAssertions(css, elementCountIn); });

  // Step G3: CSS validation
  let cssIssues;
  timedStep('validateCSSElements', () => { cssIssues = validateCSSElements(css); });

  // Step G4: Safety checks
  let safetyResult;
  timedStep('safetyChecks', () => {
    safetyResult = runSafetyChecks(css, cssIssues);
  });

  if (!css.metadata) css.metadata = {};
  css.metadata.cssValidationIssues = safetyResult.cssIssues.length;
  css.metadata.cssValidationDetails = safetyResult.cssIssues.length > 0 ? safetyResult.cssIssues.slice(0, 10) : undefined;
  css.metadata.safetyWarnings = safetyResult.safetyWarnings;
  css.metadata.modelExtent = safetyResult.modelExtent;

  // Step G5: Topology validation (uses topology by reference)
  timedStep('validateTopology', () => validateTopology(css));

  // ════════════════════════════════════════════════════════════════════════
  // PRE-GENERATE EXPORT VALIDATION — universal fail-fast gates
  // Strips elements that would produce broken IFC geometry. Applies to
  // all domains (tunnel, building, facility).
  // ════════════════════════════════════════════════════════════════════════

  timedStep('preGenerateExportValidation', () => {
    const finalKeys = new Set();
    for (const e of css.elements) {
      const k = e.element_key || e.id;
      if (k) finalKeys.add(k);
    }

    let strippedHostRef = 0;
    let strippedLinearPath = 0;
    let strippedDuplicateFloor = 0;
    let strippedBadPlacement = 0;
    let strippedReconcilerRejected = 0;
    const LINEAR_MEP_TYPES = new Set(['IfcPipeSegment', 'IfcDuctSegment', 'IfcCableCarrierSegment']);

    // Track floor slabs per container for duplicate detection
    const floorsByContainer = new Map();

    const keep = [];
    for (const elem of css.elements) {
      const type = (elem.type || '').toUpperCase();
      const st = elem.semanticType || '';
      const props = elem.properties || {};
      const meta = elem.metadata || {};
      const geom = elem.geometry || {};

      // ── Gate A-R: Reconciler-rejected doors — strip before generate ──
      // Evidence reconciliation (Step 4C-R) marked excess/weak candidates as
      // 'rejected'. They are preserved in css_structure.json for debugging but
      // must not appear in css_processed.json or the final IFC.
      if ((type === 'DOOR' || type === 'WINDOW') &&
          meta.reconciliationStatus === 'rejected') {
        strippedReconcilerRejected++;
        continue;
      }

      // ── Gate A: Host/container/relationship target validity ──
      // Elements with host refs that don't resolve → strip
      if (type === 'DOOR' || type === 'WINDOW') {
        const hostKey = meta.hostWallKey;
        if (hostKey && !finalKeys.has(hostKey)) {
          // Try canonical lineage fallback
          const fallback = css.elements.find(e =>
            (e.properties?.derivedFromBranch === hostKey || e.properties?.hostBranch === hostKey) &&
            ((e.type || '').toUpperCase() === 'WALL' || (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT')
          );
          if (fallback) {
            meta.hostWallKey = fallback.element_key || fallback.id;
            meta.hostWallResolved = 'pre_generate_lineage_fallback';
          } else {
            strippedHostRef++;
            continue;
          }
        }
      }

      // Relationship targets must resolve
      if (elem.relationships && Array.isArray(elem.relationships)) {
        const validRels = elem.relationships.filter(r => !r.target || finalKeys.has(r.target));
        if (validRels.length < elem.relationships.length) {
          elem.relationships = validRels;
        }
      }

      // ── Gate B: Linear path validity ──
      // Linear MEP with SWEEP but no pathPoints → flag as invalid, don't generate geometry
      // but keep the element so generator can decide (proxy or skip)
      if (LINEAR_MEP_TYPES.has(st)) {
        const method = geom.method || 'EXTRUSION';
        if (method === 'SWEEP') {
          const pp = geom.pathPoints;
          if (!Array.isArray(pp) || pp.length < 2) {
            if (!elem.metadata) elem.metadata = {};
            elem.metadata._invalidReason = 'sweep_missing_pathPoints';
            elem.metadata._geometryExportable = false;
            strippedLinearPath++; // count but don't strip
          }
        }
        if (method === 'EXTRUSION') {
          const depth = geom.depth || 0;
          if (depth <= 0) {
            if (!elem.metadata) elem.metadata = {};
            elem.metadata._invalidReason = 'zero_depth_extrusion';
            elem.metadata._geometryExportable = false;
            strippedLinearPath++;
          }
        }
      }

      // ── Gate C: Structural placement validity ──
      if (['WALL', 'SLAB', 'TUNNEL_SEGMENT', 'COLUMN', 'BEAM'].includes(type)) {
        const o = elem.placement?.origin;
        if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) {
          strippedBadPlacement++;
          continue;
        }
        const depth = geom.depth || 0;
        const w = geom.profile?.width || geom.profile?.radius || 0;
        if (depth <= 0 || w <= 0) {
          strippedBadPlacement++;
          continue;
        }
      }

      // ── Gate D: Duplicate coplanar floor detection ──
      if (type === 'SLAB' && (props.slabType === 'FLOOR' || !props.slabType)) {
        const container = elem.container || '_default';
        const z = Math.round((elem.placement?.origin?.z || 0) * 10) / 10; // 100mm band
        const floorKey = `${container}:${z}`;
        if (floorsByContainer.has(floorKey)) {
          strippedDuplicateFloor++;
          continue;
        }
        floorsByContainer.set(floorKey, elem.element_key || elem.id);
      }

      // ── Gate E: MEP/Equipment host validation (annotation-only) ──
      // Annotates elements with host validation status for generate lambda.
      // Does NOT strip — generate decides per output mode (HARD=suppress, SOFT=proxy).
      const geoBehavior = geom._geoBehavior || '';
      if (hasTunnelSegs && (geoBehavior === 'PATH_SWEEP' || type === 'EQUIPMENT')) {
        if (!geom._isTunnelShell) { // skip tunnel shell segments (they ARE hosts)
          const hostKey = meta.parentSegment || meta.hostSegmentId ||
                          props.hostStructuralBranchMatched || props.derivedFromBranch ||
                          props.hostBranch || '';
          const hasValidHost = hostKey && finalKeys.has(hostKey);

          if (!elem.metadata) elem.metadata = {};
          if (hasValidHost) {
            elem.metadata._hostValidation = 'VALID';
          } else {
            // Check distance to nearest valid host for WEAK_HOST classification
            const o = elem.placement?.origin;
            let nearestDist = Infinity;
            if (o) {
              for (const candidate of css.elements) {
                if (!candidate.geometry?._isTunnelShell) continue;
                const co = candidate.placement?.origin;
                if (!co) continue;
                // Constrained matching: same container check
                if (elem.container && candidate.container && elem.container !== candidate.container) continue;
                const dist = Math.sqrt(
                  ((o.x || 0) - (co.x || 0)) ** 2 +
                  ((o.y || 0) - (co.y || 0)) ** 2 +
                  ((o.z || 0) - (co.z || 0)) ** 2
                );
                if (dist < nearestDist) nearestDist = dist;
              }
            }
            // Host distance threshold: min(0.5m, 25% of profile max dimension)
            const profMaxDim = Math.max(
              geom.profile?.width || 0, geom.profile?.height || 0,
              (geom.profile?.radius || 0) * 2, 0.5
            );
            const threshold = Math.min(0.5, profMaxDim * 0.25);
            if (nearestDist <= threshold * 10) { // within 10x threshold = weak but usable
              elem.metadata._hostValidation = 'WEAK_HOST';
            } else {
              elem.metadata._hostValidation = 'NO_HOST';
            }
          }

          // Set severity based on output mode
          const outputMode = (css.metadata?.outputMode || 'HYBRID').toUpperCase();
          elem.metadata._hostFailureSeverity =
            (outputMode === 'FULL_AUTHORING' || outputMode === 'COORDINATION') ? 'HARD' : 'SOFT';
        }
      }

      keep.push(elem);
    }

    css.elements = keep;

    const totalStripped = strippedHostRef + strippedLinearPath + strippedDuplicateFloor + strippedBadPlacement + strippedReconcilerRejected;
    if (totalStripped > 0) {
      console.log(
        `preGenerateExportValidation: stripped ${totalStripped} elements ` +
        `(reconcilerRejected=${strippedReconcilerRejected}, hostRef=${strippedHostRef}, ` +
        `linearPath=${strippedLinearPath}, duplicateFloor=${strippedDuplicateFloor}, badPlacement=${strippedBadPlacement})`
      );
    } else {
      console.log('preGenerateExportValidation: all elements passed');
    }

    if (!css.metadata) css.metadata = {};
    css.metadata.preGenerateValidation = {
      strippedReconcilerRejected, strippedHostRef, strippedLinearPath,
      strippedDuplicateFloor, strippedBadPlacement, totalStripped
    };
  });

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 6C: CONNECTIVITY GAP DIAGNOSTICS + REPORT-DRIVEN FIXES
  //
  // Two-pass model:
  //   1. Build the gap report (initial) so fixes have a deterministic,
  //      audited input list.
  //   2. Apply Fix 1 (shell snap+bridges), Fix 2 (vent class+stitch), and
  //      Fix 4 (portal door diagnostics, no element creation).
  //   3. Re-synthesise duct fittings against the now-corrected duct paths.
  //   4. Re-build the gap report — this is the version written to S3.
  // ════════════════════════════════════════════════════════════════════════

  let connectivityGapReport = null;
  let connectivityGapReportInitial = null;
  let connectivityFixActions = null;

  timedStep('buildConnectivityGapReport_initial', () => {
    connectivityGapReportInitial = buildConnectivityGapReport(
      css, spaceReport, doorPlan, wallReconReport
    );
  });
  if (connectivityGapReportInitial) {
    const f = connectivityGapReportInitial.findings || {};
    console.log(`ConnectivityGapReport[initial]: shell_gaps=${f.shell_gaps} ` +
                `rooms_disconnected=${f.rooms_disconnected} ` +
                `incomplete_closure=${f.rooms_incomplete_closure} ` +
                `door_flags=${f.door_flags} ` +
                `vent_missing_fittings=${f.ventilation_missing_fittings} ` +
                `vent_floating=${f.ventilation_floating} ` +
                `vent_wrong_class=${f.ventilation_wrong_class} ` +
                `equipment_missing=${f.equipment_missing} ` +
                `portal_elev_mismatch=${f.portal_elevation_mismatch}`);
  }

  // Fix 1: shell connectivity (snap < 1m, bridge 1–6m).
  timedStep('applyShellConnectivityFixes', () => {
    const out = applyShellConnectivityFixes(css, connectivityGapReportInitial);
    connectivityFixActions = { ...(connectivityFixActions || {}), shell: out };
    console.log(`[6C] shell_fixes snapped=${out.snapped.length} bridged=${out.bridged.length} skipped=${out.skipped.length}`);
  });

  // Fix 2: ventilation class correction + endpoint stitching.
  timedStep('applyVentilationFixes', () => {
    const out = applyVentilationFixes(css, connectivityGapReportInitial);
    connectivityFixActions = { ...(connectivityFixActions || {}), ventilation: out };
    console.log(`[6C] vent_fixes classCorrected=${out.classCorrected.length} stitched=${out.stitched.length}`);
  });

  // Re-synthesise duct fittings: the stitching may have created/changed
  // junction nodes. synthesizeDuctFittings is idempotent on the network.
  if (hasTunnelSegs) {
    timedStep('synthesizeDuctFittings_post6C', () => synthesizeDuctFittings(css));
  }

  // Fix 4: portal door candidate diagnostic (no creation, just logging).
  timedStep('addPortalDoorDiagnostics', () => {
    const out = addPortalDoorDiagnostics(css, connectivityGapReportInitial, spaceReport);
    connectivityFixActions = { ...(connectivityFixActions || {}), portalDoors: out };
  });

  // Final report — reflects post-fix state. This is the artefact written to S3.
  timedStep('buildConnectivityGapReport_final', () => {
    connectivityGapReport = buildConnectivityGapReport(
      css, spaceReport, doorPlan, wallReconReport
    );
    if (connectivityGapReport) {
      connectivityGapReport.fixActionsAppliedThisRun = connectivityFixActions;
      connectivityGapReport.initialFindings = connectivityGapReportInitial?.findings || null;
    }
  });
  if (connectivityGapReport) {
    const f = connectivityGapReport.findings || {};
    console.log(`ConnectivityGapReport[final]: shell_gaps=${f.shell_gaps} ` +
                `vent_floating=${f.ventilation_floating} ` +
                `vent_wrong_class=${f.ventilation_wrong_class} ` +
                `portal_elev_mismatch=${f.portal_elevation_mismatch}`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // UNIVERSAL METADATA — Z convention, export profile
  // ════════════════════════════════════════════════════════════════════════

  if (!css.metadata) css.metadata = {};

  // Step 4: Z convention dual tracking — store both source and normalized conventions
  // so generate lambda can skip its heuristic, and logs can reference source for debugging.
  css.metadata.zConvention = {
    source: hasTunnelSegs ? 'MINE_ABSOLUTE' : 'MIXED',
    normalized: 'STOREY_RELATIVE',
    origin: 'topology_engine'
  };

  // Step 5: Export profile — informs generator's IFC representation choices.
  // Default to WEB_VIEWER; can be overridden by upstream metadata.
  css.metadata.exportProfile = css.metadata.exportProfile || 'WEB_VIEWER';

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 4: V2 ADAPTER BOUNDARY
  // Build resolved.json from the in-memory CSS (topology included).
  // ════════════════════════════════════════════════════════════════════════

  console.log('Adapter phase — building v2 artifacts from in-memory graph');

  // Inferred.json (v2 dual-write)
  // Phase 6 — preserve featureFlags through the v2 round-trip. cssToResolved
  // restructures top-level metadata (only the fields it lists), so re-stamp
  // the flag onto legacyCss after resolvedToLegacyCss() — generate reads
  // legacyCss (css_processed.json) and needs intentMode to know whether to
  // run intent-driven door placement or the legacy heuristics.
  const _featureFlagsForRoundTrip = css.metadata?.featureFlags || {};
  const inferred = cssToInferred(css);

  // Resolved.json (canonical v2 artifact)
  const resolved = cssToResolved(css);

  // Legacy CSS (for Generate)
  const legacyCss = resolvedToLegacyCss(resolved);
  // Re-stamp featureFlags (cssToResolved drops fields it doesn't enumerate).
  if (!legacyCss.metadata) legacyCss.metadata = {};
  legacyCss.metadata.featureFlags = _featureFlagsForRoundTrip;
  // Phase 6B — re-stamp wallReconstruction so the Python generate lambda can
  // emit IfcWallStandardCase from the plan. The v2 adapter strips unknown
  // metadata keys.
  if (css.metadata?.wallReconstruction) {
    legacyCss.metadata.wallReconstruction = css.metadata.wallReconstruction;
  }
  // Re-stamp specInstances so the Python generate lambda can emit the
  // deterministic spec-text instance set (62 walls, 5 slabs, 9 coverings,
  // 27 ducts, 27 fittings, 5 doors, 4 equipment, 5 systems, 81 path
  // connections, 122 ports) with correct material layers, hollow profiles,
  // door lining/panel properties, etc. The v2 adapter strips this otherwise.
  if (css.metadata?.specInstances) {
    legacyCss.metadata.specInstances = css.metadata.specInstances;
  }

  // Relationship property integrity check
  const anglesBefore = css.elements
    .flatMap(e => e.relationships || [])
    .filter(r => r.connectionAngle !== null && r.connectionAngle !== undefined).length;
  const anglesAfter = legacyCss.elements
    .flatMap(e => e.relationships || [])
    .filter(r => r.connectionAngle !== null && r.connectionAngle !== undefined).length;
  if (anglesBefore !== anglesAfter) {
    console.warn(`RELATIONSHIP_PROP_LOSS: anglesBefore=${anglesBefore} anglesAfter=${anglesAfter} lost=${anglesBefore - anglesAfter}`);
  }

  // Round-trip fidelity check — compare element_key (the canonical user-facing ID)
  // since the adapter normalizes internal elem-* IDs back to element_key in output.
  const mismatches = [];
  for (let i = 0; i < css.elements.length; i++) {
    const orig = css.elements[i];
    const rt = legacyCss.elements[i];
    if (!rt) { mismatches.push({ index: i, id: orig.id, issue: 'missing in round-trip' }); continue; }
    const origKey = orig.element_key || orig.id;
    const rtKey = rt.element_key || rt.id;
    if (origKey !== rtKey) mismatches.push({ id: orig.id, field: 'element_key', expected: origKey, got: rtKey });
    if (orig.type !== rt.type) mismatches.push({ id: orig.id, field: 'type', expected: orig.type, got: rt.type });
    if (orig.confidence !== rt.confidence) mismatches.push({ id: orig.id, field: 'confidence', expected: orig.confidence, got: rt.confidence });
    if (orig.geometry?.method !== rt.geometry?.method) mismatches.push({ id: orig.id, field: 'geometry.method', expected: orig.geometry?.method, got: rt.geometry?.method });
    if (orig.geometry?.depth !== rt.geometry?.depth) mismatches.push({ id: orig.id, field: 'geometry.depth', expected: orig.geometry?.depth, got: rt.geometry?.depth });
    if (JSON.stringify(orig.placement?.origin) !== JSON.stringify(rt.placement?.origin)) mismatches.push({ id: orig.id, field: 'placement.origin' });
    if (orig.container !== rt.container) mismatches.push({ id: orig.id, field: 'container', expected: orig.container, got: rt.container });
  }
  if (legacyCss.elements.length !== css.elements.length) {
    mismatches.push({ issue: 'element_count_mismatch', expected: css.elements.length, got: legacyCss.elements.length });
  }
  if (mismatches.length > 0) {
    console.warn(`Round-trip fidelity: ${mismatches.length} mismatches found`);
    console.warn(`Mismatches (first 10): ${JSON.stringify(mismatches.slice(0, 10))}`);
  } else {
    console.log('Round-trip fidelity: PASS — 0 mismatches');
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 5: MODEL VALIDATION (formerly builting-validate)
  // Runs in the same memory context — no S3 read needed.
  // ════════════════════════════════════════════════════════════════════════

  console.log('Validation phase — running all 4 validators in-memory');

  const { report: validationReport, readiness, semantic: semResult, geometric: geomResult } = runFullValidation(resolved);

  // Compute readiness delta if previous report exists
  let readinessDelta = null;
  if (revision > 1 && previousValidationReportS3Key) {
    try {
      const prevResponse = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: previousValidationReportS3Key
      }));
      const prevReport = JSON.parse(await prevResponse.Body.transformToString());
      const prevScore = prevReport.readiness?.score ?? null;
      const prevIssueCount = prevReport.summary?.totalIssues ?? null;
      const prevAuthoringSuitability = prevReport.readiness?.authoringSuitability ?? null;

      if (prevScore !== null) {
        readinessDelta = {
          previousScore: prevScore,
          currentScore: readiness.score,
          delta: readiness.score - prevScore,
          previousIssueCount: prevIssueCount,
          currentIssueCount: validationReport.summary.totalIssues,
          issueDelta: prevIssueCount !== null ? validationReport.summary.totalIssues - prevIssueCount : null,
          previousAuthoringSuitability: prevAuthoringSuitability,
          currentAuthoringSuitability: readiness.authoringSuitability,
          improved: readiness.score > prevScore
        };
        console.log(`Readiness delta: ${prevScore} → ${readiness.score} (${readinessDelta.delta >= 0 ? '+' : ''}${readinessDelta.delta})`);
      }
    } catch (deltaErr) {
      console.warn('Could not compute readiness delta (non-fatal):', deltaErr.message);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PR 8: TOPOLOGY VALIDATORS
  // Runs after all processing and BEFORE S3 writes so _validationWarnings
  // annotations land in legacyCss.elements (→ css_processed.json → generate).
  // All severity: 'warning' — no halts.
  // ════════════════════════════════════════════════════════════════════════

  let _topoValSummary = { total: 0, passed: 0, warned: 0, failed: 0 };
  try {
    const _vr = runTopologyValidators(legacyCss.elements, legacyCss);
    for (const entry of _vr.entries) logValidation(entry);
    _topoValSummary = { total: _vr.total, passed: _vr.passed, warned: _vr.warned, failed: _vr.failed };
    // Mirror annotations to css_structure.json (debug visibility)
    if (_vr.entries.length > 0) {
      const _cssById = new Map(css.elements.map(e => [e.element_key || e.id, e]));
      for (const entry of _vr.entries) {
        const e = _cssById.get(entry.element_id);
        if (e) {
          if (!e.metadata) e.metadata = {};
          const w = e.metadata._validationWarnings = e.metadata._validationWarnings || [];
          if (!w.includes(entry.validator)) w.push(entry.validator);
        }
      }
    }
  } catch (ve) { console.warn('[validators:topology] Non-fatal:', ve.message); }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 6: WRITE ALL ARTIFACTS TO S3
  // ════════════════════════════════════════════════════════════════════════

  const totalDurationMs = Date.now() - startTime;
  const finalTrace = buildTypeHistogram(css.elements);

  console.log(`TopologyEngine pipeline complete in ${totalDurationMs}ms — writing artifacts to S3`);
  console.log(`Final type histogram: ${JSON.stringify(finalTrace)}`);

  // 1. css_structure.json (intermediate, for debugging)
  const structureKey = `uploads/${userId}/${renderId}/css/css_structure.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: structureKey,
    Body: JSON.stringify(css), ContentType: 'application/json'
  }));

  // 2. css_processed.json (for Generate)
  const processedKey = `uploads/${userId}/${renderId}/css/css_processed.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: processedKey,
    Body: JSON.stringify(legacyCss), ContentType: 'application/json'
  }));

  // Producer self-check: css_processed (halting — generate reads this).
  await checkContractAsync('validatedCssContract', validatedCssContract, legacyCss, {
    halting: true,
    renderId,
    stage: 'topology',
    quarantineWriter: async (artifact, errors) => {
      const runId = Date.now();
      const qKey = `uploads/${userId}/${renderId}/quarantine/topology/${runId}/artifact.json`;
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: qKey,
        Body: JSON.stringify({
          quarantinedAt: new Date().toISOString(),
          stage: 'topology',
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
      console.warn(`[contract_quarantine] artifact written: s3://${bucket}/${qKey}`);
    },
  });

  // 3. inferred.json (v2)
  const inferredKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/inferred.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: inferredKey,
    Body: JSON.stringify(inferred), ContentType: 'application/json'
  }));

  // 4. resolved.json (v2 canonical)
  const resolvedKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/resolved.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: resolvedKey,
    Body: JSON.stringify(resolved), ContentType: 'application/json'
  }));

  // 5. validation_report.json
  const validationReportKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/validation_report.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: validationReportKey,
    Body: JSON.stringify(validationReport), ContentType: 'application/json'
  }));

  // 6. Topology engine report (unified debug artifact)
  const engineReportKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/topology_engine_report.json`;
  const engineReport = {
    pipelineVersion: '3.0',
    stage: 'topology_engine',
    generatedAt: new Date().toISOString(),
    durationMs: totalDurationMs,
    domain: css.domain || 'UNKNOWN',
    elementCountIn,
    elementCountOut: css.elements.length,
    finalTypeHistogram: finalTrace,
    stepTimings,
    ambiguousWallProfiles: ambiguousProfileCount,
    cssValidation: {
      valid: validationResult.valid,
      errorCount: validationResult.errors.length,
      warningCount: validationResult.warnings.length
    },
    cssValidationIssueCount: safetyResult.cssIssues.length,
    safetyWarningCount: safetyResult.safetyWarnings.length,
    modelValidation: {
      readinessScore: readiness.score,
      exportReadiness: readiness.exportReadiness,
      authoringSuitability: readiness.authoringSuitability,
      generationMode: readiness.generationModeRecommendation,
      errorCount: validationReport.summary.errorCount,
      warningCount: validationReport.summary.warningCount,
      proxyRatio: semResult.summary.proxyRatio,
      geometryFidelity: geomResult.summary.geometryFidelity || null,
    },
    roundTripFidelity: {
      mismatches: mismatches.length,
      pass: mismatches.length === 0
    }
  };
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: engineReportKey,
    Body: JSON.stringify(engineReport), ContentType: 'application/json'
  }));

  // 7. Issue report (combined — compatible with existing expectations)
  const issueReportKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/issue_report.json`;
  const issueReport = {
    pipelineVersion: '3.0',
    stage: 'topology_engine',
    generatedAt: new Date().toISOString(),
    validation: {
      valid: validationResult.valid,
      errorCount: validationResult.errors.length,
      warningCount: validationResult.warnings.length
    },
    cssValidationIssues: safetyResult.cssIssues.slice(0, 20),
    safetyWarnings: safetyResult.safetyWarnings,
    repairCount: css.metadata?.repairLog?.length || 0
  };
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: issueReportKey,
    Body: JSON.stringify(issueReport), ContentType: 'application/json'
  }));

  // 7B. Engineer-intent report (Phase 6 — see PLAN.md). Always written when
  // resolver is enabled (mode != 'off'); structure documented in
  // intent-resolver.mjs. 6A uses this for diff against legacy inferOpenings.
  if (intentReport) {
    const intentReportKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/engineer_intent_report.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: intentReportKey,
      Body: JSON.stringify(intentReport), ContentType: 'application/json'
    }));
  }

  // 7C. Evidence reconciliation report — always written when the reconciler ran.
  // Contains raw_door_candidates, accepted_doors, rejected_duplicate_or_symbolic_doors,
  // expected_count, count_match.  Written from the pre-strip snapshot on css_structure.json
  // so rejected candidates are visible even though css_processed.json excludes them.
  if (css.metadata?.evidenceReconciliation) {
    const reconKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/evidence_reconciliation_report.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: reconKey,
      Body: JSON.stringify(css.metadata.evidenceReconciliation), ContentType: 'application/json'
    }));
  }

  // 7C-Phase10. Coordinate-frame report — produced by Phase 10
  // (applyCoordinateNormalization).  Captures bbox + centroid per source
  // frame, transforms applied, and Phase 10 success gates.  Useful for
  // debugging cross-source coordinate mismatches.
  if (css.metadata?.coordinateNormalization) {
    const coordKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/coordinate_frame_report.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: coordKey,
      Body: JSON.stringify(css.metadata.coordinateNormalization),
      ContentType: 'application/json',
    }));
    console.log(`Coordinate frame report: s3://${bucket}/${coordKey}`);
  }

  // 7D. Phase 6A.5 — Space classification + semantic door plan (planning-only).
  if (spaceReport) {
    const spaceKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/space_classification_report.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: spaceKey,
      Body: JSON.stringify(spaceReport), ContentType: 'application/json'
    }));
    console.log(`Space classification report: s3://${bucket}/${spaceKey}`);
  }
  if (doorPlan) {
    const planKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/semantic_door_plan.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: planKey,
      Body: JSON.stringify(doorPlan), ContentType: 'application/json'
    }));
    console.log(`Semantic door plan: s3://${bucket}/${planKey}`);
  }

  // 7E. Phase 6B — Wall reconstruction plan.
  if (wallReconReport) {
    const wallKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/wall_reconstruction_report.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: wallKey,
      Body: JSON.stringify(wallReconReport), ContentType: 'application/json'
    }));
    console.log(`Wall reconstruction report: s3://${bucket}/${wallKey}`);
  }

  // 7F. Phase 6C — Connectivity gap report (diagnostics).
  if (connectivityGapReport) {
    const gapKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/connectivity_gap_report.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: gapKey,
      Body: JSON.stringify(connectivityGapReport), ContentType: 'application/json'
    }));
    console.log(`Connectivity gap report: s3://${bucket}/${gapKey}`);
  }

  // 8. Transform debug (compatible with existing expectations)
  const debugKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/transform_debug.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: debugKey,
    Body: JSON.stringify({
      pipelineVersion: '3.0',
      stage: 'topology_engine',
      generatedAt: new Date().toISOString(),
      durationMs: totalDurationMs,
      domain: css.domain || 'UNKNOWN',
      elementCountOut: css.elements.length,
      stepTimings,
      cssSnapshotKey: processedKey
    }),
    ContentType: 'application/json'
  }));

  console.log(`TopologyEngine complete: ${totalDurationMs}ms, ${css.elements.length} elements, score=${readiness.score}, export=${readiness.exportReadiness}`);

  // Phase 13 PR2: Trace end (Release 13.2: + scalars)
  try { await flushAudit(); } catch (ae) { console.warn('[audit:flush_failed]', ae.message); }
  if (_traceKey) {
    try {
      const typeHistogram = buildTypeHistogram(css.elements);

      // gatePassRate: 6 discrete gates from rule assertions + CSS validation + export readiness
      const _topoGates = [
        (topologyReport?.checks?.zero_height?.removed_count ?? 0) === 0,
        (topologyReport?.checks?.floating?.removed_count ?? 0) === 0,
        (topologyReport?.checks?.connection_gaps?.warning_count ?? 0) === 0,
        (topologyReport?.checks?.mep_containment?.warning_count ?? 0) === 0,
        validationResult?.valid === true,
        readiness?.exportReadiness === 'READY',
      ];
      const _topoPassed = _topoGates.filter(Boolean).length;
      const _topoGateRate = Math.round(100 * _topoPassed / _topoGates.length);

      // provenanceCompleteness: elements with non-missing provenance
      const _topoElems = css.elements || [];
      let _topoProvPct = null;
      if (_topoElems.length > 0) {
        const _attributed = _topoElems.filter(
          e => e.provenance?.sourceFileStatus && e.provenance.sourceFileStatus !== 'missing'
        ).length;
        _topoProvPct = Math.round(100 * _attributed / _topoElems.length);
      }

      await writeTraceEnd({
        traceKey: _traceKey, stage: 'topology', runId: _traceRunId, attemptN: _traceAttemptN,
        startedAt: _traceStartedAt, finishedAt: new Date().toISOString(),
        outputArtifactKey: processedKey,
        counts: { elements: css.elements.length, byType: typeHistogram },
        validationFlags: validationResult.errors.slice(0, 10).map(e => e.message || String(e)),
        scalars: {
          gatePassRate: _topoGateRate,
          contractStatus: 'pass',
          provenanceCompleteness: _topoProvPct,
          validationSummary: _topoValSummary,
        },
      });
    } catch (te) { console.warn('[trace] end write failed (non-fatal):', te.message); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // RETURN — combined output for Step Function
  // ════════════════════════════════════════════════════════════════════════

  return {
    // Geometry output (for Generate)
    cssS3Key: processedKey,
    resolvedS3Key: resolvedKey,

    // Validation output (for Store)
    validationReportS3Key: validationReportKey,
    readinessScore: readiness.score,
    exportReadiness: readiness.exportReadiness,
    authoringSuitability: readiness.authoringSuitability,
    criticalIssueCount: validationReport.summary.errorCount,
    warningCount: validationReport.summary.warningCount,
    proxyRatio: semResult.summary.proxyRatio,
    generationModeRecommendation: readiness.generationModeRecommendation,
    readinessDelta,
    geometryFidelity: geomResult.summary.geometryFidelity || null,

    // Structure output (for observability)
    inferredS3Key: inferredKey,
    elementCount: css.elements.length,
    domain: css.domain || 'UNKNOWN',
    validationResult: {
      valid: validationResult.valid,
      errorCount: validationResult.errors.length,
      warningCount: validationResult.warnings.length,
      errors: validationResult.errors.slice(0, 20),
      warnings: validationResult.warnings.slice(0, 20)
    },

    // Rule assertion findings (new top-level key — no existing schema changes)
    topology_report: topologyReport
  };
};
