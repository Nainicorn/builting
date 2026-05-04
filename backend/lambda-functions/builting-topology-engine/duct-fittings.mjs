// ============================================================================
// DUCT FITTING SYNTHESIS
// Detects junctions in the DUCT network and emits DUCT_FITTING elements
// (IfcFlowFitting) at each junction node.
//
// Subtypes:
//   ELBOW      — two ducts meet at an angle > 10°
//   TEE        — three or more ducts meet at one node
//   TRANSITION — two collinear ducts with different cross-section profiles
//                (rectangular↔circular) or significantly different sizes
// ============================================================================

/**
 * Extract the run-direction unit vector from a DUCT element at its
 * entry or exit end (based on pathPoints or placement).
 */
function getDuctAxis(duct, isEntry) {
  const pts = duct.geometry?.pathPoints;
  if (Array.isArray(pts) && pts.length >= 2) {
    const p0 = isEntry ? pts[0] : pts[pts.length - 2];
    const p1 = isEntry ? pts[1] : pts[pts.length - 1];
    const dx = (p1.x || 0) - (p0.x || 0);
    const dy = (p1.y || 0) - (p0.y || 0);
    const dz = (p1.z || 0) - (p0.z || 0);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 0.001) return { x: dx / len, y: dy / len, z: dz / len };
  }
  const ref = duct.placement?.refDirection;
  if (ref) {
    const len = Math.sqrt((ref.x || 0) ** 2 + (ref.y || 0) ** 2 + (ref.z || 0) ** 2);
    if (len > 0.001) return { x: ref.x / len, y: ref.y / len, z: ref.z / len };
  }
  return duct.placement?.axis || null;
}

/**
 * Get the 3D world coordinate at a DUCT's entry or exit node.
 */
function getDuctEndpoint(duct, isEntry) {
  const pts = duct.geometry?.pathPoints;
  if (Array.isArray(pts) && pts.length >= 2) {
    return isEntry ? { ...pts[0] } : { ...pts[pts.length - 1] };
  }
  return duct.placement?.origin ? { ...duct.placement.origin } : { x: 0, y: 0, z: 0 };
}

/**
 * Returns 'CIRCLE' or 'RECTANGLE' for a duct profile.
 */
function profileShape(profile = {}) {
  const t = (profile.type || 'RECTANGLE').toUpperCase();
  return (t === 'CIRCLE' || t === 'ROUND') ? 'CIRCLE' : 'RECTANGLE';
}

/**
 * Characteristic dimension of a duct profile (max of width/height/diameter).
 */
function profileMaxDim(profile = {}) {
  const r = profile.radius || 0;
  const w = profile.width || 0;
  const h = profile.height || 0;
  return Math.max(r * 2, w, h, 0.1);
}

/**
 * Synthesize DUCT_FITTING elements at every junction node in the DUCT network.
 * Injects new elements directly into css.elements.
 */
