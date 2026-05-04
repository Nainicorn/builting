/**
 * connectivity-fixes.mjs — Phase 6C report-driven fixes.
 *
 * Strictly consumes the connectivity_gap_report.json. Every action here is
 * traceable to a specific report entry and emits a structured `[6C]` log line
 * so reviewers can map an output IFC artefact back to the report row that
 * triggered it.
 *
 *   Fix 1 — Shell connectivity
 *     • For each A_shellConnectivity.pairs row with status='gap':
 *         gap_distance ≤ SNAP_LIMIT_M (1.0)  → snap both segment endpoints
 *         SNAP_LIMIT_M < gap ≤ BRIDGE_LIMIT  → emit synthetic bridge segment
 *
 *   Fix 2 — Ventilation
 *     • Convert EXTRUSION linear MEP → SWEEP with pathPoints
 *     • Stitch floating endpoints (status='floating') with peer within
 *       STITCH_LIMIT_M (2.0) by snapping both endpoints to midpoint
 *
 *   Fix 4 — Portal door diagnostic (no element creation)
 *     • For each main portal end wall, search raw door candidates within 5 m
 *       and record nearest candidate / not-found into
 *       css.metadata.portalDoorDiagnostic.
 *
 * Run AFTER buildConnectivityGapReport (initial), BEFORE the final report.
 *
 * Returns { actions, summary } describing what was done.
 */

import { shellThicknessFromProfile } from './shared.mjs';

const SNAP_LIMIT_M    = 1.0;   // gap_distance ≤ this → snap endpoints
const BRIDGE_LIMIT_M  = 6.0;   // gap_distance ≤ this AND > SNAP_LIMIT_M → bridge
const STITCH_LIMIT_M  = 2.0;   // duct floating peer within this → snap
const PORTAL_DOOR_RADIUS_M = 5.0;

// ── helpers ──────────────────────────────────────────────────────────────────

