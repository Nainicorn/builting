/**
 * validation.mjs — CSS validation, repair, and geometry normalization.
 * Extracted from builting-transform lines 306-575.
 */

import { safe, clamp, sanitizeDir, canonicalWallDirection, vecDot } from './shared.mjs';

// ============================================================================
// VALIDATE CSS
// ============================================================================

export function validateCSS(css) {
  const errors = [];
  const warnings = [];
  const repairSuggestions = [];

  if (css.cssVersion !== '1.0') {
    errors.push({ field: 'cssVersion', message: `Expected "1.0", got "${css.cssVersion}"`, severity: 'error' });
  }

  if (!css.elements || !Array.isArray(css.elements) || css.elements.length === 0) {
    return { valid: false, repairable: false, errors: [{ field: 'elements', message: 'Missing or empty elements', severity: 'error' }], warnings: [], repairSuggestions: [] };
  }

  if (!css.levelsOrSegments || css.levelsOrSegments.length === 0) {
    errors.push({ field: 'levelsOrSegments', message: 'Missing levelsOrSegments', severity: 'error' });
    repairSuggestions.push({ action: 'add_default_level', field: 'levelsOrSegments' });
  }

  const validContainers = new Set((css.levelsOrSegments || []).map(l => l.id));
  const validElementIds = new Set(css.elements.map(e => e.id));

  for (const elem of css.elements) {
    const eid = elem.id || 'unknown';

    if (!elem.placement || !elem.placement.origin) {
      errors.push({ elementId: eid, field: 'placement', message: 'Missing placement', severity: 'error' });
      repairSuggestions.push({ elementId: eid, action: 'assign_default_placement' });
    }

    if (!elem.geometry || !elem.geometry.method) {
      errors.push({ elementId: eid, field: 'geometry', message: 'Missing geometry', severity: 'error' });
      repairSuggestions.push({ elementId: eid, action: 'assign_default_geometry' });
    }

    if (!elem.container || !validContainers.has(elem.container)) {
      errors.push({ elementId: eid, field: 'container', message: `Invalid container: ${elem.container}`, severity: 'error' });
      repairSuggestions.push({ elementId: eid, action: 'assign_first_container' });
    }

    if (elem.geometry) {
      const d = elem.geometry.depth;
      if (d !== undefined && (d <= 0 || !isFinite(d))) {
        errors.push({ elementId: eid, field: 'geometry.depth', message: `Invalid depth: ${d}`, severity: 'error' });
        repairSuggestions.push({ elementId: eid, action: 'clamp_dimension', field: 'geometry.depth' });
      }
    }

    if (elem.placement?.origin) {
      for (const c of ['x', 'y', 'z']) {
        if (!isFinite(elem.placement.origin[c])) {
          errors.push({ elementId: eid, field: `placement.origin.${c}`, message: 'Non-finite value', severity: 'error' });
          repairSuggestions.push({ elementId: eid, action: 'replace_nan', field: `placement.origin.${c}` });
        }
      }
    }

    // Warnings
    if (elem.confidence !== undefined && elem.confidence < 0.3) {
      warnings.push({ elementId: eid, field: 'confidence', message: `Very low: ${elem.confidence}`, severity: 'warning' });
    }

    if (elem.relationships) {
      for (const rel of elem.relationships) {
        if (!validElementIds.has(rel.target)) {
          warnings.push({ elementId: eid, field: 'relationships', message: `Dangling target: ${rel.target}`, severity: 'warning' });
          repairSuggestions.push({ elementId: eid, action: 'remove_dangling_relationship' });
        }
      }
    }
  }

  // Bbox warning
  if (css.metadata?.bbox) {
    const { min, max } = css.metadata.bbox;
    const maxDim = Math.max(
      Math.abs((max?.x || 0) - (min?.x || 0)),
      Math.abs((max?.y || 0) - (min?.y || 0)),
      Math.abs((max?.z || 0) - (min?.z || 0))
    );
    if (maxDim > 10000) {
      warnings.push({ field: 'bbox', message: `Extends beyond 10km: ${maxDim.toFixed(0)}m`, severity: 'warning' });
    }
  }

  const hasErrors = errors.filter(e => e.severity === 'error').length > 0;
  return { valid: !hasErrors, repairable: hasErrors && repairSuggestions.length > 0, errors, warnings, repairSuggestions };
}


