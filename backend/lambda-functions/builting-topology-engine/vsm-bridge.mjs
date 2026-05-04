/**
 * vsm-bridge.mjs — VSM (VentSim) network gap bridging and ramp orientation.
 *
 * TUNNEL domain only. Three post-processing steps for the topology engine:
 *
 *   1. splitTunnelSubSegments — split the flat levelsOrSegments into main/upper
 *      groups based on element origin Z, before bridges are created.
 *
 *   2. bridgeVSMNodes — insert TUNNEL_SEGMENT bridge elements to close the
 *      coordinate gaps between topologically connected VSM branches.
 *      (VentSim branches share node IDs but store independent 3D endpoints.)
 *
 *   3. fixRampOrientation — annotate sloped TUNNEL_SEGMENTs (|ΔZ| > 0.5m)
 *      with the true 3D slope axis so the generate lambda extrudes them along
 *      the actual incline instead of flat horizontal.
 *
 * All three functions are no-ops outside TUNNEL domain.
 */

import { medianSegmentLength, structureZRange, shellThicknessFromProfile } from './shared.mjs';

// ============================================================================
// 1. SPLIT TUNNEL SUB-SEGMENTS
// ============================================================================

/**
 * [TUNNEL] Partition the single flat levelsOrSegments entry into sub-segments
 * by Z range:
 *   z ≤ 0.5m  → existing main segment (unchanged)
 *   z > 0.5m  → new 'upper passages' segment (appended)
 *
 * Element containers are updated to match. Run BEFORE bridgeVSMNodes so that
 * bridges inherit the correct container from their exit segment.
 *
 * @param {object} css — live CSS object (mutated in place)
 */