function dist3(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function vecAdd(a, b)   { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function vecScale(v, s) { return { x: v.x * s, y: v.y * s, z: v.z * s }; }

function getSegmentEndpoints(elem) {
  const props = elem.properties || {};
  const s = props.startPoint;
  const e = props.endPoint;
  if (s && e && Number.isFinite(s.x) && Number.isFinite(e.x)) {
    return {
      s: { x: +s.x, y: +s.y, z: Number.isFinite(+s.z) ? +s.z : 0 },
      e: { x: +e.x, y: +e.y, z: Number.isFinite(+e.z) ? +e.z : 0 }
    };
  }
  const o = (elem.placement || {}).origin;
  const ax = (elem.placement || {}).axis;
  const depth = (elem.geometry || {}).depth;
  if (!o || !ax || !depth) return null;
  const half = depth / 2;
  return {
    s: { x: o.x - ax.x * half, y: o.y - ax.y * half, z: o.z - ax.z * half },
    e: { x: o.x + ax.x * half, y: o.y + ax.y * half, z: o.z + ax.z * half }
  };
}

// Move both endpoints (and the host placement) of a TUNNEL_SEGMENT so that
// `whichEnd` (start | end) lands at `target`. Updates origin, depth (if path
// changes length), startPoint/endPoint, and pathPoints.
function snapSegmentEnd(elem, whichEnd, target) {
  const ep = getSegmentEndpoints(elem);
  if (!ep) return false;

  const oldEnd   = whichEnd === 'start' ? ep.s : ep.e;
  const otherEnd = whichEnd === 'start' ? ep.e : ep.s;
  const dx = (target.x - oldEnd.x);
  const dy = (target.y - oldEnd.y);
  const dz = (target.z - oldEnd.z);
  if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 1e-6) return false;

  // Recompute new origin = midpoint of new ends; depth = distance.
  const newStart = whichEnd === 'start' ? target : ep.s;
  const newEnd   = whichEnd === 'end'   ? target : ep.e;

  if (!elem.placement) elem.placement = {};
  elem.placement.origin = {
    x: (newStart.x + newEnd.x) / 2,
    y: (newStart.y + newEnd.y) / 2,
    z: (newStart.z + newEnd.z) / 2
  };
  const newDepth = Math.sqrt(
    (newEnd.x - newStart.x) ** 2 +
    (newEnd.y - newStart.y) ** 2 +
    (newEnd.z - newStart.z) ** 2
  );
  if (!elem.geometry) elem.geometry = {};
  elem.geometry.depth = newDepth;

  // refDirection along new bearing (XY component) for tunnel placement convention.
  const horiz = Math.sqrt((newEnd.x - newStart.x) ** 2 + (newEnd.y - newStart.y) ** 2);
  if (horiz > 1e-6) {
    elem.placement.refDirection = {
      x: (newEnd.x - newStart.x) / horiz,
      y: (newEnd.y - newStart.y) / horiz,
      z: 0
    };
  }

  if (!elem.properties) elem.properties = {};
  elem.properties.startPoint = { ...newStart };
  elem.properties.endPoint   = { ...newEnd   };
  if (Array.isArray(elem.geometry.pathPoints) && elem.geometry.pathPoints.length >= 2) {
    elem.geometry.pathPoints = [{ ...newStart }, { ...newEnd }];
  }
  if (Array.isArray(elem.geometry.path) && elem.geometry.path.length >= 2) {
    elem.geometry.path = [{ ...newStart }, { ...newEnd }];
  }
  return true;
}

// ── Fix 1 — shell connectivity ───────────────────────────────────────────────

export function applyShellConnectivityFixes(css, gapReport) {
  const actions = { snapped: [], bridged: [], skipped: [] };
  if (!gapReport || !gapReport.A_shellConnectivity) return actions;

  const elementsByKey = new Map();
  for (const e of (css.elements || [])) {
    const k = e.element_key || e.id;
    if (k) elementsByKey.set(k, e);
  }

  const newBridges = [];
  const seenBridgePairs = new Set();   // dedup symmetric pairs

  for (const pair of (gapReport.A_shellConnectivity.pairs || [])) {
    if (pair.status !== 'gap' && pair.status !== 'elevation_mismatch') continue;
    const gap = pair.gap_distance;
    if (!Number.isFinite(gap) || gap <= 0) continue;
    if (gap > BRIDGE_LIMIT_M) {
      actions.skipped.push({
        kind: 'gap_exceeds_bridge_limit',
        a: pair.segment_a, b: pair.segment_b,
        gap, limit: BRIDGE_LIMIT_M
      });
      continue;
    }

    const segA = elementsByKey.get(pair.segment_a);
    const segB = elementsByKey.get(pair.segment_b);
    if (!segA || !segB) {
      actions.skipped.push({
        kind: 'segment_missing',
        a: pair.segment_a, b: pair.segment_b
      });
      continue;
    }

    // The report stored which end of each segment is closest (endA/endB).
    const epA = getSegmentEndpoints(segA);
    const epB = getSegmentEndpoints(segB);
    if (!epA || !epB) continue;

    const ptA = pair.endA === 'start' ? epA.s : epA.e;
    const ptB = pair.endB === 'start' ? epB.s : epB.e;
    const mid = {
      x: (ptA.x + ptB.x) / 2,
      y: (ptA.y + ptB.y) / 2,
      z: (ptA.z + ptB.z) / 2
    };

    if (gap <= SNAP_LIMIT_M) {
      const movedA = snapSegmentEnd(segA, pair.endA, mid);
      const movedB = snapSegmentEnd(segB, pair.endB, mid);
      if (movedA || movedB) {
        actions.snapped.push({
          a: pair.segment_a, b: pair.segment_b,
          gap, from: { a: ptA, b: ptB }, to: mid
        });
        console.log(`[6C] gap_snapped a=${pair.segment_a} b=${pair.segment_b} gap=${gap.toFixed(3)}m`);
      }
    } else {
      // Bridge: synthesize a connector tunnel segment between ptA and ptB.
      const sortedKeys = [pair.segment_a, pair.segment_b].sort();
      const bridgeKey = `synthetic-bridge-${sortedKeys[0]}_${sortedKeys[1]}`;
      if (seenBridgePairs.has(bridgeKey)) continue;
      seenBridgePairs.add(bridgeKey);

      // Inherit the smaller-area profile to match the bore geometry.
      const profA = (segA.geometry && segA.geometry.profile) || {};
      const profB = (segB.geometry && segB.geometry.profile) || {};
      const areaOf = p => (p.type === 'CIRCLE')
        ? Math.PI * (p.radius || 0) ** 2
        : (p.width || 0) * (p.height || 0);
      const profile = areaOf(profA) <= areaOf(profB)
        ? { ...profA }
        : { ...profB };
      if (profile.type === 'CIRCLE' && !profile.radius) profile.radius = 2.0;
      else if (profile.type !== 'CIRCLE') {
        if (!profile.width)  profile.width  = 2.0;
        if (!profile.height) profile.height = profile.width;
      }
      const wallThickness = profile.wallThickness ??
        shellThicknessFromProfile({ geometry: { profile }, properties: {} }, null);

      const dx = ptB.x - ptA.x, dy = ptB.y - ptA.y, dz = ptB.z - ptA.z;
      const horiz = Math.sqrt(dx * dx + dy * dy);
      const refDir = horiz > 1e-6
        ? { x: dx / horiz, y: dy / horiz, z: 0 }
        : { x: 1, y: 0, z: 0 };
      const direction = {
        x: dx / gap, y: dy / gap, z: dz / gap
      };

      const bridge = {
        id: bridgeKey,
        element_key: bridgeKey,
        canonical_id: bridgeKey,
        type: 'TUNNEL_SEGMENT',
        semanticType: 'IfcBuildingElementProxy',
        name: `Synthetic Bridge (${pair.segment_a}↔${pair.segment_b})`,
        placement: {
          origin: { x: (ptA.x + ptB.x) / 2, y: (ptA.y + ptB.y) / 2, z: (ptA.z + ptB.z) / 2 },
          axis:   { x: 0, y: 0, z: 1 },
          refDirection: refDir
        },
        geometry: {
          method: Math.abs(dz) > 0.3 ? 'SWEEP' : 'EXTRUSION',
          _geoBehavior: Math.abs(dz) > 0.3 ? 'PATH_SWEEP' : undefined,
          profile: { ...profile, wallThickness },
          depth: gap,
          direction,
          pathPoints: [{ ...ptA }, { ...ptB }],
          path:       [{ ...ptA }, { ...ptB }]
        },
        container:
          segA.container || segB.container || (
            (css.levelsOrSegments && css.levelsOrSegments[0] && css.levelsOrSegments[0].id) ||
            'seg-tunnel-main'
          ),
        relationships: [],
        properties: {
          branchClass:         'STRUCTURAL',
          shellThickness_m:    wallThickness,
          shellMode:           segA.properties?.shellMode || segB.properties?.shellMode || 'HOLLOW_PROFILE',
          decompositionMethod: 'SHELL_GAP_BRIDGE',
          synthetic_bridge:    true,
          bridgeFromSegment:   pair.segment_a,
          bridgeToSegment:     pair.segment_b,
          startPoint: { ...ptA },
          endPoint:   { ...ptB }
        },
        material: segA.material
          ? { ...segA.material }
          : (segB.material ? { ...segB.material } : { name: 'concrete' }),
        confidence: 0.6,
        source:     'CONNECTIVITY_FIX_V6C',
        sourceFile: null,
        metadata: {
          synthetic_bridge:   true,
          gapMm:              Math.round(gap * 1000),
          fromSegmentEnd:     pair.endA,
          toSegmentEnd:       pair.endB,
          reportPair:         { a: pair.segment_a, b: pair.segment_b },
          geometryExportable: true
        }
      };
      newBridges.push(bridge);
      actions.bridged.push({
        id: bridgeKey, a: pair.segment_a, b: pair.segment_b, gap,
        from: ptA, to: ptB
      });
      console.log(`[6C] bridge_created id=${bridgeKey} from=${pair.segment_a} to=${pair.segment_b} length=${gap.toFixed(3)}m`);
    }
  }

  if (newBridges.length > 0) {
    css.elements.push(...newBridges);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.shellConnectivityFixes = {
    snapped: actions.snapped.length,
    bridged: actions.bridged.length,
    skipped: actions.skipped.length
  };

  return actions;
}

// ── Fix 2 — ventilation connectivity + class correction ─────────────────────

const LINEAR_MEP_TYPES = new Set(['DUCT', 'PIPE']);
const LINEAR_MEP_SEMANTICS = new Set([
  'IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment'
]);

function isLinearMEP(elem) {
  const t = (elem.type || '').toUpperCase();
  const st = elem.semanticType || '';
  return LINEAR_MEP_TYPES.has(t) || LINEAR_MEP_SEMANTICS.has(st);
}

function getDuctEndpoint(elem, isEntry) {
  const pp = elem.geometry?.pathPoints;
  if (Array.isArray(pp) && pp.length >= 2) {
    return isEntry ? { ...pp[0] } : { ...pp[pp.length - 1] };
  }
  const o = elem.placement?.origin || { x: 0, y: 0, z: 0 };
  const ax = elem.placement?.refDirection || elem.placement?.axis || { x: 1, y: 0, z: 0 };
  const d = elem.geometry?.depth || 0;
  const half = d / 2;
  return isEntry
    ? { x: o.x - ax.x * half, y: o.y - ax.y * half, z: o.z - ax.z * half }
    : { x: o.x + ax.x * half, y: o.y + ax.y * half, z: o.z + ax.z * half };
}

// Convert a single linear MEP element from EXTRUSION to SWEEP with explicit
// pathPoints. Returns true if the element was modified.
function convertLinearMEPtoSweep(elem) {
  if (!isLinearMEP(elem)) return false;
  const geom = elem.geometry || {};
  const method = (geom.method || '').toUpperCase();
  if (method === 'SWEEP' && Array.isArray(geom.pathPoints) && geom.pathPoints.length >= 2) {
    return false; // already a valid sweep
  }
  const o  = elem.placement?.origin;
  const ax = elem.placement?.refDirection || elem.placement?.axis;
  const d  = geom.depth || 0;
  if (!o || !ax || d <= 0) return false;
  const half = d / 2;
  const p0 = { x: o.x - ax.x * half, y: o.y - ax.y * half, z: o.z - ax.z * half };
  const p1 = { x: o.x + ax.x * half, y: o.y + ax.y * half, z: o.z + ax.z * half };

  if (!elem.geometry) elem.geometry = {};
  elem.geometry.method = 'SWEEP';
  elem.geometry._geoBehavior = 'PATH_SWEEP';
  elem.geometry.pathPoints = [p0, p1];
  elem.geometry._pathAuthored = true;
  if (!elem.metadata) elem.metadata = {};
  elem.metadata.classCorrected = 'EXTRUSION_TO_SWEEP';
  return true;
}

// Stitch a floating linear MEP endpoint to the nearest peer endpoint within
// STITCH_LIMIT_M. Mutates both endpoints to their midpoint.
function stitchEndpoints(linearByKey, run) {
  if (run.status !== 'floating') return false;
  if (run.peer_count !== 1) return false;
  const gap = run.endpoint_gap;
  if (!Number.isFinite(gap) || gap <= 0 || gap > STITCH_LIMIT_M) return false;

  const elem = linearByKey.get(run.source_segment);
  const peer = linearByKey.get(run.target_segment);
  if (!elem || !peer) return false;

  // Determine which end of `elem` corresponds to run.endpoints (its 3D coord).
  const epEntry = getDuctEndpoint(elem, true);
  const epExit  = getDuctEndpoint(elem, false);
  const dEntry = dist3(epEntry, run.endpoints);
  const dExit  = dist3(epExit,  run.endpoints);
  const elemEntry = dEntry <= dExit;

  // Find peer's nearest endpoint to that.
  const peerEntry = getDuctEndpoint(peer, true);
  const peerExit  = getDuctEndpoint(peer, false);
  const pEntryD = dist3(elemEntry ? epEntry : epExit, peerEntry);
  const pExitD  = dist3(elemEntry ? epEntry : epExit, peerExit);
  const peerIsEntry = pEntryD <= pExitD;
  const peerPt = peerIsEntry ? peerEntry : peerExit;
  const myPt   = elemEntry   ? epEntry   : epExit;

  const realGap = dist3(myPt, peerPt);
  if (realGap > STITCH_LIMIT_M) return false;

  const mid = {
    x: (myPt.x + peerPt.x) / 2,
    y: (myPt.y + peerPt.y) / 2,
    z: (myPt.z + peerPt.z) / 2
  };

  // Update pathPoints (or generate them) on both elements.
  function setEndpoint(el, isEntry, pt) {
    if (!el.geometry) el.geometry = {};
    if (!Array.isArray(el.geometry.pathPoints) || el.geometry.pathPoints.length < 2) {
      const otherPt = getDuctEndpoint(el, !isEntry);
      el.geometry.pathPoints = isEntry ? [pt, otherPt] : [otherPt, pt];
    } else {
      const idx = isEntry ? 0 : el.geometry.pathPoints.length - 1;
      el.geometry.pathPoints[idx] = pt;
    }
    el.geometry.method = 'SWEEP';
    el.geometry._geoBehavior = 'PATH_SWEEP';
    el.geometry._pathAuthored = true;
  }
  setEndpoint(elem, elemEntry, mid);
  setEndpoint(peer, peerIsEntry, mid);
  return true;
}

export function applyVentilationFixes(css, gapReport) {
  const actions = { classCorrected: [], stitched: [], skipped: [] };

  // 1) Class correction — every linear MEP with EXTRUSION → SWEEP.
  let converted = 0;
  for (const elem of (css.elements || [])) {
    if (convertLinearMEPtoSweep(elem)) {
      converted++;
      const id = elem.element_key || elem.id;
      actions.classCorrected.push({ id, type: elem.type, semanticType: elem.semanticType });
      console.log(`[6C] duct_class_corrected id=${id} from=EXTRUSION to=SWEEP`);
    }
  }

  // 2) Endpoint stitching — consume D_ventilation.runs.
  if (gapReport && gapReport.D_ventilation && Array.isArray(gapReport.D_ventilation.runs)) {
    const linearByKey = new Map();
    for (const e of (css.elements || [])) {
      if (!isLinearMEP(e)) continue;
      const k = e.element_key || e.id;
      if (k) linearByKey.set(k, e);
    }
    const stitchedPairs = new Set();
    for (const run of gapReport.D_ventilation.runs) {
      if (!run.target_segment) continue;
      const pairKey = [run.source_segment, run.target_segment].sort().join('|');
      if (stitchedPairs.has(pairKey)) continue;
      if (stitchEndpoints(linearByKey, run)) {
        stitchedPairs.add(pairKey);
        actions.stitched.push({
          a: run.source_segment, b: run.target_segment, gap: run.endpoint_gap
        });
        console.log(`[6C] duct_endpoint_snapped a=${run.source_segment} b=${run.target_segment} gap=${(run.endpoint_gap || 0).toFixed(3)}m`);
      }
    }
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.ventilationFixes = {
    classCorrected: actions.classCorrected.length,
    stitched: actions.stitched.length
  };

  return actions;
}

// ── Fix 4 — portal door candidate diagnostic (no creation) ──────────────────

export function addPortalDoorDiagnostics(css, gapReport, spaceReport) {
  const result = { mainPortals: [], summary: {} };
  if (!spaceReport || !spaceReport.mainPortalPair) return result;

  const elements = css.elements || [];
  const rawDoorCandidates = elements.filter(e => {
    const t = (e.type || '').toUpperCase();
    return t === 'DOOR' || t === 'OPENING';
  });

  const mainPortalPair = spaceReport.mainPortalPair;
  for (const portal of mainPortalPair) {
    const portalId = portal.id || portal.nearestSegmentKey;
    const portalXY = { x: portal.x, y: portal.y, z: 0 };

    // Search raw candidates within 5 m XY of the portal anchor.
    let nearest = null, nearestDist = Infinity;
    const inRange = [];
    for (const d of rawDoorCandidates) {
      const o = (d.placement || {}).origin;
      if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) continue;
      const dx = (o.x || 0) - portalXY.x;
      const dy = (o.y || 0) - portalXY.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > PORTAL_DOOR_RADIUS_M) continue;
      const cand = {
        id: d.element_key || d.id,
        distance: Number(dist.toFixed(3)),
        reconciliationStatus: d.metadata?.reconciliationStatus || null,
        evidenceZone: d.metadata?.evidenceZone || null,
        intentHost: d.metadata?.intent?.hostSegmentId || null
      };
      inRange.push(cand);
      if (dist < nearestDist) { nearestDist = dist; nearest = cand; }
    }
    inRange.sort((a, b) => a.distance - b.distance);

    const portalDiag = {
      portal_id:       portalId,
      portal_xy:       { x: portalXY.x, y: portalXY.y },
      candidates_within_radius: inRange.length,
      nearest:         nearest,
      all_in_range:    inRange.slice(0, 10)
    };

    if (nearest) {
      console.log(`[6C] portal_door_candidate_found portal=${portalId} nearest=${nearest.id} dist=${nearest.distance}m status=${nearest.reconciliationStatus}`);
    } else {
      console.log(`[6C] portal_door_candidate_not_found portal=${portalId} radius=${PORTAL_DOOR_RADIUS_M}m`);
    }
    result.mainPortals.push(portalDiag);
  }

  result.summary = {
    portalsExamined:   mainPortalPair.length,
    portalsWithCandidate: result.mainPortals.filter(p => p.nearest).length,
    rawCandidateCount: rawDoorCandidates.length,
    radiusM:           PORTAL_DOOR_RADIUS_M
  };

  if (!css.metadata) css.metadata = {};
  css.metadata.portalDoorDiagnostic = result;
  return result;
}

export default {
  applyShellConnectivityFixes,
  applyVentilationFixes,
  addPortalDoorDiagnostics
};
