/**
 * dimension-apply.mjs — Apply facilityDimensions metadata to CSS elements.
 *
 * Reads css.metadata.facilityDimensions (populated by the extract lambda's DOCX
 * structured extraction) and writes the derived dimensions directly onto element-level
 * geometry fields so the generate lambda can consume them without any knowledge of
 * the facilityDimensions channel.
 *
 * Must run BEFORE applyEquipmentMounting — getHostInteriorFrame() reads
 * geometry.profile.height to compute floorZ/ceilZ for tunnel segments, so
 * corrected bore dimensions must be in place before equipment Z placement.
 */

// Ducts below this area threshold have trivially-small or unset cross-sectional
// area (not VSM-sourced large-bore ducts) — safe to apply DUCT_SPEC radius to them.
const MIN_MEANINGFUL_AREA_M2 = 0.01;

// Radii below this value are unset placeholders, not real duct geometry.
const MIN_MEANINGFUL_RADIUS_M = 0.01;

/**
 * Normalize facilityDimensions array into a keyed lookup object.
 *
 * Handles two entry formats:
 *   - dist_patch:    { subKind, field: 'height_m', value: 4 }   (field:value pairs)
 *   - claims_route:  { subKind, height_m: 4, width_m: 4 }       (direct properties)
 *
 * @param {Array} facilityDimensions - css.metadata.facilityDimensions
 * @returns {{ tunnelProfile: {height_m?, width_m?}|null, ductSpec: {diameter_m?, shape?}|null, shaft: {...}|null }}
 */
export function buildDimensionLookup(facilityDimensions) {
  const lookup = { tunnelProfile: null, ductSpec: null, shaft: null };

  for (const entry of (facilityDimensions || [])) {
    const sub = (entry.subKind || '').toUpperCase();

    if (sub === 'TUNNEL_PROFILE') {
      if (!lookup.tunnelProfile) lookup.tunnelProfile = {};
      // dist_patch format: {field:'height_m', value:4}
      if (entry.field === 'height_m'        && entry.value != null) lookup.tunnelProfile.height_m        = entry.value;
      if (entry.field === 'width_m'         && entry.value != null) lookup.tunnelProfile.width_m         = entry.value;
      if (entry.field === 'wallThickness_m' && entry.value != null) lookup.tunnelProfile.wallThickness_m = entry.value;
      // claims_route format: {height_m:4, width_m:4}
      if (entry.height_m        != null) lookup.tunnelProfile.height_m        = entry.height_m;
      if (entry.width_m         != null) lookup.tunnelProfile.width_m         = entry.width_m;
      if (entry.wallThickness_m != null) lookup.tunnelProfile.wallThickness_m = entry.wallThickness_m;
      if (entry.shape)                    lookup.tunnelProfile.shape           = entry.shape;
      if (entry.field === 'shape' && entry.value) lookup.tunnelProfile.shape  = entry.value;

    } else if (sub === 'DUCT_SPEC') {
      if (!lookup.ductSpec) lookup.ductSpec = {};
      if (entry.diameter_m != null) lookup.ductSpec.diameter_m = entry.diameter_m;
      if (entry.shape)               lookup.ductSpec.shape      = entry.shape;

    } else if (sub === 'SHAFT') {
      lookup.shaft = {
        vertical_length_m:    entry.vertical_length_m   ?? null,
        collar_elevation_msl: entry.collar_elevation_msl ?? null,
      };
    }
  }

  return lookup;
}

/**
 * Apply DOCX-derived tunnel profile dimensions to STRUCTURAL TUNNEL_SEGMENT elements.
 *
 * The DOCX is the as-designed authority; VentSim-derived profile dimensions are
 * simulation-effective values that may differ. Only STRUCTURAL branchClass segments
 * are touched — service branches (EXHAUST, SUPPLY, AIRWAY, etc.) are also
 * TUNNEL_SEGMENT type and must retain their own cross-section data.
 *
 * Tags each updated element with properties.heightSource = 'TEXT_DESCRIPTION'
 * for per-element provenance debugging in CloudWatch and css_processed inspection.
 *
 * @param {object} css    - CSS object (mutated in place)
 * @param {object} lookup - Output of buildDimensionLookup
 */
