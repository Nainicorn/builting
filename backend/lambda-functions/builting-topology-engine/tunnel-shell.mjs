/**
 * tunnel-shell.mjs — Tunnel shell geometry pipeline.
 * Extracted from builting-transform/index.mjs lines 726-3662.
 * Shared between builting-structure Lambda.
 */

import { safe, clamp, sanitizeDir, elemId, vecNormalize, vecDot, vecCross, vecScale, vecAdd, vecSub, vecDist, vecLen, computeBisectorPlane, intersectLineWithPlane, generateChamferedRectProfile, generateCirclePoints, generateHorseshoePoints, generateLeftWallArcProfile, generateRightWallArcProfile, generateRoofArcProfile, buildTunnelFrame, validateTunnelFrame, shellThicknessFromProfile } from './shared.mjs';

// ============================================================================
// R1: DECOMPOSITION ELIGIBILITY CHECK
// Only decompose a TUNNEL_SEGMENT into shell pieces when geometry evidence
// is strong enough. Otherwise keep it as a single segment (SEGMENT_FALLBACK).
// ============================================================================

/**
 * Determines whether a tunnel segment has enough POSITIVE geometry evidence
 * to decompose into wall/slab shell pieces.
 *
 * DEFAULT: do NOT decompose. Decomposition is opt-in, not opt-out.
 * A segment must have explicit thickness/lining data AND valid geometry
 * to qualify for decomposition.
 *
 * Returns { eligible: true, frame } or { eligible: false, reasons: string[] }.
 */
function canDecomposeTunnelSegment(elem) {
  const reasons = [];
  const props = elem.properties || {};
  const placement = elem.placement || {};
  const geometry = elem.geometry || {};
  const profile = geometry.profile || {};

  // 1. Must have valid placement with axis and origin
  if (!placement.origin) reasons.push('missing_origin');
  if (!placement.axis) reasons.push('missing_axis');
  if (!placement.refDirection) reasons.push('missing_refDirection');

  // 2. Must have profile with real dimensions
  const W = profile.width || 0;
  const H = profile.height || 0;
  const depth = geometry.depth || 0;
  // Minimum viable dimensions: reject only clearly degenerate (placeholder) geometry.
  // Original 0.6m thresholds excluded valid narrow-gauge mine tunnels (~0.7m wide).
  // 0.1m minimum catches zero/near-zero placeholders without blocking real small tunnels.
  // Minimum depth of 0.1m prevents zero-extrusion artefacts without excluding short transition pieces.
  if (W < 0.10) reasons.push('width_too_small');
  if (H < 0.10) reasons.push('height_too_small');
  if (depth <= 0.1) reasons.push('depth_too_short');

  // 3. Thickness evidence — informational only, no longer blocks decomposition.
  //    VentSim data typically omits explicit wall thickness. deriveThickness(W,H)
  //    computes a structurally appropriate value from cross-section dimensions.
  //    The decomposition body at R2 will set thicknessBasis='DERIVED' when absent.
  const hasThicknessEvidence = props.wallThickness || props.shellThickness ||
    props.liningThickness || profile.thickness ||
    props.wallThickness_m || props.shell_thickness;
  // NOTE: no_thickness_evidence intentionally removed from blocking reasons.
  // A missing thickness uses deriveThickness(W,H) and is tracked via thicknessBasis='DERIVED'.

  // If any blocking reason exists, bail early
  if (reasons.length > 0) return { eligible: false, reasons };

  // 4. Must have a valid local frame
  const axis = vecNormalize(placement.axis);
  if (!axis) return { eligible: false, reasons: ['axis_not_normalizable'] };

  const origin = placement.origin;
  const entryPoint = vecAdd(origin, vecScale(axis, -depth / 2));
  const exitPoint = vecAdd(origin, vecScale(axis, depth / 2));
  const preferredUp = placement.refDirection ? vecNormalize(placement.refDirection) : null;
  const frame = buildTunnelFrame(entryPoint, exitPoint, preferredUp);
  const frameCheck = validateTunnelFrame(frame);
  if (!frameCheck.valid) {
    return { eligible: false, reasons: [`invalid_frame:${frameCheck.reason}`] };
  }

  return { eligible: true, frame };
}

// ============================================================================
// R2: THICKNESS SANITY CHECKS
// ============================================================================

// No DEFAULT_WALL_THICKNESS constant — all thickness values are derived via
// shellThicknessFromProfile(elem, facilityMeta) so they scale with structure size
// and material. See shared.mjs for the derivation rules.

/**
 * Convenience wrapper: derive shell thickness from raw profile width and height.
 * Avoids constructing a full element object at every call site.
 * @param {number} W — profile width in meters
 * @param {number} H — profile height in meters
 * @param {string} [mat] — material name hint (e.g. 'concrete', 'steel')
 */
function deriveThickness(W, H, mat) {
  return shellThicknessFromProfile(
    { geometry: { profile: { width: W || 1, height: H || 1 } }, properties: { material: mat || '' } },
    null
  );
}

const MIN_THICKNESS_RATIO = 0.02; // thickness must be >= 2% of smallest profile dim
const MAX_THICKNESS_RATIO = 0.45; // thickness must be <= 45% of smallest profile dim

/**
 * Validates whether a shell thickness is sane relative to the profile dimensions.
 * Returns { valid: true, thickness } or { valid: false, reason, fallbackThickness }.
 */
function validateShellThickness(thickness, profileWidth, profileHeight, elem, facilityMeta) {
  const minDim = Math.min(profileWidth, profileHeight);
  // Derive a structurally appropriate fallback for this specific profile
  const fallbackThickness = shellThicknessFromProfile(
    elem || { geometry: { profile: { width: profileWidth, height: profileHeight } } },
    facilityMeta || null
  );
  if (minDim <= 0) return { valid: false, reason: 'zero_profile_dim', fallbackThickness };

  const ratio = thickness / minDim;
  if (ratio < MIN_THICKNESS_RATIO) {
    return { valid: false, reason: 'thickness_too_thin', fallbackThickness };
  }
  if (ratio > MAX_THICKNESS_RATIO) {
    return { valid: false, reason: 'thickness_too_thick', fallbackThickness };
  }

  // Check that shell pieces wouldn't overlap (2*thickness must be < each dim)
  if (2 * thickness >= profileWidth || 2 * thickness >= profileHeight) {
    return { valid: false, reason: 'thickness_causes_overlap', fallbackThickness };
  }

  return { valid: true, thickness };
}

// ============================================================================
// SKELETON-FIRST GEOMETRY PIPELINE (v2)
// Builds centerline skeleton → merges collinear segments into runs →
// decomposes runs into shell pieces → trims at intersection planes →
// fills remaining corner gaps.
// ============================================================================

function buildCenterlineSkeleton(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const segments = css.elements.filter(e =>
    e.type === 'TUNNEL_SEGMENT' && (e.properties?.branchClass === 'STRUCTURAL')
  );

  if (segments.length === 0) {
    console.log('buildCenterlineSkeleton: no STRUCTURAL TUNNEL_SEGMENTs found');
    return;
  }

  const nodes = {};  // nodeId → { id, positions: [{x,y,z}], degree, incidentEdges, position, spread, hardError }
  const edges = {};  // segKey → edge object

  for (const seg of segments) {
    const key = seg.element_key || seg.id;
    if (!key) continue;
    // element_key backfill
    if (!seg.element_key) seg.element_key = elemId(seg.geometry, seg.placement);

    const placement = seg.placement || {};
    const geometry = seg.geometry || {};

    const origin = placement.origin || { x: 0, y: 0, z: 0 };
    const depth = geometry.depth || 0;
    if (depth <= 0) continue;

    // R: Use actual bore bearing — normalize(endPoint - startPoint) — rather than
    // placement.axis. Old-format VentSim CSS uses axis=(0,0,1) (Z-up) with
    // refDirection=bore, so vecNormalize(placement.axis) gives (0,0,1) and produces
    // vertically-oriented entry/exit points. That makes identifyAndMergeRuns compute
    // mergedAxis=(0,0,1), and decomposeMergedRuns emits shell pieces extruded
    // vertically (tall spike panels at every segment). getTunnelBearing returns the
    // correct horizontal bore direction for old-format and the axis directly for new-format.
    const bearing = getTunnelBearing(seg);
    if (!bearing) continue;

    const entryPoint = vecAdd(origin, vecScale(bearing, -depth / 2));
    const exitPoint = vecAdd(origin, vecScale(bearing, depth / 2));

    const entryNode = seg.properties?.entry_node;
    const exitNode = seg.properties?.exit_node;
    if (!entryNode || !exitNode) continue;

    const profile = geometry.profile || {};
    const W = profile.width || 0;
    const H = profile.height || 0;

    edges[key] = {
      segKey: key, entryNode, exitNode, axis: bearing, depth, origin,
      W, H, profile: { ...profile },
      refDirection: placement.refDirection ? { ...placement.refDirection } : null,
      container: seg.container, material: seg.material, source: seg.source,
      shape: seg.properties?.shape || 'rectangular',
      entryPoint, exitPoint, elem: seg
    };

    // Register endpoints at nodes
    for (const [nodeId, point, endType] of [[entryNode, entryPoint, 'entry'], [exitNode, exitPoint, 'exit']]) {
      if (!nodes[nodeId]) nodes[nodeId] = { id: nodeId, positions: [], degree: 0, incidentEdges: [] };
      nodes[nodeId].positions.push(point);
      nodes[nodeId].incidentEdges.push({ segKey: key, endType });
    }
  }

  // Compute node positions and degree
  let inconsistencyCount = 0;
  let hardErrorCount = 0;
  for (const node of Object.values(nodes)) {
    node.degree = node.incidentEdges.length;
    const pts = node.positions;
    if (pts.length === 0) continue;

    // Compute centroid
    const centroid = {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      z: pts.reduce((s, p) => s + p.z, 0) / pts.length
    };

    // Compute max spread from centroid
    let maxSpread = 0;
    for (const p of pts) maxSpread = Math.max(maxSpread, vecDist(p, centroid));
    node.spread = maxSpread;

    if (maxSpread > 0.20) {
      // Hard error: use longest incident segment's endpoint as anchor
      node.hardError = true;
      hardErrorCount++;
      let longestDepth = 0;
      let anchorPoint = centroid;
      for (const ie of node.incidentEdges) {
        const edge = edges[ie.segKey];
        if (edge && edge.depth > longestDepth) {
          longestDepth = edge.depth;
          anchorPoint = ie.endType === 'entry' ? edge.entryPoint : edge.exitPoint;
        }
      }
      node.position = anchorPoint;
      console.warn(`SKELETON_NODE_HARD_ERROR: node ${node.id} spread=${maxSpread.toFixed(3)}m — using longest segment anchor`);
    } else if (maxSpread > 0.05) {
      // Warning: use longest segment anchor
      node.hardError = false;
      inconsistencyCount++;
      let longestDepth = 0;
      let anchorPoint = centroid;
      for (const ie of node.incidentEdges) {
        const edge = edges[ie.segKey];
        if (edge && edge.depth > longestDepth) {
          longestDepth = edge.depth;
          anchorPoint = ie.endType === 'entry' ? edge.entryPoint : edge.exitPoint;
        }
      }
      node.position = anchorPoint;
      console.warn(`SKELETON_NODE_INCONSISTENCY: node ${node.id} spread=${maxSpread.toFixed(3)}m`);
    } else {
      node.hardError = false;
      node.position = centroid;
    }
  }

  css.skeleton = { nodes, edges };
  console.log(`buildCenterlineSkeleton: ${Object.keys(nodes).length} nodes, ${Object.keys(edges).length} edges, ${inconsistencyCount} inconsistencies, ${hardErrorCount} hard errors`);
}


function identifyAndMergeRuns(css) {
  if (!css.skeleton) return;
  const { nodes, edges } = css.skeleton;

  // Step A: classify nodes
  const continuationNodes = new Set();
  const bendNodes = new Set();
  const junctionNodeIds = [];

  for (const node of Object.values(nodes)) {
    if (node.degree === 1) continue; // terminal — run boundary
    if (node.degree >= 3) {
      junctionNodeIds.push(node.id);
      continue; // junction — run boundary
    }
    // Degree 2: check continuation criteria
    if (node.incidentEdges.length !== 2) continue;
    const edgeA = edges[node.incidentEdges[0].segKey];
    const edgeB = edges[node.incidentEdges[1].segKey];
    if (!edgeA || !edgeB) { bendNodes.add(node.id); continue; }

    // 1. Angular similarity
    const dot = Math.abs(vecDot(edgeA.axis, edgeB.axis));
    if (dot < 0.996) { bendNodes.add(node.id); continue; }

    // 2. Cross-section similarity (15%)
    if (edgeA.W > 0 && edgeB.W > 0 && Math.abs(edgeA.W - edgeB.W) / Math.max(edgeA.W, edgeB.W) > 0.15) {
      bendNodes.add(node.id); continue;
    }
    if (edgeA.H > 0 && edgeB.H > 0 && Math.abs(edgeA.H - edgeB.H) / Math.max(edgeA.H, edgeB.H) > 0.15) {
      bendNodes.add(node.id); continue;
    }

    // 3. Positional continuity: endpoint gap at node < 0.1m
    const ptA = node.incidentEdges[0].endType === 'entry' ? edgeA.entryPoint : edgeA.exitPoint;
    const ptB = node.incidentEdges[1].endType === 'entry' ? edgeB.entryPoint : edgeB.exitPoint;
    if (vecDist(ptA, ptB) > 0.1) { bendNodes.add(node.id); continue; }

    // 4. Lateral offset: perpendicular distance between centerlines < 0.1m
    const midA = edgeA.origin;
    const midB = edgeB.origin;
    const ab = vecSub(midB, midA);
    const projLen = Math.abs(vecDot(ab, edgeA.axis));
    const totalDist = vecLen(ab);
    const lateralOffset = Math.sqrt(Math.max(0, totalDist * totalDist - projLen * projLen));
    if (lateralOffset > 0.1) { bendNodes.add(node.id); continue; }

    // 5. Semantic compatibility: same container
    if (edgeA.container && edgeB.container && edgeA.container !== edgeB.container) {
      bendNodes.add(node.id); continue;
    }

    // 6. Profile family compatibility: same shape type
    if (edgeA.shape !== edgeB.shape) { bendNodes.add(node.id); continue; }

    continuationNodes.add(node.id);
  }

  // Step B: walk chains
  const visited = new Set();
  const runs = [];
  let runCounter = 0;

  function walkChain(startNode, firstEdgeKey) {
    const chain = [firstEdgeKey];
    visited.add(firstEdgeKey);
    const firstEdge = edges[firstEdgeKey];
    let currentNode = firstEdge.entryNode === startNode ? firstEdge.exitNode : firstEdge.entryNode;

    while (continuationNodes.has(currentNode)) {
      const node = nodes[currentNode];
      const nextEdge = node.incidentEdges.find(ie => !visited.has(ie.segKey));
      if (!nextEdge) break;
      chain.push(nextEdge.segKey);
      visited.add(nextEdge.segKey);
      const edge = edges[nextEdge.segKey];
      currentNode = edge.entryNode === currentNode ? edge.exitNode : edge.entryNode;
    }

    return { edgeKeys: chain, endNode: currentNode };
  }

  // Start from non-continuation nodes
  for (const node of Object.values(nodes)) {
    if (continuationNodes.has(node.id)) continue;
    for (const ie of node.incidentEdges) {
      if (visited.has(ie.segKey)) continue;
      const { edgeKeys, endNode } = walkChain(node.id, ie.segKey);
      runs.push({ startNode: node.id, endNode, edgeKeys });
    }
  }
  // Handle cycles
  for (const key of Object.keys(edges)) {
    if (visited.has(key)) continue;
    const edge = edges[key];
    const { edgeKeys, endNode } = walkChain(edge.entryNode, key);
    runs.push({ startNode: edge.entryNode, endNode, edgeKeys });
  }

  // Step C: merge segments within each run
  css.runs = [];
  for (const run of runs) {
    // Order edges along the chain from startNode to endNode
    const ordered = [];
    let currentNode = run.startNode;
    for (const key of run.edgeKeys) {
      const edge = edges[key];
      // Orient edge so we walk from currentNode
      if (edge.entryNode === currentNode) {
        ordered.push({ ...edge, walkDir: 1 });
        currentNode = edge.exitNode;
      } else {
        ordered.push({ ...edge, walkDir: -1 });
        currentNode = edge.entryNode;
      }
    }

    if (ordered.length === 0) continue;

    // Compute merged geometry
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const startPoint = first.walkDir === 1 ? first.entryPoint : first.exitPoint;
    const endPoint = last.walkDir === 1 ? last.exitPoint : last.entryPoint;

    const mergedDepth = vecDist(startPoint, endPoint);
    if (mergedDepth < 0.1) continue; // degenerate

    const mergedOrigin = {
      x: (startPoint.x + endPoint.x) / 2,
      y: (startPoint.y + endPoint.y) / 2,
      z: (startPoint.z + endPoint.z) / 2
    };
    const mergedAxis = vecNormalize(vecSub(endPoint, startPoint));
    if (!mergedAxis) continue;

    // Average cross-section
    let totalW = 0, totalH = 0, count = 0;
    for (const e of ordered) { totalW += e.W; totalH += e.H; count++; }
    const avgW = count > 0 ? totalW / count : 1;
    const avgH = count > 0 ? totalH / count : 1;

    // refDirection: Gram-Schmidt orthogonalize first segment's refDir against merged axis
    let refDir = first.refDirection ? vecNormalize(first.refDirection) : null;
    if (refDir) {
      const proj = vecDot(refDir, mergedAxis);
      refDir = vecNormalize(vecSub(refDir, vecScale(mergedAxis, proj)));
    }
    if (!refDir) refDir = vecNormalize({ x: 0, y: 0, z: 1 });
    if (!refDir || Math.abs(vecDot(refDir, mergedAxis)) > 0.95) {
      refDir = vecNormalize({ x: 1, y: 0, z: 0 });
    }

    // Cumulative drift check
    const endToEndAxis = mergedAxis;
    let maxLateralDrift = 0;
    for (const e of ordered) {
      const toSeg = vecSub(e.origin, mergedOrigin);
      const along = vecDot(toSeg, endToEndAxis);
      const lateralSq = vecDot(toSeg, toSeg) - along * along;
      maxLateralDrift = Math.max(maxLateralDrift, Math.sqrt(Math.max(0, lateralSq)));
    }

    // If drift is too large, this shouldn't be one run (but classification should have caught it)
    if (maxLateralDrift > 0.5) {
      console.warn(`identifyAndMergeRuns: run-${runCounter} has lateral drift ${maxLateralDrift.toFixed(3)}m — accepting but flagging`);
    }

    const segKeys = ordered.map(e => e.segKey);
    css.runs.push({
      id: `run-${runCounter++}`,
      segKeys,
      startNode: run.startNode,
      endNode: run.endNode,
      mergedOrigin, mergedAxis, mergedDepth,
      W: avgW, H: avgH,
      profile: first.profile,
      refDirection: refDir,
      container: first.container,
      material: first.material || { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0.0 },
      source: first.source || 'VSM',
      shape: first.shape || 'rectangular',
      maxLateralDrift
    });
  }

  css.junctionNodes = junctionNodeIds;

  const segCounts = css.runs.map(r => r.segKeys.length);
  console.log(`identifyAndMergeRuns: ${css.runs.length} runs from ${Object.keys(edges).length} segments`);
  console.log(`  continuation=${continuationNodes.size}, bends=${bendNodes.size}, junctions=${junctionNodeIds.length}`);
  console.log(`  segs/run: min=${Math.min(...segCounts)||0}, max=${Math.max(...segCounts)||0}, avg=${(segCounts.reduce((a,b)=>a+b,0)/segCounts.length||0).toFixed(1)}`);
}