export function splitTunnelSubSegments(css) {
  // Data-driven: check for actual TUNNEL_SEGMENT elements
  if (!(css.elements || []).some(e => e.type === 'TUNNEL_SEGMENT')) return;
  if (!css.levelsOrSegments || !css.elements) return;

  // Only consider STRUCTURAL tunnel segments for Z-range — equipment/ducts on
  // ceilings or portal structures should NOT trigger a multi-level split.
  const structuralSegs = css.elements.filter(e =>
    e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL'
  );
  if (structuralSegs.length < 2) return;

  // Collect sorted Z values of structural segments to detect genuine multi-level gaps
  const structZs = structuralSegs
    .map(e => e.placement?.origin?.z ?? 0)
    .sort((a, b) => a - b);

  // Look for a clear Z-gap in the structural segments — a range where no segments
  // exist, indicating truly separate tunnel levels. A tunnel with continuous ramps
  // has no gap and should NOT be split.
  const MIN_GAP = 3.0; // 3m minimum gap between levels to justify a split
  let bestGap = 0, splitZ = null;
  for (let i = 1; i < structZs.length; i++) {
    const gap = structZs[i] - structZs[i - 1];
    if (gap > bestGap) {
      bestGap = gap;
      splitZ = (structZs[i - 1] + structZs[i]) / 2; // midpoint of the gap
    }
  }

  const zMin = structZs[0], zMax = structZs[structZs.length - 1];
  console.log(`splitTunnelSubSegments: structural Z-range ${zMin.toFixed(1)}–${zMax.toFixed(1)}m, `
    + `largest Z-gap=${bestGap.toFixed(2)}m (need ≥${MIN_GAP}m to split)`);

  if (bestGap < MIN_GAP) {
    // No significant Z-gap — single-level tunnel with ramps/grades, no split needed
    console.log(`splitTunnelSubSegments: single-level tunnel (no Z-gap ≥ ${MIN_GAP}m)`);
    return;
  }

  // Guard: if the detected Z-gap is explained by the portal elevation grade, it is a
  // continuous slope — NOT a genuine multi-level structure. Splitting here would create a
  // spurious "upper" container that causes the generate lambda to mis-place one portal leg.
  // Use 1.5× headroom to account for slight VentSim Z spread beyond the documented grade.
  const _portalsWithElev = (css.metadata?.portals || []).filter(p => p.elevation_msl != null);
  if (_portalsWithElev.length >= 2) {
    const _elevs = _portalsWithElev.map(p => p.elevation_msl);
    const _portalGrade = Math.max(..._elevs) - Math.min(..._elevs);
    if (_portalGrade > 0 && bestGap <= _portalGrade * 1.5) {
      console.warn(`splitTunnelSubSegments: SKIPPING SPLIT — Z-gap=${bestGap.toFixed(1)}m ≤ portal grade ${_portalGrade.toFixed(1)}m × 1.5 = ${(_portalGrade * 1.5).toFixed(1)}m. This is a graded single-level tunnel, not multi-level. Suppressing spurious split.`);
      return;
    }
  }

  const UPPER_Z_THRESHOLD = splitZ;

  // Scan all elements for max upper-zone Z (for elevation tracking)
  let maxUpperZ = -Infinity;
  for (const elem of css.elements) {
    const z = elem.placement?.origin?.z ?? 0;
    if (z > UPPER_Z_THRESHOLD && z > maxUpperZ) maxUpperZ = z;
  }

  if (maxUpperZ === -Infinity) return;

  // Identify the main segment (first SEGMENT entry, lowest elevation)
  const mainSeg = css.levelsOrSegments.find(s => s.type === 'SEGMENT') ?? css.levelsOrSegments[0];
  if (!mainSeg) return;

  const upperSegId = `${mainSeg.id}-upper`;

  // Create the upper segment entry if it doesn't already exist
  if (!css.levelsOrSegments.some(s => s.id === upperSegId)) {
    css.levelsOrSegments.push({
      id:          upperSegId,
      type:        'SEGMENT',
      name:        'Upper Passages',
      elevation_m: 0,
      // height_m: inherit from main segment; no occupancy-based default since tunnels
      // are single-level — upper passages have the same headroom as the main bore.
      height_m:    mainSeg.height_m ?? null,
    });
    console.log(`splitTunnelSubSegments: added "${upperSegId}" at elevation_m=0 (maxUpperZ was ${Math.round(maxUpperZ * 100) / 100})`);
  }

  // Reassign containers for elements whose origin is in the upper zone
  let moved = 0;
  for (const elem of css.elements) {
    const z = elem.placement?.origin?.z ?? 0;
    if (z > UPPER_Z_THRESHOLD && (!elem.container || elem.container === mainSeg.id)) {
      elem.container = upperSegId;
      moved++;
    }
  }

  if (moved > 0) {
    console.log(`splitTunnelSubSegments: moved ${moved} elements to "${upperSegId}"`);
  }
}

// ============================================================================
// 2. BRIDGE VSM NODES
// ============================================================================

/**
 * [TUNNEL] Close coordinate gaps between topologically connected VSM branches.
 *
 * VentSim stores each branch as an independent 3D shape. Adjacent branches that
 * share a node ID (entry_node of one = exit_node of another) frequently have
 * endpoint coordinates that don't coincide — gaps range from centimetres to
 * tens of metres. This step inserts a straight TUNNEL_SEGMENT bridge for every
 * such pair to produce a physically connected IFC network.
 *
 * Rules:
 *   • Only bridges gaps  >  50 mm  (COINCIDENCE_TOL — already coincident → skip)
 *   • Only bridges gaps  < 100 m   (MAX_BRIDGE_LEN  — implausible gap     → skip)
 *   • Inherits cross-section profile of the smaller-area segment
 *   • Z path interpolates linearly between the two endpoint Z values
 *   • source: 'BRIDGE_INFERRED', confidence: 0.6
 *   • Uses actual VentSim nodeId for entry_node/exit_node so bridges
 *     participate in topology graph and get PATH_CONNECTS relationships
 *
 * Run AFTER splitTunnelSubSegments (so bridges inherit updated containers) and
 * AFTER snapWallEndpoints, BEFORE buildTopologyGraph.
 *
 * @param {object} css — live CSS object (mutated in place)
 */