export function applyTextDerivedHeights(css, lookup) {
  if (!lookup.tunnelProfile) return;
  const { height_m, width_m } = lookup.tunnelProfile;
  // Derive profile shape from text description
  const shape = (lookup.tunnelProfile.shape || '').toUpperCase();
  const isArch = ['HORSESHOE', 'ARCH', 'SEMICIRCULAR', 'ARCHED'].includes(shape);

  if (height_m == null && width_m == null && !isArch) return;

  let applied = 0;
  for (const elem of css.elements) {
    if (elem.type !== 'TUNNEL_SEGMENT') continue;
    if (elem.properties?.branchClass !== 'STRUCTURAL') continue;
    const profile = elem.geometry?.profile;
    if (!profile) continue;

    if (height_m != null) profile.height = height_m;
    if (width_m  != null) profile.width  = width_m;
    // Set profile type to ARCH for horseshoe/arched tunnels.
    // The generate lambda's _generate_arch_profile_points() creates a
    // semicircular crown + vertical side walls from width/height.
    // curveRatio controls the arch height: 0.5 = semicircular crown over
    // the full top half, 0.3 = moderate arch.  Must override the VentSim-
    // derived curveRatio=0.01 (set by decomposeTunnelShell when VentSim
    // reports shape='rectangular').
    if (isArch) {
      profile.type = 'ARCH';
      profile.curveRatio = 0.5;  // full semicircular horseshoe crown
    }
    if (!elem.properties) elem.properties = {};
    elem.properties.heightSource = 'TEXT_DESCRIPTION';
    applied++;
  }

  console.log(`applyTextDerivedHeights: applied to ${applied} TUNNEL_SEGMENT[STRUCTURAL] elements (h=${height_m}m, w=${width_m}m, shape=${isArch ? 'ARCH' : 'RECTANGLE'})`);

  // Apply wallThickness_m to DXF-sourced WALL elements.
  // DXF walls arrive with profile.width = segment run length (large), so the generate lambda's
  // DXF-convention detector sets thickness from the existing profile.width only when < 0.5m.
  // Writing the DOCX-derived value here ensures the correct structural lining thickness is used.
  const { wallThickness_m } = lookup.tunnelProfile;
  if (wallThickness_m != null) {
    let wallApplied = 0;
    for (const elem of css.elements) {
      if (elem.type !== 'WALL' || elem.source !== 'DXF') continue;
      if (!elem.geometry) elem.geometry = {};
      if (!elem.geometry.profile) elem.geometry.profile = {};
      elem.geometry.profile.width = wallThickness_m;
      if (!elem.properties) elem.properties = {};
      elem.properties.wallThicknessSource = 'TEXT_DESCRIPTION';
      wallApplied++;
    }
    if (wallApplied > 0)
      console.log(`applyTextDerivedHeights: applied wallThickness_m=${wallThickness_m}m to ${wallApplied} DXF WALL elements`);
  }
}

/**
 * Normalize DXF wall geometry for tunnel renders.
 *
 * The DXF parser produces walls where:
 *   - geometry.depth      = polyline run length (should be wall HEIGHT)
 *   - geometry.direction   = segment bearing (correct, but not copied to refDirection)
 *   - profile.width       = wall thickness (set by applyTextDerivedHeights)
 *   - profile.height      = 0.10m stub
 *   - placement.origin.z  = 0 (tunnel centerline, not floor)
 *
 * The generate lambda detects DXF convention and reinterprets these fields.
 * But canonicalWallDirection (shared.mjs) infers refDirection from profile dims
 * when refDirection is unset, producing (1,0,0) for ALL walls.
 *
 * This function:
 *   1. Derives refDirection from geometry.direction (preserving actual DXF bearing)
 *   2. Moves wall origin Z to tunnel floor level
 *
 * Runs AFTER applyTextDerivedHeights (which sets profile.width = wallThickness).
 *
 * @param {object} css    - CSS object (mutated in place)
 * @param {object} lookup - Output of buildDimensionLookup
 */