function decomposeMergedRuns(css) {
  if (!css.runs || css.runs.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const derivedElements = [];
  let shellPieceCount = 0;
  let voidCount = 0;
  let curvedShellCount = 0;
  let runFallbackCount = 0;

  // Step A: structural shell pieces (one per run per role)
  for (const run of css.runs) {
    const W = run.W;
    const H = run.H;
    const depth = run.mergedDepth;
    if (!W || W < 0.10 || !H || H < 0.10 || depth <= 0.1) continue;

    // R3: Use stable frame builder instead of ad-hoc construction
    const startPoint = vecAdd(run.mergedOrigin, vecScale(run.mergedAxis, -depth / 2));
    const endPoint = vecAdd(run.mergedOrigin, vecScale(run.mergedAxis, depth / 2));
    const frame = buildTunnelFrame(startPoint, endPoint, run.refDirection ? vecNormalize(run.refDirection) : null);
    const frameCheck = validateTunnelFrame(frame);
    if (!frameCheck.valid) {
      runFallbackCount++;
      console.warn(`decomposeMergedRuns: run ${run.id} frame invalid (${frameCheck.reason}), skipping`);
      continue;
    }

    const axis = frame.tangent;
    const side = frame.lateral;
    const up = frame.up;

    // R2: Thickness — derive from profile dimensions and material rather than using a fixed constant
    const _runElem = { geometry: { profile: { width: W, height: H } }, properties: { material: run.material?.name } };
    let t = shellThicknessFromProfile(_runElem, css.facilityMeta ?? css.metadata?.facilityMeta ?? null);
    let thicknessBasis = 'DERIVED';
    let usedDefaultThickness = false;
    const thicknessCheck = validateShellThickness(t, W, H, _runElem, css.facilityMeta ?? null);
    if (!thicknessCheck.valid) {
      t = thicknessCheck.fallbackThickness;
      thicknessBasis = 'SANITY_FALLBACK';
      console.log(`decomposeMergedRuns: thickness sanity fallback for run ${run.id} `
        + `(${thicknessCheck.reason}): t=${t.toFixed(4)}m`);
    }
    const slabW = W - 2 * t;
    const parentKey = run.segKeys[0]; // first segment key for backward compat
    const parentOrigin = run.mergedOrigin;
    const parentMaterial = run.material || { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0.0 };

    // Determine shape-specific decomposition
    const shape = run.shape || 'rectangular';
    let isApproximated = false;
    let approximationType = null;
    let pieces;
    const ARC_SEGMENTS = 24;

    if (shape === 'circular' || (run.profile?.type === 'CIRCLE')) {
      isApproximated = true;
      approximationType = 'CIRCULAR_TO_RECT';
      const R = W / 2;
      const leftProfile = { type: 'ARBITRARY', points: generateLeftWallArcProfile(R, t, ARC_SEGMENTS) };
      const rightProfile = { type: 'ARBITRARY', points: generateRightWallArcProfile(R, t, ARC_SEGMENTS) };
      pieces = [
        ['left_wall', 'WALL', 'IfcWall', { x: 0, y: 0, z: 0 }, W, H, side, 0.92, { geometryApproximation: 'CIRCULAR_ARC_SHELL' }, leftProfile],
        ['right_wall', 'WALL', 'IfcWall', { x: 0, y: 0, z: 0 }, W, H, side, 0.92, { geometryApproximation: 'CIRCULAR_ARC_SHELL' }, rightProfile],
      ];
      curvedShellCount += 2;
    } else if (shape === 'horseshoe') {
      isApproximated = true;
      approximationType = 'HORSESHOE_TO_RECT';
      const halfW = W / 2;
      const wallH = H * 0.5;
      const archH = halfW;
      const roofProfile = { type: 'ARBITRARY', points: generateRoofArcProfile(halfW, wallH, archH, t, ARC_SEGMENTS) };
      pieces = [
        ['left_wall', 'WALL', 'IfcWall', vecScale(side, -(W / 2 - t / 2)), t, H, side, 0.92, {}],
        ['right_wall', 'WALL', 'IfcWall', vecScale(side, (W / 2 - t / 2)), t, H, side, 0.92, {}],
        ['roof', 'SLAB', 'IfcSlab', { x: 0, y: 0, z: 0 }, slabW, t, side, 0.92, { slabType: 'ROOF', geometryApproximation: 'HORSESHOE_ARCH_SHELL' }, roofProfile],
      ];
      curvedShellCount += 1;
    } else {
      pieces = [
        ['left_wall', 'WALL', 'IfcWall', vecScale(side, -(W / 2 - t / 2)), t, H, side, 0.92, {}],
        ['right_wall', 'WALL', 'IfcWall', vecScale(side, (W / 2 - t / 2)), t, H, side, 0.92, {}],
        ['floor', 'SLAB', 'IfcSlab', vecScale(up, -(H / 2 - t / 2)), slabW, t, side, 0.92, { slabType: 'FLOOR' }],
        ['roof', 'SLAB', 'IfcSlab', vecScale(up, (H / 2 - t / 2)), slabW, t, side, 0.92, { slabType: 'ROOF' }],
      ];
    }

    for (const [suffix, cssType, semanticType, offsetVec, profW, profH, refDir, confidence, extraProps, curvedProfile] of pieces) {
      const derivedOrigin = vecAdd(parentOrigin, offsetVec);
      const derivedPlacement = {
        origin: derivedOrigin,
        axis: { ...axis },
        refDirection: refDir || { ...axis }
      };

      let derivedProfile;
      if (curvedProfile) {
        derivedProfile = { ...curvedProfile };
      } else {
        derivedProfile = { type: 'RECTANGLE', width: profW, height: profH };
      }

      const derivedGeometry = {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: depth,
        profile: derivedProfile
      };

      const derivedId = elemId(derivedGeometry, derivedPlacement);

      derivedElements.push({
        id: derivedId,
        element_key: `run_${run.id}_${suffix}`,
        type: cssType,
        name: run.segKeys[0],
        semanticType: semanticType,
        confidence: confidence,
        source: run.source,
        container: run.container,
        placement: derivedPlacement,
        geometry: derivedGeometry,
        material: cssType === 'SPACE' ? { name: 'space', color: [0.88, 0.88, 0.88], transparency: 0.7 } : { ...parentMaterial },
        properties: {
          derivedFromBranch: parentKey,
          derivedFromBranches: [...run.segKeys],
          shellPiece: suffix.toUpperCase(),
          decompositionMethod: isApproximated ? 'skeleton_first_approx_v1' : 'skeleton_first_v1',
          shellThickness_m: t,
          shellThicknessBasis: thicknessBasis,
          usedDefaultThickness,
          isMergedRun: true,
          mergedPieceCount: run.segKeys.length,
          runId: run.id,
          entry_node: run.startNode,
          exit_node: run.endNode,
          branchClass: 'STRUCTURAL',
          ...extraProps
        },
        relationships: []
      });
      shellPieceCount++;
    }
  }

  // Step B: VOID spaces per original segment (not per run)
  // Enabled: IfcSpace containment is required for equipment hosting (IfcRelContainedInSpatialStructure)
  const GENERATE_TUNNEL_SPACES_SKELETON = true;
  const segments = GENERATE_TUNNEL_SPACES_SKELETON ? css.elements.filter(e =>
    e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL'
  ) : [];

  for (const seg of segments) {
    const placement = seg.placement || {};
    const geometry = seg.geometry || {};
    const profile = geometry.profile || {};
    // R: Same fix as buildCenterlineSkeleton — use bore bearing, not placement.axis.
    // Old-format VentSim: placement.axis=(0,0,1), so vecNormalize gives (0,0,1) and
    // the void space extrudes vertically (giant transparent spike). Use bore direction instead.
    const axis = getTunnelBearing(seg) || vecNormalize(placement.axis);
    if (!axis) continue;

    const W = profile.width || 0;
    const H = profile.height || 0;
    const depth = geometry.depth || 0;
    if (W < 0.10 || H < 0.10 || depth <= 0.1) continue;

    const voidT = deriveThickness(W, H, seg.properties?.material);
    const innerW = W - 2 * voidT;
    const innerH = H - 2 * voidT;
    if (innerW <= 0.1 || innerH <= 0.1) continue;

    const parentKey = seg.element_key || seg.id;

    // Check for curved void profiles
    const shape = seg.properties?.shape || 'rectangular';
    let voidProfile;
    if (shape === 'horseshoe') {
      voidProfile = { type: 'ARBITRARY', points: generateHorseshoePoints(innerW, innerH, 24) };
    } else if (shape === 'circular') {
      const innerR = (W / 2) - voidT;
      if (innerR > 0.1) {
        voidProfile = { type: 'ARBITRARY', points: generateCirclePoints(innerR, 32) };
      } else {
        voidProfile = { type: 'RECTANGLE', width: innerW, height: innerH };
      }
    } else {
      voidProfile = { type: 'RECTANGLE', width: innerW, height: innerH };
    }

    // R3: Use stable frame for void placement — now with correct bore axis
    const segDepth = geometry.depth || 0;
    const segOrigin = placement.origin || { x: 0, y: 0, z: 0 };
    const segStart = vecAdd(segOrigin, vecScale(axis, -segDepth / 2));
    const segEnd = vecAdd(segOrigin, vecScale(axis, segDepth / 2));
    // preferredUp=null: tangent is now the bore (not vertical), so world-up (0,0,1) is the correct up candidate
    const voidFrame = buildTunnelFrame(segStart, segEnd, null);
    const side = voidFrame ? voidFrame.lateral : vecNormalize(vecCross(axis, { x: 0, y: 0, z: 1 }));

    const voidGeometry = {
      method: 'EXTRUSION',
      direction: { x: 0, y: 0, z: 1 },
      depth: depth,
      profile: voidProfile
    };

    const voidPlacement = {
      origin: { ...(placement.origin || { x: 0, y: 0, z: 0 }) },
      axis: { ...axis },
      refDirection: side || placement.refDirection || { x: 1, y: 0, z: 0 }
    };

    derivedElements.push({
      id: elemId(voidGeometry, voidPlacement),
      element_key: `${parentKey}_void`,
      type: 'SPACE',
      name: seg.name || parentKey,
      semanticType: 'IfcSpace',
      confidence: 0.85,
      source: seg.source || 'VSM',
      container: seg.container,
      placement: voidPlacement,
      geometry: voidGeometry,
      material: { name: 'space', color: [0.88, 0.88, 0.88], transparency: 0.7 },
      properties: {
        derivedFromBranch: parentKey,
        shellPiece: 'VOID',
        decompositionMethod: 'skeleton_first_v1',
        shellThickness_m: voidT,
        shellThicknessBasis: 'DERIVED',
        usedDefaultThickness: false,
        entry_node: seg.properties?.entry_node,
        exit_node: seg.properties?.exit_node,
        branchClass: 'STRUCTURAL'
      },
      relationships: []
    });
    voidCount++;
  }

  // Step C: Equipment containment linking (reuse finite-segment centerline matching)
  const EPS = 1e-9;
  const voidSpaces = [];
  for (const d of derivedElements) {
    if (d.properties?.shellPiece !== 'VOID') continue;
    const o = d.placement?.origin;
    const ax = d.placement?.axis;
    const vDepth = d.geometry?.depth || 0;
    if (!o || !ax || vDepth <= 0) continue;
    const axLen = Math.sqrt(ax.x * ax.x + ax.y * ax.y + ax.z * ax.z);
    if (!Number.isFinite(axLen) || axLen < EPS) continue;
    voidSpaces.push({
      key: d.element_key,
      branchKey: d.properties.derivedFromBranch,
      cx: o.x, cy: o.y, cz: o.z,
      ax: ax.x / axLen, ay: ax.y / axLen, az: ax.z / axLen,
      halfDepth: vDepth / 2
    });
  }

  let infrastructureLinkedCount = 0;
  const MAX_CONTAINMENT_DISTANCE = 10;
  const ALONG_AXIS_TOLERANCE = 2.0;

  for (const elem of css.elements) {
    if ((elem.type || '').toUpperCase() !== 'EQUIPMENT') continue;
    const eqOrigin = elem.placement?.origin;
    if (!eqOrigin || voidSpaces.length === 0) continue;

    let bestKey = null, bestBranchKey = null, bestDist = Infinity, bestAbsT = Infinity;
    for (const vs of voidSpaces) {
      const dx = eqOrigin.x - vs.cx, dy = eqOrigin.y - vs.cy, dz = eqOrigin.z - vs.cz;
      const t = dx * vs.ax + dy * vs.ay + dz * vs.az;
      if (Math.abs(t) > vs.halfDepth + ALONG_AXIS_TOLERANCE) continue;
      const tc = Math.max(-vs.halfDepth, Math.min(vs.halfDepth, t));
      const cpx = vs.cx + tc * vs.ax, cpy = vs.cy + tc * vs.ay, cpz = vs.cz + tc * vs.az;
      const dist = Math.sqrt((eqOrigin.x - cpx) ** 2 + (eqOrigin.y - cpy) ** 2 + (eqOrigin.z - cpz) ** 2);
      const absT = Math.abs(t);
      if (bestKey === null || dist < bestDist - EPS ||
          (Math.abs(dist - bestDist) <= EPS && absT < bestAbsT - EPS) ||
          (Math.abs(dist - bestDist) <= EPS && Math.abs(absT - bestAbsT) <= EPS && vs.key < bestKey)) {
        bestDist = dist; bestAbsT = absT; bestKey = vs.key; bestBranchKey = vs.branchKey;
      }
    }

    if (bestKey && bestDist <= MAX_CONTAINMENT_DISTANCE) {
      if (!elem.metadata) elem.metadata = {};
      elem.metadata.hostSpaceKey = bestKey;
      elem.metadata.hostSpaceDistance = Math.round(bestDist * 100) / 100;
      elem.metadata.hostVoidSpaceKeyMatched = bestKey;
      elem.metadata.hostStructuralBranchMatched = bestBranchKey;
      infrastructureLinkedCount++;
    }
  }

  // Append derived elements
  for (const de of derivedElements) {
    if (!de.provenance) {
      de.provenance = { sourceFile: null, sourceFileStatus: 'derived_geometric', sourceFiles: [], stage: 'topology:decomposeTunnelShell', modifications: [] };
    }
  }
  css.elements.push(...derivedElements);

  if (!css.metadata) css.metadata = {};
  css.metadata.tunnelDecomposition = {
    method: 'skeleton_first_v2_guarded',
    runCount: css.runs.length,
    runFallbackCount,
    shellPieceCount,
    voidCount,
    curvedShellCount,
    infrastructureLinkedCount,
    derivedShellPieceCount: derivedElements.length
  };

  console.log(`decomposeMergedRuns: ${shellPieceCount} shell pieces from ${css.runs.length} runs, ${voidCount} voids, ${infrastructureLinkedCount} equipment linked`);
}


function trimShellsAtJunctions(css) {
  if (!css.runs || css.runs.length === 0) return;
  if (!css.skeleton) return;

  const { nodes } = css.skeleton;
  let trimmedCount = 0;
  let skippedParallel = 0;
  let skippedTooShort = 0;
  let warnedAggressiveTrim = 0;

  // Build run lookup by node
  const runsByNode = {};  // nodeId → [{ run, endType: 'start'|'end' }]
  for (const run of css.runs) {
    if (!runsByNode[run.startNode]) runsByNode[run.startNode] = [];
    runsByNode[run.startNode].push({ run, endType: 'start' });
    if (!runsByNode[run.endNode]) runsByNode[run.endNode] = [];
    runsByNode[run.endNode].push({ run, endType: 'end' });
  }

  // Compute trim planes at each non-continuation node with degree >= 2
  const trimPlanes = {};  // nodeId → Map<runId, trimPlane>
  const allJunctionBendNodes = new Set([...(css.junctionNodes || [])]);

  // Also find bend nodes (degree-2 but non-continuation)
  for (const node of Object.values(nodes)) {
    if (node.degree === 2 && !allJunctionBendNodes.has(node.id)) {
      const runsAtNode = runsByNode[node.id] || [];
      if (runsAtNode.length >= 2) allJunctionBendNodes.add(node.id); // bend node
    }
  }

  for (const nodeId of allJunctionBendNodes) {
    const node = nodes[nodeId];
    if (!node) continue;
    const runsAtNode = runsByNode[nodeId] || [];
    if (runsAtNode.length < 2) continue;

    // Compute direction each run points AWAY from this node
    const runDirs = [];
    for (const { run, endType } of runsAtNode) {
      // If this node is the start of the run, run points from start→end (axis direction)
      // If this node is the end of the run, run points from end→start (reverse axis)
      const awayDir = endType === 'start' ? run.mergedAxis : vecScale(run.mergedAxis, -1);
      runDirs.push({ runId: run.id, dir: awayDir, run, endType });
    }

    const perRunPlanes = {};

    if (node.hardError) {
      // Hard error: perpendicular cut at node position only
      for (const { runId, dir } of runDirs) {
        perRunPlanes[runId] = { normal: vecNormalize(dir), point: node.position };
      }
    } else if (runDirs.length === 2) {
      // Degree-2 bend: single bisector plane
      const plane = computeBisectorPlane(runDirs[0].dir, runDirs[1].dir, node.position);
      if (plane) {
        perRunPlanes[runDirs[0].runId] = plane;
        perRunPlanes[runDirs[1].runId] = plane;
      }
    } else {
      // Degree-3+: per-run trim = bisector with most-opposing neighbor
      for (const rd of runDirs) {
        let bestPlane = null;
        let bestDot = 1; // most-opposing = smallest dot product

        for (const other of runDirs) {
          if (other.runId === rd.runId) continue;
          const d = vecDot(rd.dir, other.dir);
          if (d < bestDot) {
            bestDot = d;
            const plane = computeBisectorPlane(rd.dir, other.dir, node.position);
            if (plane) bestPlane = plane;
          }
        }

        if (bestPlane) {
          // Undercut guard: verify this plane doesn't trim too aggressively
          // The plane should face toward the run (positive dot with run's approaching direction)
          const approachDir = vecScale(rd.dir, -1); // direction toward the node
          const planeFacing = vecDot(approachDir, bestPlane.normal);
          if (planeFacing < -0.1) {
            // Plane faces wrong way — fall back to perpendicular cut
            perRunPlanes[rd.runId] = { normal: vecNormalize(rd.dir), point: node.position };
          } else {
            perRunPlanes[rd.runId] = bestPlane;
          }
        } else {
          // Fallback: perpendicular cut at node position
          perRunPlanes[rd.runId] = { normal: vecNormalize(rd.dir), point: node.position };
        }
      }
    }

    trimPlanes[nodeId] = perRunPlanes;
  }

  // Apply trim to shell pieces
  const shellPieces = css.elements.filter(e =>
    e.properties?.shellPiece &&
    e.properties?.shellPiece !== 'VOID' &&
    e.properties?.runId
  );

  for (const piece of shellPieces) {
    const runId = piece.properties.runId;
    const entryNode = piece.properties.entry_node;
    const exitNode = piece.properties.exit_node;
    const axis = vecNormalize(piece.placement?.axis);
    if (!axis || !piece.placement?.origin) continue;

    const depth = piece.geometry?.depth || 0;
    if (depth <= 0) continue;

    // Try trimming at both ends
    for (const [nodeId, isExitEnd] of [[entryNode, false], [exitNode, true]]) {
      if (!nodeId || !trimPlanes[nodeId] || !trimPlanes[nodeId][runId]) continue;

      const plane = trimPlanes[nodeId][runId];
      const t = intersectLineWithPlane(piece.placement.origin, axis, plane.point, plane.normal);
      if (t === null) { skippedParallel++; continue; }

      // Compute new depth keeping far end fixed
      let newDepth;
      if (isExitEnd) {
        // Trimming exit (positive) end: far end is at origin - axis*depth/2
        newDepth = t + depth / 2;
      } else {
        // Trimming entry (negative) end: far end is at origin + axis*depth/2
        newDepth = depth / 2 - t;
      }

      // Safety rules
      if (newDepth >= depth) continue; // would extend, not trim
      if (newDepth < 0.1) { skippedTooShort++; continue; } // too short
      if (newDepth < depth * 0.6) {
        warnedAggressiveTrim++;
        console.warn(`trimShellsAtJunctions: aggressive trim on ${piece.element_key} at node ${nodeId}: ${depth.toFixed(2)}→${newDepth.toFixed(2)}`);
      }

      // Apply trim: keep far end fixed, adjust origin
      const farEnd = isExitEnd
        ? vecAdd(piece.placement.origin, vecScale(axis, -depth / 2))  // entry end stays
        : vecAdd(piece.placement.origin, vecScale(axis, depth / 2));  // exit end stays
      const trimmedEnd = vecAdd(piece.placement.origin, vecScale(axis, t));

      piece.geometry.depth = newDepth;
      piece.placement.origin = {
        x: (farEnd.x + trimmedEnd.x) / 2,
        y: (farEnd.y + trimmedEnd.y) / 2,
        z: (farEnd.z + trimmedEnd.z) / 2
      };

      if (!piece.properties) piece.properties = {};
      piece.properties.trimmedAtNode = nodeId;
      piece.properties.trimAmount = +(depth - newDepth).toFixed(4);
      piece.properties.originalDepth = depth;
      trimmedCount++;
    }
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.shellTrimming = {
    trimmedPieceCount: trimmedCount,
    skippedParallel,
    skippedTooShort,
    aggressiveTrimWarnings: warnedAggressiveTrim,
    junctionBendNodes: allJunctionBendNodes.size
  };

  console.log(`trimShellsAtJunctions: ${trimmedCount} pieces trimmed at ${allJunctionBendNodes.size} nodes (${skippedParallel} parallel, ${skippedTooShort} too-short, ${warnedAggressiveTrim} aggressive)`);
}


function generateJunctionFills(css) {
  if (!css.skeleton || !css.runs) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const { nodes } = css.skeleton;
  // Thickness is derived per-element from profile dimensions; this is a working default
  // for fill geometry that doesn't yet have a profile assigned.
  const WALL_THICKNESS = deriveThickness(2.0, 2.0);
  const GAP_THRESHOLD = 0.05;
  const FILL_MARGIN = 0.05;
  const fillElements = [];
  let fillCount = 0;

  // Collect trimmed shell piece endpoints at each junction/bend node
  const allJunctionBendNodes = new Set([...(css.junctionNodes || [])]);
  // Also find bend nodes
  const runsByNode = {};
  for (const run of css.runs) {
    if (!runsByNode[run.startNode]) runsByNode[run.startNode] = [];
    runsByNode[run.startNode].push(run);
    if (!runsByNode[run.endNode]) runsByNode[run.endNode] = [];
    runsByNode[run.endNode].push(run);
  }
  for (const node of Object.values(nodes)) {
    if (node.degree === 2 && (runsByNode[node.id] || []).length >= 2) {
      allJunctionBendNodes.add(node.id);
    }
  }

  const SHELL_ROLES = ['LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'];
  const ROLE_TYPE_MAP = {
    'LEFT_WALL': { type: 'WALL', semanticType: 'IfcWall' },
    'RIGHT_WALL': { type: 'WALL', semanticType: 'IfcWall' },
    'FLOOR': { type: 'SLAB', semanticType: 'IfcSlab', slabType: 'FLOOR' },
    'ROOF': { type: 'SLAB', semanticType: 'IfcSlab', slabType: 'ROOF' }
  };

  for (const nodeId of allJunctionBendNodes) {
    const node = nodes[nodeId];
    if (!node) continue;

    // Find all shell piece endpoints at this node
    const shellPieces = css.elements.filter(e =>
      e.properties?.shellPiece &&
      e.properties.shellPiece !== 'VOID' &&
      (e.properties.entry_node === nodeId || e.properties.exit_node === nodeId)
    );

    // Group by role
    for (const role of SHELL_ROLES) {
      const rolePieces = shellPieces.filter(p => p.properties.shellPiece === role);
      if (rolePieces.length < 2) continue;

      // Compute endpoints at this node
      const endpoints = [];
      for (const piece of rolePieces) {
        const ax = vecNormalize(piece.placement?.axis);
        if (!ax || !piece.placement?.origin) continue;
        const d = piece.geometry?.depth || 0;
        const isEntry = piece.properties.entry_node === nodeId;
        const endpoint = vecAdd(piece.placement.origin, vecScale(ax, isEntry ? -d / 2 : d / 2));
        endpoints.push(endpoint);
      }

      if (endpoints.length < 2) continue;

      // Measure max gap between any two endpoints
      let maxGap = 0;
      for (let i = 0; i < endpoints.length; i++) {
        for (let j = i + 1; j < endpoints.length; j++) {
          maxGap = Math.max(maxGap, vecDist(endpoints[i], endpoints[j]));
        }
      }

      if (maxGap <= GAP_THRESHOLD) continue;

      // Generate role-aware fill
      const center = {
        x: endpoints.reduce((s, p) => s + p.x, 0) / endpoints.length,
        y: endpoints.reduce((s, p) => s + p.y, 0) / endpoints.length,
        z: endpoints.reduce((s, p) => s + p.z, 0) / endpoints.length
      };

      const fillDepth = maxGap + FILL_MARGIN;
      // Use average axis from incident runs for fill orientation
      const runsHere = runsByNode[nodeId] || [];
      let avgAxis = { x: 0, y: 0, z: 0 };
      for (const r of runsHere) {
        const dir = r.startNode === nodeId ? r.mergedAxis : vecScale(r.mergedAxis, -1);
        avgAxis = vecAdd(avgAxis, dir);
      }
      const fillAxis = vecNormalize(avgAxis) || { x: 0, y: 0, z: 1 };

      const roleInfo = ROLE_TYPE_MAP[role] || { type: 'PROXY', semanticType: 'IfcBuildingElementProxy' };

      // Determine fill profile — use first run's cross-section data
      const firstRun = runsHere[0];
      const W = firstRun?.W || 4;
      const H = firstRun?.H || 3;
      const t = WALL_THICKNESS;

      let fillProfile;
      if (role === 'LEFT_WALL' || role === 'RIGHT_WALL') {
        fillProfile = { type: 'RECTANGLE', width: t, height: H };
      } else {
        fillProfile = { type: 'RECTANGLE', width: W - 2 * t, height: t };
      }

      const fillGeometry = {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: fillDepth,
        profile: fillProfile
      };

      const fillPlacement = {
        origin: center,
        axis: fillAxis,
        refDirection: firstRun?.refDirection || { x: 1, y: 0, z: 0 }
      };

      fillElements.push({
        id: elemId(fillGeometry, fillPlacement),
        element_key: `jfill_${nodeId}_${role.toLowerCase()}`,
        type: roleInfo.type,
        name: `Junction Fill ${role} at ${nodeId}`,
        semanticType: roleInfo.semanticType,
        confidence: 0.2,
        source: 'GENERATED',
        container: firstRun?.container,
        placement: fillPlacement,
        geometry: fillGeometry,
        material: { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0.0 },
        properties: {
          isTransitionHelper: true,
          isApproximation: true,
          shellPiece: role,
          junctionNodeId: nodeId,
          fillGap: +maxGap.toFixed(4),
          branchClass: 'STRUCTURAL',
          ...(roleInfo.slabType ? { slabType: roleInfo.slabType } : {})
        },
        relationships: []
      });
      fillCount++;
    }

    // Companion void at junction (if voids exist nearby)
    const nearbyVoids = css.elements.filter(e =>
      e.properties?.shellPiece === 'VOID' &&
      (e.properties.entry_node === nodeId || e.properties.exit_node === nodeId)
    );

    if (nearbyVoids.length >= 2) {
      const runsHere = runsByNode[nodeId] || [];
      const firstRun = runsHere[0];
      const W = firstRun?.W || 4;
      const H = firstRun?.H || 3;
      const t = WALL_THICKNESS;
      const innerW = W - 2 * t;
      const innerH = H - 2 * t;

      if (innerW > 0.1 && innerH > 0.1) {
        const voidCenter = node.position;
        const voidDepth = 0.5; // small junction void
        const fillAxis = vecNormalize(runsByNode[nodeId]?.[0]?.mergedAxis || { x: 0, y: 0, z: 1 }) || { x: 0, y: 0, z: 1 };
        const voidGeometry = {
          method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 },
          depth: voidDepth,
          profile: { type: 'RECTANGLE', width: innerW, height: innerH }
        };
        const voidPlacement = {
          origin: voidCenter, axis: fillAxis,
          refDirection: firstRun?.refDirection || { x: 1, y: 0, z: 0 }
        };
        fillElements.push({
          id: elemId(voidGeometry, voidPlacement),
          element_key: `jfill_${nodeId}_void`,
          type: 'SPACE', name: `Junction Void at ${nodeId}`,
          semanticType: 'IfcSpace', confidence: 0.2,
          source: 'GENERATED', container: firstRun?.container,
          placement: voidPlacement, geometry: voidGeometry,
          material: { name: 'space', color: [0.88, 0.88, 0.88], transparency: 0.7 },
          properties: { isTransitionHelper: true, isApproximation: true, shellPiece: 'VOID', junctionNodeId: nodeId, branchClass: 'STRUCTURAL' },
          relationships: []
        });
      }
    }
  }

  for (const fe of fillElements) {
    if (!fe.provenance) {
      fe.provenance = { sourceFile: null, sourceFileStatus: 'derived_geometric', sourceFiles: [], stage: 'topology:generateJunctionTransitions', modifications: [] };
    }
  }
  css.elements.push(...fillElements);

  if (!css.metadata) css.metadata = {};
  css.metadata.junctionFills = {
    fillCount,
    junctionBendNodes: allJunctionBendNodes.size,
    totalFillElements: fillElements.length
  };

  console.log(`generateJunctionFills: ${fillCount} fills at ${allJunctionBendNodes.size} nodes (${fillElements.length} total elements)`);
}


// ============================================================================
// PIECE-FIRST GEOMETRY PIPELINE (v1 — deprecated, behind feature flag)
// ============================================================================

function decomposeTunnelShell(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') {
    console.log('decomposeTunnelShell: skipping non-TUNNEL domain');
    return;
  }

  let decomposedBranchCount = 0;
  let skippedCircularCount = 0;
  let skippedDuctCount = 0;
  let skippedSmallSegments = 0;
  let skippedAlreadyDecomposed = 0;
  let skippedInvalidPlacement = 0;
  let defaultedThicknessCount = 0;
  let segmentFallbackCount = 0;
  let thicknessSanityFailCount = 0;

  for (const elem of css.elements) {
    if (elem.type !== 'TUNNEL_SEGMENT') continue;

    const props = elem.properties || {};

    // Skip ducts/airways
    if (props.branchClass !== 'STRUCTURAL') {
      skippedDuctCount++;
      continue;
    }

    // Duplicate-decomposition guard: skip when ANY of these already exist
    if (props.decompositionMethod || props.derivedFromBranch || props.shellPiece) {
      skippedAlreadyDecomposed++;
      continue;
    }

    // ---- R1: Eligibility check ----
    const eligibility = canDecomposeTunnelSegment(elem);
    if (!eligibility.eligible) {
      // SEGMENT_FALLBACK: keep as single segment, do not decompose
      segmentFallbackCount++;

      // element_key backfill
      if (!elem.element_key) {
        elem.element_key = elemId(elem.geometry || {}, elem.placement || {});
      }

      // Mark the element with fallback provenance + shell metadata
      if (!elem.properties) elem.properties = {};
      elem.properties.decompositionMethod = 'SEGMENT_FALLBACK';
      elem.properties.fallbackReasons = eligibility.reasons;
      const _fbW = elem.geometry?.profile?.width || 1;
      const _fbH = elem.geometry?.profile?.height || 1;
      const _fbT = deriveThickness(_fbW, _fbH, elem.properties?.material);
      elem.properties.shellThicknessBasis = 'DERIVED';
      elem.properties.shellThickness_m = _fbT;
      elem.properties.shellMode = 'HOLLOW_PROFILE';
      if (elem.geometry?.profile) {
        elem.geometry.profile.wallThickness = _fbT;
      }
      // Lower confidence for fallback elements
      elem.confidence = Math.min(elem.confidence || 0.7, 0.45);

      // Part C: Set ARCH profile for structural tunnel segments
      // This flows through to the IFC generator which renders arched extrusions
      const placement = elem.placement || {};
      const geometry = elem.geometry || {};
      if (props.branchClass === 'STRUCTURAL' && geometry.profile?.type === 'RECTANGLE') {
        // Always use ARCH for structural segments — IfcRectangleHollowProfileDef
        // crashes web-ifc WASM parser. Use low curveRatio for rectangular shapes.
        geometry.profile.type = 'ARCH';
        geometry.profile.curveRatio = props.shape === 'rectangular' ? 0.01 : 0.3;
      }

      // F4: Populate geometry.path from entry/exit points so the element
      // carries real path data instead of path:null
      const axis = placement.axis ? vecNormalize(placement.axis) : null;
      const depth = geometry.depth || 0;
      if (axis && placement.origin && depth > 0) {
        const entryPt = vecAdd(placement.origin, vecScale(axis, -depth / 2));
        const exitPt = vecAdd(placement.origin, vecScale(axis, depth / 2));
        if (!geometry.path) {
          geometry.path = [
            { x: +entryPt.x.toFixed(4), y: +entryPt.y.toFixed(4), z: +entryPt.z.toFixed(4) },
            { x: +exitPt.x.toFixed(4), y: +exitPt.y.toFixed(4), z: +exitPt.z.toFixed(4) }
          ];
        }
      }

      console.log(`SEGMENT_FALLBACK: ${elem.element_key || elem.id} — reasons: ${eligibility.reasons.join(', ')}`);
      continue;
    }

    // Handle non-rectangular tunnels: normalize profile to RECTANGLE for hollow generation
    const shape = props.shape || '';
    const profileType = elem.geometry?.profile?.type || '';
    let isApproximated = false;
    let approximationType = null;

    // ---- R2: Determine thickness ----
    // Prefer explicit thickness data from properties; derive from profile if absent.
    const _elemW = elem.geometry?.profile?.width || 1;
    const _elemH = elem.geometry?.profile?.height || 1;
    let WALL_THICKNESS = deriveThickness(_elemW, _elemH, props.material);
    let thicknessBasis = 'DERIVED';
    let usedDefaultThickness = false;

    const explicitThickness = props.wallThickness || props.shellThickness ||
      props.liningThickness || elem.geometry?.profile?.thickness;
    if (explicitThickness && explicitThickness > 0) {
      WALL_THICKNESS = explicitThickness;
      thicknessBasis = 'EXPLICIT';
      usedDefaultThickness = false;
    }

    // A1 fix: skip normalization if profile is already ARCH (set by applyTextDerivedHeights).
    // Previously, non-fallback segments with ARCH profile (horseshoe tunnel) had it overwritten
    // to RECTANGLE here, causing one segment to render as a flat box instead of arch cross-section.
    if (shape !== 'rectangular' && profileType !== 'RECTANGLE' && profileType !== 'ARCH') {
      const profile = elem.geometry?.profile || {};
      if (profile.radius && profile.radius > 0) {
        const diameter = profile.radius * 2;
        profile.width = diameter;
        profile.height = diameter;
        profile.type = 'RECTANGLE';
        isApproximated = true;
        approximationType = shape === 'horseshoe' ? 'HORSESHOE_TO_RECT' : 'CIRCULAR_TO_RECT';
      } else if (profile.width && profile.height) {
        profile.type = 'RECTANGLE';
        isApproximated = true;
        approximationType = `${(shape || 'UNKNOWN').toUpperCase()}_TO_RECT`;
      } else {
        skippedCircularCount++;
        continue;
      }
    }

    // Required placement/geometry fields
    const placement = elem.placement || {};
    const geometry = elem.geometry || {};
    const profile = geometry.profile || {};
    const W = profile.width;
    const H = profile.height;
    const depth = geometry.depth;

    if (!placement.axis || !placement.refDirection || !W || !H || !depth) {
      skippedInvalidPlacement++;
      continue;
    }

    // Minimum dimension guard
    if (W <= 0.6 || H <= 0.6 || depth <= 0.5) {
      skippedSmallSegments++;
      continue;
    }

    // ---- R2: Thickness sanity check ----
    const thicknessCheck = validateShellThickness(WALL_THICKNESS, W, H);
    if (!thicknessCheck.valid) {
      thicknessSanityFailCount++;
      console.warn(`THICKNESS_SANITY_FAIL: ${elem.element_key || elem.id} — ${thicknessCheck.reason}, using fallback ${thicknessCheck.fallbackThickness}m`);
      WALL_THICKNESS = thicknessCheck.fallbackThickness;
      thicknessBasis = 'SANITY_FALLBACK';
      usedDefaultThickness = true;
    }

    // element_key backfill — the only allowed parent mutation
    if (!elem.element_key) {
      elem.element_key = elemId(geometry, placement);
    }

    // R3: frame available for validation but shell pieces no longer emitted

    // ---- Semantic annotation (no shell piece emission) ----
    // Instead of splitting into geometry fragments, annotate the parent segment
    // with shell metadata so the generator can build proper hollow solids.
    const t = WALL_THICKNESS;

    // Annotate the segment with shell contract fields
    if (!elem.properties) elem.properties = {};
    elem.properties.shellThickness_m = t;
    elem.properties.shellThicknessBasis = thicknessBasis;
    elem.properties.shellMode = 'HOLLOW_PROFILE';
    elem.properties.decompositionMethod = isApproximated
      ? `SEMANTIC_${approximationType || 'CURVED'}` : 'SEMANTIC_RECTANGULAR';

    // A1 fix (secondary guard): if applyTextDerivedHeights did not run (no DOCX shape data)
    // but the segment is non-rectangular (horseshoe/arch facility), set ARCH with curveRatio=0.3
    // so generate renders the correct arch cross-section instead of a flat rectangular box.
    // This mirrors the SEGMENT_FALLBACK ARCH assignment above for eligible (non-fallback) segments.
    const _finalProfileType = elem.geometry?.profile?.type || 'RECTANGLE';
    if (_finalProfileType === 'RECTANGLE' && shape !== 'rectangular') {
      if (elem.geometry?.profile) {
        elem.geometry.profile.type = 'ARCH';
        elem.geometry.profile.curveRatio = 0.3;
      }
    }

    // Backfill geometry.path from frame if not present
    if (!elem.geometry.path) {
      const bearing = getTunnelBearing(elem);
      if (bearing && placement.origin && depth > 0) {
        elem.geometry.path = [
          { x: +placement.origin.x.toFixed(4), y: +placement.origin.y.toFixed(4), z: +placement.origin.z.toFixed(4) },
          { x: +(placement.origin.x + bearing.x * depth).toFixed(4),
            y: +(placement.origin.y + bearing.y * depth).toFixed(4),
            z: +(placement.origin.z + bearing.z * depth).toFixed(4) }
        ];
      }
    }

    // Ensure profile carries wallThickness for hollow generation
    if (elem.geometry.profile) {
      elem.geometry.profile.wallThickness = t;
    }

    // Lower confidence when using default thickness
    if (usedDefaultThickness) {
      elem.confidence = Math.min(elem.confidence || 0.7, 0.6);
    }

    decomposedBranchCount++;
  }

  // Log annotation results
  if (decomposedBranchCount > 0) {
    console.log(`Tunnel semantic annotation: ${decomposedBranchCount} segments annotated with shell metadata`);
  }

  // ---- Segment-based equipment matching ----
  // Match EQUIPMENT to nearest annotated structural tunnel segment by distance
  // to segment centerline. Uses the segment itself (not void pieces) as authority.
  const EPS = 1e-9;
  const segmentCenterlines = [];
  for (const seg of css.elements) {
    if (seg.type !== 'TUNNEL_SEGMENT') continue;
    if ((seg.properties?.branchClass || '') !== 'STRUCTURAL') continue;
    const o = seg.placement?.origin;
    if (!o) continue;
    const bearing = getTunnelBearing(seg);
    if (!bearing) continue;
    const depth = seg.geometry?.depth || 0;
    if (depth <= 0) continue;
    const key = seg.element_key || seg.id;
    const bLen = Math.sqrt(bearing.x * bearing.x + bearing.y * bearing.y + bearing.z * bearing.z);
    const bx = bLen > EPS ? bearing.x / bLen : 0;
    const by = bLen > EPS ? bearing.y / bLen : 0;
    const bz = bLen > EPS ? bearing.z / bLen : 0;
    segmentCenterlines.push({
      key, cx: o.x, cy: o.y, cz: o.z,
      ax: bx, ay: by, az: bz,
      halfDepth: depth / 2,
      innerW: (seg.geometry?.profile?.width || 5) - 2 * (seg.properties?.shellThickness_m || deriveThickness(seg.geometry?.profile?.width || 5, seg.geometry?.profile?.height || 5, seg.properties?.material)),
      innerH: (seg.geometry?.profile?.height || 5) - 2 * (seg.properties?.shellThickness_m || deriveThickness(seg.geometry?.profile?.width || 5, seg.geometry?.profile?.height || 5, seg.properties?.material))
    });
  }

  let infrastructureLinkedCount = 0;
  let noSegmentAvailableCount = 0;
  const MAX_CONTAINMENT_DISTANCE = 10;
  const ALONG_AXIS_TOLERANCE = 2.0;

  for (const elem of css.elements) {
    if ((elem.type || '').toUpperCase() !== 'EQUIPMENT') continue;
    const eqOrigin = elem.placement?.origin;
    if (!eqOrigin) continue;
    if (segmentCenterlines.length === 0) { noSegmentAvailableCount++; continue; }

    let bestKey = null;
    let bestDist = Infinity;
    let bestAbsT = Infinity;
    for (const sc of segmentCenterlines) {
      const dx = eqOrigin.x - sc.cx;
      const dy = eqOrigin.y - sc.cy;
      const dz = eqOrigin.z - sc.cz;
      const t = dx * sc.ax + dy * sc.ay + dz * sc.az;
      if (Math.abs(t) > sc.halfDepth + ALONG_AXIS_TOLERANCE) continue;
      const tc = Math.max(-sc.halfDepth, Math.min(sc.halfDepth, t));
      const cpx = sc.cx + tc * sc.ax;
      const cpy = sc.cy + tc * sc.ay;
      const cpz = sc.cz + tc * sc.az;
      const dist = Math.sqrt((eqOrigin.x - cpx) ** 2 + (eqOrigin.y - cpy) ** 2 + (eqOrigin.z - cpz) ** 2);
      const absT = Math.abs(t);
      if (bestKey === null || dist < bestDist - EPS ||
          (Math.abs(dist - bestDist) <= EPS && absT < bestAbsT - EPS) ||
          (Math.abs(dist - bestDist) <= EPS && Math.abs(absT - bestAbsT) <= EPS && sc.key < bestKey)) {
        bestDist = dist; bestAbsT = absT; bestKey = sc.key;
      }
    }

    if (bestKey && bestDist <= MAX_CONTAINMENT_DISTANCE) {
      if (!elem.metadata) elem.metadata = {};
      elem.metadata.hostTunnelSegmentKeyMatched = bestKey;
      elem.metadata.hostStructuralBranchMatched = bestKey;
      elem.metadata.hostSegmentDistance = Math.round(bestDist * 100) / 100;
      infrastructureLinkedCount++;
    } else {
      noSegmentAvailableCount++;
    }
  }

  // ---- Cross-section clamping against segment interior ----
  const CLAMP_MARGIN = 0.25;
  let placementCorrectedCount = 0;

  for (const elem of css.elements) {
    if ((elem.type || '').toUpperCase() !== 'EQUIPMENT') continue;
    if (!elem.metadata?.hostTunnelSegmentKeyMatched) continue;
    const eqOrigin = elem.placement?.origin;
    if (!eqOrigin) continue;

    const sc = segmentCenterlines.find(s => s.key === elem.metadata.hostTunnelSegmentKeyMatched);
    if (!sc) continue;

    // Build local frame from bearing
    const A = { x: sc.ax, y: sc.ay, z: sc.az };
    // Lateral = cross(bearing, world-up) or fallback
    let R = vecNormalize(vecCross(A, { x: 0, y: 0, z: 1 }));
    if (!R) R = { x: 1, y: 0, z: 0 };
    const C = vecNormalize(vecCross(A, R));
    if (!C) continue;

    const dx = eqOrigin.x - sc.cx;
    const dy = eqOrigin.y - sc.cy;
    const dz = eqOrigin.z - sc.cz;
    const localAlong = dx * A.x + dy * A.y + dz * A.z;
    const localX = dx * R.x + dy * R.y + dz * R.z;
    const localY = dx * C.x + dy * C.y + dz * C.z;

    const halfW = Math.max(0, (sc.innerW / 2) - CLAMP_MARGIN);
    const halfH = Math.max(0, (sc.innerH / 2) - CLAMP_MARGIN);
    const halfD = sc.halfDepth;
    const clampedX = Math.max(-halfW, Math.min(halfW, localX));
    const clampedY = Math.max(-halfH, Math.min(halfH, localY));
    const clampedAlong = Math.max(-halfD, Math.min(halfD, localAlong));

    if (Math.abs(clampedX - localX) > 0.01 || Math.abs(clampedY - localY) > 0.01 || Math.abs(clampedAlong - localAlong) > 0.01) {
      elem.metadata.originalOrigin = { x: eqOrigin.x, y: eqOrigin.y, z: eqOrigin.z };
      elem.metadata.placementCorrected = true;
      elem.placement.origin = {
        x: sc.cx + clampedAlong * A.x + clampedX * R.x + clampedY * C.x,
        y: sc.cy + clampedAlong * A.y + clampedX * R.y + clampedY * C.y,
        z: sc.cz + clampedAlong * A.z + clampedX * R.z + clampedY * C.z
      };
      placementCorrectedCount++;
    }
  }

  if (placementCorrectedCount > 0) {
    console.log(`Cross-section clamping: ${placementCorrectedCount} equipment elements repositioned inside segments`);
  }

  // Track decomposition stats
  if (!css.metadata) css.metadata = {};
  css.metadata.tunnelDecomposition = {
    annotatedSegmentCount: decomposedBranchCount,
    segmentFallbackCount,
    skippedDuctCount,
    skippedSmallSegments,
    skippedAlreadyDecomposed,
    skippedInvalidPlacement,
    defaultedThicknessCount,
    thicknessSanityFailCount,
    infrastructureLinkedCount,
    noSegmentAvailableCount,
    segmentCenterlineCount: segmentCenterlines.length,
    wallThickness_m: 'derived-per-element',
    method: 'semantic_annotation_v1',
    placementCorrectedCount
  };

  console.log(`Tunnel semantic annotation: ${decomposedBranchCount} segments annotated, ${segmentFallbackCount} fallbacks | Equipment: ${infrastructureLinkedCount} linked to ${segmentCenterlines.length} segments (${noSegmentAvailableCount} unmatched) | Clamped: ${placementCorrectedCount}`);
}