// ============================================================================
// REPAIR CSS
// ============================================================================

export function repairCSS(css) {
  const repairLog = css.metadata?.repairLog || [];
  const validContainers = new Set((css.levelsOrSegments || []).map(l => l.id));
  const validElementIds = new Set(css.elements.map(e => e.id));

  // Ensure levelsOrSegments
  if (!css.levelsOrSegments || css.levelsOrSegments.length === 0) {
    css.levelsOrSegments = [{ id: 'level-1', type: 'STOREY', name: 'Ground Floor', elevation_m: 0, height_m: 3 }];
    validContainers.add('level-1');
    repairLog.push({ elementId: 'global', action: 'added_default_level', field: 'levelsOrSegments' });
  }

  const firstContainerId = css.levelsOrSegments[0].id;

  for (const elem of css.elements) {
    const eid = elem.id || 'unknown';

    // Fix missing placement
    if (!elem.placement) {
      elem.placement = { origin: { x: 0, y: 0, z: 0 } };
      repairLog.push({ elementId: eid, action: 'assigned_default_placement', field: 'placement' });
    }
    if (!elem.placement.origin) {
      elem.placement.origin = { x: 0, y: 0, z: 0 };
      repairLog.push({ elementId: eid, action: 'assigned_default_origin', field: 'placement.origin' });
    }

    // Fix NaN in placement
    for (const c of ['x', 'y', 'z']) {
      if (!isFinite(elem.placement.origin[c])) {
        elem.placement.origin[c] = 0;
        repairLog.push({ elementId: eid, action: 'replaced_nan', field: `placement.origin.${c}` });
      }
    }

    // Fix missing geometry
    if (!elem.geometry) {
      elem.geometry = { method: 'EXTRUSION', profile: { type: 'RECTANGLE', width: 1, height: 1 }, direction: { x: 0, y: 0, z: 1 }, depth: 1 };
      repairLog.push({ elementId: eid, action: 'assigned_default_geometry', field: 'geometry' });
    }
    if (!elem.geometry.method) elem.geometry.method = 'EXTRUSION';

    // Fix dimensions
    if (elem.geometry.depth !== undefined) {
      if (!isFinite(elem.geometry.depth) || elem.geometry.depth <= 0) {
        elem.geometry.depth = 1;
        repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'geometry.depth' });
      } else if (elem.geometry.depth > 500) {
        elem.geometry.depth = 500;
        repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'geometry.depth' });
      }
    }

    if (elem.geometry.profile) {
      const p = elem.geometry.profile;
      if (p.width !== undefined && (!isFinite(p.width) || p.width <= 0)) { p.width = 1; repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'profile.width' }); }
      if (p.height !== undefined && (!isFinite(p.height) || p.height <= 0)) { p.height = 1; repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'profile.height' }); }
      if (p.radius !== undefined && (!isFinite(p.radius) || p.radius <= 0)) { p.radius = 0.5; repairLog.push({ elementId: eid, action: 'clamped_dimension', field: 'profile.radius' }); }
    }

    // Fix container
    if (!elem.container || !validContainers.has(elem.container)) {
      elem.container = firstContainerId;
      repairLog.push({ elementId: eid, action: 'assigned_container', field: 'container' });
    }

    // Fix confidence/source
    if (elem.confidence === undefined || !isFinite(elem.confidence)) elem.confidence = 0.5;
    elem.confidence = Math.max(0, Math.min(1, elem.confidence));
    if (!elem.source) elem.source = 'LLM';

    // Remove dangling relationships
    if (elem.relationships && Array.isArray(elem.relationships)) {
      elem.relationships = elem.relationships.filter(rel => {
        if (!validElementIds.has(rel.target)) {
          repairLog.push({ elementId: eid, action: 'removed_dangling_relationship', field: 'relationships' });
          return false;
        }
        return true;
      });
    }
  }

  css.metadata = css.metadata || {};
  css.metadata.repairLog = repairLog;
  if (repairLog.length > 0) css.metadata.validationStatus = 'REPAIRED';

  // Per-element resilience: only downgrade individual broken elements, not the entire model
  let brokenCount = 0;
  for (const elem of css.elements) {
    const isBroken = !elem.placement?.origin || !elem.geometry?.method || !elem.container;
    if (isBroken && elem.type !== 'PROXY') {
      elem.semanticType = elem.semanticType || elem.type;
      elem.type = 'PROXY';
      repairLog.push({ elementId: elem.id, action: 'downgraded_to_proxy', reason: 'missing_required_fields', field: 'type' });
      brokenCount++;
    }
  }
  if (brokenCount > 0) {
    console.log(`Per-element proxy: ${brokenCount} element(s) downgraded (${css.elements.length - brokenCount} preserved)`);
    const counts = {};
    for (const e of css.elements) counts[e.type] = (counts[e.type] || 0) + 1;
    css.metadata.elementCounts = counts;
  }
}