export function normalizeDxfWallGeometry(css, lookup) {
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;
  if (!css.elements || css.elements.length === 0) return;

  // When VentSim provides authoritative 3D structure, DXF walls that overlap the
  // tunnel bore corridor are redundant and should be suppressed. However, DXF walls
  // that are spatially far from all tunnel segments are portal building walls and
  // must be preserved.
  const hasTunnelSegs = css.elements.some(e => e.type === 'TUNNEL_SEGMENT');
  if (hasTunnelSegs) {
    const boreRadius = (lookup.tunnelProfile?.height_m || 4.0) / 2;
    // Any wall centroid within 4× bore radius of a tunnel segment centroid is a bore wall.
    // Portal building walls are 100m+ from the bore centerline, so this threshold is safe.
    const BORE_PROXIMITY = boreRadius * 4;
    const tunnelSegOrigins = css.elements
      .filter(e => e.type === 'TUNNEL_SEGMENT' && e.placement?.origin)
      .map(e => e.placement.origin);

    const dxfWalls = css.elements.filter(e => e.type === 'WALL' && e.source === 'DXF');
    if (dxfWalls.length > 0) {
      const boreWalls = new Set();
      let portalKept = 0;
      for (const wall of dxfWalls) {
        const wo = wall.placement?.origin;
        if (!wo || tunnelSegOrigins.length === 0) { boreWalls.add(wall); continue; }
        const nearBore = tunnelSegOrigins.some(so => {
          const dx = wo.x - so.x, dy = wo.y - so.y;
          return Math.sqrt(dx * dx + dy * dy) < BORE_PROXIMITY;
        });
        if (nearBore) {
          boreWalls.add(wall);
        } else {
          // Portal building wall — mark for storey assignment and preserve.
          if (!wall.properties) wall.properties = {};
          wall.properties.segmentType = 'PORTAL_BUILDING';
          portalKept++;
        }
      }
      css.elements = css.elements.filter(e => !boreWalls.has(e));
      console.log(`normalizeDxfWallGeometry: SUPPRESSED ${boreWalls.size} bore DXF walls, kept ${portalKept} portal building walls (bore proximity threshold=${BORE_PROXIMITY.toFixed(1)}m)`);
    }
    return;
  }

  const boreHeight = lookup.tunnelProfile?.height_m || 4.0;
  const boreWidth  = lookup.tunnelProfile?.width_m  || 4.0;
  const halfH = boreHeight / 2;

  // Max wall run length: tunnel bore perimeter is a reasonable ceiling.
  // Anything longer is an outer-lining polyline that wraps the entire corridor.
  const MAX_WALL_LENGTH = Math.max(boreWidth, boreHeight) * 5; // 20m for 4m bore

  let dirFixed = 0, zFixed = 0, lengthClamped = 0;

  // ── Pass 1: Fix refDirection, Z-origin, and clamp absurd lengths ──

  const dxfWalls = [];
  for (const elem of css.elements) {
    if (elem.type !== 'WALL' || elem.source !== 'DXF') continue;
    dxfWalls.push(elem);

    // 1a. Derive refDirection from geometry.direction
    const gDir = elem.geometry?.direction;
    let dx = 0, dy = 0;
    if (gDir && Array.isArray(gDir)) { dx = gDir[0] || 0; dy = gDir[1] || 0; }
    else if (gDir && typeof gDir === 'object') { dx = gDir.x || 0; dy = gDir.y || 0; }
    const dlen = Math.sqrt(dx * dx + dy * dy);
    if (dlen > 1e-6) {
      if (!elem.placement) elem.placement = {};
      elem.placement.refDirection = { x: dx / dlen, y: dy / dlen, z: 0 };
      dirFixed++;
    }

    // 1b. Move wall origin to tunnel floor level
    if (elem.placement?.origin) {
      const oz = elem.placement.origin.z || 0;
      if (Math.abs(oz) < 0.5) {
        elem.placement.origin.z = -halfH;
        zFixed++;
      }
    }

    // 1c. Clamp absurd wall run lengths (geometry.depth = polyline length in DXF convention)
    const wallLen = elem.geometry?.depth || 0;
    if (wallLen > MAX_WALL_LENGTH) {
      console.log(`normalizeDxfWallGeometry: clamping ${elem.element_key || elem.id} depth ${wallLen.toFixed(1)}m → ${MAX_WALL_LENGTH}m`);
      elem.geometry.depth = MAX_WALL_LENGTH;
      lengthClamped++;
    }
  }

  // ── Pass 2: Deduplicate paired DXF walls ──
  // DXF tunnel drawings have inner + outer lining polylines, producing two nearly
  // identical walls offset by wall thickness (~0.5m). Remove the duplicate.
  const DEDUP_DIST = 1.5;   // max origin distance for dedup candidate
  const DEDUP_DOT  = 0.95;  // direction alignment threshold

  const toRemove = new Set();
  for (let i = 0; i < dxfWalls.length; i++) {
    if (toRemove.has(dxfWalls[i])) continue;
    const a = dxfWalls[i];
    const aO = a.placement?.origin;
    const aD = a.placement?.refDirection;
    const aLen = a.geometry?.depth || 0;
    if (!aO || !aD) continue;

    for (let j = i + 1; j < dxfWalls.length; j++) {
      if (toRemove.has(dxfWalls[j])) continue;
      const b = dxfWalls[j];
      const bO = b.placement?.origin;
      const bD = b.placement?.refDirection;
      const bLen = b.geometry?.depth || 0;
      if (!bO || !bD) continue;

      // Origin distance (XY only)
      const dist = Math.sqrt((aO.x - bO.x) ** 2 + (aO.y - bO.y) ** 2);
      if (dist > DEDUP_DIST) continue;

      // Direction alignment (same or opposite)
      const dot = Math.abs(aD.x * bD.x + aD.y * bD.y);
      if (dot < DEDUP_DOT) continue;

      // Length similarity (within 15%)
      const minL = Math.min(aLen, bLen), maxL = Math.max(aLen, bLen);
      if (minL > 0 && maxL / minL > 1.15) continue;

      // Confirmed duplicate — keep the one with lower element_key
      const aKey = a.element_key || a.id || '';
      const bKey = b.element_key || b.id || '';
      const remove = aKey <= bKey ? b : a;
      toRemove.add(remove);
      console.log(`normalizeDxfWallGeometry: DEDUP removed ${remove.element_key || remove.id} (len=${(remove.geometry?.depth||0).toFixed(1)}m) — kept ${remove === b ? aKey : bKey}`);
    }
  }

  if (toRemove.size > 0) {
    css.elements = css.elements.filter(e => !toRemove.has(e));
  }

  const parts = [];
  if (dirFixed > 0) parts.push(`${dirFixed} refDir`);
  if (zFixed > 0) parts.push(`${zFixed} Z-origin(${-halfH}m)`);
  if (lengthClamped > 0) parts.push(`${lengthClamped} length-clamped(max=${MAX_WALL_LENGTH}m)`);
  if (toRemove.size > 0) parts.push(`${toRemove.size} deduped`);
  if (parts.length > 0) {
    console.log(`normalizeDxfWallGeometry: ${parts.join(', ')}`);
  }
}

/**
 * Write tunnel profile height into levelsOrSegments so the generate lambda's
 * storey_height_map gets a real height for DXF wall extrusion.
 *
 * The generate lambda populates storey_height_map from level.height_m only in the
 * BUILDING branch; tunnel levels were always created without a height.  This function
 * backfills height_m onto every tunnel levelsOrSegments entry that lacks one, using
 * the authoritative DOCX-derived tunnel bore height.
 *
 * @param {object} css    - CSS object (mutated in place)
 * @param {object} lookup - Output of buildDimensionLookup
 */