// ============================================================================
// PHASE 1A-PRE: SHELL COMPLETENESS AUDIT
// Verifies all structural branches have required shell roles, reconstructs missing.
// ============================================================================

function auditShellCompleteness(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  // Thickness derived per-segment below; this default is only for reconstructed missing pieces
  // and will be replaced by the segment's own shellThickness_m when available.
  const REQUIRED_ROLES = ['LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'];

  const parentSegments = css.elements.filter(e =>
    e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL'
  );

  // Index existing shell pieces by branch+role
  const existingShells = new Map();
  for (const e of css.elements) {
    if (e.properties?.derivedFromBranch && e.properties?.shellPiece) {
      existingShells.set(`${e.properties.derivedFromBranch}__${e.properties.shellPiece}`, true);
    }
  }

  let completeCount = 0;
  let missingCount = 0;
  let reconstructedCount = 0;
  const reconstructed = [];

  for (const seg of parentSegments) {
    // F6: Do NOT reconstruct shell pieces for segments in SEGMENT_FALLBACK mode.
    // Those were intentionally kept as single segments due to insufficient evidence.
    if (seg.properties?.decompositionMethod === 'SEGMENT_FALLBACK') continue;

    const parentKey = seg.element_key || seg.id;
    const parentOrigin = seg.placement?.origin;
    const axis = getTunnelBearing(seg);
    if (!parentOrigin || !axis) continue;

    const W = seg.geometry?.profile?.width || 4;
    const H = seg.geometry?.profile?.height || 4;
    const depth = seg.geometry?.depth || 0;
    if (depth <= 0) continue;

    const t = WALL_THICKNESS;
    const up = { x: 0, y: 0, z: 1 };
    const side = vecNormalize(vecCross(axis, up)) || { x: 0, y: 1, z: 0 };

    let branchComplete = true;

    for (const role of REQUIRED_ROLES) {
      if (existingShells.has(`${parentKey}__${role}`)) continue;

      branchComplete = false;
      missingCount++;

      // Reconstruct missing shell piece using same logic as decomposeTunnelShell
      let offsetVec, profW, profH, cssType, semanticType, refDir;
      if (role === 'LEFT_WALL') {
        offsetVec = vecScale(side, -(W / 2 - t / 2));
        profW = t; profH = H - 2 * t; cssType = 'WALL'; semanticType = 'IfcWall'; refDir = side;
      } else if (role === 'RIGHT_WALL') {
        offsetVec = vecScale(side, (W / 2 - t / 2));
        profW = t; profH = H - 2 * t; cssType = 'WALL'; semanticType = 'IfcWall'; refDir = side;
      } else if (role === 'FLOOR') {
        offsetVec = vecScale(up, -(H / 2 - t / 2));
        profW = W; profH = t; cssType = 'SLAB'; semanticType = 'IfcSlab'; refDir = side;
      } else if (role === 'ROOF') {
        offsetVec = vecScale(up, (H / 2 - t / 2));
        profW = W; profH = t; cssType = 'SLAB'; semanticType = 'IfcSlab'; refDir = side;
      }

      if (profW <= 0 || profH <= 0) continue;

      const derivedOrigin = vecAdd(parentOrigin, offsetVec);
      const elem = {
        id: `reconstructed_${parentKey}_${role.toLowerCase()}`,
        element_key: `${parentKey}_${role.toLowerCase()}`,
        type: cssType,
        name: `${role} (reconstructed)`,
        semanticType,
        confidence: 0.5,
        source: 'SHELL_RECONSTRUCTION',
        container: seg.container,
        placement: { origin: derivedOrigin, axis: { ...axis }, refDirection: refDir || { x: 1, y: 0, z: 0 } },
        geometry: { method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth, profile: { type: 'RECTANGLE', width: profW, height: profH } },
        material: { name: 'concrete', color: [0.753, 0.753, 0.753], transparency: 0 },
        properties: { derivedFromBranch: parentKey, shellPiece: role, reconstructed: true, shellThickness_m: t, shellThicknessBasis: 'DEFAULT', decompositionMethod: 'shell_reconstruction_v1' },
        relationships: []
      };

      reconstructed.push(elem);
      reconstructedCount++;
    }

    if (branchComplete) completeCount++;
  }

  if (reconstructed.length > 0) {
    for (const re of reconstructed) {
      if (!re.provenance) {
        re.provenance = { sourceFile: null, sourceFileStatus: 'derived_geometric', sourceFiles: [], stage: 'topology:auditShellCompleteness', modifications: [] };
      }
    }
    css.elements.push(...reconstructed);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.shellCompleteness = { complete: completeCount, missing: missingCount, reconstructed: reconstructedCount, totalBranches: parentSegments.length };

  if (missingCount > 0) {
    console.log(`auditShellCompleteness: ${missingCount} missing shell roles, ${reconstructedCount} reconstructed, ${completeCount}/${parentSegments.length} branches complete`);
  }
}

// ============================================================================
// PHASE 1A-PRE2: CLOSURE TARGET COMPUTATION
// Computes per-role closure targets at each junction/bend node.
// ============================================================================

function computeClosureTargets(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const parentSegments = css.elements.filter(e =>
    e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL'
  );

  const nodeToParents = {};
  const segByKey = {};
  for (const seg of parentSegments) {
    const key = seg.element_key || seg.id;
    segByKey[key] = seg;
    const entry = seg.properties?.entry_node;
    const exit = seg.properties?.exit_node;
    if (entry) { if (!nodeToParents[entry]) nodeToParents[entry] = []; nodeToParents[entry].push(key); }
    if (exit) { if (!nodeToParents[exit]) nodeToParents[exit] = []; nodeToParents[exit].push(key); }
  }

  const SHELL_ROLES = ['LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'];
  const shellByBranchRole = new Map();
  for (const e of css.elements) {
    if (e.properties?.derivedFromBranch && e.properties?.shellPiece) {
      const key = `${e.properties.derivedFromBranch}__${e.properties.shellPiece}`;
      if (!shellByBranchRole.has(key)) shellByBranchRole.set(key, e);
    }
  }

  css.closureTargets = {};

  for (const [node, parents] of Object.entries(nodeToParents)) {
    if (parents.length < 2) continue;

    // Collect branch endpoints at this node
    const branchEndpoints = [];
    for (const parentKey of parents) {
      const seg = segByKey[parentKey];
      if (!seg?.placement?.origin) continue;
      const ax = getTunnelBearing(seg);
      if (!ax) continue;
      const depth = seg.geometry?.depth || 0;
      const isEntry = seg.properties?.entry_node === node;
      const endOffset = isEntry ? -depth / 2 : depth / 2;
      const endpoint = vecAdd(seg.placement.origin, vecScale(ax, endOffset));
      branchEndpoints.push({ key: parentKey, endpoint, axis: ax, depth, isEntry });
    }

    if (branchEndpoints.length < 2) continue;

    const degree = parents.length;

    // Compute closure target per role
    const roleTargets = {};

    if (degree === 2) {
      // Degree-2: use join plane (perpendicular bisector between two axes)
      const axA = branchEndpoints[0].axis;
      const axB = branchEndpoints[1].axis;
      const midpoint = {
        x: (branchEndpoints[0].endpoint.x + branchEndpoints[1].endpoint.x) / 2,
        y: (branchEndpoints[0].endpoint.y + branchEndpoints[1].endpoint.y) / 2,
        z: (branchEndpoints[0].endpoint.z + branchEndpoints[1].endpoint.z) / 2
      };
      const bisector = vecNormalize(vecAdd(axA, axB)) || axA;

      for (const role of SHELL_ROLES) {
        // For degree-2, closure target is the midpoint between the two branch endpoints
        // adjusted per shell role (perpendicular offset from centerline)
        const pieceA = shellByBranchRole.get(`${branchEndpoints[0].key}__${role}`);
        const pieceB = shellByBranchRole.get(`${branchEndpoints[1].key}__${role}`);

        if (pieceA && pieceB) {
          const depthA = pieceA.geometry?.depth || 0;
          const depthB = pieceB.geometry?.depth || 0;
          const axisA = vecNormalize(pieceA.placement?.axis);
          const axisB = vecNormalize(pieceB.placement?.axis);

          if (axisA && axisB && pieceA.placement?.origin && pieceB.placement?.origin) {
            const endA = vecAdd(pieceA.placement.origin, vecScale(axisA, branchEndpoints[0].isEntry ? -depthA / 2 : depthA / 2));
            const endB = vecAdd(pieceB.placement.origin, vecScale(axisB, branchEndpoints[1].isEntry ? -depthB / 2 : depthB / 2));
            roleTargets[role] = {
              point: { x: (endA.x + endB.x) / 2, y: (endA.y + endB.y) / 2, z: (endA.z + endB.z) / 2 },
              normal: bisector,
              source: 'JOIN_PLANE'
            };
          }
        }

        if (!roleTargets[role]) {
          roleTargets[role] = { point: midpoint, normal: bisector, source: 'CENTER_FALLBACK' };
        }
      }
    } else {
      // Degree-3+: weighted center based on branch depths
      const totalDepth = branchEndpoints.reduce((s, b) => s + b.depth, 0);
      const center = totalDepth > 0 ? {
        x: branchEndpoints.reduce((s, b) => s + b.endpoint.x * b.depth, 0) / totalDepth,
        y: branchEndpoints.reduce((s, b) => s + b.endpoint.y * b.depth, 0) / totalDepth,
        z: branchEndpoints.reduce((s, b) => s + b.endpoint.z * b.depth, 0) / totalDepth
      } : {
        x: branchEndpoints.reduce((s, b) => s + b.endpoint.x, 0) / branchEndpoints.length,
        y: branchEndpoints.reduce((s, b) => s + b.endpoint.y, 0) / branchEndpoints.length,
        z: branchEndpoints.reduce((s, b) => s + b.endpoint.z, 0) / branchEndpoints.length
      };

      // Check if existing transition elements provide a boundary
      const transitionElems = css.elements.filter(e =>
        e.properties?.isTransitionHelper && (e.properties?.junctionNodeId === node || e.properties?.bendNodeId === node)
      );

      for (const role of SHELL_ROLES) {
        if (transitionElems.length > 0) {
          // Use transition element boundary as target
          const transition = transitionElems[0];
          const tAxis = vecNormalize(transition.placement?.axis);
          const tDepth = transition.geometry?.depth || 0;
          if (tAxis && transition.placement?.origin && tDepth > 0) {
            roleTargets[role] = { point: { ...transition.placement.origin }, normal: tAxis, source: 'TRANSITION_BOUNDARY' };
            continue;
          }
        }
        roleTargets[role] = { point: center, normal: { x: 0, y: 0, z: 1 }, source: 'CENTER_FALLBACK' };
      }
    }

    css.closureTargets[node] = roleTargets;
  }

  const targetCount = Object.keys(css.closureTargets).length;
  if (targetCount > 0) {
    console.log(`computeClosureTargets: ${targetCount} closure target nodes computed`);
  }
}


// ============================================================================
// PHASE 1A: TUNNEL SHELL CONTINUITY ALIGNMENT
// Aligns adjacent shell pieces across branches without destroying semantics.
// Preserves: element_key, derivedFromBranch, shellPiece, assemblies, boundaries.
// Only micro-adjusts placement.origin and profile dimensions for zero-gap continuity.
// ============================================================================

function alignShellContinuity(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  // F6: Skip if no shell pieces were actually created (all segments in fallback)
  const shellPieceCount = css.elements.filter(e => e.properties?.shellPiece && e.properties.shellPiece !== 'VOID').length;
  if (shellPieceCount === 0) {
    console.log('alignShellContinuity: no shell pieces exist, skipping');
    return;
  }

  // Build adjacency from TUNNEL_SEGMENT entry/exit nodes
  const parentSegments = css.elements.filter(e => e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL');
  const shellPieces = css.elements.filter(e => e.properties?.shellPiece && e.properties?.derivedFromBranch);

  // Map: parentKey → segment element
  const segByKey = {};
  for (const seg of parentSegments) {
    const key = seg.element_key || seg.id;
    segByKey[key] = seg;
  }

  // Map: node → [parentKey, ...]
  const nodeToParents = {};
  for (const seg of parentSegments) {
    const key = seg.element_key || seg.id;
    const entry = seg.properties?.entry_node;
    const exit = seg.properties?.exit_node;
    if (entry) { if (!nodeToParents[entry]) nodeToParents[entry] = []; nodeToParents[entry].push(key); }
    if (exit) { if (!nodeToParents[exit]) nodeToParents[exit] = []; nodeToParents[exit].push(key); }
  }

  // Find adjacent pairs: branches sharing a node with exactly degree 2 (no junctions)
  const adjacentPairs = new Set();
  for (const [node, parents] of Object.entries(nodeToParents)) {
    if (parents.length === 2) {
      const sorted = [parents[0], parents[1]].sort();
      adjacentPairs.add(`${sorted[0]}||${sorted[1]}`);
    }
  }

  if (adjacentPairs.size === 0) {
    console.log('alignShellContinuity: no adjacent branch pairs found');
    return;
  }

  // Group shell pieces by derivedFromBranch + shellPiece role
  const shellByBranchRole = {};
  for (const sp of shellPieces) {
    const branch = sp.properties.derivedFromBranch;
    const role = sp.properties.shellPiece;
    const key = `${branch}__${role}`;
    shellByBranchRole[key] = sp;
  }

  let alignedPairs = 0;
  let dimensionSnaps = 0;
  let continuityGroupCounter = 0;
  const continuityGroups = {}; // groupId -> [element_key, ...]

  const SHELL_ROLES = ['LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF', 'VOID'];
  const AXIS_DOT_MIN = 0.996; // ~5 degrees
  const DIM_TOLERANCE = 0.15; // 15%

  for (const pairKey of adjacentPairs) {
    const [branchA, branchB] = pairKey.split('||');

    for (const role of SHELL_ROLES) {
      const pieceA = shellByBranchRole[`${branchA}__${role}`];
      const pieceB = shellByBranchRole[`${branchB}__${role}`];
      if (!pieceA || !pieceB) continue;

      const axisA = vecNormalize(pieceA.placement?.axis);
      const axisB = vecNormalize(pieceB.placement?.axis);
      if (!axisA || !axisB) continue;

      // Check axis alignment (within 5 degrees)
      const dot = Math.abs(vecDot(axisA, axisB));
      if (dot < AXIS_DOT_MIN) continue;

      // Check cross-section similarity (within 15%)
      const wA = pieceA.geometry?.profile?.width || 0;
      const hA = pieceA.geometry?.profile?.height || 0;
      const wB = pieceB.geometry?.profile?.width || 0;
      const hB = pieceB.geometry?.profile?.height || 0;
      if (wA > 0 && wB > 0 && Math.abs(wA - wB) / Math.max(wA, wB) > DIM_TOLERANCE) continue;
      if (hA > 0 && hB > 0 && Math.abs(hA - hB) / Math.max(hA, hB) > DIM_TOLERANCE) continue;

      // Snap cross-section dimensions to average
      if (wA > 0 && wB > 0 && wA !== wB) {
        const avgW = (wA + wB) / 2;
        pieceA.geometry.profile.width = avgW;
        pieceB.geometry.profile.width = avgW;
        dimensionSnaps++;
      }
      if (hA > 0 && hB > 0 && hA !== hB) {
        const avgH = (hA + hB) / 2;
        pieceA.geometry.profile.height = avgH;
        pieceB.geometry.profile.height = avgH;
        dimensionSnaps++;
      }

      // Snap endpoints to eliminate micro-gaps
      // Piece endpoint = origin + axis * depth/2
      // Piece startpoint = origin - axis * depth/2
      const depthA = pieceA.geometry?.depth || 0;
      const depthB = pieceB.geometry?.depth || 0;
      if (depthA <= 0 || depthB <= 0) continue;

      const oA = pieceA.placement.origin;
      const oB = pieceB.placement.origin;

      // Find which ends are closest (A_end to B_start or A_start to B_end)
      const endA = vecAdd(oA, vecScale(axisA, depthA / 2));
      const startA = vecAdd(oA, vecScale(axisA, -depthA / 2));
      const endB = vecAdd(oB, vecScale(axisB, depthB / 2));
      const startB = vecAdd(oB, vecScale(axisB, -depthB / 2));

      const dEndAStartB = Math.sqrt((endA.x - startB.x) ** 2 + (endA.y - startB.y) ** 2 + (endA.z - startB.z) ** 2);
      const dStartAEndB = Math.sqrt((startA.x - endB.x) ** 2 + (startA.y - endB.y) ** 2 + (startA.z - endB.z) ** 2);

      // Only snap if gap is small (< 0.5m)
      const minGap = Math.min(dEndAStartB, dStartAEndB);
      if (minGap > 0.5) continue;

      if (dEndAStartB <= dStartAEndB && dEndAStartB > 0.001) {
        // Snap endA → startB: shift both origins slightly
        const mid = { x: (endA.x + startB.x) / 2, y: (endA.y + startB.y) / 2, z: (endA.z + startB.z) / 2 };
        // New origin A: mid - axis * depthA/2
        pieceA.placement.origin = vecAdd(mid, vecScale(axisA, -depthA / 2));
        // New origin B: mid + axis * depthB/2
        pieceB.placement.origin = vecAdd(mid, vecScale(axisB, depthB / 2));
      } else if (dStartAEndB > 0.001) {
        const mid = { x: (startA.x + endB.x) / 2, y: (startA.y + endB.y) / 2, z: (startA.z + endB.z) / 2 };
        pieceA.placement.origin = vecAdd(mid, vecScale(axisA, depthA / 2));
        pieceB.placement.origin = vecAdd(mid, vecScale(axisB, -depthB / 2));
      }

      // Assign continuity group
      const existingGroupA = pieceA.properties.continuityGroupId;
      const existingGroupB = pieceB.properties.continuityGroupId;
      let groupId;
      if (existingGroupA) { groupId = existingGroupA; }
      else if (existingGroupB) { groupId = existingGroupB; }
      else { groupId = `cg-${role.toLowerCase()}-${continuityGroupCounter++}`; }

      pieceA.properties.continuityGroupId = groupId;
      pieceB.properties.continuityGroupId = groupId;
      if (!pieceA.properties.adjacentShellKeys) pieceA.properties.adjacentShellKeys = [];
      if (!pieceB.properties.adjacentShellKeys) pieceB.properties.adjacentShellKeys = [];
      if (!pieceA.properties.adjacentShellKeys.includes(pieceB.element_key)) pieceA.properties.adjacentShellKeys.push(pieceB.element_key);
      if (!pieceB.properties.adjacentShellKeys.includes(pieceA.element_key)) pieceB.properties.adjacentShellKeys.push(pieceA.element_key);

      if (!continuityGroups[groupId]) continuityGroups[groupId] = new Set();
      continuityGroups[groupId].add(pieceA.element_key);
      continuityGroups[groupId].add(pieceB.element_key);

      alignedPairs++;
    }
  }

  // Phase 3D: Dimension averaging + endpoint snapping at degree-3+ nodes
  let junctionDimSnaps = 0;
  let junctionEndpointSnaps = 0;
  const junctionNodes = [];
  const OVERLAP_MARGIN = 0.05;

  for (const [node, parents] of Object.entries(nodeToParents)) {
    if (parents.length < 3) continue;
    junctionNodes.push(node);

    for (const role of SHELL_ROLES) {
      const piecesAtNode = parents.map(p => shellByBranchRole[`${p}__${role}`]).filter(Boolean);
      if (piecesAtNode.length < 2) continue;

      // Average width and height across all pieces at this junction
      const widths = piecesAtNode.map(p => p.geometry?.profile?.width).filter(w => w > 0);
      const heights = piecesAtNode.map(p => p.geometry?.profile?.height).filter(h => h > 0);
      if (widths.length >= 2) {
        const avgW = widths.reduce((s, w) => s + w, 0) / widths.length;
        for (const p of piecesAtNode) {
          if (p.geometry?.profile?.width > 0 && Math.abs(p.geometry.profile.width - avgW) / avgW < DIM_TOLERANCE) {
            p.geometry.profile.width = avgW;
            junctionDimSnaps++;
          }
        }
      }
      if (heights.length >= 2) {
        const avgH = heights.reduce((s, h) => s + h, 0) / heights.length;
        for (const p of piecesAtNode) {
          if (p.geometry?.profile?.height > 0 && Math.abs(p.geometry.profile.height - avgH) / avgH < DIM_TOLERANCE) {
            p.geometry.profile.height = avgH;
            junctionDimSnaps++;
          }
        }
      }

      // Endpoint snapping: extend shell pieces to reach closure target
      const closureTarget = css.closureTargets?.[node]?.[role];
      if (!closureTarget) continue;

      for (const piece of piecesAtNode) {
        const pieceAxis = vecNormalize(piece.placement?.axis);
        if (!pieceAxis || !piece.placement?.origin) continue;

        const depth = piece.geometry?.depth || 0;
        if (depth <= 0) continue;

        // Find parent segment to determine which end faces this node
        const parentKey = piece.properties?.derivedFromBranch;
        const parentSeg = parentKey ? segByKey[parentKey] : null;
        if (!parentSeg) continue;

        const isEntry = parentSeg.properties?.entry_node === node;
        const currentEndpoint = vecAdd(piece.placement.origin, vecScale(pieceAxis, isEntry ? -depth / 2 : depth / 2));
        const gapToTarget = vecDist(currentEndpoint, closureTarget.point);

        // Only snap if gap is significant but not absurd
        if (gapToTarget < 0.01 || gapToTarget > depth * 0.5) continue;

        const extension = gapToTarget + OVERLAP_MARGIN;
        piece.geometry.depth = depth + extension;

        // Shift origin so far end stays fixed
        const shift = isEntry ? -extension / 2 : extension / 2;
        piece.placement.origin = vecAdd(piece.placement.origin, vecScale(pieceAxis, shift));

        if (!piece.properties) piece.properties = {};
        piece.properties.junctionSnapped = true;
        piece.properties.junctionSnapExtension = +extension.toFixed(4);
        junctionEndpointSnaps++;
      }
    }
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.shellContinuity = {
    adjacentBranchPairs: adjacentPairs.size,
    alignedShellPairs: alignedPairs,
    dimensionSnaps,
    junctionDimSnaps,
    junctionEndpointSnaps,
    junctionNodes: junctionNodes.length,
    continuityGroups: Object.keys(continuityGroups).length,
    sampleGroups: Object.entries(continuityGroups).slice(0, 3).map(([id, keys]) => ({ id, members: keys.size }))
  };

  console.log(`alignShellContinuity: ${alignedPairs} shell pairs aligned across ${adjacentPairs.size} branch pairs, ${Object.keys(continuityGroups).length} continuity groups, ${dimensionSnaps} dimension snaps, ${junctionDimSnaps} junction dimension snaps at ${junctionNodes.length} junction nodes`);
}


// ============================================================================
// PHASE 3A-PRE: MERGE SHELL RUNS
// Merges adjacent collinear shell pieces (WALL/SLAB) into single continuous
// elements. VOIDs are never merged (per-branch identity needed for equipment).
// ============================================================================

function mergeShellRuns(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;
  // Temporarily disabled to preserve corner fidelity — merging can stretch
  // shell runs across bend areas and create seam gaps at junctions.
  console.log('mergeShellRuns: temporarily disabled for TUNNEL to preserve corner fidelity');
  return;
  // F6: Skip if no shell pieces exist
  const hasShells = css.elements.some(e => e.properties?.shellPiece && e.properties.shellPiece !== 'VOID');
  if (!hasShells) { console.log('mergeShellRuns: no shell pieces, skipping'); return; }

  const shellPieces = css.elements.filter(e =>
    e.properties?.shellPiece &&
    e.properties?.derivedFromBranch &&
    e.properties?.continuityGroupId
  );

  if (shellPieces.length === 0) return;

  // Group by continuityGroupId + shellPiece role
  const groups = {};
  for (const sp of shellPieces) {
    const groupKey = `${sp.properties.continuityGroupId}__${sp.properties.shellPiece}`;
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(sp);
  }

  // Build branch ordering via entry/exit node chains
  const parentSegments = css.elements.filter(e => e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL');
  const segByKey = {};
  for (const seg of parentSegments) {
    segByKey[seg.element_key || seg.id] = seg;
  }

  // Order pieces within each group by walking entry_node→exit_node chain
  function orderPiecesByChain(pieces) {
    if (pieces.length <= 1) return pieces;

    const branchKeys = pieces.map(p => p.properties.derivedFromBranch);
    const segments = branchKeys.map(k => segByKey[k]).filter(Boolean);
    if (segments.length !== pieces.length) return pieces;

    const pieceByBranch = {};
    for (const p of pieces) pieceByBranch[p.properties.derivedFromBranch] = p;

    const entryNodes = {};
    const exitNodes = {};
    for (const s of segments) {
      const k = s.element_key || s.id;
      entryNodes[k] = s.properties?.entry_node;
      exitNodes[k] = s.properties?.exit_node;
    }

    const exitToNext = {};
    for (const k of branchKeys) {
      const exitNode = exitNodes[k];
      if (!exitNode) continue;
      for (const k2 of branchKeys) {
        if (k2 === k) continue;
        if (entryNodes[k2] === exitNode) { exitToNext[k] = k2; break; }
      }
    }

    const hasPredeccessor = new Set(Object.values(exitToNext));
    let startKey = branchKeys.find(k => !hasPredeccessor.has(k));
    if (!startKey) startKey = branchKeys[0];

    const ordered = [];
    const visited = new Set();
    let current = startKey;
    while (current && !visited.has(current)) {
      visited.add(current);
      if (pieceByBranch[current]) ordered.push(pieceByBranch[current]);
      current = exitToNext[current];
    }

    return ordered.length === pieces.length ? ordered : pieces;
  }

  const mergedElements = [];
  let piecesConsolidated = 0;
  const runLengths = [];

  for (const [groupKey, pieces] of Object.entries(groups)) {
    if (pieces.length < 2) continue;

    const role = pieces[0].properties.shellPiece;
    // Never merge VOIDs — per-branch identity needed for equipment containment
    if (role === 'VOID') continue;

    const ordered = orderPiecesByChain(pieces);
    if (ordered.length < 2) continue;

    const first = ordered[0];
    const cgId = first.properties.continuityGroupId;

    const axis = vecNormalize(first.placement?.axis);
    if (!axis) continue;

    // Validate all pieces have valid geometry
    const allValid = ordered.every(p =>
      p.placement?.origin && p.placement?.axis && (p.geometry?.depth || 0) > 0
    );
    if (!allValid) continue;

    // Compute merged geometry — true span from first piece's start to last piece's end
    const last = ordered[ordered.length - 1];
    const firstDepth = first.geometry?.depth || 0;
    const lastDepth = last.geometry?.depth || 0;
    if (firstDepth <= 0 || lastDepth <= 0) continue;

    const firstProfile = first.geometry?.profile;
    if (!firstProfile) continue;

    // Validate axis consistency across all ordered pieces (reject if > 5° divergence)
    let axisConsistent = true;
    for (const p of ordered) {
      const pAxis = vecNormalize(p.placement?.axis);
      if (pAxis) {
        const dot = Math.abs(vecDot(axis, pAxis));
        if (dot < 0.996) { // cos(5°) ≈ 0.996
          axisConsistent = false;
          break;
        }
      }
    }
    if (!axisConsistent) {
      console.warn(`mergeShellRuns: skipping merge of ${cgId}/${role} — axis divergence > 5°`);
      continue;
    }

    // Compute true span endpoints (origin = center convention, endpoints at ±depth/2)
    const firstStart = vecAdd(first.placement.origin, vecScale(axis, -firstDepth / 2));
    const lastEnd = vecAdd(last.placement.origin, vecScale(axis, lastDepth / 2));
    const mergedDepth = vecDist(firstStart, lastEnd);
    if (mergedDepth <= 0 || !Number.isFinite(mergedDepth)) continue;

    const mergedOrigin = {
      x: (firstStart.x + lastEnd.x) / 2,
      y: (firstStart.y + lastEnd.y) / 2,
      z: (firstStart.z + lastEnd.z) / 2
    };

    // Log correction delta for debugging
    const totalDepth = ordered.reduce((sum, p) => sum + (p.geometry?.depth || 0), 0);
    const depthDelta = Math.abs(mergedDepth - totalDepth);
    if (depthDelta > 0.1) {
      console.log(`mergeShellRuns: ${cgId}/${role} depth delta ${depthDelta.toFixed(3)}m (internal gaps present)`);
    }

    const derivedFromBranches = ordered.map(p => p.properties.derivedFromBranch);
    const mergedKey = `merged_${role.toLowerCase()}_${cgId}`;

    runLengths.push(mergedDepth);

    mergedElements.push({
      id: mergedKey,
      element_key: mergedKey,
      type: first.type,
      name: `${role} — ${ordered.length} segments merged`,
      semanticType: first.semanticType,
      confidence: first.confidence,
      source: first.source,
      container: first.container,
      placement: {
        origin: mergedOrigin,
        axis: { ...axis },
        refDirection: first.placement.refDirection ? { ...first.placement.refDirection } : { x: 1, y: 0, z: 0 }
      },
      geometry: {
        method: 'EXTRUSION',
        direction: first.geometry?.direction ? { ...first.geometry.direction } : { x: 0, y: 0, z: 1 },
        depth: mergedDepth,
        profile: JSON.parse(JSON.stringify(firstProfile))
      },
      material: first.material ? JSON.parse(JSON.stringify(first.material)) : { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0 },
      properties: {
        derivedFromBranch: first.properties.derivedFromBranch,
        derivedFromBranches: derivedFromBranches,
        shellPiece: role,
        isMergedRun: true,
        mergedPieceCount: ordered.length,
        continuityGroupId: cgId,
        shellThickness_m: first.properties.shellThickness_m || 0.3,
        shellThicknessBasis: first.properties.shellThicknessBasis || 'DEFAULT',
        decompositionMethod: first.properties.decompositionMethod || 'rectangular_shell_v1',
        mergedStartEndpoint: firstStart,
        mergedEndEndpoint: lastEnd,
        mergedDepthDelta: +depthDelta.toFixed(4)
      },
      relationships: []
    });

    // Mark originals for skip in generate
    for (const p of ordered) {
      p.properties.mergedIntoRun = mergedKey;
    }
    piecesConsolidated += ordered.length;
  }

  if (mergedElements.length > 0) {
    for (const me of mergedElements) {
      if (!me.provenance) {
        me.provenance = { sourceFile: null, sourceFileStatus: 'derived_geometric', sourceFiles: [], stage: 'topology:mergeShellRuns', modifications: [] };
      }
    }
    css.elements.push(...mergedElements);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.shellRunMerge = {
    runsCreated: mergedElements.length,
    piecesConsolidated,
    unmergedPieceCount: shellPieces.length - piecesConsolidated,
    avgRunLength: runLengths.length > 0 ? +(runLengths.reduce((s, l) => s + l, 0) / runLengths.length).toFixed(2) : 0
  };

  if (mergedElements.length > 0) {
    console.log(`mergeShellRuns: ${mergedElements.length} runs created, ${piecesConsolidated} pieces consolidated, avg run length ${css.metadata.shellRunMerge.avgRunLength}m`);
  }
}


// ============================================================================
// PHASE 3A: SHELL EXTENSION AT JUNCTIONS
// Extends shell pieces at junction/bend nodes to reduce gaps.
// ============================================================================

function extendShellAtJunctions(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;
  // F6: Skip if no shell pieces exist
  const hasShells = css.elements.some(e => e.properties?.shellPiece && e.properties.shellPiece !== 'VOID');
  if (!hasShells) { console.log('extendShellAtJunctions: no shell pieces, skipping'); return; }

  const parentSegments = css.elements.filter(e => e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL');
  const shellPieces = css.elements.filter(e => e.properties?.shellPiece && e.properties?.derivedFromBranch);

  // Build node adjacency
  const nodeToParents = {};
  const segByKey = {};
  for (const seg of parentSegments) {
    const key = seg.element_key || seg.id;
    segByKey[key] = seg;
    const entry = seg.properties?.entry_node;
    const exit = seg.properties?.exit_node;
    if (entry) { if (!nodeToParents[entry]) nodeToParents[entry] = []; nodeToParents[entry].push(key); }
    if (exit) { if (!nodeToParents[exit]) nodeToParents[exit] = []; nodeToParents[exit].push(key); }
  }

  // Shell pieces by branch
  const shellByBranch = {};
  for (const sp of shellPieces) {
    const branch = sp.properties.derivedFromBranch;
    if (!shellByBranch[branch]) shellByBranch[branch] = [];
    shellByBranch[branch].push(sp);
  }

  let extensionCount = 0;
  const extendedNodes = [];

  for (const [node, parents] of Object.entries(nodeToParents)) {
    const degree = parents.length;
    if (degree < 2) continue;

    // For degree-2: check angle between axes.
    // Never extend at T-junctions (degree ≥ 3) — multiple branches all push into the junction
    // simultaneously, creating a multi-solid collision at every intersection ("stick pile").
    // Instead, let generateJunctionTransitions place a clean junction plug that bridges the gap.
    let shouldExtend = false;
    if (degree === 2) {
      const segA = segByKey[parents[0]];
      const segB = segByKey[parents[1]];
      if (segA && segB) {
        const axA = vecNormalize(segA.placement?.axis);
        const axB = vecNormalize(segB.placement?.axis);
        if (axA && axB) {
          const dot = Math.abs(vecDot(axA, axB));
          // angle > 20° means dot < cos(20°) ≈ 0.94
          if (dot < 0.94) shouldExtend = true;
        }
      }
    }
    if (!shouldExtend) continue;

    // Extend shell pieces from each branch at this node
    for (const parentKey of parents) {
      const seg = segByKey[parentKey];
      if (!seg) continue;
      const pieces = shellByBranch[parentKey];
      if (!pieces || pieces.length === 0) continue;

      // Determine which end of the segment faces this node
      const isEntryEnd = seg.properties?.entry_node === node;
      const segAxis = vecNormalize(seg.placement?.axis);
      if (!segAxis) continue;

      for (const piece of pieces) {
        const depth = piece.geometry?.depth;
        if (!depth || depth <= 0) continue;

        const pieceAxis = vecNormalize(piece.placement?.axis);
        if (!pieceAxis || !piece.placement?.origin) continue;

        const shellRole = piece.properties?.shellPiece;
        const OVERLAP_MARGIN = 0.05;
        // Cross-section diameter cap: extension should not exceed the tunnel's own profile size
        const pieceProfile = piece.geometry?.profile || {};
        const crossSectionDiam = Math.max(pieceProfile.width || 1, pieceProfile.height || 1);

        // Target-based gap closing: compute actual gap to closure target
        const closureTarget = css.closureTargets?.[node]?.[shellRole];
        let EXTENSION;

        if (closureTarget) {
          const currentEndpoint = vecAdd(piece.placement.origin, vecScale(pieceAxis, isEntryEnd ? -depth / 2 : depth / 2));
          const gapToTarget = vecDist(currentEndpoint, closureTarget.point);
          // Extend to reach target, capped by cross-section diameter and 15% of segment length
          EXTENSION = Math.min(gapToTarget + OVERLAP_MARGIN, crossSectionDiam, depth * 0.15);
        } else {
          // Fallback: compute gap to junction center and extend to cover it
          const nodeBranches = nodeToParents[node] || [];
          const nodeEndpoints = [];
          for (const bk of nodeBranches) {
            const bSeg = segByKey[bk];
            if (!bSeg?.placement?.origin || !bSeg?.placement?.axis) continue;
            const bAx = vecNormalize(bSeg.placement.axis);
            if (!bAx) continue;
            const bDepth = bSeg.geometry?.depth || 0;
            const bIsEntry = bSeg.properties?.entry_node === node;
            const bEndOffset = bIsEntry ? -bDepth / 2 : bDepth / 2;
            nodeEndpoints.push(vecAdd(bSeg.placement.origin, vecScale(bAx, bEndOffset)));
          }
          if (nodeEndpoints.length >= 2) {
            const junctionCenter = {
              x: nodeEndpoints.reduce((s, p) => s + p.x, 0) / nodeEndpoints.length,
              y: nodeEndpoints.reduce((s, p) => s + p.y, 0) / nodeEndpoints.length,
              z: nodeEndpoints.reduce((s, p) => s + p.z, 0) / nodeEndpoints.length
            };
            const currentEndpoint = vecAdd(piece.placement.origin, vecScale(pieceAxis, isEntryEnd ? -depth / 2 : depth / 2));
            const gapDistance = vecDist(currentEndpoint, junctionCenter);
            EXTENSION = Math.min(gapDistance + 0.1, crossSectionDiam, depth * 0.15);
          } else {
            EXTENSION = Math.min(1.0, depth * 0.15);
          }
        }

        if (EXTENSION < 0.01) continue;

        // Extend depth
        piece.geometry.depth = depth + EXTENSION;

        // Shift origin so the far end stays fixed
        const shift = isEntryEnd ? -EXTENSION / 2 : EXTENSION / 2;
        piece.placement.origin = vecAdd(piece.placement.origin, vecScale(pieceAxis, shift));

        if (!piece.properties) piece.properties = {};
        piece.properties.junctionExtended = true;
        piece.properties.junctionExtensionAmount = +EXTENSION.toFixed(4);
        extensionCount++;
      }
    }
    extendedNodes.push(node);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.junctionExtensions = { count: extensionCount, nodes: extendedNodes };
  if (extensionCount > 0) {
    console.log(`extendShellAtJunctions: ${extensionCount} shell pieces extended at ${extendedNodes.length} nodes`);
  }
}


// ============================================================================
// PHASE 3B: JUNCTION TRANSITION HELPER VOLUMES
// Generates 1-2 approximation geometry elements per junction to fill gaps.
// Uses PROXY type — NOT canonical structure.
// ============================================================================

/**
 * Get the tunnel bearing direction for a segment. When placement.axis is vertical
 * (extrusion upward), the actual bore direction is in placement.refDirection.
 */
function getTunnelBearing(seg) {
  const axis = seg.placement?.axis;
  const refDir = seg.placement?.refDirection;
  if (axis) {
    const axisN = vecNormalize(axis);
    if (axisN) {
      if (Math.abs(axisN.z) > 0.9 && refDir) {
        const refN = vecNormalize(refDir);
        if (refN) return refN;
      }
      return axisN;
    }
  }
  if (refDir) {
    const refN = vecNormalize(refDir);
    if (refN) return refN;
  }
  return null;
}

function generateJunctionTransitions(css) {
  if (!css.elements || css.elements.length === 0) return;
  // Data-driven: check for actual TUNNEL_SEGMENT elements rather than relying on domain string
  if (!css.elements.some(e => e.type === 'TUNNEL_SEGMENT')) return;
  const parentSegments = css.elements.filter(e => e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL');
  // In v2 (skeleton-first), topology annotates TUNNEL_SEGMENT elements — no shell piece sub-elements are emitted.
  // Guard on structural segments instead of shell pieces so junction fills are generated in both v1 and v2.
  if (parentSegments.length === 0) { console.log('generateJunctionTransitions: no structural segments, skipping'); return; }
  // Legacy v1 shell pieces (empty in v2 — kept for compatibility)
  const shellPieces = css.elements.filter(e => e.properties?.shellPiece && e.properties?.derivedFromBranch);

  // Build node adjacency
  const nodeToParents = {};
  const segByKey = {};
  for (const seg of parentSegments) {
    const key = seg.element_key || seg.id;
    segByKey[key] = seg;
    const entry = seg.properties?.entry_node;
    const exit = seg.properties?.exit_node;
    if (entry) { if (!nodeToParents[entry]) nodeToParents[entry] = []; nodeToParents[entry].push(key); }
    if (exit) { if (!nodeToParents[exit]) nodeToParents[exit] = []; nodeToParents[exit].push(key); }
  }

  // Shell pieces by branch (for checking voids)
  const voidByBranch = {};
  for (const sp of shellPieces) {
    if (sp.properties?.shellPiece === 'VOID') {
      voidByBranch[sp.properties.derivedFromBranch] = sp;
    }
  }

  const transitionElements = [];
  let junctionCount = 0;
  let bendCount = 0;
  let voidHelpersGenerated = 0;

  for (const [node, parents] of Object.entries(nodeToParents)) {
    const degree = parents.length;
    if (degree < 2) continue;

    // Collect branch endpoints at this node
    const branchEndpoints = [];
    for (const parentKey of parents) {
      const seg = segByKey[parentKey];
      if (!seg?.placement?.origin) continue;
      const ax = getTunnelBearing(seg);
      if (!ax) continue;
      const depth = seg.geometry?.depth || 0;
      const W = seg.geometry?.profile?.width || 4;
      const H = seg.geometry?.profile?.height || 4;

      // Determine which endpoint is at this node
      const isEntry = seg.properties?.entry_node === node;
      const endOffset = isEntry ? -depth / 2 : depth / 2;
      const endpoint = vecAdd(seg.placement.origin, vecScale(ax, endOffset));

      branchEndpoints.push({ key: parentKey, endpoint, axis: ax, W, H, depth, container: seg.container, isEntry });
    }

    if (branchEndpoints.length < 2) continue;

    // For degree-2: check angle for bend transition
    if (degree === 2) {
      const axA = branchEndpoints[0].axis;
      const axB = branchEndpoints[1].axis;
      const dot = Math.abs(vecDot(axA, axB));
      // angle > 30° means dot < cos(30°) ≈ 0.866
      if (dot >= 0.866) continue;

      // Generate bend plug
      const center = {
        x: (branchEndpoints[0].endpoint.x + branchEndpoints[1].endpoint.x) / 2,
        y: (branchEndpoints[0].endpoint.y + branchEndpoints[1].endpoint.y) / 2,
        z: (branchEndpoints[0].endpoint.z + branchEndpoints[1].endpoint.z) / 2
      };
      const bisector = vecNormalize(vecAdd(axA, axB));
      const bendAxis = bisector || axA;
      // Use average (not max) branch dimensions to prevent oversized plugs at narrow junctions
      const jW = (branchEndpoints[0].W + branchEndpoints[1].W) / 2;
      const jH = (branchEndpoints[0].H + branchEndpoints[1].H) / 2;
      const gapDist = vecDist(branchEndpoints[0].endpoint, branchEndpoints[1].endpoint);
      // Hollow-manifold approach: tubes already overlap past their nominal ends.
      // Bend plug fills the residual corner gap — cap at 1.2m (arch tubes have wider overlap
      // zones than rectangular panels, so a larger cap ensures full coverage).
      const bendPlugDepth = Math.min(Math.max(gapDist * 1.1 + 0.1, 0.3), 1.2);
      const bendProfile = { type: 'ARCH', width: jW, height: jH, curveRatio: 0.3 };

      const bendFrame = buildTunnelFrame(center, vecAdd(center, bendAxis));
      const bendRef = bendFrame?.lateral || { x: 1, y: 0, z: 0 };

      transitionElements.push({
        id: `bend-plug-${node}`,
        element_key: `bend-plug-${node}`,
        type: 'WALL',
        name: `Bend Transition — ${node}`,
        semanticType: 'IfcWall',
        confidence: 0.2,
        source: 'TRANSITION_APPROXIMATION',
        container: branchEndpoints[0].container,
        placement: {
          origin: center,
          axis: bendAxis,
          refDirection: bendRef
        },
        geometry: {
          method: 'EXTRUSION',
          direction: { x: 0, y: 0, z: 1 },
          depth: bendPlugDepth,
          profile: bendProfile
        },
        material: { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0.0 },
        properties: { isBendTransition: true, isTransitionHelper: true, isApproximation: true, geometryApproximation: 'BEND_PLUG', bendNodeId: node, gapDistance: +gapDist.toFixed(3) },
        relationships: []
      });
      bendCount++;
      continue;
    }

    // Degree ≥ 3: junction transition plug
    junctionCount++;

    // Compute junction center — weighted by branch depth for asymmetric junctions
    const totalBranchDepth = branchEndpoints.reduce((s, b) => s + b.depth, 0);
    const center = totalBranchDepth > 0 ? {
      x: branchEndpoints.reduce((s, b) => s + b.endpoint.x * b.depth, 0) / totalBranchDepth,
      y: branchEndpoints.reduce((s, b) => s + b.endpoint.y * b.depth, 0) / totalBranchDepth,
      z: branchEndpoints.reduce((s, b) => s + b.endpoint.z * b.depth, 0) / totalBranchDepth
    } : {
      x: branchEndpoints.reduce((s, b) => s + b.endpoint.x, 0) / branchEndpoints.length,
      y: branchEndpoints.reduce((s, b) => s + b.endpoint.y, 0) / branchEndpoints.length,
      z: branchEndpoints.reduce((s, b) => s + b.endpoint.z, 0) / branchEndpoints.length
    };

    // Use average branch dimensions to prevent oversized plugs at mixed-size junctions
    const jW = branchEndpoints.reduce((s, b) => s + b.W, 0) / branchEndpoints.length;
    const jH = branchEndpoints.reduce((s, b) => s + b.H, 0) / branchEndpoints.length;
    const maxGap = Math.max(...branchEndpoints.map(b => vecDist(b.endpoint, center)));
    // Plug depth must be at least the average tunnel dimension so it volumetrically fills the
    // junction cavity — when endpoints are snapped (maxGap ≈ 0) the old formula gave 0.3m for a
    // 5m tunnel, making the plug appear as a flat slab. Now it's at least (jW+jH)/2 deep.
    // Hollow-manifold approach: T-junction plugs fill the triangular gap at the T.
    // Cap at 1.5m (vs old 3.0m) — the hollow tube walls contain the visual volume.
    const plugDepth = Math.min(Math.max(2 * maxGap + 0.5, 0.6), 1.5);

    // Weighted average axis
    const avgAxis = vecNormalize(branchEndpoints.reduce((acc, b) => vecAdd(acc, b.axis), { x: 0, y: 0, z: 0 }));
    const junctionAxis = avgAxis || { x: 1, y: 0, z: 0 };

    // Rectangular profile — matches the shell piece cross-section exactly.
    // The previous chamfered octagon created visible polygon seams where rectangular shell pieces
    // met the 8-sided plug. Using RECTANGLE produces IfcRectangleProfileDef, same as shell pieces.
    const junctionProfile = { type: 'RECTANGLE', width: jW, height: jH };

    const junctionFrame = buildTunnelFrame(center, vecAdd(center, junctionAxis));
    const junctionRef = junctionFrame?.lateral || { x: 1, y: 0, z: 0 };

    const plugElem = {
      id: `junction-plug-${node}`,
      element_key: `junction-plug-${node}`,
      type: 'PROXY',
      name: `Junction Transition — ${node}`,
      semanticType: 'IfcBuildingElementProxy',
      confidence: 0.25,
      source: 'TRANSITION_APPROXIMATION',
      container: branchEndpoints[0].container,
      placement: {
        origin: center,
        axis: junctionAxis,
        refDirection: junctionRef
      },
      geometry: {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        depth: plugDepth,
        profile: junctionProfile
      },
      material: { name: 'concrete', color: [0.7, 0.7, 0.7], transparency: 0.0 },
      properties: {
        isTransitionHelper: true,
        isApproximation: true,
        junctionNodeId: node,
        junctionDegree: degree,
        geometryApproximation: 'JUNCTION_PLUG',
        maxGapDistance: +maxGap.toFixed(3)
      },
      relationships: []
    };
    transitionElements.push(plugElem);

    // Generate companion void — in v2 (skeleton-first), structural junctions are always hollow
    // so the void is always needed. In v1, we check for legacy VOID shell pieces or gap size.
    const hasVoidsByLegacy = branchEndpoints.some(b => !!voidByBranch[b.key]);
    const hasStructuralBranch = branchEndpoints.some(b => segByKey[b.key]?.properties?.branchClass === 'STRUCTURAL');
    const needsVoid = hasVoidsByLegacy || maxGap > 0.5 || hasStructuralBranch;

    if (needsVoid) {
      const WALL_THICKNESS = deriveThickness(jW, jH);
      const innerW = jW - 2 * WALL_THICKNESS;
      const innerH = jH - 2 * WALL_THICKNESS;
      if (innerW > 0.1 && innerH > 0.1) {
        // Inner void uses rectangular profile — consistent with junction plug and shell pieces.
        const voidProfile = { type: 'RECTANGLE', width: innerW, height: innerH };
        transitionElements.push({
          id: `junction-void-${node}`,
          element_key: `junction-void-${node}`,
          type: 'SPACE',
          name: `Junction Void — ${node}`,
          semanticType: 'IfcSpace',
          confidence: 0.2,
          source: 'TRANSITION_APPROXIMATION',
          container: branchEndpoints[0].container,
          placement: { ...plugElem.placement, origin: { ...center } },
          geometry: {
            method: 'EXTRUSION',
            direction: { x: 0, y: 0, z: 1 },
            depth: plugDepth,
            profile: voidProfile
          },
          material: { name: 'space', color: [0.88, 0.88, 0.88], transparency: 0.7 },
          properties: { isTransitionHelper: true, isApproximation: true, shellPiece: 'VOID', junctionNodeId: node },
          relationships: []
        });
        voidHelpersGenerated++;
      }
    }
  }

  if (transitionElements.length > 0) {
    for (const te of transitionElements) {
      if (!te.provenance) {
        te.provenance = { sourceFile: null, sourceFileStatus: 'derived_geometric', sourceFiles: [], stage: 'topology:generateJunctionTransitions', modifications: [] };
      }
    }
    css.elements.push(...transitionElements);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.junctionTransitions = {
    junctionCount,
    bendCount,
    transitionElementCount: transitionElements.length,
    voidHelpersGenerated
  };
  if (transitionElements.length > 0) {
    console.log(`generateJunctionTransitions: ${junctionCount} junctions, ${bendCount} bends → ${transitionElements.length} transition elements (${voidHelpersGenerated} void helpers)`);
  }
}


// ============================================================================
// PHASE 3-VAL: TUNNEL GEOMETRY CONTINUITY VALIDATION
// Measures gaps between shell endpoints at junction nodes after all geometry passes.
// ============================================================================

function validateTunnelGeometry(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const parentSegments = css.elements.filter(e => e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL');
  const shellPieces = css.elements.filter(e =>
    e.properties?.shellPiece &&
    e.properties?.derivedFromBranch &&
    !e.properties?.mergedIntoRun &&
    e.properties?.shellPiece !== 'VOID'
  );
  const mergedRuns = css.elements.filter(e => e.properties?.isMergedRun && e.properties?.shellPiece !== 'VOID');
  const allStructural = [...shellPieces, ...mergedRuns];

  // Build node adjacency
  const nodeToParents = {};
  const segByKey = {};
  for (const seg of parentSegments) {
    const key = seg.element_key || seg.id;
    segByKey[key] = seg;
    const entry = seg.properties?.entry_node;
    const exit = seg.properties?.exit_node;
    if (entry) { if (!nodeToParents[entry]) nodeToParents[entry] = []; nodeToParents[entry].push(key); }
    if (exit) { if (!nodeToParents[exit]) nodeToParents[exit] = []; nodeToParents[exit].push(key); }
  }

  // Shell pieces by branch
  const shellByBranch = {};
  for (const sp of allStructural) {
    const branches = sp.properties?.derivedFromBranches || [sp.properties?.derivedFromBranch];
    for (const b of branches) {
      if (!b) continue;
      if (!shellByBranch[b]) shellByBranch[b] = [];
      shellByBranch[b].push(sp);
    }
  }

  let gapCount = 0;
  let maxGap = 0;
  let totalGap = 0;
  const gapDetails = [];

  for (const [node, parents] of Object.entries(nodeToParents)) {
    if (parents.length < 2) continue;

    // Collect shell endpoints at this node from each branch
    const endpoints = [];
    for (const parentKey of parents) {
      const seg = segByKey[parentKey];
      if (!seg) continue;
      const pieces = shellByBranch[parentKey] || [];
      const isEntry = seg.properties?.entry_node === node;

      for (const piece of pieces) {
        const ax = vecNormalize(piece.placement?.axis);
        if (!ax || !piece.placement?.origin) continue;
        const depth = piece.geometry?.depth || 0;
        if (depth <= 0) continue;
        const endpoint = vecAdd(piece.placement.origin, vecScale(ax, isEntry ? -depth / 2 : depth / 2));
        endpoints.push({ endpoint, role: piece.properties?.shellPiece, branch: parentKey });
      }
    }

    // Measure gaps between endpoints from different branches at same node
    for (let i = 0; i < endpoints.length; i++) {
      for (let j = i + 1; j < endpoints.length; j++) {
        if (endpoints[i].branch === endpoints[j].branch) continue;
        if (endpoints[i].role !== endpoints[j].role) continue;
        const gap = vecDist(endpoints[i].endpoint, endpoints[j].endpoint);
        if (gap > 0.02) {
          gapCount++;
          totalGap += gap;
          if (gap > maxGap) maxGap = gap;
          if (gapDetails.length < 10) {
            gapDetails.push({ node, role: endpoints[i].role, gap: +gap.toFixed(4) });
          }
        }
      }
    }
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.tunnelGeometry = {
    gapCount,
    maxGap: +maxGap.toFixed(4),
    avgGap: gapCount > 0 ? +(totalGap / gapCount).toFixed(4) : 0,
    gapDetails
  };

  if (gapCount > 0) {
    console.warn(`validateTunnelGeometry: ${gapCount} gaps detected, max=${maxGap.toFixed(3)}m, avg=${(totalGap / gapCount).toFixed(3)}m`);
  } else {
    console.log('validateTunnelGeometry: no gaps detected — geometry is continuous');
  }
}


// ============================================================================
// PHASE 3-GEO: POST-FIX GEOMETRY GAP AUDIT
// Measures end-face gaps/overlaps between adjacent same-role structural elements.
// ============================================================================

function auditGeometryGaps(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const shellPieces = css.elements.filter(e =>
    e.properties?.shellPiece && e.properties?.derivedFromBranch &&
    !e.properties?.mergedIntoRun &&
    e.properties?.shellPiece !== 'VOID'
  );

  // Also include merged runs
  const mergedRuns = css.elements.filter(e => e.properties?.isMergedRun && e.properties?.shellPiece !== 'VOID');
  const allStructural = [...shellPieces, ...mergedRuns];

  // Build adjacency from continuityGroupId or adjacentShellKeys
  const gaps = [];
  const overlaps = [];
  const processed = new Set();

  for (const piece of allStructural) {
    const adjacentKeys = piece.properties?.adjacentShellKeys || [];
    const pieceKey = piece.element_key || piece.id;
    const pieceAxis = vecNormalize(piece.placement?.axis);
    if (!pieceAxis || !piece.placement?.origin) continue;
    const depth = piece.geometry?.depth || 0;

    for (const adjKey of adjacentKeys) {
      const pairKey = [pieceKey, adjKey].sort().join('|');
      if (processed.has(pairKey)) continue;
      processed.add(pairKey);

      const adj = allStructural.find(e => (e.element_key || e.id) === adjKey);
      if (!adj || !adj.placement?.origin) continue;

      const adjAxis = vecNormalize(adj.placement?.axis);
      if (!adjAxis) continue;
      const adjDepth = adj.geometry?.depth || 0;

      // Compute all 4 endpoint pairs and find the closest
      const endpoints1 = [
        vecAdd(piece.placement.origin, vecScale(pieceAxis, -depth / 2)),
        vecAdd(piece.placement.origin, vecScale(pieceAxis, depth / 2))
      ];
      const endpoints2 = [
        vecAdd(adj.placement.origin, vecScale(adjAxis, -adjDepth / 2)),
        vecAdd(adj.placement.origin, vecScale(adjAxis, adjDepth / 2))
      ];

      let minDist = Infinity;
      for (const e1 of endpoints1) {
        for (const e2 of endpoints2) {
          const d = vecDist(e1, e2);
          if (d < minDist) minDist = d;
        }
      }

      // Check for overlap (negative gap) by projecting along axis
      // If closest endpoints are very close, check if elements actually overlap
      const dot = Math.abs(vecDot(pieceAxis, adjAxis));
      if (dot > 0.9) {
        // Collinear — compute 1D overlap along shared axis
        const proj1Start = vecDot(endpoints1[0], pieceAxis);
        const proj1End = vecDot(endpoints1[1], pieceAxis);
        const proj2Start = vecDot(endpoints2[0], pieceAxis);
        const proj2End = vecDot(endpoints2[1], pieceAxis);
        const span1 = [Math.min(proj1Start, proj1End), Math.max(proj1Start, proj1End)];
        const span2 = [Math.min(proj2Start, proj2End), Math.max(proj2Start, proj2End)];
        const overlapAmount = Math.min(span1[1], span2[1]) - Math.max(span1[0], span2[0]);

        if (overlapAmount > 0.01) {
          overlaps.push({ a: pieceKey, b: adjKey, role: piece.properties?.shellPiece, overlap: +overlapAmount.toFixed(4) });
        } else if (minDist > 0.01) {
          gaps.push({ a: pieceKey, b: adjKey, role: piece.properties?.shellPiece, gap: +minDist.toFixed(4) });
        }
      } else if (minDist > 0.01) {
        gaps.push({ a: pieceKey, b: adjKey, role: piece.properties?.shellPiece, gap: +minDist.toFixed(4) });
      }
    }
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.geometryGaps = {
    gapCount: gaps.length,
    overlapCount: overlaps.length,
    maxGap: gaps.length > 0 ? Math.max(...gaps.map(g => g.gap)) : 0,
    avgGap: gaps.length > 0 ? +(gaps.reduce((s, g) => s + g.gap, 0) / gaps.length).toFixed(4) : 0,
    maxOverlap: overlaps.length > 0 ? Math.max(...overlaps.map(o => o.overlap)) : 0,
    gaps: gaps.slice(0, 10),
    overlaps: overlaps.slice(0, 10)
  };

  if (gaps.length > 0 || overlaps.length > 0) {
    console.log(`auditGeometryGaps: ${gaps.length} gaps (max ${css.metadata.geometryGaps.maxGap}m), ${overlaps.length} overlaps (max ${css.metadata.geometryGaps.maxOverlap}m)`);
  }
}

// ============================================================================
// PHASE 3-GEO-B: VISUAL GEOMETRY QUALITY VALIDATION
// Classifies geometry as DEMO_READY, MARGINAL, or FAIL.
// ============================================================================

function auditVisualGeometryQuality(css) {
  if (!css.metadata) css.metadata = {};

  const gapData = css.metadata.geometryGaps || {};
  const shellData = css.metadata.shellCompleteness || {};
  const junctionData = css.metadata.junctionTransitions || css.metadata.junctionFills || {};
  const trimData = css.metadata.shellTrimming || {};
  const skeletonData = css.metadata.tunnelDecomposition || {};

  const maxGap = gapData.maxGap || 0;
  const avgGap = gapData.avgGap || 0;
  const maxOverlap = gapData.maxOverlap || 0;
  const missingShellRoles = shellData.missing || 0;
  const reconstructed = shellData.reconstructed || 0;
  const gapCount = gapData.gapCount || 0;
  const overlapCount = gapData.overlapCount || 0;

  // Count unresolved junctions and bends
  const junctionCount = junctionData.junctionCount || junctionData.junctionBendNodes || 0;
  const bendCount = junctionData.bendCount || 0;
  const transitionCount = junctionData.transitionElementCount || junctionData.fillCount || 0;

  // Overhang and cross-territory detection (skeleton-first pipeline)
  let overhangCount = 0;
  let maxOverhangLength = 0;
  let crossTerritoryCount = 0;

  if (false && css.skeleton && css.runs) { // skeleton-first pipeline disabled
    const { nodes } = css.skeleton;
    const trimPlanes = {};

    // Rebuild run lookup by node for territory checks
    const runsByNode = {};
    for (const run of css.runs) {
      if (!runsByNode[run.startNode]) runsByNode[run.startNode] = [];
      runsByNode[run.startNode].push({ run, endType: 'start' });
      if (!runsByNode[run.endNode]) runsByNode[run.endNode] = [];
      runsByNode[run.endNode].push({ run, endType: 'end' });
    }

    // Check each shell piece endpoint against trim boundaries
    const shellPieces = css.elements.filter(e =>
      e.properties?.shellPiece && e.properties.shellPiece !== 'VOID' && e.properties?.runId
    );

    for (const piece of shellPieces) {
      const ax = vecNormalize(piece.placement?.axis);
      if (!ax || !piece.placement?.origin) continue;
      const d = piece.geometry?.depth || 0;
      if (d <= 0) continue;

      for (const [nodeId, isExit] of [[piece.properties.entry_node, false], [piece.properties.exit_node, true]]) {
        if (!nodeId) continue;
        const node = nodes[nodeId];
        if (!node || node.degree < 2) continue;

        // Check if this endpoint extends beyond the node position
        const endpoint = vecAdd(piece.placement.origin, vecScale(ax, isExit ? d / 2 : -d / 2));
        const nodePos = node.position;
        if (!nodePos) continue;

        // Overhang = endpoint extending past node into other territory
        const runDir = isExit ? ax : vecScale(ax, -1); // direction toward node
        const toNode = vecSub(nodePos, piece.placement.origin);
        const projToNode = vecDot(toNode, runDir);
        const endpointProj = isExit ? d / 2 : d / 2; // distance from origin to endpoint in run direction

        if (endpointProj > projToNode + 0.01) {
          const overhang = endpointProj - projToNode;
          overhangCount++;
          maxOverhangLength = Math.max(maxOverhangLength, overhang);

          // Check if endpoint is in another run's territory
          const runsAtNode = runsByNode[nodeId] || [];
          for (const { run: otherRun } of runsAtNode) {
            if (otherRun.id === piece.properties.runId) continue;
            // Endpoint is past node and another run exists here — cross-territory
            crossTerritoryCount++;
            break;
          }
        }
      }
    }
  }

  // Demo-ready thresholds
  const MAX_GAP_THRESHOLD = 0.03;
  const AVG_GAP_THRESHOLD = 0.01;
  const MAX_OVERLAP_THRESHOLD = 0.15;

  const errors = [];
  const warnings = [];

  if (missingShellRoles - reconstructed > 0) errors.push(`${missingShellRoles - reconstructed} required shell roles still missing after reconstruction`);
  if (maxGap > MAX_GAP_THRESHOLD) errors.push(`Max gap ${maxGap.toFixed(3)}m exceeds ${MAX_GAP_THRESHOLD}m threshold`);
  if (avgGap > AVG_GAP_THRESHOLD) errors.push(`Average gap ${avgGap.toFixed(3)}m exceeds ${AVG_GAP_THRESHOLD}m threshold`);
  if (maxOverlap > MAX_OVERLAP_THRESHOLD) warnings.push(`Max overlap ${maxOverlap.toFixed(3)}m exceeds ${MAX_OVERLAP_THRESHOLD}m — may look blobby`);
  if (gapCount > 0) warnings.push(`${gapCount} geometry gaps detected`);
  if (overhangCount > 0) errors.push(`${overhangCount} wall overhangs detected (max ${maxOverhangLength.toFixed(3)}m)`);
  if (crossTerritoryCount > 0) errors.push(`${crossTerritoryCount} cross-territory violations`);

  let classification;
  if (errors.length === 0 && warnings.length <= 2) {
    classification = 'DEMO_READY';
  } else if (errors.length === 0) {
    classification = 'MARGINAL';
  } else {
    classification = 'FAIL';
  }

  css.metadata.visualGeometryQuality = {
    classification,
    pipelineVersion: 'piece_first',
    missingShellRoles: missingShellRoles - reconstructed,
    maxGap,
    avgGap,
    gapCountAboveTolerance: gapCount,
    overlapCountAboveTolerance: overlapCount,
    maxOverlap,
    overhangCount,
    maxOverhangLength: +maxOverhangLength.toFixed(4),
    crossTerritoryCount,
    transitionsInserted: transitionCount,
    mergedRunsCorrected: css.metadata.shellRunMerge?.runsCreated || 0,
    runCount: css.runs?.length || 0,
    trimmedPieceCount: trimData.trimmedPieceCount || 0,
    junctionsClosed: junctionCount,
    bendsClosed: bendCount,
    errors: errors.slice(0, 10),
    warnings: warnings.slice(0, 10)
  };

  console.log(`auditVisualGeometryQuality: ${classification} | pipeline=piece_first maxGap=${maxGap.toFixed(3)}m avgGap=${avgGap.toFixed(3)}m overhang=${overhangCount} crossTerritory=${crossTerritoryCount} errors=${errors.length} warnings=${warnings.length}`);
}

// ============================================================================
// ORPHAN AUDIT — find TUNNEL_SEGMENTs excluded from skeleton and bridge gaps
// A segment is an "orphan" if it has no entry_node / exit_node and therefore
// never entered css.skeleton.edges. We generate a PROXY bridge element between
// each orphan endpoint and the nearest skeleton node to close the manifold.
// ============================================================================

function auditOrphansAndBridgeGaps(css) {
  if (!css.elements || css.elements.length === 0) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;
  if (!css.skeleton) {
    console.log('auditOrphansAndBridgeGaps: no skeleton, skipping');
    return;
  }

  const { nodes, edges } = css.skeleton;
  const nodeList = Object.values(nodes).filter(n => n.position);

  const orphans = [];
  for (const elem of css.elements) {
    if (elem.type !== 'TUNNEL_SEGMENT') continue;
    if (elem.properties?.branchClass !== 'STRUCTURAL') continue;
    // Skip derived elements (already generated shell pieces / voids)
    if (elem.properties?.derivedFromBranch || elem.properties?.shellPiece) continue;
    const key = elem.element_key || elem.id;
    if (!key) continue;
    // If this segment IS in the skeleton it is properly connected — skip it
    if (edges[key]) continue;
    orphans.push(elem);
  }

  if (orphans.length === 0) {
    console.log('auditOrphansAndBridgeGaps: no orphan segments found');
    return;
  }

  const BRIDGE_TOLERANCE = 5.0; // meters — max gap that a bridge proxy will fill
  const proxiesAdded = [];
  let bridgedCount = 0;

  for (const orphan of orphans) {
    const placement = orphan.placement || {};
    const geometry  = orphan.geometry  || {};
    const axis = vecNormalize(placement.axis);
    if (!axis || !placement.origin || !(geometry.depth > 0)) continue;

    const depth  = geometry.depth;
    const origin = placement.origin;
    const entryPt = vecAdd(origin, vecScale(axis, -depth / 2));
    const exitPt  = vecAdd(origin, vecScale(axis,  depth / 2));

    const W = geometry.profile?.width  || 4;
    const H = geometry.profile?.height || 3;

    // Try to bridge both endpoints to nearest skeleton node
    for (const [endPt, endLabel] of [[entryPt, 'entry'], [exitPt, 'exit']]) {
      let bestNode = null, bestDist = Infinity;
      for (const node of nodeList) {
        const d = vecDist(endPt, node.position);
        if (d < bestDist) { bestDist = d; bestNode = node; }
      }
      if (!bestNode || bestDist > BRIDGE_TOLERANCE) continue;
      if (bestDist < 0.01) continue; // already coincident — no bridge needed

      // Direction from orphan endpoint toward skeleton node
      const bridgeDir = vecNormalize(vecSub(bestNode.position, endPt));
      if (!bridgeDir) continue;

      const bridgeDepth  = Math.max(0.2, bestDist);
      const bridgeCenter = vecScale(vecAdd(endPt, bestNode.position), 0.5);

      // Build a lateral direction perpendicular to bridge axis (for refDirection)
      const up = { x: 0, y: 0, z: 1 };
      const cross = vecCross(bridgeDir, up);
      const refDir = vecNormalize(cross) || { x: 1, y: 0, z: 0 };

      const proxyKey = `orphan-bridge-${orphan.element_key || orphan.id}-${endLabel}`;
      proxiesAdded.push({
        id: proxyKey,
        element_key: proxyKey,
        type: 'PROXY',
        name: `Orphan Bridge — ${orphan.name || orphan.id} (${endLabel})`,
        semanticType: 'IfcBuildingElementProxy',
        confidence: 0.2,
        source: 'ORPHAN_BRIDGE',
        container: orphan.container,
        placement: {
          origin: bridgeCenter,
          axis: bridgeDir,
          refDirection: refDir
        },
        geometry: {
          method: 'EXTRUSION',
          depth: bridgeDepth,
          profile: { type: 'ARBITRARY', points: generateChamferedRectProfile(W / 2, H / 2) }
        },
        material: { name: 'concrete', color: [0.65, 0.65, 0.65], transparency: 0.0 },
        properties: {
          isOrphanBridge: true,
          isTransitionHelper: true,
          isApproximation: true,
          geometryApproximation: 'ORPHAN_BRIDGE',
          branchClass: 'STRUCTURAL',
          orphanSegmentKey: orphan.element_key || orphan.id,
          nearestNodeId: bestNode.id,
          gapDistance: +bestDist.toFixed(3)
        },
        relationships: []
      });
      bridgedCount++;
    }
  }

  for (const pa of proxiesAdded) {
    if (!pa.provenance) {
      pa.provenance = { sourceFile: null, sourceFileStatus: 'derived_inferred', sourceFiles: [], stage: 'topology:auditOrphansAndBridgeGaps', modifications: [] };
    }
  }
  css.elements.push(...proxiesAdded);
  if (!css.metadata) css.metadata = {};
  css.metadata.orphanAudit = {
    orphanCount: orphans.length,
    bridgedCount,
    proxiesAdded: proxiesAdded.length
  };
  console.log(`auditOrphansAndBridgeGaps: ${orphans.length} orphan segments → ${bridgedCount} bridge proxies added`);
}


/**
 * generatePortalEndWalls — create simple closure walls at tunnel terminal endpoints.
 * A terminal endpoint is a segment start/end that no other segment shares.
 * Each portal end wall is perpendicular to the tunnel bearing, closing the mouth.
 */
function generatePortalEndWalls(css) {
  const segs = css.elements.filter(e =>
    e.type === 'TUNNEL_SEGMENT' &&
    e.properties?.branchClass === 'STRUCTURAL' &&
    e.geometry?.profile
  );
  if (segs.length === 0) return;

  const SNAP_DIST = 0.5; // endpoint coincidence threshold (meters)

  // Compute start/end points for each segment using bearing (handles vertical axis convention)
  const endpoints = []; // { point, seg, end: 'start'|'end', bearing }
  for (const seg of segs) {
    const bearing = getTunnelBearing(seg);
    if (!bearing) continue;
    const o = seg.placement?.origin;
    if (!o) continue;
    const depth = parseFloat(seg.geometry?.depth || 0);
    if (depth <= 0) continue;
    const halfD = depth / 2;
    const startPt = {
      x: o.x - bearing.x * halfD,
      y: o.y - bearing.y * halfD,
      z: o.z - (bearing.z || 0) * halfD
    };
    const endPt = {
      x: o.x + bearing.x * halfD,
      y: o.y + bearing.y * halfD,
      z: o.z + (bearing.z || 0) * halfD
    };
    endpoints.push({ point: startPt, seg, end: 'start', bearing });
    endpoints.push({ point: endPt, seg, end: 'end', bearing });
  }

  // Find terminal endpoints: no other endpoint within SNAP_DIST
  const terminals = [];
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    let shared = false;
    for (let j = 0; j < endpoints.length; j++) {
      if (i === j) continue;
      // Skip same segment's other endpoint
      if (endpoints[j].seg === ep.seg) continue;
      const d = vecDist(ep.point, endpoints[j].point);
      if (d < SNAP_DIST) { shared = true; break; }
    }
    if (!shared) terminals.push(ep);
  }

  if (terminals.length === 0) return;

  let created = 0;
  for (const term of terminals) {
    const seg = term.seg;
    const prof = seg.geometry.profile;
    const w = parseFloat(prof.width || 5);
    const h = parseFloat(prof.height || 5);
    const wt = parseFloat(seg.properties?.shellThickness_m || 0.3);
    const wallDepth = Math.max(wt, 0.25);
    const segKey = seg.element_key || seg.id;

    // Bearing points into tunnel from this endpoint
    // Offset wall center inward by half its depth so it closes the mouth flush
    const inward = term.end === 'start' ? 1 : -1;
    const wallCenter = {
      x: term.point.x + term.bearing.x * (wallDepth / 2) * inward,
      y: term.point.y + term.bearing.y * (wallDepth / 2) * inward,
      z: term.point.z
    };

    // Lateral direction perpendicular to bearing (horizontal plane)
    const bLen2D = Math.sqrt(term.bearing.x ** 2 + term.bearing.y ** 2);
    let lateral;
    if (bLen2D > 0.001) {
      lateral = { x: -term.bearing.y / bLen2D, y: term.bearing.x / bLen2D, z: 0 };
    } else {
      lateral = { x: 1, y: 0, z: 0 };
    }

    const endWall = {
      id: `portal-end-wall-${segKey}-${term.end}`,
      element_key: `portal-end-wall-${segKey}-${term.end}`,
      type: 'WALL',
      semanticType: 'IfcWall',
      name: `Portal End Wall (${term.end})`,
      placement: {
        origin: wallCenter,
        axis: { x: 0, y: 0, z: 1 },
        refDirection: lateral
      },
      geometry: {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: w, height: h },
        depth: wallDepth
      },
      properties: {
        segmentType: 'PORTAL_END_WALL',
        hostTunnelSegment: segKey,
        portalEnd: term.end
      },
      metadata: {
        geometryExportable: true,
        generatedBy: 'PORTAL_END_WALL'
      },
      provenance: { sourceFile: null, sourceFileStatus: 'derived_geometric', sourceFiles: [], stage: 'topology:generatePortalEndWalls', modifications: [] },
      relationships: []
    };

    css.elements.push(endWall);
    created++;
  }

  if (created > 0) {
    console.log(`Portal end walls: ${created} closure walls created at ${terminals.length} terminal endpoints`);
  }
}

export { decomposeTunnelShell, buildCenterlineSkeleton, identifyAndMergeRuns, decomposeMergedRuns, auditShellCompleteness, computeClosureTargets, alignShellContinuity, extendShellAtJunctions, mergeShellRuns, generateJunctionTransitions, validateTunnelGeometry, auditGeometryGaps, auditVisualGeometryQuality, auditOrphansAndBridgeGaps, generatePortalEndWalls };
