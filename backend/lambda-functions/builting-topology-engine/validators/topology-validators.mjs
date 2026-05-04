/**
 * Topology-stage validators — all severity: 'warning'.
 *
 * Each function returns an array of validation entries.
 * The runner in index.mjs:
 *   1. Logs entries via logValidation()
 *   2. Annotates elem.metadata._validationWarnings so generate can stamp Pset_BuiltingValidation
 *   3. Returns a summary for trace scalars
 */

const SEVERITY = 'warning';

// ── Helpers ─────────────────────────────────────────────────────────────────

function elemId(e) {
  return e.element_key || e.id || '(unknown)';
}

function _dist3(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function _pathLength(pp) {
  let len = 0;
  for (let i = 1; i < pp.length; i++) len += _dist3(pp[i - 1], pp[i]);
  return len;
}

function _pathMidpoint(pp) {
  if (!Array.isArray(pp) || pp.length === 0) return null;
  if (pp.length === 1) return { x: pp[0].x || 0, y: pp[0].y || 0, z: pp[0].z || 0 };
  const p0 = pp[0], pN = pp[pp.length - 1];
  return {
    x: ((p0.x || 0) + (pN.x || 0)) / 2,
    y: ((p0.y || 0) + (pN.y || 0)) / 2,
    z: ((p0.z || 0) + (pN.z || 0)) / 2,
  };
}

/**
 * Compute an axis-aligned bounding box for a CSS element.
 * For PATH_SWEEP elements uses pathPoints; otherwise uses placement + profile.
 */
function _elemBbox(elem) {
  const geom = elem.geometry || {};
  const pp = geom.pathPoints;
  const profile = geom.profile || {};
  const halfW = Math.max(profile.width || 0, (profile.radius || 0) * 2, 0.2) / 2;

  if (Array.isArray(pp) && pp.length >= 2) {
    let [minX, minY, minZ] = [Infinity, Infinity, Infinity];
    let [maxX, maxY, maxZ] = [-Infinity, -Infinity, -Infinity];
    for (const p of pp) {
      const x = p.x || 0, y = p.y || 0, z = p.z || 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX: minX - halfW, maxX: maxX + halfW, minY: minY - halfW, maxY: maxY + halfW, minZ: minZ - halfW, maxZ: maxZ + halfW };
  }

  const o = elem.placement?.origin || {};
  const halfLen = (geom.depth || 1) / 2;
  return {
    minX: (o.x || 0) - halfLen, maxX: (o.x || 0) + halfLen,
    minY: (o.y || 0) - halfW,   maxY: (o.y || 0) + halfW,
    minZ: (o.z || 0) - halfW,   maxZ: (o.z || 0) + halfW,
  };
}

// ── Validator: wallRunsConnected ─────────────────────────────────────────────
/**
 * Warn when a wall's endpoint is within 500mm of another wall's endpoint but
 * not coincident (< 10mm).  Uses explicit startPoint/endPoint if available,
 * otherwise falls back to placement centre ± depth/2 along X.
 */
export function wallRunsConnected(elements) {
  const issues = [];
  const walls = elements.filter(e => (e.type || '').toUpperCase() === 'WALL' && e.placement?.origin);
  if (walls.length === 0) return issues;

  // Build endpoint list per wall
  const wallEndpoints = walls.map(w => {
    const o = w.placement.origin;
    const sp = w.properties?.startPoint || w.geometry?.startPoint;
    const ep = w.properties?.endPoint   || w.geometry?.endPoint;
    if (sp && ep && typeof sp === 'object' && typeof ep === 'object') {
      return { elem: w, pts: [sp, ep] };
    }
    // Rough fallback: centre ± half-depth along local X
    const halfLen = (w.geometry?.depth || 0) / 2;
    const pts = halfLen > 0.001
      ? [{ x: (o.x || 0) - halfLen, y: o.y || 0, z: o.z || 0 },
         { x: (o.x || 0) + halfLen, y: o.y || 0, z: o.z || 0 }]
      : [{ x: o.x || 0, y: o.y || 0, z: o.z || 0 }];
    return { elem: w, pts };
  });

  const SNAP = 0.5;  // 500mm — near but not snapped
  const COIN = 0.01; // 10mm — considered coincident

  for (let i = 0; i < wallEndpoints.length; i++) {
    for (const pt of wallEndpoints[i].pts) {
      let nearestDist = Infinity;
      let nearestId = null;
      let coincident = false;

      for (let j = 0; j < wallEndpoints.length; j++) {
        if (i === j) continue;
        for (const pt2 of wallEndpoints[j].pts) {
          const d = _dist3(pt, pt2);
          if (d < COIN) { coincident = true; break; }
          if (d < nearestDist) { nearestDist = d; nearestId = elemId(wallEndpoints[j].elem); }
        }
        if (coincident) break;
      }

      if (!coincident && nearestDist < SNAP) {
        issues.push({
          validator: 'wallRunsConnected',
          element_id: elemId(wallEndpoints[i].elem),
          result: 'warn',
          expected: 'wall endpoint coincident with neighbor (< 10mm)',
          actual: `nearest endpoint ${Math.round(nearestDist * 1000)}mm away`,
          severity: SEVERITY,
          params: {
            wall_id: elemId(wallEndpoints[i].elem),
            endpoint: pt,
            nearest_wall_id: nearestId,
            distance_mm: Math.round(nearestDist * 1000),
          },
        });
        break; // one issue per wall, not per endpoint
      }
    }
  }
  return issues;
}

// ── Validator: slabStoreyConsistency ─────────────────────────────────────────
/**
 * Every inferred SLAB should have a container that maps to a known storey or
 * level — for BUILDING domain; tunnel slabs live inside tunnel segments (OK).
 */
export function slabStoreyConsistency(elements, css) {
  const issues = [];
  const domain = (css?.domain || '').toUpperCase();

  const storeyIds = new Set(
    (css?.levelsOrSegments || [])
      .filter(ls => ls.type === 'STOREY' || ls.type === 'LEVEL' || ls.type === 'FLOOR')
      .map(ls => ls.id)
  );
  for (const e of elements) {
    const t = (e.type || '').toUpperCase();
    if (t === 'STOREY' || t === 'LEVEL') storeyIds.add(elemId(e));
  }

  for (const elem of elements) {
    if ((elem.type || '').toUpperCase() !== 'SLAB') continue;

    const container = elem.container;
    if (!container) {
      issues.push({
        validator: 'slabStoreyConsistency',
        element_id: elemId(elem),
        result: 'fail',
        expected: 'slab.container references a storey',
        actual: null,
        severity: SEVERITY,
      });
    } else if (domain !== 'TUNNEL' && !storeyIds.has(container)) {
      issues.push({
        validator: 'slabStoreyConsistency',
        element_id: elemId(elem),
        result: 'warn',
        expected: `container "${container}" is a known storey/level`,
        actual: `"${container}" not in storey registry`,
        severity: SEVERITY,
      });
    }
  }
  return issues;
}

// ── Validator: jointAnglePlausible ───────────────────────────────────────────
/**
 * Warn when a path-connection joint angle falls outside the expected range
 * for its declared connection type.
 */
const JOINT_RULES = {
  MITRE: { center: 45, tol: 10 },
  BUTT:  { center: 90, tol: 5 },
  TEE:   { center: 90, tol: 15 },
};

export function jointAnglePlausible(elements) {
  const issues = [];
  for (const elem of elements) {
    for (const rel of (elem.relationships || [])) {
      const angle = rel.connectionAngle;
      const jType = (rel.connectionType || '').toUpperCase();
      if (angle == null || !JOINT_RULES[jType]) continue;
      const rule = JOINT_RULES[jType];
      const deviation = Math.abs(angle - rule.center);
      if (deviation > rule.tol) {
        issues.push({
          validator: 'jointAnglePlausible',
          element_id: elemId(elem),
          result: 'warn',
          expected: `${jType} angle within ±${rule.tol}° of ${rule.center}°`,
          actual: `${angle}° (deviation ${Math.round(deviation)}°)`,
          severity: SEVERITY,
          params: {
            element_id: elemId(elem),
            joint_type: jType,
            actual_angle: angle,
            expected_range: [rule.center - rule.tol, rule.center + rule.tol],
          },
        });
      }
    }
  }
  return issues;
}

// ── Validator: spatialContainment ────────────────────────────────────────────
/**
 * KEY VALIDATOR — catches ducts/pipes extruding through walls.
 *
 * For each MEP element that declares a host (parentSegment / hostStructuralBranch
 * / derivedFromBranch), verify that the element's path midpoint (or placement
 * origin if no path) falls within the host's bounding box, expanded by MARGIN.
 *
 * The MARGIN is generous (5m) because:
 *   - tunnel coordinates can be in the hundreds-of-metres range
 *   - MEP equipment may be validly mounted at the tunnel portal opening
 *   - false positives here are cheap to review; missed true positives are costly
 */
export function spatialContainment(elements) {
  const issues = [];
  const byKey = new Map();
  for (const e of elements) {
    const k = elemId(e);
    if (k !== '(unknown)') byKey.set(k, e);
  }

  const MEP_TYPES = new Set(['DUCT', 'PIPE', 'CABLE_TRAY', 'EQUIPMENT', 'FAN', 'PUMP', 'LIGHT']);

  for (const elem of elements) {
    const type = (elem.type || '').toUpperCase();
    if (!MEP_TYPES.has(type)) continue;

    const geom  = elem.geometry  || {};
    const meta  = elem.metadata  || {};
    const props = elem.properties || {};

    // Find the declared host key (multiple fallback fields)
    const hostKey =
      meta.parentSegment          ||
      meta.hostSegmentId           ||
      props.hostStructuralBranchMatched ||
      props.derivedFromBranch      ||
      props.hostBranch             ||
      null;
    if (!hostKey) continue;

    const host = byKey.get(hostKey);
    if (!host) continue;

    // Element centroid — prefer path midpoint
    const pp = geom.pathPoints;
    const centroid = _pathMidpoint(pp) || elem.placement?.origin;
    if (!centroid) continue;

    const bbox = _elemBbox(host);

    // Vertical shafts have a short CSS depth (4m) but extend 30m+ physically.
    // Expand effective maxZ to cover the full geometry depth.
    const hostType = (host.type || '').toUpperCase();
    const hostSemantic = (host.semanticType || '').toLowerCase();
    if (hostType === 'VERTICAL_SHAFT' || hostSemantic.includes('shaft')) {
      const geomDepth = host.geometry?.depth || 0;
      bbox.maxZ = Math.max(bbox.maxZ, bbox.minZ + geomDepth);
    }

    const MARGIN = 5.0; // 5 metres

    if (
      centroid.x < bbox.minX - MARGIN || centroid.x > bbox.maxX + MARGIN ||
      centroid.y < bbox.minY - MARGIN || centroid.y > bbox.maxY + MARGIN ||
      centroid.z < bbox.minZ - MARGIN || centroid.z > bbox.maxZ + MARGIN
    ) {
      issues.push({
        validator: 'spatialContainment',
        element_id: elemId(elem),
        result: 'warn',
        expected: `element centroid inside host "${hostKey}" bbox (±${MARGIN}m margin)`,
        actual: `centroid (${centroid.x?.toFixed(1)},${centroid.y?.toFixed(1)},${centroid.z?.toFixed(1)}) outside bbox`,
        severity: SEVERITY,
        params: {
          element_id: elemId(elem),
          host_id: hostKey,
          element_centroid: centroid,
          host_bbox: bbox,
        },
      });
    }
  }
  return issues;
}

// ── Validator: branchConnectivity ────────────────────────────────────────────
/**
 * Every branch-type element (TUNNEL_SEGMENT, DUCT, PIPE) should be reachable
 * from the network graph — either it has outgoing relationship connections, or
 * another element references it as a target, or it is explicitly a terminal.
 *
 * Elements with 0 connections AND not referenced as any element's target are
 * completely orphaned from the network.
 */
export function branchConnectivity(elements) {
  const issues = [];

  // Build set of all elements that are referenced as relationship targets
  const referencedAsTarget = new Set();
  for (const e of elements) {
    for (const rel of (e.relationships || [])) {
      if (rel.target) referencedAsTarget.add(rel.target);
    }
  }

  const BRANCH_TYPES = new Set(['TUNNEL_SEGMENT', 'DUCT', 'PIPE']);

  for (const elem of elements) {
    const type = (elem.type || '').toUpperCase();
    if (!BRANCH_TYPES.has(type)) continue;

    const props = elem.properties || {};
    const meta  = elem.metadata  || {};
    // Skip declared terminals and bridge gap-fillers (structurally connected but not network nodes)
    if (props.isTerminal || meta.isTerminal || props.branchClass === 'TERMINAL' || props._isBridgeSegment || props.synthetic_bridge) continue;

    const k = elemId(elem);
    // PATH_CONNECTS is the type emitted by buildPathConnections; also accept legacy 'PATH' and
    // relationships that carry a connectionType field (e.g. from earlier pipeline passes).
    const hasOutgoingRel = (elem.relationships || []).some(r =>
      r.target && (r.type === 'PATH_CONNECTS' || r.type === 'PATH' || r.connectionType));
    const isTarget = referencedAsTarget.has(k);

    if (!hasOutgoingRel && !isTarget) {
      issues.push({
        validator: 'branchConnectivity',
        element_id: k,
        result: 'warn',
        expected: 'element has at least 1 path connection or is referenced as a target',
        actual: '0 connections and not referenced by any element',
        severity: SEVERITY,
        params: {
          branch_id: k,
          unconnected_endpoints: ['start', 'end'],
        },
      });
    }
  }
  return issues;
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * runTopologyValidators — run all topology-stage validators.
 *
 * Also annotates each element with elem.metadata._validationWarnings so
 * the generate lambda can stamp Pset_BuiltingValidation in the IFC file.
 *
 * Returns { entries, total, passed, warned, failed }.
 */
export function runTopologyValidators(elements, css) {
  if (!elements || elements.length === 0) {
    return { entries: [], total: 0, passed: 0, warned: 0, failed: 0 };
  }

  const entries = [
    ...wallRunsConnected(elements),
    ...slabStoreyConsistency(elements, css),
    ...jointAnglePlausible(elements),
    ...spatialContainment(elements),
    ...branchConnectivity(elements),
  ];

  // Annotate elements for downstream Pset stamping
  if (entries.length > 0) {
    const byKey = new Map();
    for (const e of elements) {
      const k = elemId(e);
      if (k !== '(unknown)') byKey.set(k, e);
    }
    for (const entry of entries) {
      if (entry.result === 'pass') continue;
      const elem = byKey.get(entry.element_id);
      if (!elem) continue;
      if (!elem.metadata) elem.metadata = {};
      const w = elem.metadata._validationWarnings = elem.metadata._validationWarnings || [];
      if (!w.includes(entry.validator)) w.push(entry.validator);
    }
  }

  const failed = entries.filter(e => e.result === 'fail').length;
  const warned = entries.filter(e => e.result === 'warn').length;

  console.log(
    `[topology-validators] total=${entries.length} warned=${warned} failed=${failed} ` +
    `spatialContainment=${entries.filter(e => e.validator === 'spatialContainment').length} ` +
    `branchConnectivity=${entries.filter(e => e.validator === 'branchConnectivity').length}`
  );

  return { entries, total: entries.length, passed: 0, warned, failed };
}