export function applyStoreyHeightFromProfile(css, lookup) {
  const height = lookup.tunnelProfile?.height_m;
  if (height == null) return;

  let applied = 0;
  for (const level of (css.levelsOrSegments || [])) {
    if (level.height_m != null) continue; // already authored — DOCX is authority but never overwrite explicit data
    level.height_m = height;
    applied++;
  }

  if (applied > 0)
    console.log(`applyStoreyHeightFromProfile: set height_m=${height}m on ${applied} levelsOrSegments entries`);
}

/**
 * Synthesize a Portal_Roof storey in levelsOrSegments for portal-building walls.
 *
 * Portal buildings (WALL elements with properties.segmentType=PORTAL_BUILDING) sit atop
 * the tunnel portals.  The generate lambda places them relative to a storey elevation,
 * so this function creates a 'seg-portal-roof' entry at maxUpperZ — the highest Z seen
 * in the upper-tunnel sub-segment — so the portal face structure is correctly elevated.
 *
 * maxUpperZ is derived by scanning elements assigned to the upper-tunnel container
 * (created by splitTunnelSubSegments), avoiding dependence on local variables from
 * that step.  Falls back to 15m if no upper elements are found.
 *
 * @param {object} css - CSS object (mutated in place)
 */
export function synthesizePortalStoreys(css) {
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const hasPortalBuildings = (css.elements || []).some(
    e => e.type === 'WALL' && e.properties?.segmentType === 'PORTAL_BUILDING'
  );
  if (!hasPortalBuildings) return;

  const PORTAL_ROOF_ID = 'seg-portal-roof';
  if ((css.levelsOrSegments || []).some(s => s.id === PORTAL_ROOF_ID)) return;

  // Compute maxUpperZ: max origin Z of elements in the upper-tunnel container.
  const upperSeg = (css.levelsOrSegments || []).find(s => s.id && s.id.endsWith('-upper'));
  const upperSegId = upperSeg?.id;

  let maxUpperZ = 0;
  for (const elem of (css.elements || [])) {
    const z = elem.placement?.origin?.z ?? 0;
    if (upperSegId ? elem.container === upperSegId : z > 0.5) {
      if (z > maxUpperZ) maxUpperZ = z;
    }
  }
  if (maxUpperZ <= 0) maxUpperZ = 15.0; // fallback when no upper elements exist

  css.levelsOrSegments = css.levelsOrSegments || [];
  css.levelsOrSegments.push({
    id:          PORTAL_ROOF_ID,
    type:        'SEGMENT',
    name:        'Portal Roof',
    elevation_m: maxUpperZ,
    height_m:    3.0,
  });

  console.log(`synthesizePortalStoreys: added '${PORTAL_ROOF_ID}' at elevation_m=${maxUpperZ.toFixed(2)}m`);
}

/**
 * Apply DUCT_SPEC to DUCT/PIPE elements.
 *
 * When the DOCX explicitly specifies a duct shape (e.g. "round, 1m diameter"),
 * the DOCX is the as-designed authority and overrides VentSim simulation-effective
 * cross-sections for ALL ducts — including those with area_m2 set.
 *
 * When no explicit shape is given, only ducts without area_m2 (non-VentSim) are
 * updated, preserving the VentSim-derived ASHRAE aspect-ratio profiles.
 *
 * @param {object} css    - CSS object (mutated in place)
 * @param {object} lookup - Output of buildDimensionLookup
 */
export function applyDuctZDefaults(css, lookup) {
  if (!lookup.ductSpec?.diameter_m) return;
  const radius = lookup.ductSpec.diameter_m / 2;
  const DUCT_TYPES = new Set(['DUCT', 'PIPE']);
  const shapeOverride = (lookup.ductSpec.shape || '').toUpperCase();
  const isExplicitCircular = ['ROUND', 'CIRCULAR', 'CIRCLE'].includes(shapeOverride);
  let applied = 0;

  for (const elem of css.elements) {
    if (!DUCT_TYPES.has(elem.type)) continue;

    // When DOCX explicitly sets shape=round, override ALL ducts (including VentSim).
    // Otherwise, only apply to ducts without VentSim area data.
    if (!isExplicitCircular) {
      if ((elem.properties?.area_m2 ?? 0) > MIN_MEANINGFUL_AREA_M2) continue;
      const geom = elem.geometry;
      if (!geom) continue;
      if (!geom.profile) geom.profile = {};
      if ((geom.profile.radius ?? 0) > MIN_MEANINGFUL_RADIUS_M) continue;
      geom.profile.type   = 'CIRCLE';
      geom.profile.radius = radius;
      applied++;
    } else {
      const geom = elem.geometry;
      if (!geom) continue;
      if (!geom.profile) geom.profile = {};
      geom.profile.type   = 'CIRCLE';
      geom.profile.radius = radius;
      // Clear rectangular profile fields so generate doesn't misinterpret
      delete geom.profile.width;
      delete geom.profile.height;
      if (!elem.properties) elem.properties = {};
      elem.properties.ductProfileSource = 'TEXT_DESCRIPTION';
      applied++;
    }
  }

  if (applied > 0)
    console.log(`applyDuctZDefaults: set CIRCLE radius=${radius}m on ${applied} DUCT/PIPE elements from DUCT_SPEC (shape=${shapeOverride || 'default'})`);
}

