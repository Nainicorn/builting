/**
 * Unified v2 Adapter — CSS ↔ inferred.json ↔ resolved.json ↔ legacy CSS
 *
 * Merged from builting-structure/v2-adapter.mjs (cssToInferred) and
 * builting-geometry/v2-adapter.mjs (cssToResolved, resolvedToLegacyCss).
 *
 * All three adapters now live in the same module within the Topology Engine,
 * eliminating the serialization boundary that previously separated them.
 */

import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════
// CSS → inferred.json (formerly in builting-structure)
// ═══════════════════════════════════════════════════════════════════════════

export function cssToInferred(css) {
  const domain = (css.domain || 'BUILDING').toUpperCase();
  const inferredObjects = [];
  const rulesApplied = new Map();

  for (const elem of (css.elements || [])) {
    const type = (elem.type || 'UNKNOWN').toUpperCase();
    const inferredId = `inf-${crypto.randomUUID().slice(0, 12)}`;

    let inferenceRule = 'structureResolve';
    let provenanceBasis = 'DIRECT_SEGMENT_GEOMETRY';
    if (elem.properties?.decompositionMethod === 'SEGMENT_FALLBACK') {
      inferenceRule = 'segmentFallback';
      provenanceBasis = 'SEGMENT_FALLBACK';
    } else if (elem.properties?.shellPiece) {
      inferenceRule = 'decomposeTunnelShell';
      if (elem.properties?.usedDefaultThickness) {
        provenanceBasis = 'DEFAULT_THICKNESS_FALLBACK';
      } else {
        provenanceBasis = 'DECOMPOSED_SHELL_GEOMETRY';
      }
    } else if (elem.properties?.isMergedRun) {
      inferenceRule = 'mergeShellRuns';
      provenanceBasis = 'DECOMPOSED_SHELL_GEOMETRY';
    } else if (elem.properties?.isJunctionTransition) {
      inferenceRule = 'generateJunctionTransitions';
      provenanceBasis = 'JUNCTION_UNRESOLVED_FALLBACK';
    } else if (elem.properties?.isFallback) {
      inferenceRule = 'guaranteeBuildingEnvelope';
      provenanceBasis = 'SEGMENT_FALLBACK';
    } else if (elem.properties?.mergedWalls) {
      inferenceRule = 'mergeWalls';
      provenanceBasis = 'DIRECT_SEGMENT_GEOMETRY';
    } else if (elem.properties?.inferredSlab) {
      inferenceRule = 'inferSlabs';
      provenanceBasis = 'DIRECT_SEGMENT_GEOMETRY';
    } else if (type === 'TUNNEL_SEGMENT') {
      inferenceRule = 'tunnelSegmentPassthrough';
      provenanceBasis = 'DIRECT_SEGMENT_GEOMETRY';
    } else if (type === 'EQUIPMENT') {
      inferenceRule = 'equipmentExtraction';
      provenanceBasis = 'DIRECT_SEGMENT_GEOMETRY';
    }

    if (!rulesApplied.has(inferenceRule)) {
      rulesApplied.set(inferenceRule, { inputCount: 0, outputCount: 0, deterministic: true });
    }
    rulesApplied.get(inferenceRule).outputCount++;

    const geom = elem.geometry;
    inferredObjects.push({
      inferred_id: inferredId,
      canonical_id: elem.canonical_id || elem.element_key || elem.id,
      instance_id: crypto.randomUUID(),
      element_key: elem.element_key || elem.id,
      type,
      semanticType: elem.semanticType || elem.semantic_type || 'IfcBuildingElementProxy',
      name: elem.name || '',
      derivedFrom: elem.properties?.source_claim_ids || [],
      properties: elem.properties || {},
      placementHypothesis: elem.placement ? {
        origin: elem.placement.origin || { x: 0, y: 0, z: 0 },
        axis: elem.placement.axis || { x: 0, y: 0, z: 1 },
        refDirection: elem.placement.refDirection || { x: 1, y: 0, z: 0 }
      } : null,
      geometryHypothesis: geom ? {
        intent: geom.method === 'EXTRUSION' ? 'extrusion' :
               geom.method === 'SWEEP' ? 'sweep' :
               geom.method === 'BREP' ? 'brep' :
               (geom.mesh || geom.vertices) ? 'mesh' : 'extrusion',
        method: geom.method || null,
        profile: geom.profile || null,
        depth: geom.depth || null,
        direction: geom.direction || null,
        path: geom.path || null,
        pathPoints: geom.pathPoints || null,
        vertices: geom.vertices || null,
        faces: geom.faces || null
      } : null,
      containerHypothesis: elem.container || null,
      relationships: (elem.relationships || []).map(r => ({ ...r, type: r.type, target: r.target })),
      material: elem.material || null,
      confidence: elem.confidence || 0.7,
      source: elem.source || 'LLM',
      sourceFile: elem.sourceFile || null,
      evidence: elem.metadata?.evidence || null,
      deterministic: true,
      provenance: elem.provenance || {
        sourceFile: elem.sourceFile || null,
        sourceFileStatus: elem.sourceFile ? 'legacy' : 'missing',
        sourceFiles: elem.sourceFile ? [elem.sourceFile] : [],
        stage: 'extract',
        modifications: [],
      },
      _inferenceProvenance: {
        inference_rule: inferenceRule,
        basis: provenanceBasis,
        resolutionPolicy: provenanceBasis === 'LEGACY_TRANSFORM' ? 'legacy_transform' : 'guarded_shell_v2'
      }
    });
  }

  const inferenceReport = {
    rulesApplied: Array.from(rulesApplied.entries()).map(([rule, stats]) => ({
      rule, inputCount: stats.inputCount, outputCount: stats.outputCount, deterministic: stats.deterministic
    })),
    repairActions: css.metadata?.repairLog || [],
    ambiguousOutputs: [],
    droppedCandidates: []
  };

  return {
    schemaVersion: '2.0',
    layer: 'inferred',
    domain,
    inferredObjects,
    inferenceReport,
    metadata: {
      observedElementsConsumed: css.elements?.length || 0,
      inferredElementsProduced: inferredObjects.length
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CSS → resolved.json (formerly in builting-geometry)
// ═══════════════════════════════════════════════════════════════════════════

export function cssToResolved(css) {
  const domain = (css.domain || 'BUILDING').toUpperCase();
  const meta = css.metadata || {};

  const containers = (css.levelsOrSegments || []).map(level => ({
    id: level.id,
    type: level.type === 'SEGMENT' ? 'SEGMENT' : 'STOREY',
    name: level.name || level.id,
    elevation_m: level.elevation_m || 0,
    height_m: level.height_m || 3.5
  }));

  const elements = (css.elements || []).map(elem => {
    const type = (elem.type || 'UNKNOWN').toUpperCase();
    const geom = elem.geometry;

    return {
      canonical_id: elem.canonical_id || elem.element_key || elem.id,
      instance_id: crypto.randomUUID(),
      element_key: elem.element_key || elem.id,
      type,
      semanticType: elem.semanticType || elem.semantic_type || 'IfcBuildingElementProxy',
      name: elem.name || '',
      placement: elem.placement ? {
        origin: elem.placement.origin || { x: 0, y: 0, z: 0 },
        axis: elem.placement.axis || { x: 0, y: 0, z: 1 },
        refDirection: elem.placement.refDirection || { x: 1, y: 0, z: 0 }
      } : null,
      geometry: geom ? (() => {
        const g = {
          intent: geom.method === 'EXTRUSION' ? 'extrusion' :
                 geom.method === 'SWEEP' ? 'sweep' :
                 geom.method === 'BREP' ? 'brep' :
                 (geom.mesh || geom.vertices) ? 'mesh' : 'extrusion',
          method: geom.method || null,
          profile: geom.profile || null,
          path: geom.path || null,
          pathPoints: geom.pathPoints || null,
          depth: geom.depth || null,
          direction: geom.direction || null,
          vertices: geom.vertices || null,
          faces: geom.faces || null,
          meshRef: (geom.mesh || geom.vertices) ? 'inline' : null
        };
        // Preserve topology-engine annotations (_geoBehavior, _isTunnelShell, _pathAuthored, etc.)
        for (const k of Object.keys(geom)) {
          if (k.startsWith('_') && !(k in g)) g[k] = geom[k];
        }
        return g;
      })() : null,
      container: elem.container || null,
      unresolvedContainer: !elem.container,
      relationships: (elem.relationships || []).map(r => ({ ...r, type: r.type, target: r.target })),
      properties: elem.properties || {},
      material: elem.material || { name: 'default', color: [0.5, 0.5, 0.5], transparency: 0 },
      confidence: elem.confidence || 0.7,
      source: elem.source || 'LLM',
      sourceFile: elem.sourceFile || null,
      evidence: elem.metadata?.evidence || null,
      topologyMetadata: elem.metadata || null,
      sourceLayer: 'inferred',
      provenance: elem.provenance || {
        sourceFile: elem.sourceFile || null,
        sourceFileStatus: elem.sourceFile ? 'legacy' : 'missing',
        sourceFiles: elem.sourceFile ? [elem.sourceFile] : [],
        stage: 'extract',
        modifications: [],
      },
      locks: { humanLocked: false, lockedFields: [] },
      exportHints: {
        preferProxy: (elem.confidence || 0.7) < 0.5,
        avoidMesh: false,
        authoringSafeTarget: (elem.confidence || 0.7) >= 0.7,
        hostRequiredBeforeOpeningExport: false
      }
    };
  });

  const topology = css.topology || { nodes: [], runs: [], junctions: [], interfaces: [], hosts: [], openings: [] };

  return {
    schemaVersion: '2.0',
    layer: 'resolved',
    domain,
    facility: css.facility || {
      name: meta.facilityName || '',
      type: domain.toLowerCase(),
      description: '',
      units: 'M',
      origin: { x: 0, y: 0, z: 0 },
      axes: 'RIGHT_HANDED_Z_UP'
    },
    containers,
    elements,
    topology,
    metadata: {
      layerSummary: { observed: 0, inferred: elements.length, resolved: elements.length },
      modelExtent: meta.modelExtent || { x: 0, y: 0, z: 0, elementCount: elements.length },
      safetyWarnings: meta.safetyWarnings || [],
      exportProfile: meta.exportProfile || 'coordination',
      pipelineVersion: '3.0',
      outputMode: meta.outputMode || 'HYBRID',
      placementZIsAbsolute: meta.placementZIsAbsolute ?? true,
      sourceFusion: meta.sourceFusion || null,
      interiorSuppression: meta.interiorSuppression || null,
      tunnelDecomposition: meta.tunnelDecomposition || null,
      repairLog: meta.repairLog || [],
      cssValidationIssues: meta.cssValidationIssues || 0,
      cssValidationDetails: meta.cssValidationDetails || undefined,
      ambiguousWallProfiles: meta.ambiguousWallProfiles || undefined,
      facilityDimensions: meta.facilityDimensions || [],
      materialAssignments: meta.materialAssignments || []
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// resolved.json → legacy CSS v1.0 (formerly in builting-geometry)
// ═══════════════════════════════════════════════════════════════════════════

export function resolvedToLegacyCss(resolved) {
  const INTENT_TO_METHOD = {
    extrusion: 'EXTRUSION',
    sweep: 'SWEEP',
    mesh: 'MESH',
    brep: 'BREP'
  };

  const levelsOrSegments = (resolved.containers || []).map(c => ({
    id: c.id,
    type: c.type,
    name: c.name || c.id,
    elevation_m: c.elevation_m || 0,
    height_m: c.height_m || 3.5
  }));

  const elements = (resolved.elements || []).map(elem => {
    const geom = elem.geometry;

    const cssElem = {
      id: elem.element_key,
      element_key: elem.element_key,
      canonical_id: elem.canonical_id,
      type: elem.type,
      semanticType: elem.semanticType,
      name: elem.name || '',
      placement: elem.placement ? {
        origin: elem.placement.origin || { x: 0, y: 0, z: 0 },
        axis: elem.placement.axis || { x: 0, y: 0, z: 1 },
        refDirection: elem.placement.refDirection || { x: 1, y: 0, z: 0 }
      } : null,
      geometry: geom ? (() => {
        const method = geom.method || INTENT_TO_METHOD[geom.intent] || 'EXTRUSION';
        const g = { method, profile: geom.profile || null, depth: geom.depth || null };
        if (geom.direction) g.direction = geom.direction;
        if (geom.path) g.path = geom.path;
        if (geom.pathPoints) g.pathPoints = geom.pathPoints;
        if (geom.vertices) g.vertices = geom.vertices;
        if (geom.faces) g.faces = geom.faces;
        if (geom.vertices || geom.meshRef === 'inline') g.mesh = true;
        // Preserve topology-engine annotations (_geoBehavior, _isTunnelShell, _pathAuthored, etc.)
        for (const k of Object.keys(geom)) {
          if (k.startsWith('_') && !(k in g)) g[k] = geom[k];
        }
        return g;
      })() : null,
      container: elem.container || null,
      relationships: (elem.relationships || []).map(r => ({ ...r, type: r.type, target: r.target })),
      properties: elem.properties || {},
      material: elem.material || { name: 'default', color: [0.5, 0.5, 0.5], transparency: 0 },
      confidence: elem.confidence || 0.7,
      source: elem.source || 'LLM',
      sourceFile: elem.sourceFile || null,
      provenance: elem.provenance || {
        sourceFile: elem.sourceFile || null,
        sourceFileStatus: elem.sourceFile ? 'legacy' : 'missing',
        sourceFiles: elem.sourceFile ? [elem.sourceFile] : [],
        stage: 'extract',
        modifications: [],
      },
    };

    // Preserve full metadata: evidence + topology placement metadata (zAligned, parentSegment, etc.)
    const topo = elem.topologyMetadata || {};
    const evidence = elem.evidence || topo.evidence || null;
    cssElem.metadata = { ...topo };
    if (evidence) cssElem.metadata.evidence = evidence;

    return cssElem;
  });

  const rMeta = resolved.metadata || {};

  return {
    cssVersion: '1.0',
    domain: resolved.domain || 'BUILDING',
    facility: resolved.facility || {
      name: '',
      type: (resolved.domain || 'building').toLowerCase(),
      description: '',
      units: 'M',
      origin: { x: 0, y: 0, z: 0 },
      axes: 'RIGHT_HANDED_Z_UP'
    },
    levelsOrSegments,
    elements,
    topology: resolved.topology || { nodes: [], runs: [], junctions: [], interfaces: [], hosts: [], openings: [] },
    metadata: {
      modelExtent: rMeta.modelExtent || { x: 0, y: 0, z: 0, elementCount: elements.length },
      safetyWarnings: rMeta.safetyWarnings || [],
      exportProfile: rMeta.exportProfile || 'coordination',
      outputMode: rMeta.outputMode || 'HYBRID',
      placementZIsAbsolute: rMeta.placementZIsAbsolute ?? true,
      sourceFusion: rMeta.sourceFusion || null,
      interiorSuppression: rMeta.interiorSuppression || null,
      tunnelDecomposition: rMeta.tunnelDecomposition || null,
      repairLog: rMeta.repairLog || [],
      cssValidationIssues: rMeta.cssValidationIssues || 0,
      cssValidationDetails: rMeta.cssValidationDetails || undefined,
      ambiguousWallProfiles: rMeta.ambiguousWallProfiles || undefined,
      facilityDimensions: rMeta.facilityDimensions || [],
      materialAssignments: rMeta.materialAssignments || [],
      adapterSource: 'resolvedToLegacyCss',
      resolvedSchemaVersion: resolved.schemaVersion || '2.0'
    }
  };
}