export function synthesizeDuctFittings(css) {
  if (!Array.isArray(css.elements)) return;

  // If spec-text already materialized fittings (deterministic 25 elbows + 3 R2R + 1 round-trans),
  // skip junction-inference synthesis to avoid double-emission. The topology graph still gets
  // the spec fittings via css.elements; their `properties.specInstance` marks them as authoritative.
  const specFittingCount = css.metadata?.specInstances?.fittings?.length || 0;
  if (specFittingCount > 0) {
    console.log(`synthesizeDuctFittings: skipped — spec_text provided ${specFittingCount} authoritative fittings`);
    return;
  }

  const ducts = css.elements.filter(e => e.type === 'DUCT');
  if (ducts.length < 2) return;

  // Build node → [{duct, isEntry}] from entry_node / exit_node properties.
  // Falls back to proximity-snapped buckets when node IDs are absent.
  const nodeToDucts = new Map();   // nodeKey → [{duct, isEntry}]
  const nodeCoords  = new Map();   // nodeKey → {x,y,z}

  let useNodeIds = false;

  // First pass: try named node IDs (VentSim-sourced data)
  for (const duct of ducts) {
    const props = duct.properties || {};
    if (props.entry_node || props.exit_node) {
      useNodeIds = true;
      break;
    }
  }

  if (useNodeIds) {
    for (const duct of ducts) {
      const props = duct.properties || {};
      for (const [nodeId, isEntry] of [
        [props.entry_node, true],
        [props.exit_node, false],
      ]) {
        if (!nodeId) continue;
        if (!nodeToDucts.has(nodeId)) nodeToDucts.set(nodeId, []);
        nodeToDucts.get(nodeId).push({ duct, isEntry });
        if (!nodeCoords.has(nodeId)) {
          nodeCoords.set(nodeId, getDuctEndpoint(duct, isEntry));
        }
      }
    }
  } else {
    // Proximity fallback: quantize endpoints to 10cm grid
    const GRID = 0.1;
    const bucketKey = (pt) =>
      `${Math.round((pt.x || 0) / GRID)}_${Math.round((pt.y || 0) / GRID)}_${Math.round((pt.z || 0) / GRID)}`;

    for (const duct of ducts) {
      for (const isEntry of [true, false]) {
        const pt = getDuctEndpoint(duct, isEntry);
        const key = bucketKey(pt);
        if (!nodeToDucts.has(key)) nodeToDucts.set(key, []);
        nodeToDucts.get(key).push({ duct, isEntry });
        if (!nodeCoords.has(key)) nodeCoords.set(key, pt);
      }
    }
  }

  const fittings = [];

  for (const [nodeId, connections] of nodeToDucts) {
    if (connections.length < 2) continue;

    const coord = nodeCoords.get(nodeId) || { x: 0, y: 0, z: 0 };
    const degree = connections.length;

    let subtype = 'ELBOW';
    let fittingName = 'Round Elbow';
    let confidence = 0.75;

    if (degree >= 3) {
      subtype = 'TEE';
      fittingName = 'Duct Tee';
    } else {
      // degree === 2: determine ELBOW vs TRANSITION
      const { duct: dA, isEntry: iA } = connections[0];
      const { duct: dB, isEntry: iB } = connections[1];
      const profA = dA.geometry?.profile || {};
      const profB = dB.geometry?.profile || {};
      const shapeA = profileShape(profA);
      const shapeB = profileShape(profB);

      if (shapeA !== shapeB) {
        // Different cross-section shapes → Rect-to-Round transition
        subtype = 'TRANSITION';
        fittingName = 'Rect-to-Round Transition';
        confidence = 0.8;
      } else {
        const axA = getDuctAxis(dA, iA);
        const axB = getDuctAxis(dB, iB);
        if (axA && axB) {
          const dot = Math.abs(
            (axA.x || 0) * (axB.x || 0) +
            (axA.y || 0) * (axB.y || 0) +
            (axA.z || 0) * (axB.z || 0)
          );
          const clampedDot = Math.min(1.0, dot);
          const angleDeg = Math.acos(clampedDot) * (180 / Math.PI);

          if (angleDeg < 10) {
            // Collinear — check for size change (round transition)
            const dimA = profileMaxDim(profA);
            const dimB = profileMaxDim(profB);
            if (Math.abs(dimA - dimB) > 0.05) {
              subtype = 'TRANSITION';
              fittingName = 'Round Duct Transition';
              confidence = 0.8;
            } else {
              // Collinear same-size ducts don't need a fitting
              continue;
            }
          }
          // else: bend angle ≥ 10° → ELBOW (default)
        }
      }
    }

    // Fitting geometry: box sized to max connected duct dimension
    const allProfiles = connections.map(c => c.duct.geometry?.profile || {});
    const maxDim = Math.max(...allProfiles.map(profileMaxDim), 0.3);
    const boxSide = maxDim * 1.1;
    const boxDepth = maxDim * 0.5;

    const container = connections[0].duct.container;

    fittings.push({
      id: `duct-fitting-${nodeId}`,
      element_key: `duct-fitting-${nodeId}`,
      type: 'DUCT_FITTING',
      name: fittingName,
      semanticType: 'IfcFlowFitting',
      confidence,
      source: 'TOPOLOGY_SYNTHESIS',
      container,
      placement: {
        origin: { x: coord.x, y: coord.y, z: coord.z },
        axis: { x: 0, y: 0, z: 1 },
        refDirection: { x: 1, y: 0, z: 0 },
      },
      geometry: {
        method: 'EXTRUSION',
        profile: { type: 'RECTANGLE', width: boxSide, height: boxSide },
        depth: boxDepth,
        _geoBehavior: 'DISCRETE_SOLID',
      },
      properties: {
        subtype,
        fittingNode: nodeId,
        connectedDucts: connections.map(c => c.duct.element_key || c.duct.id).filter(Boolean),
      },
      material: { name: 'galvanized steel' },
      discipline: 'mechanical',
    });
  }

  if (fittings.length > 0) {
    css.elements.push(...fittings);
    console.log(`synthesizeDuctFittings: emitted ${fittings.length} DUCT_FITTING elements (ELBOW/TEE/TRANSITION)`);
  }
}