export function bridgeVSMNodes(css) {
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;
  if (!css.elements) return;

  const COINCIDENCE_TOL = 0.05;   // 50 mm — already touching, skip
  // MIN_BRIDGE_LEN: gaps shorter than this are floating-point jitter, not real structural gaps.
  // The generate lambda's END_CAP overlap covers these; inserting a sub-0.5m bridge
  // creates degenerate geometry that fails the "depth < 0.5m" validation contract.
  const MIN_BRIDGE_LEN  = 0.5;    // 500 mm — below this, skip and let END_CAP handle it
  // MAX_BRIDGE_LEN: derived from median segment length × 1.5 so it scales with the structure.
  // A 5 m cap is suitable for a small mine; a large rail tunnel may have 50 m transition gaps.
  // Capped at 100 m to guard against clearly unconnected branches in sparse VSM models.
  const MAX_BRIDGE_LEN  = Math.min(100, Math.max(5, medianSegmentLength(css.elements) * 1.5));
  console.log(`bridgeVSMNodes: MAX_BRIDGE_LEN=${MAX_BRIDGE_LEN.toFixed(1)}m `
    + `(derived from median segment length)`);
  const COS_45          = Math.SQRT1_2; // cos(45°) ≈ 0.7071 — arccos(0.707) = 45°

  // Only consider segments that have a valid path
  const tunnelSegs = css.elements.filter(
    e => e.type === 'TUNNEL_SEGMENT' &&
         Array.isArray(e.geometry?.path) &&
         e.geometry.path.length >= 2
  );

  // Build nodeId → [ { seg, endpointType:'entry'|'exit', point } ]
  const nodeMap = new Map();
  for (const seg of tunnelSegs) {
    const path      = seg.geometry.path;
    const entryNode = seg.properties?.entry_node;
    const exitNode  = seg.properties?.exit_node;

    if (entryNode) {
      if (!nodeMap.has(entryNode)) nodeMap.set(entryNode, []);
      nodeMap.get(entryNode).push({ seg, endpointType: 'entry', point: path[0] });
    }
    if (exitNode) {
      if (!nodeMap.has(exitNode)) nodeMap.set(exitNode, []);
      nodeMap.get(exitNode).push({ seg, endpointType: 'exit', point: path[path.length - 1] });
    }
  }

  // Direction vector for each segment (path start → end, normalised)
  const segDirMap = new Map();
  for (const seg of tunnelSegs) {
    const p  = seg.geometry.path;
    const sx = (p[p.length - 1].x ?? 0) - (p[0].x ?? 0);
    const sy = (p[p.length - 1].y ?? 0) - (p[0].y ?? 0);
    const sz = (p[p.length - 1].z ?? 0) - (p[0].z ?? 0);
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    segDirMap.set(seg.id, sl > 1e-6 ? { x: sx / sl, y: sy / sl, z: sz / sl } : { x: 1, y: 0, z: 0 });
  }

  // Segment IDs that already have equipment (FAN/PUMP/DAMPER/VALVE) assigned to them
  const EQUIPMENT_TYPES = new Set(['FAN', 'PUMP', 'DAMPER', 'VALVE']);
  const equipmentContainers = new Set(
    css.elements
      .filter(e => EQUIPMENT_TYPES.has(e.type) && e.container)
      .map(e => e.container)
  );

  const bridges        = [];
  const seen           = new Set(); // dedup key: 'exitId→entryId@nodeId'
  let   skippedGaps    = 0;
  let   skippedEquip   = 0;
  let   skippedAngle   = 0;

  for (const [nodeId, endpoints] of nodeMap) {
    const exits   = endpoints.filter(e => e.endpointType === 'exit');
    const entries = endpoints.filter(e => e.endpointType === 'entry');

    for (const exitEp of exits) {
      for (const entryEp of entries) {
        if (exitEp.seg === entryEp.seg) continue;

        const dedupeKey = `${exitEp.seg.id}→${entryEp.seg.id}@${nodeId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const p0 = exitEp.point;
        const p1 = entryEp.point;
        const dx = (p1.x ?? 0) - (p0.x ?? 0);
        const dy = (p1.y ?? 0) - (p0.y ?? 0);
        const dz = (p1.z ?? 0) - (p0.z ?? 0);
        const gap = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (gap < COINCIDENCE_TOL) continue;
        if (gap < MIN_BRIDGE_LEN) {
          // Sub-minimum gap: floating-point jitter between nearly-coincident endpoints.
          // Inserting a bridge this short creates degenerate geometry. Skip — the
          // generate lambda's END_CAP overlap (junction extension) covers the gap.
          console.log(`bridgeVSMNodes: ${exitEp.seg.id}→${entryEp.seg.id} gap=${gap.toFixed(3)}m < MIN_BRIDGE_LEN, skipping (END_CAP covers)`);
          skippedGaps++;
          continue;
        }
        if (gap > MAX_BRIDGE_LEN) {
          console.warn(`bridgeVSMNodes: ${exitEp.seg.id}→${entryEp.seg.id} gap=${gap.toFixed(1)}m > ${MAX_BRIDGE_LEN}m, skipping`);
          skippedGaps++;
          continue;
        }

        // Equipment filter — if either segment hosts a FAN/PUMP/DAMPER/VALVE they
        // connect via that equipment, not a raw bridge
        if (equipmentContainers.has(exitEp.seg.id) || equipmentContainers.has(entryEp.seg.id)) {
          skippedEquip++;
          continue;
        }

        // Angle filter — segments must be pointing within 45° of each other
        const exitDir  = segDirMap.get(exitEp.seg.id);
        const entryDir = segDirMap.get(entryEp.seg.id);
        const dot = exitDir.x * entryDir.x + exitDir.y * entryDir.y + exitDir.z * entryDir.z;
        if (dot < COS_45) {
          skippedAngle++;
          continue;
        }

        // Profile: inherit from the smaller-area segment
        const exitProf  = exitEp.seg.geometry?.profile  ?? {};
        const entryProf = entryEp.seg.geometry?.profile ?? {};
        const area = p => p.type === 'CIRCLE'
          ? Math.PI * (p.radius ?? 0) ** 2
          : (p.width ?? 0) * (p.height ?? 0);
        const profile = area(exitProf) <= area(entryProf)
          ? { ...exitProf }
          : { ...entryProf };

        // Fix #2 — ensure profile has valid dimensions; undefined radius/width
        // blocks IFC export entirely for the affected segments.
        // Lookup order: profile field → properties.cross_section → 2.0m fallback.
        const _getCrossDim = (seg) =>
          seg.properties?.cross_section?.radius ||
          (seg.properties?.cross_section?.hydraulic_diameter != null
            ? seg.properties.cross_section.hydraulic_diameter / 2 : null) ||
          seg.properties?.cross_section?.width ||
          null;
        if (profile.type === 'CIRCLE') {
          if (!profile.radius) {
            profile.radius = _getCrossDim(exitEp.seg) || _getCrossDim(entryEp.seg) || 2.0;
          }
        } else {
          if (!profile.width)  profile.width  = _getCrossDim(exitEp.seg) || _getCrossDim(entryEp.seg) || 2.0;
          if (!profile.height) profile.height = profile.width;
        }

        // Normalised 3D direction (used by generate for extrusion axis)
        const nx = dx / gap, ny = dy / gap, nz = dz / gap;
        // Guard: gap > COINCIDENCE_TOL guarantees gap > 0 but floating-point edge
        // cases can still produce NaN/Inf — skip rather than emit corrupt geometry.
        if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) {
          console.warn(`bridgeVSMNodes: non-finite direction for ${exitEp.seg.id}→${entryEp.seg.id} `
            + `gap=${gap}, skipping`);
          continue;
        }
        // Horizontal bearing (for placement refDirection — XY plane only)
        const hLen = Math.sqrt(dx * dx + dy * dy);
        const bx   = hLen > 1e-6 ? dx / hLen : 1;
        const by   = hLen > 1e-6 ? dy / hLen : 0;

        // Fix #3 — deterministic bridge ID: sort the two segment IDs so that
        // bridge_A_B and bridge_B_A produce the same key, preventing duplicate
        // bridge insertion when the same pair appears in both exit→entry orders.
        const [segA, segB] = [exitEp.seg.id, entryEp.seg.id].sort();
        const bridgeId = `bridge_${segA}_${segB}`;
        // Skip if a bridge for this segment pair was already queued this pass
        if (bridges.some(b => b.id === bridgeId)) continue;

        bridges.push({
          id:           bridgeId,
          element_key:  bridgeId,
          canonical_id: bridgeId,
          type:         'TUNNEL_SEGMENT',
          semanticType: 'IfcBuildingElementProxy',
          name:         `Bridge_${nodeId}`,
          placement: {
            origin:       { x: p0.x ?? 0, y: p0.y ?? 0, z: p0.z ?? 0 },
            axis:         { x: 0, y: 0, z: 1 },
            refDirection: { x: bx, y: by, z: 0 },
          },
          geometry: Math.abs(dz) > 0.3
            ? {
                method:       'SWEEP',
                _geoBehavior: 'PATH_SWEEP',
                profile:      { ...profile, wallThickness: profile.wallThickness ?? shellThicknessFromProfile({ geometry: { profile }, properties: {} }, null) },
                depth:        gap,
                direction:    { x: nx, y: ny, z: nz },
                pathPoints: [
                  { x: p0.x ?? 0, y: p0.y ?? 0, z: p0.z ?? 0 },
                  { x: p1.x ?? 0, y: p1.y ?? 0, z: p1.z ?? 0 },
                ],
                path: [
                  { x: p0.x ?? 0, y: p0.y ?? 0, z: p0.z ?? 0 },
                  { x: p1.x ?? 0, y: p1.y ?? 0, z: p1.z ?? 0 },
                ],
              }
            : {
                method:    'EXTRUSION',
                profile:   { ...profile, wallThickness: profile.wallThickness ?? shellThicknessFromProfile({ geometry: { profile }, properties: {} }, null) },
                depth:     gap,
                direction: { x: nx, y: ny, z: nz },
                path: [
                  { x: p0.x ?? 0, y: p0.y ?? 0, z: p0.z ?? 0 },
                  { x: p1.x ?? 0, y: p1.y ?? 0, z: p1.z ?? 0 },
                ],
              },
          container:     exitEp.seg.container ?? 'seg-tunnel-main',
          relationships: [],
          properties: {
            entry_node:          nodeId,
            exit_node:           nodeId,
            branchClass:         'STRUCTURAL',
            shellThickness_m:    profile.wallThickness ?? shellThicknessFromProfile({ geometry: { profile }, properties: {} }, null),
            shellMode:           exitEp.seg.properties?.shellMode ?? 'HOLLOW_PROFILE',
            decompositionMethod: 'BRIDGE_INFERRED',
            _isBridgeSegment:    true,
          },
          material: exitEp.seg.material
            ? { ...exitEp.seg.material }
            : { name: 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 },
          confidence:  0.6,
          source:      'BRIDGE_INFERRED',
          sourceFile:  null,
          metadata: {
            bridgeForNode:      nodeId,
            bridgeFromSegment:  exitEp.seg.id,
            bridgeToSegment:    entryEp.seg.id,
            gapMm:              Math.round(gap * 1000),
            geometryExportable: true,
          },
        });
      }
    }
  }

  // Position-based dedup: different node traversals can produce bridges at
  // nearly the same 3D location via different node IDs. Round to 10cm grid.
  const posIndex = new Map();
  let posDuplicates = 0;
  const dedupedBridges = bridges.filter(b => {
    const o = b.placement?.origin ?? {};
    const pk = `${Math.round((o.x ?? 0) * 10)}_${Math.round((o.y ?? 0) * 10)}_${Math.round((o.z ?? 0) * 10)}`;
    if (posIndex.has(pk)) {
      console.log(`bridgeVSMNodes: positional duplicate removed: ${b.id} at (${(o.x??0).toFixed(1)},${(o.y??0).toFixed(1)},${(o.z??0).toFixed(1)}) — kept ${posIndex.get(pk)}`);
      posDuplicates++;
      return false;
    }
    posIndex.set(pk, b.id);
    return true;
  });

  if (dedupedBridges.length > 0) {
    css.elements.push(...dedupedBridges);
  }
  console.log(`bridgeVSMNodes: inserted ${dedupedBridges.length} bridge segments (${posDuplicates} positional duplicates removed, ${skippedGaps} exceeded 5m, ${skippedEquip} had equipment, ${skippedAngle} angle >45°)`);
}

// ============================================================================
// 3. FIX RAMP ORIENTATION
// ============================================================================

/**
 * [TUNNEL] Annotate sloped TUNNEL_SEGMENTs with their true 3D slope axis.
 *
 * Segments where |path[end].z − path[start].z| > 0.5m are currently rendered
 * as flat horizontal extrusions placed at the wrong elevation, because
 * annotateSweepGeometry skips isTunnelShell elements. This step:
 *
 *   • Sets _geoBehavior = 'PATH_SWEEP' (overrides flat classification)
 *   • Sets _isRamp = true (flag for generate lambda)
 *   • Sets _slopeAxis / _runAxis = normalised 3D slope vector
 *   • Sets geometry.direction = slope vector (generate reads this for extrusion)
 *   • Writes pathPoints from the existing path so generate has a clean directrix
 *
 * Run AFTER annotateSweepGeometry so any flat-axis that step wrote for
 * isTunnelShell elements is correctly overridden for ramps.
 *
 * @param {object} css — live CSS object (mutated in place)
 */
export function fixRampOrientation(css) {
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;
  if (!css.elements) return;

  const RAMP_Z_THRESHOLD = 0.5; // 500 mm Z variation triggers ramp treatment

  let count = 0;

  for (const elem of css.elements) {
    if (elem.type !== 'TUNNEL_SEGMENT') continue;
    const geom = elem.geometry;
    if (!geom) continue;

    const path = geom.path;
    if (!Array.isArray(path) || path.length < 2) continue;

    const startZ = path[0].z ?? 0;
    const endZ   = path[path.length - 1].z ?? 0;
    if (Math.abs(endZ - startZ) <= RAMP_Z_THRESHOLD) continue;

    // True 3D slope vector
    const dx  = (path[path.length - 1].x ?? 0) - (path[0].x ?? 0);
    const dy  = (path[path.length - 1].y ?? 0) - (path[0].y ?? 0);
    const dz  = endZ - startZ;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) continue;

    const slopeAxis = { x: dx / len, y: dy / len, z: dz / len };

    geom._geoBehavior  = 'PATH_SWEEP';
    geom._isTunnelShell = true;
    geom._isRamp       = true;
    geom._slopeAxis    = slopeAxis;
    geom._runAxis      = slopeAxis;
    geom._pathAuthored = true;
    geom._pathLength   = len;
    // Carry slope into geometry.direction so the generate lambda can read it
    // without needing to recompute from the path.
    geom.direction  = slopeAxis;
    // Ensure pathPoints exist and mirror the geometry path for the directrix
    geom.pathPoints = path.map(p => ({ x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0 }));

    count++;
  }

  if (count > 0) console.log(`fixRampOrientation: annotated ${count} ramp segment(s) with slope axis`);
}