/**
 * Synthesize a vertical shaft element from SHAFT facilityDimension data.
 *
 * Creates a tall vertical cylinder (IfcBuildingElementProxy) at the location
 * matching the shaft fan's VentSim branch. The shaft is typically at the
 * center-north of the tunnel network, connecting the surface to the underground.
 *
 * @param {object} css    - CSS object (mutated in place)
 * @param {object} lookup - Output of buildDimensionLookup
 */
export function synthesizeVerticalShaft(css, lookup) {
  if (!lookup.shaft?.vertical_length_m) return;
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const { vertical_length_m, collar_elevation_msl } = lookup.shaft;

  // Find the shaft fan's host branch to get XY position
  // The shaft fan is typically on a near-vertical branch
  let shaftX = null, shaftY = null, shaftZ = 0;
  let shaftRadius = 2.0; // default radius

  for (const elem of (css.elements || [])) {
    if (elem.type !== 'EQUIPMENT') continue;
    const name = (elem.name || '').toLowerCase();
    if (!name.includes('shaft')) continue;

    const o = elem.placement?.origin;
    if (o) {
      shaftX = o.x;
      shaftY = o.y;
      shaftZ = o.z ?? 0;
      // Use fan diameter as shaft radius hint
      const fanDiam = elem.properties?.diameter_m;
      if (fanDiam && fanDiam > 0.5) shaftRadius = Math.max(fanDiam, 2.0);
      console.log(`synthesizeVerticalShaft: positioned at shaft fan "${elem.name}" (${shaftX.toFixed(1)}, ${shaftY.toFixed(1)})`);
      break;
    }
  }

  // If no shaft fan found, try to find a near-vertical tunnel segment
  if (shaftX === null) {
    for (const elem of (css.elements || [])) {
      if (elem.type !== 'TUNNEL_SEGMENT') continue;
      const sp = elem.properties?.startPoint;
      const ep = elem.properties?.endPoint;
      if (!sp || !ep) continue;
      const dx = ep.x - sp.x, dy = ep.y - sp.y, dz = (ep.z ?? 0) - (sp.z ?? 0);
      const hLen = Math.sqrt(dx * dx + dy * dy);
      const vLen = Math.abs(dz);
      // Near-vertical: vertical span >> horizontal span
      if (vLen > 2.0 && hLen < vLen * 0.3) {
        const o = elem.placement?.origin;
        if (o) { shaftX = o.x; shaftY = o.y; shaftZ = o.z ?? 0; }
        break;
      }
    }
  }

  // If still no position found, place at the centroid of the network + offset north
  if (shaftX === null) {
    const segs = (css.elements || []).filter(e =>
      e.type === 'TUNNEL_SEGMENT' && e.properties?.branchClass === 'STRUCTURAL'
    );
    if (segs.length === 0) return;
    let sumX = 0, sumY = 0, maxY = -Infinity;
    for (const s of segs) {
      const o = s.placement?.origin;
      if (!o) continue;
      sumX += o.x; sumY += o.y;
      if (o.y > maxY) maxY = o.y;
    }
    shaftX = sumX / segs.length;
    shaftY = maxY + 5; // offset north of the northernmost segment
    console.log(`synthesizeVerticalShaft: no shaft fan found — placed at centroid-north (${shaftX.toFixed(1)}, ${shaftY.toFixed(1)})`);
  }

  // Create the shaft element
  const shaftId = 'vertical-shaft-1';
  const shaftElem = {
    id: shaftId,
    element_key: shaftId,
    type: 'TUNNEL_SEGMENT',
    semanticType: 'IfcBuildingElementProxy',
    name: 'Vertical Shaft',
    placement: {
      origin: { x: shaftX, y: shaftY, z: shaftZ },
      axis: { x: 0, y: 0, z: 1 },
      refDirection: { x: 1, y: 0, z: 0 },
    },
    geometry: {
      method: 'EXTRUSION',
      profile: { type: 'CIRCLE', radius: shaftRadius },
      direction: { x: 0, y: 0, z: 1 },
      depth: vertical_length_m,
    },
    container: (css.levelsOrSegments || [])[0]?.id || 'seg-tunnel-main',
    relationships: [],
    properties: {
      branchClass: 'STRUCTURAL',
      segmentType: 'VERTICAL_SHAFT',
      isPortalHelper: true, // prevents door rehosting to shaft
      vertical_length_m,
      collar_elevation_msl: collar_elevation_msl ?? null,
    },
    material: { name: 'concrete', color: [0.75, 0.75, 0.75], transparency: 0 },
    confidence: 0.75,
    source: 'TEXT_DESCRIPTION',
    metadata: {
      geometryExportable: true,
      generatedBy: 'VERTICAL_SHAFT',
    },
  };

  css.elements.push(shaftElem);
  console.log(`synthesizeVerticalShaft: created shaft at (${shaftX.toFixed(1)}, ${shaftY.toFixed(1)}) — ` +
    `height=${vertical_length_m}m, radius=${shaftRadius.toFixed(1)}m` +
    (collar_elevation_msl != null ? `, collar=${collar_elevation_msl}m MSL` : ''));
}