// ============================================================================
// NORMALIZE GEOMETRY
// ============================================================================

export function normalizeGeometry(css) {
  const MAX_COORD = 50000;

  // Compute bbox from placements
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const elem of css.elements) {
    const o = elem.placement?.origin;
    if (!o) continue;
    const x = safe(o.x), y = safe(o.y), z = safe(o.z);
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }

  if (!isFinite(minX)) return; // no valid elements

  const shiftX = -minX, shiftY = -minY, shiftZ = -minZ;

  for (const elem of css.elements) {
    if (elem.placement?.origin) {
      elem.placement.origin.x = clamp(safe(elem.placement.origin.x) + shiftX, MAX_COORD);
      elem.placement.origin.y = clamp(safe(elem.placement.origin.y) + shiftY, MAX_COORD);
      elem.placement.origin.z = clamp(safe(elem.placement.origin.z) + shiftZ, MAX_COORD);
    }
    if (elem.placement?.axis) sanitizeDir(elem.placement.axis);
    if (elem.placement?.refDirection) sanitizeDir(elem.placement.refDirection);

    // Wall-aware direction recovery: sanitizeDir may set (0,0,1) for zero-vector
    // refDirection, which is vertical — invalid for horizontal wall run direction.
    // Recover via canonicalWallDirection's 4-level fallback chain.
    const elemType = (elem.type || '').toUpperCase();
    if (elemType === 'WALL' || elemType === 'COLUMN' || elemType === 'BEAM') {
      const ref = elem.placement?.refDirection;
      if (!ref || Math.abs(ref.z) > 0.5) {
        canonicalWallDirection(elem); // writes back a horizontal refDirection
      }
      // Orthogonality guard: axis ⊥ refDirection
      const ax = elem.placement?.axis;
      const rd = elem.placement?.refDirection;
      if (ax && rd && Math.abs(vecDot(ax, rd)) > 0.01) {
        elem.placement.axis = { x: 0, y: 0, z: 1 };
      }
    }

    if (elem.geometry) {
      if (elem.geometry.depth !== undefined) {
        elem.geometry.depth = clamp(Math.abs(safe(elem.geometry.depth)), MAX_COORD);
        if (elem.geometry.depth <= 0) elem.geometry.depth = 0.01;
      }
      if (elem.geometry.direction) sanitizeDir(elem.geometry.direction);
      if (elem.geometry.profile) {
        const p = elem.geometry.profile;
        if (p.width !== undefined) p.width = Math.abs(safe(p.width)) || 1;
        if (p.height !== undefined) p.height = Math.abs(safe(p.height)) || 1;
        if (p.radius !== undefined) p.radius = Math.abs(safe(p.radius)) || 0.5;
      }
      if (elem.geometry.vertices) {
        for (const v of elem.geometry.vertices) {
          v.x = clamp(safe(v.x) + shiftX, MAX_COORD);
          v.y = clamp(safe(v.y) + shiftY, MAX_COORD);
          v.z = clamp(safe(v.z) + shiftZ, MAX_COORD);
        }
      }
      if (elem.geometry.pathPoints) {
        for (const p of elem.geometry.pathPoints) {
          p.x = clamp(safe(p.x) + shiftX, MAX_COORD);
          p.y = clamp(safe(p.y) + shiftY, MAX_COORD);
          p.z = clamp(safe(p.z) + shiftZ, MAX_COORD);
        }
      }
      if (elem.geometry.path) {
        for (const p of elem.geometry.path) {
          p.x = clamp(safe(p.x) + shiftX, MAX_COORD);
          p.y = clamp(safe(p.y) + shiftY, MAX_COORD);
          p.z = clamp(safe(p.z) + shiftZ, MAX_COORD);
        }
      }
    }

    // Shift VentSim source coordinates so they stay consistent with placement.origin.
    // Without this, generate's VentSim re-placement (which re-derives origin from
    // startPoint/endPoint) would undo the normalization shift, displacing tunnel
    // segments from their shell pieces.
    const props = elem.properties;
    if (props) {
      if (props.startPoint) {
        props.startPoint.x = clamp(safe(props.startPoint.x) + shiftX, MAX_COORD);
        props.startPoint.y = clamp(safe(props.startPoint.y) + shiftY, MAX_COORD);
        props.startPoint.z = clamp(safe(props.startPoint.z) + shiftZ, MAX_COORD);
      }
      if (props.endPoint) {
        props.endPoint.x = clamp(safe(props.endPoint.x) + shiftX, MAX_COORD);
        props.endPoint.y = clamp(safe(props.endPoint.y) + shiftY, MAX_COORD);
        props.endPoint.z = clamp(safe(props.endPoint.z) + shiftZ, MAX_COORD);
      }
    }
  }

  if (css.facility) css.facility.origin = { x: 0, y: 0, z: 0 };

  // Shift storey/segment elevations by the same Z-offset so they stay consistent
  // with the shifted element Z-coordinates.
  if (shiftZ !== 0 && css.levelsOrSegments) {
    for (const level of css.levelsOrSegments) {
      if (level.elevation_m !== undefined) {
        level.elevation_m = level.elevation_m + shiftZ;
      }
    }
  }

  // Normalize wall depths to storey height.
  // The LLM sometimes sets geometry.depth equal to the wall's own length (profile.width)
  // rather than the storey floor-to-floor height — catch and correct that here.
  const levelHeightMap = {};
  for (const level of (css.levelsOrSegments || [])) {
    if (level.height_m > 0) levelHeightMap[level.id] = level.height_m;
  }
  if (Object.keys(levelHeightMap).length > 0) {
    for (const elem of css.elements) {
      if ((elem.type || '').toUpperCase() !== 'WALL') continue;
      const geom = elem.geometry;
      if (!geom || geom.depth === undefined) continue;
      const levelHeight = levelHeightMap[elem.container];
      if (!levelHeight) continue;
      const profileWidth = geom.profile?.width || 0;
      const depthEqualsLength = profileWidth > 0 && Math.abs(geom.depth - profileWidth) < 0.02;
      const depthTooShort = geom.depth < 0.8;
      const depthTooTall = geom.depth > levelHeight * 1.6;
      if (depthEqualsLength || depthTooShort || depthTooTall) {
        geom.depth = levelHeight;
      }
    }
  }

  // Recalculate bbox
  let nMinX = Infinity, nMinY = Infinity, nMinZ = Infinity;
  let nMaxX = -Infinity, nMaxY = -Infinity, nMaxZ = -Infinity;
  for (const elem of css.elements) {
    const o = elem.placement?.origin;
    if (!o) continue;
    nMinX = Math.min(nMinX, o.x); nMinY = Math.min(nMinY, o.y); nMinZ = Math.min(nMinZ, o.z);
    nMaxX = Math.max(nMaxX, o.x); nMaxY = Math.max(nMaxY, o.y); nMaxZ = Math.max(nMaxZ, o.z);
  }
  if (isFinite(nMinX)) {
    css.metadata.bbox = { min: { x: nMinX, y: nMinY, z: nMinZ }, max: { x: nMaxX, y: nMaxY, z: nMaxZ } };
  }
  css.metadata.unitNormalizationApplied = true;
}