/**
 * Apply portal elevation differences to tunnel segment Z coordinates.
 *
 * Reads css.metadata.portals (populated by DOCX extraction), matches each portal
 * to the nearest tunnel terminal endpoint, then linearly interpolates Z along
 * the tunnel path so segments between portals have a grade.
 *
 * This adds the elevation grade that VentSim simulation data doesn't encode —
 * the as-built portal elevations come from the text description (DOCX).
 *
 * @param {object} css - CSS object (mutated in place)
 */
export function applyPortalElevations(css) {
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;
  const portals = css.metadata?.portals;
  if (!Array.isArray(portals) || portals.length < 2) {
    console.log(`applyPortalElevations: skipped — need ≥2 portals, got ${portals?.length ?? 0}`);
    return;
  }

  // Compute duct ceiling offset from facilityDimensions.
  // mounting_height_m = height from tunnel floor (e.g. 2.8m from spec).
  // boreHeight_m = tunnel bore clear height (e.g. 4.0m from TUNNEL_PROFILE).
  // offset from centerline = mounting_height_m - boreHeight_m / 2
  let _ductCeilingOffset = null;
  {
    let _mountH = null, _boreH = null;
    for (const fd of (css.metadata?.facilityDimensions || [])) {
      if (fd.subKind === 'DUCT_SPEC' && fd.mounting_height_m != null) _mountH = fd.mounting_height_m;
      if (fd.subKind === 'TUNNEL_PROFILE') {
        const h = fd.height_m ?? (fd.field === 'height_m' ? fd.value : null);
        if (h != null) _boreH = h;
      }
    }
    if (_mountH != null && _boreH != null) {
      _ductCeilingOffset = _mountH - _boreH / 2;
      console.log(`applyPortalElevations: duct ceiling offset = +${_ductCeilingOffset.toFixed(2)}m above centerline (mounting=${_mountH}m from floor, bore=${_boreH}m)`);
    } else {
      console.log(`applyPortalElevations: no duct ceiling offset — mounting_height_m=${_mountH}, boreHeight=${_boreH} (need both in facilityDimensions)`);
    }
  }

  // Filter portals with valid elevation_msl
  const validPortals = portals.filter(p => p.elevation_msl != null);
  if (validPortals.length < 2) {
    console.log(`applyPortalElevations: skipped — only ${validPortals.length} portals have elevation_msl`);
    return;
  }

  // Compute elevation difference (relative to lowest portal as Z=0)
  const minElev = Math.min(...validPortals.map(p => p.elevation_msl));
  const portalOffsets = validPortals.map(p => ({
    name: p.name || 'unknown',
    elevation_msl: p.elevation_msl,
    relativeZ: p.elevation_msl - minElev,
    orientation: p.orientation || null,
  }));

  console.log(`applyPortalElevations: ${portalOffsets.length} portals — ` +
    portalOffsets.map(p => `${p.name}=${p.elevation_msl}m MSL (Δ${p.relativeZ.toFixed(1)}m)`).join(', '));

  // Collect structural tunnel segments (exclude vertical shaft and bridge segments)
  const segs = (css.elements || []).filter(e =>
    e.type === 'TUNNEL_SEGMENT' &&
    e.properties?.branchClass === 'STRUCTURAL' &&
    e.geometry?.profile &&
    e.properties?.segmentType !== 'VERTICAL_SHAFT' &&
    !e.properties?._isBridgeSegment
  );
  if (segs.length === 0) return;

  // Compute start/end points from origin + bearing * depth/2 (same as generatePortalEndWalls)
  const SNAP_DIST = 2.0; // endpoint coincidence threshold
  const endpoints = [];
  for (const seg of segs) {
    const o = seg.placement?.origin;
    if (!o) continue;
    const depth = parseFloat(seg.geometry?.depth || 0);
    if (depth <= 0) continue;
    // Bearing from refDirection (horizontal plane)
    const rd = seg.placement?.refDirection || seg.geometry?.direction || { x: 1, y: 0, z: 0 };
    const rx = rd.x ?? 1, ry = rd.y ?? 0;
    const rLen = Math.sqrt(rx * rx + ry * ry);
    if (rLen < 1e-6) continue;
    const nx = rx / rLen, ny = ry / rLen;
    const halfD = depth / 2;
    endpoints.push({ x: o.x - nx * halfD, y: o.y - ny * halfD, z: 0, seg, end: 'start' });
    endpoints.push({ x: o.x + nx * halfD, y: o.y + ny * halfD, z: 0, seg, end: 'end' });
  }

  // Identify terminals: endpoints not shared with any other segment
  const terminals = [];
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    let shared = false;
    for (let j = 0; j < endpoints.length; j++) {
      if (i === j || endpoints[j].seg === ep.seg) continue;
      const dx = ep.x - endpoints[j].x, dy = ep.y - endpoints[j].y;
      if (Math.sqrt(dx * dx + dy * dy) < SNAP_DIST) { shared = true; break; }
    }
    if (!shared) terminals.push(ep);
  }

  console.log(`applyPortalElevations: found ${endpoints.length} endpoints from ${segs.length} segs, ${terminals.length} terminals`);

  if (terminals.length < 2) {
    console.log(`applyPortalElevations: only ${terminals.length} terminal endpoints found, need ≥2`);
    return;
  }

  // Match portal definitions to terminal endpoints by proximity or orientation
  // Sort terminals by X coordinate to establish west→east ordering
  terminals.sort((a, b) => a.x - b.x);
  // Sort portal offsets by elevation (lower first → assume west-to-east grade)
  portalOffsets.sort((a, b) => a.relativeZ - b.relativeZ);

  // Match: assign the two most separated terminals to the two portals
  // Use the two terminals with the greatest XY distance (tunnel entry/exit)
  let bestPair = [0, 1], bestDist = 0;
  for (let i = 0; i < terminals.length; i++) {
    for (let j = i + 1; j < terminals.length; j++) {
      const dx = terminals[i].x - terminals[j].x;
      const dy = terminals[i].y - terminals[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > bestDist) { bestDist = d; bestPair = [i, j]; }
    }
  }

  const termA = terminals[bestPair[0]]; // entry terminal (lower X or matched orientation)
  const termB = terminals[bestPair[1]]; // exit terminal (higher X or matched orientation)

  // Assign portal elevations: lower elevation to lower-X terminal, higher to higher-X
  const zA = portalOffsets[0].relativeZ;
  const zB = portalOffsets[portalOffsets.length - 1].relativeZ;

  console.log(`applyPortalElevations: terminal A=(${termA.x.toFixed(1)},${termA.y.toFixed(1)}) → Z=${zA.toFixed(1)}m, ` +
    `terminal B=(${termB.x.toFixed(1)},${termB.y.toFixed(1)}) → Z=${zB.toFixed(1)}m, span=${bestDist.toFixed(1)}m`);

  if (bestDist < 1) {
    console.log('applyPortalElevations: terminals too close, skipping');
    return;
  }

  // Interpolate Z for all structural segments based on projection along terminal axis
  const axisX = termB.x - termA.x;
  const axisY = termB.y - termA.y;
  const axisLen = Math.sqrt(axisX * axisX + axisY * axisY);
  const normX = axisX / axisLen;
  const normY = axisY / axisLen;

  // REPLACE (not add) existing Z with the DOCX-derived portal grade.
  // VentSim Z values are discarded — the as-built DOCX portal elevations are authoritative.
  // This prevents double-counting when normalizeGeometry has already shifted Z by -minZ.
  let applied = 0;
  let zMin = Infinity, zMax = -Infinity;
  for (const seg of segs) {
    const o = seg.placement?.origin;
    if (!o) continue;
    // Project segment origin onto terminal axis
    const dx = o.x - termA.x;
    const dy = o.y - termA.y;
    const t = Math.max(0, Math.min(1, (dx * normX + dy * normY) / axisLen));
    const interpZ = zA + t * (zB - zA);

    // SET (not add) — DOCX grade replaces any prior Z
    o.z = interpZ;
    if (interpZ < zMin) zMin = interpZ;
    if (interpZ > zMax) zMax = interpZ;

    // Replace startPoint/endPoint Z with individually-interpolated grade values
    const sp = seg.properties?.startPoint;
    const ep = seg.properties?.endPoint;
    if (sp) {
      const tSp = Math.max(0, Math.min(1, ((sp.x - termA.x) * normX + (sp.y - termA.y) * normY) / axisLen));
      sp.z = zA + tSp * (zB - zA);
    }
    if (ep) {
      const tEp = Math.max(0, Math.min(1, ((ep.x - termA.x) * normX + (ep.y - termA.y) * normY) / axisLen));
      ep.z = zA + tEp * (zB - zA);
    }
    if (Array.isArray(seg.geometry?.path)) {
      for (const pt of seg.geometry.path) {
        const tPt = Math.max(0, Math.min(1, ((pt.x - termA.x) * normX + (pt.y - termA.y) * normY) / axisLen));
        pt.z = zA + tPt * (zB - zA);
      }
    }

    applied++;
  }

  // Sanity check: confirm written Z values are in local range (not MSL)
  console.log(`applyPortalElevations: Z range written = [${zMin.toFixed(2)}, ${zMax.toFixed(2)}]m — should be in [${zA.toFixed(1)}, ${zB.toFixed(1)}]m local range`);
  if (zMax > 100) {
    console.warn(`applyPortalElevations: WARN written Z ${zMax.toFixed(1)}m > 100m — may still be MSL coordinates`);
  }

  // Also SET DUCT, DOOR, and WALL element Z from grade interpolation.
  // For DUCT/PIPE elements: add ceiling mounting offset above the grade baseline
  // (mounting_height_m above tunnel floor − bore_half_height = offset above centerline).
  let _ductOffsetApplied = 0;
  for (const elem of (css.elements || [])) {
    if (elem.type === 'TUNNEL_SEGMENT' && elem.properties?.branchClass === 'STRUCTURAL') continue; // already done
    // SPACE elements own their floor elevation from extraction — do not overwrite with grade interpolation
    if ((elem.type || '').toUpperCase() === 'SPACE') continue;
    const o = elem.placement?.origin;
    if (!o) continue;
    const dx = o.x - termA.x;
    const dy = o.y - termA.y;
    const t = Math.max(0, Math.min(1, (dx * normX + dy * normY) / axisLen));
    const interpZ = zA + t * (zB - zA);
    if ((elem.type === 'DUCT' || elem.type === 'PIPE') && _ductCeilingOffset != null) {
      o.z = interpZ + _ductCeilingOffset;
      _ductOffsetApplied++;
    } else {
      o.z = interpZ;
    }
  }
  if (_ductOffsetApplied > 0) {
    console.log(`applyPortalElevations: applied duct ceiling offset to ${_ductOffsetApplied} DUCT/PIPE elements`);
  }

  // Phase 6C Fix 3 — annotate the PORTAL_END_WALL emitted by generatePortalEndWalls
  // at each terminal with the matched portal's name + expected_floor_z. The
  // connectivity diagnostic reads metadata.portalName / metadata.expectedFloorZ
  // directly so name-prefix normalisation isn't needed downstream.
  const portalA = portalOffsets[0];
  const portalB = portalOffsets[portalOffsets.length - 1];
  let _portalsAnnotated = 0;
  for (const term of [{ ep: termA, p: portalA }, { ep: termB, p: portalB }]) {
    const segKey = term.ep.seg.element_key || term.ep.seg.id;
    const wantedEnd = term.ep.end;
    const wallId = `portal-end-wall-${segKey}-${wantedEnd}`;
    const wall = (css.elements || []).find(e =>
      (e.element_key || e.id) === wallId &&
      (e.type || '').toUpperCase() === 'WALL'
    );
    if (!wall) continue;
    if (!wall.metadata) wall.metadata = {};
    wall.metadata.portalName     = term.p.name;
    wall.metadata.expectedFloorZ = term.p.relativeZ;
    wall.metadata.elevation_msl  = term.p.elevation_msl;
    if (wall.properties) wall.properties.portalName = term.p.name;
    _portalsAnnotated++;
    console.log(`[6C] portal_matched id=${wallId} name="${term.p.name}" elevation=${term.p.relativeZ.toFixed(2)}m (msl=${term.p.elevation_msl}m)`);
  }
  if (_portalsAnnotated > 0) {
    console.log(`applyPortalElevations: annotated ${_portalsAnnotated} portal end walls with portalName + expectedFloorZ`);
  }

  console.log(`applyPortalElevations: SET Z grade on ${applied} structural segments + non-structural elements, grade=${((zB - zA) / axisLen * 100).toFixed(2)}%`);
}

/**
 * Synthesize STOREY-type levelsOrSegments entries from portal elevation metadata.
 *
 * For tunnel renders with portal buildings (e.g. two portals at different MSL
 * elevations), the generate lambda needs separate IfcBuildingStorey entities so
 * portal walls are placed at the correct absolute elevation.  This function:
 *   1. Reads css.metadata.portals for unique elevation_msl values
 *   2. Creates a STOREY entry per unique elevation (relative to lowest portal = 0)
 *   3. Reassigns PORTAL_END_WALL elements to the nearest portal storey
 *
 * Must run AFTER applyPortalElevations (which sets Z values on portal walls)
 * and AFTER generatePortalEndWalls (which creates PORTAL_END_WALL elements).
 *
 * @param {object} css - CSS object (mutated in place)
 */
export function synthesizeBuildingStoreys(css) {
  if ((css.domain || '').toUpperCase() !== 'TUNNEL') return;

  const portals = css.metadata?.portals;
  if (!Array.isArray(portals) || portals.length < 2) return;

  const validPortals = portals.filter(p => p.elevation_msl != null);
  if (validPortals.length < 2) return;

  const minElev = Math.min(...validPortals.map(p => p.elevation_msl));

  // Build a STOREY entry per unique portal elevation (deduplicated to 1m)
  const seen = new Set();
  const newStoreys = [];
  for (const p of validPortals) {
    const relZ = Math.round((p.elevation_msl - minElev) * 10) / 10;
    const key = relZ.toFixed(1);
    if (seen.has(key)) continue;
    seen.add(key);
    const storeyId = `portal-storey-${key.replace('.', '_')}`;
    // Skip if already present
    if ((css.levelsOrSegments || []).some(s => s.id === storeyId)) continue;
    newStoreys.push({
      id: storeyId,
      type: 'STOREY',
      name: p.name || `Portal Level ${key}m`,
      elevation_m: relZ,
      height_m: 4.0,
    });
  }

  if (newStoreys.length === 0) return;

  css.levelsOrSegments = css.levelsOrSegments || [];
  css.levelsOrSegments.push(...newStoreys);

  // Reassign portal walls (PORTAL_END_WALL and PORTAL_BUILDING) to the nearest portal storey by Z proximity
  const storeyZMap = newStoreys.map(s => ({ id: s.id, z: s.elevation_m }));
  let reassigned = 0;
  for (const elem of (css.elements || [])) {
    const segType = elem.properties?.segmentType;
    if (segType !== 'PORTAL_END_WALL' && segType !== 'PORTAL_BUILDING') continue;
    const elemZ = elem.placement?.origin?.z ?? 0;
    let nearest = storeyZMap[0];
    let nearestDist = Math.abs(elemZ - nearest.z);
    for (const s of storeyZMap) {
      const d = Math.abs(elemZ - s.z);
      if (d < nearestDist) { nearest = s; nearestDist = d; }
    }
    elem.container = nearest.id;
    reassigned++;
  }

  console.log(`synthesizeBuildingStoreys: added ${newStoreys.length} STOREY level(s) — ` +
    newStoreys.map(s => `${s.id}@${s.elevation_m}m`).join(', ') +
    ` — reassigned ${reassigned} portal wall(s)`);
}
