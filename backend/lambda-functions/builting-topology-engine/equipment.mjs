import {
  vecDist, vecAdd, vecSub, vecScale, vecLen,
  vecDot, buildTunnelFrame, validateTunnelFrame,
  getHostInteriorFrame
} from './shared.mjs';

// ============================================================================
// PHASE 3: EQUIPMENT MOUNTING (Universal — domain-aware)
// Frame-relative placement for tunnels, storey-based for buildings.
// Auto-generates continuous MEP systems (lights, pipes, cable trays, ducts).
// ============================================================================

// ---- Mounting zone definitions (6 zones in tunnel cross-section) ----
// lateral/vertical are fractions of half-width/half-height from tunnel center axis
const TUNNEL_MOUNTING_ZONES = {
  crown:              { lateral: 0.0,   vertical: 0.85 },
  left_wall_upper:    { lateral: -0.85, vertical: 0.4 },
  right_wall_upper:   { lateral: 0.85,  vertical: 0.4 },
  left_wall_service:  { lateral: -0.85, vertical: 0.0 },
  right_wall_service: { lateral: 0.85,  vertical: 0.0 },
  floor_left:         { lateral: -0.6,  vertical: -0.90 },
  floor_right:        { lateral: 0.6,   vertical: -0.90 },
};

// ---- SemanticType → preferred zone list (first available wins) ----
const ZONE_PREFERENCES = {
  IfcFan:                        ['crown'],
  IfcLightFixture:               ['crown'],
  IfcCableCarrierSegment:        ['left_wall_upper', 'right_wall_upper'],
  IfcPipeSegment:                ['crown', 'left_wall_upper'],
  IfcFireSuppressionTerminal:    ['crown', 'right_wall_upper'],
  IfcDuctSegment:                ['crown'],
  IfcSensor:                     ['left_wall_service', 'right_wall_service'],
  IfcAlarm:                      ['right_wall_service', 'left_wall_service'],
  IfcCommunicationsAppliance:    ['left_wall_service', 'right_wall_service'],
  IfcElectricDistributionBoard:  ['right_wall_service', 'left_wall_service'],
  IfcPump:                       ['floor_left', 'floor_right'],
  IfcTank:                       ['floor_right', 'floor_left'],
  IfcElectricGenerator:          ['floor_left', 'floor_right'],
  IfcCompressor:                 ['floor_right', 'floor_left'],
  IfcTransformer:                ['floor_left', 'floor_right'],
  IfcBoiler:                     ['floor_right', 'floor_left'],
  IfcChiller:                    ['floor_left', 'floor_right'],
};

// ---- Clearance margins per type (meters from envelope wall) ----
const CLEARANCE_MARGINS = {
  IfcFan: 0.5, IfcElectricGenerator: 0.8, IfcCompressor: 0.8,
  IfcPump: 0.5, IfcTank: 0.5,
  IfcDuctSegment: 0.2, IfcPipeSegment: 0.1,
  IfcCableCarrierSegment: 0.1,
  IfcLightFixture: 0.05, IfcSensor: 0.05, IfcAlarm: 0.05,
  DEFAULT: 0.15
};

// ---- Equipment spacing along tunnel axis (meters between same-type items in same zone) ----
const EQUIPMENT_SPACING = {
  IfcFan: 40, IfcLightFixture: 12, IfcSensor: 20,
  IfcElectricDistributionBoard: 25, IfcFireSuppressionTerminal: 15,
  DEFAULT: 10
};

// ---- Floor-mounted types that get equipment pads ----
const FLOOR_MOUNTED = new Set([
  'IfcPump', 'IfcTank', 'IfcElectricGenerator', 'IfcCompressor',
  'IfcTransformer', 'IfcBoiler', 'IfcChiller'
]);

// ---- Continuous system generation specs ----
const CONTINUOUS_SYSTEMS = [
  {
    type: 'EQUIPMENT', semanticType: 'IfcLightFixture', name: 'Tunnel Light',
    zone: 'crown', spacingM: 12,
    width: 0.6, height: 0.6, depth: 0.1
  },
  {
    type: 'EQUIPMENT', semanticType: 'IfcPipeSegment', name: 'Fire Suppression Main',
    zone: 'crown', continuous: true,
    width: 0.1, height: 0.1, depth: null, // full segment length
    profile: { type: 'CIRCLE', radius: 0.05 }
  },
  {
    type: 'EQUIPMENT', semanticType: 'IfcCableCarrierSegment', name: 'Cable Tray Left',
    zone: 'left_wall_upper', continuous: true,
    width: 0.12, height: 0.06, depth: null
  },
  {
    type: 'EQUIPMENT', semanticType: 'IfcCableCarrierSegment', name: 'Cable Tray Right',
    zone: 'right_wall_upper', continuous: true,
    width: 0.12, height: 0.06, depth: null
  },
  {
    type: 'EQUIPMENT', semanticType: 'IfcDuctSegment', name: 'Ventilation Duct',
    zone: 'crown', continuous: true,
    width: 0.3, height: 0.3, depth: null,
    profile: { type: 'CIRCLE', radius: 0.15 }
  },
];


// ============================================================================
// SEGMENT FILTERING — only index real tunnel parent segments
// ============================================================================

function isRealTunnelParentSegment(elem) {
  const type = (elem.type || '').toUpperCase();
  if (type !== 'TUNNEL_SEGMENT') return false;

  const name = (elem.name || '').toLowerCase();
  if (name.includes('portal building')) return false;
  if (name.includes('portal wall')) return false;
  if (name.includes('portal slab')) return false;
  if (name.includes('portal roof')) return false;
  if (name.includes('entry building')) return false;
  if (name.includes('wall')) return false;
  if (name.includes('slab')) return false;
  if (name.includes('roof')) return false;
  if (name.includes('floor')) return false;
  if (name.includes('opening')) return false;
  if (name.includes('space')) return false;
  if (name.includes('void')) return false;
  if (name.includes('helper')) return false;

  return true;
}

function isPortalHelper(elem) {
  const name = (elem.name || '').toLowerCase();
  return (
    name.includes('portal building') ||
    name.includes('portal wall') ||
    name.includes('portal slab') ||
    name.includes('portal roof') ||
    name.includes('entry building')
  );
}


// ============================================================================
// SEGMENT INDEX — pre-compute tunnel frames and envelopes
// ============================================================================

function buildSegmentIndex(css) {
  const index = new Map(); // element_key → segRecord
  let skippedNoPath = 0;
  let skippedNoProfile = 0;
  let skippedBadFrame = 0;

  for (const elem of css.elements) {
    if (!isRealTunnelParentSegment(elem)) continue;
    if (isPortalHelper(elem)) continue;

    const geom = elem.geometry;
    if (!geom) continue;

    // Prefer placement-based coordinates (matches IFC output) over raw path.
    // IMPORTANT: For tunnel segments, placement.axis is the EXTRUSION direction
    // (typically {0,0,1} = vertical) while placement.refDirection is the tunnel
    // BEARING (horizontal direction). We need the bearing to compute the segment
    // centerline for equipment placement and projection.
    const origin = elem.placement?.origin;
    const axis = elem.placement?.axis;
    const refDir = elem.placement?.refDirection;
    const depth = geom.depth;

    let startPt, endPt;
    if (origin && depth > 0) {
      // Determine tunnel bearing: if axis is near-vertical, use refDirection as bearing
      let dir = null;
      if (axis) {
        const axisLen = vecLen(axis);
        const normAxis = axisLen > 0.001 ? vecScale(axis, 1 / axisLen) : null;
        if (normAxis && Math.abs(normAxis.z) > 0.9 && refDir) {
          // Axis is vertical (extrusion upward) — refDirection IS the tunnel bearing
          const refLen = vecLen(refDir);
          dir = refLen > 0.001 ? vecScale(refDir, 1 / refLen) : null;
        } else {
          dir = normAxis;
        }
      }
      if (!dir && refDir) {
        const refLen = vecLen(refDir);
        dir = refLen > 0.001 ? vecScale(refDir, 1 / refLen) : null;
      }
      if (!dir) { skippedNoPath++; continue; }
      // placement.origin is the segment MIDPOINT (IFC convention), not the start.
      // Use geom.path endpoints when available for the true extent; otherwise
      // offset by half-depth in each direction from the midpoint origin.
      if (geom.path && geom.path.length >= 2) {
        startPt = geom.path[0];
        endPt = geom.path[geom.path.length - 1];
      } else {
        startPt = vecSub(origin, vecScale(dir, depth / 2));
        endPt   = vecAdd(origin, vecScale(dir, depth / 2));
      }
    } else if (geom.path && geom.path.length >= 2) {
      startPt = geom.path[0];
      endPt = geom.path[geom.path.length - 1];
    } else {
      skippedNoPath++;
      continue;
    }

    // Segment length = actual distance between start and end
    const length = vecLen(vecSub(endPt, startPt));
    if (length < 0.5) continue;

    const frame = buildTunnelFrame(startPt, endPt);
    const frameCheck = validateTunnelFrame(frame);
    if (!frameCheck.valid) {
      skippedBadFrame++;
      continue;
    }

    // STRICT: require real cross-section profile dimensions, no defaults
    const profileW = geom.profile?.width;
    const profileH = geom.profile?.height;
    if (!(profileW > 0) || !(profileH > 0)) {
      skippedNoProfile++;
      continue;
    }
    const halfW = profileW / 2;
    const halfH = profileH / 2;
    const center = vecScale(vecAdd(startPt, endPt), 0.5);

    const key = elem.element_key || elem.id;
    index.set(key, {
      elem, key, startPt, endPt, center, frame,
      length,
      halfW, halfH,
      branchId: elem.properties?.derivedFromBranch || elem.properties?.hostBranch || key,
      occupiedSlots: {} // zone → [longitudinalFraction]
    });
  }

  console.log(`buildSegmentIndex: ${index.size} segments indexed (skipped: ${skippedNoPath} no path, ${skippedNoProfile} no profile, ${skippedBadFrame} bad frame)`);
  return index;
}


// ============================================================================
// PROJECTION HELPER — project point onto segment line
// ============================================================================

function projectPointToSegment(point, start, end) {
  const seg = vecSub(end, start);
  const segLen2 = vecDot(seg, seg);
  if (segLen2 <= 1e-6) return null;

  const t = vecDot(vecSub(point, start), seg) / segLen2;
  const clamped = Math.max(0, Math.min(1, t));
  const projected = vecAdd(start, vecScale(seg, clamped));
  return { t: clamped, projected, distance: vecDist(point, projected) };
}


// ============================================================================
// ZONE POSITION — compute world coordinates for a mounting zone
// ============================================================================

function computeZonePosition(segRecord, zoneName, longitudinalFraction) {
  const zone = TUNNEL_MOUNTING_ZONES[zoneName];
  if (!zone) return null;

  const { startPt, frame, length, halfW, halfH } = segRecord;
  if (!frame || !length || length <= 0) return null;

  const f = Math.max(0.05, Math.min(0.95, longitudinalFraction));

  // Longitudinal position along tunnel axis (use segment length, NOT extrusion depth)
  const alongAxis = vecScale(frame.tangent, length * f);
  // Lateral offset (side-to-side, from cross-section profile)
  const lateralOffset = vecScale(frame.lateral, halfW * zone.lateral);
  // Vertical offset (floor-to-roof, from cross-section profile)
  const verticalOffset = vecScale(frame.up, halfH * zone.vertical);

  return vecAdd(vecAdd(vecAdd(startPt, alongAxis), lateralOffset), verticalOffset);
}


// ============================================================================
// ELLIPTICAL ENVELOPE CHECK
// ============================================================================

function isInsideEnvelope(point, segRecord, margin) {
  const { center, frame, halfW, halfH, startPt, endPt } = segRecord;

  // Project point into local frame
  const rel = vecSub(point, center);
  const localX = vecDot(rel, frame.lateral);
  const localY = vecDot(rel, frame.up);

  const effW = halfW - margin;
  const effH = halfH - margin;
  if (effW <= 0 || effH <= 0) return false;

  // Elliptical check
  return (localX * localX) / (effW * effW) + (localY * localY) / (effH * effH) <= 1.0;
}


// ============================================================================
// FIND PARENT SEGMENT — match equipment to its host tunnel segment
// ============================================================================

// Debug counters for parent matching
let _matchByHost = 0;
let _matchByContainer = 0;
let _matchByProjection = 0;
let _matchNone = 0;

function findNearestSegment(elem, segIndex) {
  const o = elem.placement?.origin;
  if (!o) return null;
  let best = null, bestDist = Infinity;
  for (const rec of segIndex.values()) {
    const proj = projectPointToSegment(o, rec.startPt, rec.endPt);
    if (!proj) continue;
    if (proj.distance < bestDist) { bestDist = proj.distance; best = rec; }
  }
  if (!best) return null;
  const maxProjDist = Math.max(1.5, Math.hypot(best.halfW, best.halfH) * 1.5);
  return bestDist < maxProjDist ? best : null;
}

function findParentSegment(elem, segIndex) {
  // 1. Try explicit container/hostBranch (check both properties and metadata —
  //    tunnel-shell writes to metadata, so both locations must be read)
  const hostBranch = elem.properties?.hostStructuralBranchMatched ||
                     elem.properties?.derivedFromBranch ||
                     elem.properties?.hostBranch ||
                     elem.metadata?.hostStructuralBranchMatched;
  if (hostBranch) {
    for (const rec of segIndex.values()) {
      if (rec.branchId === hostBranch || rec.key === hostBranch) {
        _matchByHost++;
        return rec;
      }
    }
    // Key resolved but stale (segment was split/merged after host assignment).
    // Use nearest-centerline projection rather than falling through to container,
    // which may point to a geometrically wrong segment.
    const nearest = findNearestSegment(elem, segIndex);
    if (nearest) { _matchByProjection++; return nearest; }
  }

  // 2. Try container
  if (elem.container) {
    const rec = segIndex.get(elem.container);
    if (rec) {
      _matchByContainer++;
      return rec;
    }
  }

  // 3. Project onto segment lines — pick smallest perpendicular distance
  const o = elem.placement?.origin;
  if (!o) { _matchNone++; return null; }

  let best = null;
  let bestDist = Infinity;

  for (const rec of segIndex.values()) {
    const proj = projectPointToSegment(o, rec.startPt, rec.endPt);
    if (!proj) continue;
    if (proj.distance < bestDist) {
      bestDist = proj.distance;
      best = rec;
    }
  }

  // Only accept if within a profile-relative distance — prevents attaching equipment
  // to the wrong segment when metadata is messy. Cap at 1.5x the segment cross-section
  // half-diagonal (min 1.5m) instead of a blanket 10m.
  if (best) {
    const maxProjDist = Math.max(1.5, Math.hypot(best.halfW, best.halfH) * 1.5);
    if (bestDist < maxProjDist) {
      _matchByProjection++;
      return best;
    }
  }

  _matchNone++;
  return null;
}


// ============================================================================
// EQUIPMENT ORIENTATION — axis/refDirection from tunnel frame
// ============================================================================

function getEquipmentOrientation(frame, zoneName, semanticType) {
  // Continuous runs (pipes, ducts, trays) align with tunnel axis
  if (['IfcPipeSegment', 'IfcDuctSegment', 'IfcCableCarrierSegment'].includes(semanticType)) {
    return { axis: frame.up, refDirection: frame.tangent };
  }

  // Inline mechanical equipment (fans): extrusion axis along flow direction
  if (semanticType === 'IfcFan') {
    return { axis: frame.tangent, refDirection: frame.up };
  }

  // Floor equipment: upright, facing lateral
  if (zoneName.startsWith('floor_')) {
    return { axis: frame.up, refDirection: frame.lateral };
  }

  // Wall equipment: upright, face into tunnel center
  if (zoneName.includes('wall')) {
    const faceInward = zoneName.includes('left')
      ? frame.lateral  // left wall → face right (positive lateral)
      : vecScale(frame.lateral, -1); // right wall → face left
    return { axis: frame.up, refDirection: faceInward };
  }

  // Crown/ceiling: upright, aligned with lateral
  return { axis: frame.up, refDirection: frame.lateral };
}


// ============================================================================
// SPACING CHECK — prevent equipment stacking in same zone
// ============================================================================

function findAvailableSlot(segRecord, zoneName, fraction, semanticType) {
  const spacing = EQUIPMENT_SPACING[semanticType] || EQUIPMENT_SPACING.DEFAULT;
  const minFractionGap = spacing / Math.max(segRecord.length, 1);

  if (!segRecord.occupiedSlots[zoneName]) {
    segRecord.occupiedSlots[zoneName] = [];
  }

  const occupied = segRecord.occupiedSlots[zoneName];
  let candidate = fraction;

  // Nudge if too close to occupied slot
  for (let attempt = 0; attempt < 10; attempt++) {
    const conflict = occupied.some(f => Math.abs(f - candidate) < minFractionGap);
    if (!conflict) {
      occupied.push(candidate);
      return candidate;
    }
    candidate += minFractionGap;
    if (candidate > 0.95) candidate = 0.05 + (attempt * 0.05);
  }

  // Give up — place anyway
  occupied.push(candidate);
  return candidate;
}


// ============================================================================
// MAIN FUNCTION
// ============================================================================

function applyEquipmentMounting(css) {
  if (!css.elements || css.elements.length === 0) return;

  const isTunnel = (css.domain || '').toUpperCase() === 'TUNNEL';

  // ---- BUILDING DOMAIN: storey-based (original logic) ----
  if (!isTunnel) {
    applyBuildingEquipmentMounting(css);
    return;
  }

  // ---- TUNNEL DOMAIN: frame-relative placement ----
  // Reset debug counters (module-level globals drift across warm Lambda invocations)
  _matchByHost = 0;
  _matchByContainer = 0;
  _matchByProjection = 0;
  _matchNone = 0;

  const segIndex = buildSegmentIndex(css);
  if (segIndex.size === 0) {
    console.log('applyEquipmentMounting: no tunnel segments found, skipping');
    return;
  }

  // Build SPACE index for room-bound equipment placement.
  // SPACE origins are often the room entry anchor on the bore wall, not the room centroid.
  // Push ROOM_INTERIOR_OFFSET_M inward along the bore→room direction so equipment lands
  // visibly inside the room volume, not on the wall face.
  const ROOM_INTERIOR_OFFSET_M = 1.5;
  const spaceIndex = new Map();
  for (const e of css.elements) {
    if ((e.type || '').toUpperCase() !== 'SPACE') continue;
    const k = e.element_key || e.id;
    if (!k) continue;
    const eo = e.placement?.origin;
    if (!eo) continue;
    const anchorX = eo.x ?? 0, anchorY = eo.y ?? 0, floorZ = eo.z ?? 0;

    // Skip SPACEs at default/zero origin — they have no valid placement.
    if (Math.abs(anchorX) < 0.1 && Math.abs(anchorY) < 0.1) continue;

    // Project anchor onto nearest tunnel segment centerline (XY only).
    // The vector from that projection → anchor = "outward from bore" = "into room".
    // Offset ROOM_INTERIOR_OFFSET_M further along that direction from the anchor.
    let cx = anchorX, cy = anchorY;
    let nearestDx = 0, nearestDy = 0, nearestDist = Infinity;
    for (const rec of segIndex.values()) {
      const sX = rec.startPt.x, sY = rec.startPt.y;
      const eX = rec.endPt.x, eY = rec.endPt.y;
      const dX = eX - sX, dY = eY - sY;
      const len2 = dX * dX + dY * dY;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((anchorX - sX) * dX + (anchorY - sY) * dY) / len2));
      const projX = sX + t * dX, projY = sY + t * dY;
      const dist = Math.hypot(anchorX - projX, anchorY - projY);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestDx = anchorX - projX;
        nearestDy = anchorY - projY;
      }
    }
    // Only offset when anchor is meaningfully off the centerline (on a side wall).
    const nearestLen = Math.hypot(nearestDx, nearestDy);
    if (nearestLen > 0.5) {
      cx = anchorX + (nearestDx / nearestLen) * ROOM_INTERIOR_OFFSET_M;
      cy = anchorY + (nearestDy / nearestLen) * ROOM_INTERIOR_OFFSET_M;
    }

    // Name tokens for keyword matching (words from name + key, lowercased).
    const nameTokens = ((e.name || '') + ' ' + k).toLowerCase().split(/[\s\-_/]+/).filter(Boolean);

    spaceIndex.set(k, { key: k, cx, cy, floorZ, anchorX, anchorY, nameTokens });
  }

  // Helper: find best-matching SPACE for an equipment element by name keyword overlap,
  // tiebroken by proximity. Used when container/hostRoom don't point to a SPACE key.
  // Portal buildings are excluded — fans don't live in portals.
  const PORTAL_KEY_RE = /portal/i;
  function findRoomForEquipment(elemName, origin) {
    const nameLow = (elemName || '').toLowerCase();
    const nameWords = nameLow.split(/[\s\-_/]+/).filter(Boolean);
    if (nameWords.length === 0) return null;

    let bestEntry = null, bestScore = -1, bestDist = Infinity;
    for (const entry of spaceIndex.values()) {
      if (PORTAL_KEY_RE.test(entry.key)) continue; // portals are structural, not equipment rooms
      const score = entry.nameTokens.filter(t => nameWords.some(w => w === t || w.includes(t) || t.includes(w))).length;
      const dist = (origin && Number.isFinite(origin.x))
        ? Math.hypot(origin.x - entry.anchorX, origin.y - entry.anchorY)
        : Infinity;
      if (score > bestScore || (score === bestScore && dist < bestDist)) {
        bestScore = score;
        bestDist = dist;
        bestEntry = entry;
      }
    }
    return bestScore > 0 ? bestEntry : null;
  }

  let mountingCorrections = 0;
  let roomPlacementCount = 0;
  let originGuardCorrections = 0;
  let envelopeClips = 0;
  const generatedElements = [];

  // ---- Process existing equipment ----
  for (const elem of css.elements) {
    if (elem.type !== 'EQUIPMENT') continue;
    const st = elem.semanticType || '';
    const o = elem.placement?.origin;
    if (!o) continue;

    if (!elem.metadata) elem.metadata = {};
    elem.metadata.originalPlacement = { x: o.x, y: o.y, z: o.z };

    // Room-bound check: place inside the host SPACE at the interior centroid + 0.5m above floor.
    // 1. Direct key match (container or hostRoom points to a SPACE key).
    // 2. Name-keyword fallback: match equipment name tokens against SPACE name tokens,
    //    tiebroken by proximity. Handles fans whose container is a tunnel segment branch
    //    but whose name clearly identifies a specific room (e.g. "AC Fan" → AC Room).
    let roomEntry = spaceIndex.get(elem.container) || spaceIndex.get(elem.properties?.hostRoom);
    if (!roomEntry) roomEntry = findRoomForEquipment(elem.name, o);
    if (roomEntry) {
      o.x = roomEntry.cx; o.y = roomEntry.cy; o.z = roomEntry.floorZ + 0.5;
      elem.container = roomEntry.key;
      elem.metadata.correctedBy = 'ROOM_PLACEMENT';
      elem.metadata.placedInRoom = roomEntry.key;
      roomPlacementCount++;
      continue;
    }

    // Origin guard — skip equipment at near-zero origin with no host lineage.
    // These would otherwise project onto the nearest segment by distance, creating
    // misleading placements. Better to leave them unmounted and annotated.
    const isZeroish = Math.abs(o.x) < 0.001 && Math.abs(o.y) < 0.001 && Math.abs(o.z) < 0.001;
    if (isZeroish && !elem.properties?.hostBranch && !elem.container) {
      elem.metadata.mountingSkipped = 'INVALID_ORIGIN_NO_HOST';
      originGuardCorrections++;
      continue;
    }

    // Find parent segment — for IfcFan, fall back to unconstrained nearest-segment
    // search when the normal distance-gated lookup fails (spec-derived fans can sit
    // 10–20m outside the tunnel bbox but still belong there).
    let seg = findParentSegment(elem, segIndex);
    if (!seg && st === 'IfcFan') {
      seg = findNearestSegment(elem, segIndex);
    }
    if (!seg) continue;

    // Canonicalize container ref to resolved segment key — prevents stale
    // branch IDs (e.g. ventsim_branch_260) from surviving into the final
    // element set where they would fail container validation.
    elem.container = seg.key;

    // Pick zone
    const prefs = ZONE_PREFERENCES[st] || ['left_wall_service'];
    const zoneName = prefs[0];

    // Compute longitudinal fraction (how far along segment length)
    const toElem = vecSub(o, seg.startPt);
    let fraction = seg.length > 0 ? vecDot(toElem, seg.frame.tangent) / seg.length : 0.5;
    fraction = Number.isFinite(fraction) ? Math.max(0.05, Math.min(0.95, fraction)) : 0.5;

    // Check spacing
    fraction = findAvailableSlot(seg, zoneName, fraction, st);

    // Compute new position
    const newPos = computeZonePosition(seg, zoneName, fraction);
    if (!newPos) continue;

    // Envelope check — if preferred zone is outside profile, try all alternate zones.
    // If all zones fail (equipment larger than tunnel), generate a TUNNEL_NICHE proxy
    // that expands the wall surface to contain the element — no "poke-through" allowed.
    const margin = CLEARANCE_MARGINS[st] || CLEARANCE_MARGINS.DEFAULT;
    let allZonesFailed = false;

    if (!isInsideEnvelope(newPos, seg, margin)) {
      envelopeClips++;
      let placed = false;
      for (const altZone of Object.keys(TUNNEL_MOUNTING_ZONES)) {
        const altPos = computeZonePosition(seg, altZone, fraction);
        if (altPos && isInsideEnvelope(altPos, seg, margin)) {
          o.x = altPos.x; o.y = altPos.y; o.z = altPos.z;
          elem.metadata.mountingZone = altZone;
          placed = true;
          break;
        }
      }
      if (!placed) {
        // No zone works — equipment is larger than the tunnel cross-section.
        // Mark it so a TUNNEL_NICHE proxy is generated below.
        allZonesFailed = true;
        elem.metadata.mountingZone = zoneName; // retain for orientation
        elem.metadata.envelopeFallback = 'NICHE_GENERATED';
      }
    } else {
      o.x = newPos.x; o.y = newPos.y; o.z = newPos.z;
      elem.metadata.mountingZone = zoneName;
    }

    // Generate TUNNEL_NICHE proxy when equipment cannot fit inside any interior zone.
    // The niche is a wall-surface box that expands the tunnel locally to contain the element.
    // Also relocate the equipment into the niche so it doesn't float at its original origin.
    if (allZonesFailed) {
      const eqW = elem.geometry?.profile?.width || 0.6;
      const eqH = elem.geometry?.profile?.height || 0.6;
      const eqD = elem.geometry?.depth || 0.4;
      const NICHE_MARGIN = 0.1; // 100mm clearance around equipment

      // Position niche flush with the tunnel wall surface at the preferred zone's lateral side
      const zone = TUNNEL_MOUNTING_ZONES[zoneName];
      const lateralSign = zone ? Math.sign(zone.lateral || 1) : 1;
      const wallFacePt = vecAdd(
        vecAdd(seg.startPt, vecScale(seg.frame.tangent, seg.length * fraction)),
        vecScale(seg.frame.lateral, seg.halfW * lateralSign)
      );

      // Anchor equipment into the niche — offset slightly inward from wall face
      const nicheAnchor = vecAdd(wallFacePt, vecScale(seg.frame.lateral, lateralSign * 0.05));
      o.x = nicheAnchor.x;
      o.y = nicheAnchor.y;
      o.z = nicheAnchor.z;
      elem.metadata.mountedInGeneratedNiche = true;

      const fractionTag = Math.round(fraction * 1000);
      const nicheKey = `niche-${elem.element_key || elem.id}-${seg.key}-${zoneName}-${fractionTag}`;
      generatedElements.push({
        id: nicheKey,
        element_key: nicheKey,
        type: 'PROXY',
        name: `Equipment Niche (${st.replace('Ifc', '')})`,
        semanticType: 'IfcBuildingElementProxy',
        confidence: 0.3,
        source: 'GENERATED',
        container: seg.key,
        placement: {
          origin: wallFacePt,
          axis: seg.frame.up,
          refDirection: seg.frame.lateral
        },
        geometry: {
          method: 'EXTRUSION',
          profile: {
            type: 'RECTANGLE',
            width:  eqW + NICHE_MARGIN,
            height: eqH + NICHE_MARGIN
          },
          depth: eqD + NICHE_MARGIN
        },
        properties: {
          isTunnelNiche: true,
          hostEquipment: elem.element_key || elem.id,
          derivedFromBranch: seg.branchId,
          generated: true
        },
        metadata: { generatedBy: 'TUNNEL_NICHE', parentSegment: seg.key }
      });
    }

    // Set orientation
    const orient = getEquipmentOrientation(seg.frame, elem.metadata.mountingZone || zoneName, st);
    if (!elem.placement.axis) elem.placement.axis = {};
    elem.placement.axis = orient.axis;
    if (!elem.placement.refDirection) elem.placement.refDirection = {};
    elem.placement.refDirection = orient.refDirection;

    elem.metadata.parentSegment = seg.key;
    elem.metadata.longitudinalFraction = Math.round(fraction * 1000) / 1000;
    elem.metadata.correctedBy = 'INTERIOR_PLACEMENT';
    elem.metadata.clearanceMargin = margin;
    elem.metadata.correctionDelta = {
      dx: Math.round((o.x - elem.metadata.originalPlacement.x) * 100) / 100,
      dy: Math.round((o.y - elem.metadata.originalPlacement.y) * 100) / 100,
      dz: Math.round((o.z - elem.metadata.originalPlacement.z) * 100) / 100
    };
    mountingCorrections++;

    // Derive _mountType from zone assignment (tunnel domain)
    const assignedZone = elem.metadata.mountingZone || zoneName;
    if (assignedZone.startsWith('crown')) {
      elem.metadata._mountType = 'CEILING';
    } else if (assignedZone.startsWith('floor')) {
      elem.metadata._mountType = 'FLOOR';
    } else if (assignedZone.includes('wall')) {
      elem.metadata._mountType = 'WALL';
    } else {
      elem.metadata._mountType = 'FLOOR';
    }

    // Floor pad for heavy equipment — skip in tunnel domain since the tunnel
    // segment floor IS the pad (generating pads creates visual double-floor)
    if (FLOOR_MOUNTED.has(st) && !isTunnel) {
      const eqW = elem.geometry?.profile?.width || 0.6;
      const eqD = elem.geometry?.profile?.height || elem.geometry?.depth || 0.6;
      const padPos = computeZonePosition(seg, elem.metadata.mountingZone || zoneName, fraction);
      if (padPos) {
        // Shift pad down so equipment sits on top
        const padTop = vecAdd(padPos, vecScale(seg.frame.up, -0.1));
        generatedElements.push({
          id: `pad-${elem.element_key || elem.id}-${seg.key}-${elem.metadata.mountingZone || zoneName}-${Math.round(fraction * 1000)}`,
          element_key: `pad-${elem.element_key || elem.id}-${seg.key}-${elem.metadata.mountingZone || zoneName}-${Math.round(fraction * 1000)}`,
          type: 'SLAB',
          semanticType: 'IfcSlab',
          name: `Equipment Pad (${st.replace('Ifc', '')})`,
          placement: {
            origin: padTop,
            axis: seg.frame.up,
            refDirection: seg.frame.lateral
          },
          geometry: {
            method: 'EXTRUSION',
            profile: { type: 'RECTANGLE', width: eqW + 0.4, height: eqD + 0.4 },
            depth: 0.2
          },
          properties: { slabType: 'EQUIPMENT_PAD', parentEquipment: elem.element_key || elem.id, generated: true, derivedFromBranch: seg.branchId },
          container: seg.key,
          confidence: 0.6,
          source: 'GENERATED',
          metadata: { generatedBy: 'EQUIPMENT_PAD', parentSegment: seg.key }
        });
      }
    }
  }

  // ---- Node-based path + Z-clamped placement for ALL linear MEP ----
  // 1. Build node XY position map from entry/exit nodes
  // 2. Build segment-by-node lookup for Z clamping (tunnel floor + height)
  // 3. Force SWEEP for all ducts/pipes, clamp Z to tunnel interior

  // Helper: compute host-relative Z using semantic mounting bands.
  // Uses getHostInteriorFrame() to derive inner floor/ceiling, then places
  // elements with proper clearance based on their type and dimensions.
  function getSemanticZ(hostSeg, semanticType, elementProfile) {
    const frame = getHostInteriorFrame(hostSeg);
    const clearance = CLEARANCE_MARGINS[semanticType] || CLEARANCE_MARGINS.DEFAULT;
    const elemH = elementProfile?.height || (elementProfile?.radius ? elementProfile.radius * 2 : 0.3);

    // Crown-mounted: hang from inner ceiling with clearance
    if (['IfcDuctSegment', 'IfcPipeSegment', 'IfcLightFixture', 'IfcFireSuppressionTerminal'].includes(semanticType)) {
      return frame.innerCeilZ - clearance - elemH / 2;
    }
    // Cable trays: wall-upper band (just below ceiling)
    if (semanticType === 'IfcCableCarrierSegment') {
      return frame.innerCeilZ - clearance - elemH / 2;
    }
    // Fans: ceiling-hung inline with airway
    if (semanticType === 'IfcFan') {
      return frame.innerCeilZ - clearance - elemH / 2;
    }
    // Floor-mounted equipment: stand on inner floor
    if (FLOOR_MOUNTED.has(semanticType)) {
      return frame.innerFloorZ + clearance + elemH / 2;
    }
    // Wall-mounted sensors/alarms: mid-height of interior
    return (frame.innerFloorZ + frame.innerCeilZ) / 2;
  }

  // Legacy wrapper for backward compatibility within continuous system generation
  function getTunnelZ(tunnelSeg, ratio) {
    const centerZ = tunnelSeg?.placement?.origin?.z || 0;
    const h = tunnelSeg?.geometry?.profile?.height || 5;
    const floorZ = centerZ - h / 2;
    return floorZ + h * ratio;
  }

  // Build node XY map (horizontal positions only — Z comes from host tunnel)
  const nodeXY = new Map();
  for (const elem of css.elements) {
    const o = elem.placement?.origin;
    if (!o) continue;
    const props = elem.properties || {};
    const bearing = elem.placement?.refDirection || elem.placement?.axis;
    const depth = elem.geometry?.depth || 0;
    if (props.entry_node && !nodeXY.has(props.entry_node)) {
      nodeXY.set(props.entry_node, { x: o.x, y: o.y });
    }
    if (props.exit_node && bearing && depth > 0 && !nodeXY.has(props.exit_node)) {
      const bLen = vecLen(bearing);
      if (bLen > 0.001) {
        const dir = vecScale(bearing, 1 / bLen);
        nodeXY.set(props.exit_node, { x: o.x + dir.x * depth, y: o.y + dir.y * depth });
      }
    }
  }

  // Build node → host structural segment lookup (for Z clamping)
  const nodeToSegment = new Map();
  for (const elem of css.elements) {
    if (elem.type !== 'TUNNEL_SEGMENT' || elem.properties?.branchClass !== 'STRUCTURAL') continue;
    const en = elem.properties?.entry_node;
    const ex = elem.properties?.exit_node;
    if (en && !nodeToSegment.has(en)) nodeToSegment.set(en, elem);
    if (ex && !nodeToSegment.has(ex)) nodeToSegment.set(ex, elem);
  }
  console.log(`Node map: ${nodeXY.size} XY positions, ${nodeToSegment.size} segment-linked nodes`);

  // Map AIRWAY nodes to nearest STRUCTURAL segment for Z-clamping
  const structuralSegs = css.elements.filter(e =>
    e.type === 'TUNNEL_SEGMENT' &&
    (e.properties?.branchClass || '').toUpperCase() === 'STRUCTURAL'
  );
  let airwayNodesMapped = 0;
  for (const elem of css.elements) {
    if ((elem.properties?.branchClass || '').toUpperCase() !== 'AIRWAY') continue;
    if (!elem.metadata) elem.metadata = {};
    for (const nk of [elem.properties?.entry_node, elem.properties?.exit_node]) {
      if (!nk || nodeToSegment.has(nk)) continue;
      const npos = nodeXY.get(nk);
      if (!npos) continue;
      let bestSeg = null, bestDist = Infinity;
      for (const seg of structuralSegs) {
        const so = seg.placement?.origin;
        if (!so) continue;
        const d = Math.hypot(npos.x - so.x, npos.y - so.y);
        if (d < bestDist) { bestDist = d; bestSeg = seg; }
      }
      if (bestSeg && bestDist < 30) {
        nodeToSegment.set(nk, bestSeg);
        elem.metadata.parentSegment = bestSeg.element_key || bestSeg.id;
        airwayNodesMapped++;
      }
    }
  }
  if (airwayNodesMapped > 0) {
    console.log(`AIRWAY node mapping: ${airwayNodesMapped} nodes mapped to nearest structural segment`);
  }

  let mepCenterlineSnaps = 0;
  let mepNodePaths = 0;
  let mepFanConverted = 0;

  for (const elem of css.elements) {
    const type = (elem.type || '').toUpperCase();
    const st = elem.semanticType || '';
    const props = elem.properties || {};
    const isLinearMEP =
      ['IfcPipeSegment', 'IfcDuctSegment', 'IfcCableCarrierSegment'].includes(st) ||
      ['PIPE', 'DUCT'].includes(type);
    if (!isLinearMEP) continue;
    if (elem.metadata?.parentSegment) continue;

    const o = elem.placement?.origin;
    if (!o) continue;
    if (!elem.metadata) elem.metadata = {};
    if (!elem.geometry) elem.geometry = {};

    // Convert fan_type ducts to equipment — place at midpoint of entry/exit nodes,
    // flow-aligned axis, at semantic ceiling-hung Z
    if (props.fan_type && props.fan_type > 0) {
      elem.type = 'EQUIPMENT';
      elem.semanticType = 'IfcFan';
      elem.name = `Ventilation Fan (Type ${props.fan_type})`;

      const fn1 = props.entry_node ? nodeXY.get(props.entry_node) : null;
      const fn2 = props.exit_node ? nodeXY.get(props.exit_node) : null;
      const hostSeg = nodeToSegment.get(props.entry_node) || nodeToSegment.get(props.exit_node);
      const fanProfile = elem.geometry?.profile || { height: 1.2, width: 1.2 };

      // Cap depth to fan disk thickness — the duct's depth is the BRANCH LENGTH (metres),
      // not the fan disk thickness.  Emitting a 2.5m-deep cylinder along Z pushes the fan
      // body well above the tunnel ceiling.  Use diameter × 0.2 matching the extract formula.
      const fanRadius = fanProfile.radius || (Math.min(fanProfile.width || 1.2, fanProfile.height || 1.2) / 2);
      const diskThickness = Math.max(0.15, fanRadius * 0.4);
      elem.geometry.depth = diskThickness;

      // Anchor Z: position the TOP of the disk at innerCeilZ − 0.1m clearance.
      // Do NOT use getSemanticZ here because it was sized for the original elemH.
      let fanZ;
      if (hostSeg) {
        const hf = getHostInteriorFrame(hostSeg);
        fanZ = hf.innerCeilZ - 0.1 - diskThickness;
      } else {
        fanZ = o.z + 2.0;
      }

      if (fn1 && fn2) {
        // Place at midpoint of entry/exit nodes
        o.x = (fn1.x + fn2.x) / 2;
        o.y = (fn1.y + fn2.y) / 2;
        o.z = fanZ;
        // Flow-aligned: axis along flow direction, refDirection up
        const flowDir = { x: fn2.x - fn1.x, y: fn2.y - fn1.y, z: 0 };
        const flowLen = vecLen(flowDir);
        if (flowLen > 0.001) {
          const normalizedFlow = vecScale(flowDir, 1 / flowLen);
          elem.placement.axis = normalizedFlow;
          elem.placement.refDirection = { x: 0, y: 0, z: 1 };
        }
      } else {
        o.z = fanZ;
        if (props.hostDirectionX !== undefined) {
          elem.placement.axis = { x: props.hostDirectionX, y: props.hostDirectionY || 0, z: 0 };
          elem.placement.refDirection = { x: 0, y: 0, z: 1 };
        }
      }
      if (hostSeg) elem.container = hostSeg.element_key || hostSeg.id;
      elem.metadata.convertedFromDuct = true;
      elem.metadata.zAligned = true;
      mepFanConverted++;
      continue;
    }

    // FORCE SWEEP for all linear MEP — EXTRUSION is never correct for ducts/pipes
    const entryNode = props.entry_node;
    const exitNode = props.exit_node;
    const n1 = entryNode ? nodeXY.get(entryNode) : null;
    const n2 = exitNode ? nodeXY.get(exitNode) : null;

    // Find host tunnel segment for Z clamping — use semantic Z based on element type.
    // nodeToSegment stores raw CSS elements (used by getSemanticZ/getHostInteriorFrame).
    // Y-range validation needs a segRecord (has startPt/endPt/halfW) — look it up in segIndex.
    const hostSeg = nodeToSegment.get(entryNode) || nodeToSegment.get(exitNode);
    const hostSegKey = hostSeg ? (hostSeg.element_key || hostSeg.id) : null;
    const hostSegRecord = hostSegKey ? segIndex.get(hostSegKey) : null;
    const elemProfile = elem.geometry?.profile || {};
    const ductZ = hostSeg ? getSemanticZ(hostSeg, st, elemProfile) : (o.z + 2.0);

    if (n1 && n2) {
      // Validate NODE_MAP coords against host segment Y range — node IDs from different
      // coordinate frames (DXF vs VentSim) can land 10+ m off the tunnel centerline.
      let nodeMapOk = true;
      if (hostSegRecord) {
        const NODE_MAP_Y_MARGIN = 5.0; // metres
        const segMinY = Math.min(hostSegRecord.startPt.y, hostSegRecord.endPt.y) - hostSegRecord.halfW - NODE_MAP_Y_MARGIN;
        const segMaxY = Math.max(hostSegRecord.startPt.y, hostSegRecord.endPt.y) + hostSegRecord.halfW + NODE_MAP_Y_MARGIN;
        if (n1.y < segMinY || n1.y > segMaxY || n2.y < segMinY || n2.y > segMaxY) {
          console.log(`applyEquipmentMounting: NODE_MAP Y [${n1.y.toFixed(1)},${n2.y.toFixed(1)}] outside host Y [${segMinY.toFixed(1)},${segMaxY.toFixed(1)}] for ${elem.element_key || elem.id || '(unknown)'} — falling to SEGMENT_PROJECTION`);
          nodeMapOk = false;
        }
      }
      if (nodeMapOk) {
        elem.geometry.method = 'SWEEP';
        // pathPoints in WORLD coordinates — generate's PATH_SWEEP normalization subtracts
        // the VentSim centroid from both pathPoints and placement.origin, then overwrites
        // placement.origin with (centred) pathPoints[0]. Using local (0,0,0) offsets here
        // causes the centroid subtraction to shift pathPoints[0] to −44 km, which then
        // poisons the placement and scatters these ducts to world-origin.
        o.x = n1.x; o.y = n1.y; o.z = ductZ;
        elem.geometry.pathPoints = [
          { x: n1.x, y: n1.y, z: ductZ },
          { x: n2.x, y: n2.y, z: ductZ }
        ];
        delete elem.geometry.direction;
        delete elem.geometry.depth; // depth is not used for SWEEP — pathPoints define length
        // Identity placement frame: local X/Y/Z = world X/Y/Z, so the pathPoints delta
        // {n2.x-n1.x, n2.y-n1.y, 0} stored in local coords maps to exactly that world offset
        // from the placement origin. A non-identity axis rotates the local frame, causing IFC
        // to transform the delta to a completely wrong world position (scattered ducts).
        elem.placement.axis = { x: 0, y: 0, z: 1 };
        elem.placement.refDirection = { x: 1, y: 0, z: 0 };
        if (hostSeg) {
          elem.container = hostSeg.element_key || hostSeg.id;
          elem.metadata.parentSegment = hostSeg.element_key || hostSeg.id;
        }
        elem.metadata.pathSource = 'NODE_MAP';
        elem.metadata.zAligned = true;
        elem.metadata.pathGenerated = true;
        mepNodePaths++;
        mepCenterlineSnaps++;
        continue;
      }
    }

    // Fallback: segment projection (semantic Z clamping)
    const seg = findParentSegment(elem, segIndex);
    if (!seg) continue;

    const segZ = getSemanticZ(seg.elem, st, elemProfile);

    // Generate path along segment bearing at clamped Z
    const p0 = vecAdd(seg.startPt, vecScale(seg.frame.tangent, seg.length * 0.10));
    const p1 = vecAdd(seg.startPt, vecScale(seg.frame.tangent, seg.length * 0.90));

    elem.geometry.method = 'SWEEP';
    // pathPoints in WORLD coordinates — same reason as NODE_MAP path above.
    o.x = p0.x; o.y = p0.y; o.z = segZ;
    elem.geometry.pathPoints = [
      { x: p0.x, y: p0.y, z: segZ },
      { x: p1.x, y: p1.y, z: segZ }
    ];
    delete elem.geometry.direction;
    delete elem.geometry.depth;
    // Identity frame — same reason as NODE_MAP path: local delta must equal world delta.
    elem.placement.axis = { x: 0, y: 0, z: 1 };
    elem.placement.refDirection = { x: 1, y: 0, z: 0 };
    elem.container = seg.key;
    elem.metadata.pathSource = 'SEGMENT_PROJECTION';
    elem.metadata.zAligned = true;
    elem.metadata.pathGenerated = true;
    elem.metadata.parentSegment = seg.key;
    elem.metadata.parentSegmentKey = seg.key;
    mepCenterlineSnaps++;
  }
  if (mepCenterlineSnaps > 0 || mepNodePaths > 0 || mepFanConverted > 0) {
    console.log(`MEP path generation: ${mepNodePaths} node-based, ${mepCenterlineSnaps - mepNodePaths} segment-projected, ${mepFanConverted} fan conversions`);
  }

  // ---- Clip PATH_SWEEP pathPoints to host segment longitudinal bounds ----
  // NODE_MAP paths span the full entry→exit node distance, which may cross multiple
  // sub-segments after buildPathConnections splits original branches. Clamp each
  // pathPoint to [0, length] along the host tangent so swept geometry stays within
  // its assigned segment bbox.
  let pathPointClips = 0;
  for (const elem of css.elements) {
    if (!elem.geometry?.pathPoints || elem.geometry.pathPoints.length < 2) continue;
    if (!elem.metadata?.parentSegment) continue;
    const clipSeg = segIndex.get(elem.metadata.parentSegment);
    if (!clipSeg || clipSeg.length <= 0) continue;

    const { startPt: cStart, frame: cFrame, length: cLen } = clipSeg;
    let anyClipped = false;
    const newPoints = elem.geometry.pathPoints.map(pt => {
      const along = vecDot(vecSub(pt, cStart), cFrame.tangent);
      const t = along / cLen;
      const tc = Math.max(0, Math.min(1, t));
      if (Math.abs(tc - t) > 1e-3) {
        anyClipped = true;
        const clamped = vecAdd(cStart, vecScale(cFrame.tangent, tc * cLen));
        return { x: clamped.x, y: clamped.y, z: pt.z };
      }
      return pt;
    });
    if (!anyClipped) continue;

    // Guard: both ends clamped to same endpoint — expand to 10%–90% of segment
    const p0 = newPoints[0], pN = newPoints[newPoints.length - 1];
    if (Math.hypot(pN.x - p0.x, pN.y - p0.y) < 0.1) {
      const z = p0.z;
      const fb0 = vecAdd(cStart, vecScale(cFrame.tangent, cLen * 0.1));
      const fbN = vecAdd(cStart, vecScale(cFrame.tangent, cLen * 0.9));
      newPoints[0] = { x: fb0.x, y: fb0.y, z };
      newPoints[newPoints.length - 1] = { x: fbN.x, y: fbN.y, z };
    }

    elem.geometry.pathPoints = newPoints;
    if (elem.placement?.origin) {
      elem.placement.origin.x = newPoints[0].x;
      elem.placement.origin.y = newPoints[0].y;
    }
    elem.metadata.pathClipped = true;
    pathPointClips++;
  }
  if (pathPointClips > 0) {
    console.log(`Path clip: ${pathPointClips} PATH_SWEEP elements clipped to host segment bounds`);
  }

  // ---- Auto-generate continuous systems ----
  let generatedSystemCount = 0;

  // Demo stabilization: disable ALL synthetic continuous systems for tunnel domain.
  // These generate clutter that is not source-backed.
  if ((css.domain || '').toUpperCase() === 'TUNNEL') {
    console.log('Demo mode: skipping synthetic continuous systems for tunnel');
  } else
  for (const seg of segIndex.values()) {
    // Skip continuous system generation for VentSim-sourced segments —
    // VentSim already provides real MEP data; generated systems create noise
    if (seg.elem?.source === 'VSM') continue;

    for (const spec of CONTINUOUS_SYSTEMS) {
      // Check if this system type already exists on this segment
      const alreadyExists = css.elements.some(e =>
        e.type === 'EQUIPMENT' &&
        e.semanticType === spec.semanticType &&
        e.metadata?.parentSegment === seg.key &&
        e.name === spec.name
      );
      if (alreadyExists) continue;

      // Skip ducts/pipes if an explicit extracted element already exists on this segment
      if (spec.semanticType === 'IfcDuctSegment' || spec.semanticType === 'IfcPipeSegment') {
        const hasExplicit = css.elements.some(e =>
          e.semanticType === spec.semanticType &&
          (e.metadata?.parentSegment === seg.key || e.metadata?.parentSegmentKey === seg.key)
        );
        if (hasExplicit) continue;
      }

      if (spec.continuous) {
        // Full-length run along segment — use SWEEP with pathPoints for circular
        // profiles (pipes, ducts) so they follow the tunnel axis correctly.
        // Rectangular profiles (cable trays) stay as EXTRUSION.
        const p0 = computeZonePosition(seg, spec.zone, 0.10);
        const p1 = computeZonePosition(seg, spec.zone, 0.90);
        if (!p0 || !p1) continue;

        const orient = getEquipmentOrientation(seg.frame, spec.zone, spec.semanticType);
        const genId = `gen-${spec.semanticType.replace('Ifc', '').toLowerCase()}-${spec.zone}-${seg.key}`;

        const isCircular = spec.profile?.type === 'CIRCLE';
        const geom = isCircular
          ? {
              method: 'SWEEP',
              profile: spec.profile,
              pathPoints: [
                { x: p0.x, y: p0.y, z: p0.z },
                { x: p1.x, y: p1.y, z: p1.z }
              ]
            }
          : {
              method: 'EXTRUSION',
              profile: { type: 'RECTANGLE', width: spec.width, height: spec.height },
              depth: seg.length * 0.80
            };

        generatedElements.push({
          id: genId,
          element_key: genId,
          type: 'EQUIPMENT',
          semanticType: spec.semanticType,
          name: spec.name,
          placement: {
            origin: p0,
            axis: orient.axis,
            refDirection: orient.refDirection
          },
          geometry: geom,
          properties: {
            generated: true,
            systemType: spec.name,
            derivedFromBranch: seg.branchId,
            // entry_node / exit_node inherited from parent segment so that
            // builting-generate can create IfcDistributionPort + IfcRelConnectsPorts
            // connections between continuous MEP runs at shared skeleton nodes.
            entry_node: seg.elem?.properties?.entry_node ?? null,
            exit_node:  seg.elem?.properties?.exit_node  ?? null
          },
          container: seg.key,
          confidence: 0.5,
          source: 'GENERATED',
          metadata: {
            generatedBy: 'CONTINUOUS_SYSTEM',
            parentSegment: seg.key,
            mountingZone: spec.zone,
            longitudinalFraction: 0.10
          }
        });
        generatedSystemCount++;

      } else if (spec.spacingM) {
        // Spaced items (e.g., lights every 12m)
        const count = Math.max(1, Math.floor(seg.length / spec.spacingM));
        for (let i = 0; i < count; i++) {
          const fraction = (i + 0.5) / count;
          const pos = computeZonePosition(seg, spec.zone, fraction);
          if (!pos) continue;

          const orient = getEquipmentOrientation(seg.frame, spec.zone, spec.semanticType);
          const genId = `gen-${spec.semanticType.replace('Ifc', '').toLowerCase()}-${spec.zone}-${seg.key}-${i}`;

          generatedElements.push({
            id: genId,
            element_key: genId,
            type: 'EQUIPMENT',
            semanticType: spec.semanticType,
            name: `${spec.name} ${i + 1}`,
            placement: {
              origin: pos,
              axis: orient.axis,
              refDirection: orient.refDirection
            },
            geometry: {
              method: 'EXTRUSION',
              profile: { type: 'RECTANGLE', width: spec.width, height: spec.height },
              depth: spec.depth || 0.6
            },
            properties: { generated: true, systemType: spec.name, index: i, derivedFromBranch: seg.branchId },
            container: seg.key,
            confidence: 0.5,
            source: 'GENERATED',
            metadata: {
              generatedBy: 'CONTINUOUS_SYSTEM',
              parentSegment: seg.key,
              mountingZone: spec.zone,
              longitudinalFraction: Math.round(fraction * 1000) / 1000
            }
          });
          generatedSystemCount++;
        }
      }
    }
  }

  // Add generated elements to CSS
  css.elements.push(...generatedElements);

  // ---- Assign ventilation roles from source layer data ----
  let ventRolesAssigned = 0;
  for (const elem of css.elements) {
    if ((elem.properties?.branchClass || '').toUpperCase() !== 'AIRWAY') continue;
    if (!elem.metadata) elem.metadata = {};
    const layer = (elem.properties?.ventLayer || '').toLowerCase();
    if (layer.includes('fresh')) elem.metadata.ventRole = 'PORTAL_INTAKE';
    else if (layer.includes('exhaust')) elem.metadata.ventRole = 'SHAFT_EXHAUST';
    else if (layer.includes('supply')) elem.metadata.ventRole = 'HVAC_SUPPLY';
    else if (layer.includes('return')) elem.metadata.ventRole = 'HVAC_RETURN';
    else if (layer.includes('tunnel')) elem.metadata.ventRole = 'TUNNEL_AIR';
    else elem.metadata.ventRole = 'NETWORK_ONLY';
    if (elem.metadata.ventRole !== 'NETWORK_ONLY') ventRolesAssigned++;
  }
  if (ventRolesAssigned > 0) {
    console.log(`Vent roles: ${ventRolesAssigned} AIRWAY elements assigned source-backed roles`);
  }

  // ---- Force Z-alignment for promoted ventilation ducts ----
  for (const elem of css.elements) {
    if ((elem.properties?.branchClass || '').toUpperCase() !== 'AIRWAY') continue;
    if (!elem.metadata?.ventRole || elem.metadata.ventRole === 'NETWORK_ONLY') continue;
    if (!elem.geometry?.pathPoints || elem.geometry.pathPoints.length < 2) continue;
    const seg = nodeToSegment.get(elem.properties?.entry_node) || nodeToSegment.get(elem.properties?.exit_node);
    if (!seg) continue;
    const centerZ = seg.placement?.origin?.z || 0;
    const halfH = (seg.geometry?.profile?.height || 5) / 2;
    const z = elem.metadata.ventRole === 'SHAFT_EXHAUST' ? centerZ + halfH * 0.7
            : elem.metadata.ventRole === 'PORTAL_INTAKE' ? centerZ + halfH * 0.5
            : centerZ + halfH * 0.6;
    elem.geometry.pathPoints = elem.geometry.pathPoints.map(p => ({ x: p.x, y: p.y, z }));
    if (elem.placement?.origin) {
      elem.placement.origin = { ...elem.geometry.pathPoints[0] };
    }
    elem.metadata.zAligned = true;
    if (!elem.metadata.parentSegment) {
      elem.metadata.parentSegment = seg.element_key || seg.id;
    }
    if (!elem.container) {
      elem.container = seg.element_key || seg.id;
    }
  }

  // ---- Universal geometry exportability annotation ----
  // Not every extracted graph edge should become visible geometry.
  // Simulation/network branches (AIRWAY, routing skeletons, semantic connectors)
  // are only exportable if explicitly promoted to a visible class (e.g. fan conversion).
  const PROMOTED_SEMANTIC_TYPES = new Set([
    'IfcFan', 'IfcPump', 'IfcCompressor', 'IfcValve',
    'IfcLightFixture', 'IfcSensor', 'IfcAlarm',
    'IfcElectricDistributionBoard', 'IfcFireSuppressionTerminal',
    'IfcCommunicationsAppliance', 'IfcElectricGenerator',
    'IfcTransformer', 'IfcBoiler', 'IfcChiller', 'IfcTank'
  ]);
  const NON_RENDERABLE_BRANCH_CLASSES = new Set(['AIRWAY', 'ROUTING', 'SEMANTIC', 'NETWORK']);
  let airwayHidden = 0;

  for (const elem of css.elements) {
    if (!elem.metadata) elem.metadata = {};
    const bc = (elem.properties?.branchClass || '').toUpperCase();

    // Source-backed renderable linear MEP check (geometry-valid ducts/pipes)
    const isRenderableLinear =
      (elem.semanticType === 'IfcDuctSegment' || elem.semanticType === 'IfcPipeSegment') &&
      (
        (elem.geometry?.method === 'SWEEP' &&
         Array.isArray(elem.geometry?.pathPoints) &&
         elem.geometry.pathPoints.length >= 2)
        ||
        (elem.geometry?.method === 'EXTRUSION' &&
         elem.geometry?.profile &&
         (elem.geometry?.depth || 0) > 0)
      );

    if (NON_RENDERABLE_BRANCH_CLASSES.has(bc)) {
      // Promoted equipment types (fans, pumps, etc.) stay exportable
      if (PROMOTED_SEMANTIC_TYPES.has(elem.semanticType) || elem.metadata?.convertedFromDuct) {
        elem.metadata.geometryExportable = true;
        elem.metadata.exportReason = 'promoted_to_visible_class';
        continue;
      }
      // Source-backed ducts/pipes with valid geometry
      if (isRenderableLinear) {
        elem.metadata.geometryExportable = true;
        elem.metadata.exportReason = 'promoted_visible_linear_demo';
        continue;
      }
      // Everything else in non-renderable classes: hide
      elem.metadata.geometryExportable = false;
      elem.metadata.exportReason = 'semantic_network_only';
      airwayHidden++;
      continue;
    } else {
      elem.metadata.geometryExportable = true;
    }
  }
  if (airwayHidden > 0) {
    console.log(`Exportability filter: ${airwayHidden} network-only elements marked non-exportable`);
  }

  // ---- Export detail policy ----
  // Only source-backed or explicitly requested MEP should export by default.
  // Auto-generated "helpful detail" systems (lights, cable trays, pipes, ducts)
  // are hidden unless detail mode is enabled.
  const exportDetail = css.metadata?.exportDetail || 'STRUCTURE_ONLY';
  let generatedHidden = 0;

  if (exportDetail === 'STRUCTURE_ONLY') {
    // Helper MEP types that are inferred/generated, not core structure
    const DETAIL_ONLY_TYPES = new Set([
      'IfcLightFixture', 'IfcCableCarrierSegment', 'IfcPipeSegment',
      'IfcDuctSegment', 'IfcFireSuppressionTerminal'
    ]);
    // Promoted types that should always remain visible (fans, pumps, etc.)
    const ALWAYS_VISIBLE = new Set([
      'IfcFan', 'IfcPump', 'IfcCompressor', 'IfcElectricGenerator',
      'IfcTransformer', 'IfcBoiler', 'IfcChiller', 'IfcTank', 'IfcValve'
    ]);

    for (const elem of css.elements) {
      if (!elem.metadata) elem.metadata = {};
      // Skip elements already marked non-exportable
      if (elem.metadata.geometryExportable === false) continue;
      // Skip structural elements, walls, doors — always visible
      if (['TUNNEL_SEGMENT', 'WALL', 'DOOR', 'WINDOW', 'SLAB'].includes(elem.type)) continue;
      // Skip always-visible promoted types
      if (ALWAYS_VISIBLE.has(elem.semanticType)) continue;

      // SHOW auto-generated continuous systems — they ARE the correct interior MEP
      // (crown ducts, pipes, cable trays, lights) with proper sizing and placement.
      if (elem.source === 'GENERATED' && elem.metadata.generatedBy === 'CONTINUOUS_SYSTEM') {
        continue; // keep exportable — interior equipment should be visible
      }
      // SHOW source-provided MEP — VentSim airway ducts/pipes are primary data,
      // not inferred detail. They need to reach generate for SweptDiskSolid treatment.
      if (elem.source === 'VSM' && (elem.type === 'DUCT' || elem.type === 'PIPE')) {
        continue;
      }
      // Hide inferred helper equipment (lights, cable trays, pipes, ducts)
      // that were auto-generated by the pipeline, not provided by source data.
      const MEP_CSS_TYPES = new Set(['EQUIPMENT', 'DUCT', 'PIPE', 'CABLE_TRAY']);
      if (DETAIL_ONLY_TYPES.has(elem.semanticType) && MEP_CSS_TYPES.has(elem.type)) {
        elem.metadata.geometryExportable = false;
        elem.metadata.exportReason = 'detail_mode_structure_only';
        generatedHidden++;
      }
    }
    if (generatedHidden > 0) {
      console.log(`Export detail (${exportDetail}): ${generatedHidden} detail elements hidden`);
    }
  }

  // ---- Universal host-envelope validation pass ----
  // Verify every hosted element's center lies within its host's interior bounds.
  // Re-project once if outside; mark non-exportable if still outside.
  let envelopeViolations = 0;
  let envelopeReprojections = 0;
  for (const elem of css.elements) {
    if (elem.type !== 'EQUIPMENT' && !['DUCT', 'PIPE', 'CABLE_TRAY'].includes((elem.type || '').toUpperCase())) continue;
    if (!elem.metadata?.parentSegment) continue;
    const seg = segIndex.get(elem.metadata.parentSegment);
    if (!seg) continue;
    const o = elem.placement?.origin;
    if (!o) continue;
    const margin = CLEARANCE_MARGINS[elem.semanticType] || CLEARANCE_MARGINS.DEFAULT;
    if (!isInsideEnvelope(o, seg, margin)) {
      envelopeViolations++;
      // Attempt re-projection to nearest valid zone
      const frac = elem.metadata.longitudinalFraction || 0.5;
      let reprojected = false;
      for (const altZone of Object.keys(TUNNEL_MOUNTING_ZONES)) {
        const pos = computeZonePosition(seg, altZone, frac);
        if (pos && isInsideEnvelope(pos, seg, margin)) {
          o.x = pos.x; o.y = pos.y; o.z = pos.z;
          if (!elem.metadata) elem.metadata = {};
          elem.metadata.envelopeReprojected = true;
          elem.metadata.reprojectedZone = altZone;
          envelopeReprojections++;
          reprojected = true;
          break;
        }
      }
      if (!reprojected) {
        if (!elem.metadata) elem.metadata = {};
        elem.metadata.exportReady = false;
        elem.metadata.envelopeViolation = true;
      }
    }
  }
  if (envelopeViolations > 0) {
    console.log(`Envelope validation: ${envelopeViolations} violations, ${envelopeReprojections} reprojected, ${envelopeViolations - envelopeReprojections} marked non-exportable`);
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.equipmentMounting = {
    mountingCorrections,
    roomPlacementCount,
    originGuardCorrections,
    envelopeClips,
    envelopeViolations,
    envelopeReprojections,
    generatedSystems: generatedSystemCount,
    generatedPads: generatedElements.filter(e => e.properties?.slabType === 'EQUIPMENT_PAD').length,
    segmentsIndexed: segIndex.size
  };
  console.log(`applyEquipmentMounting [TUNNEL]: ${mountingCorrections} corrections, ${roomPlacementCount} room placements, ${envelopeClips} envelope clips, ${generatedSystemCount} systems generated, ${generatedElements.length} total new elements`);
  console.log(`  parentMatch: host=${_matchByHost} container=${_matchByContainer} projection=${_matchByProjection} none=${_matchNone}`);
}


// ============================================================================
// BUILDING-DOMAIN EQUIPMENT MOUNTING (original storey-based logic)
// ============================================================================

function applyBuildingEquipmentMounting(css) {
  const WALL_MOUNTED = new Set(['IfcSensor', 'IfcAlarm', 'IfcActuator', 'IfcCommunicationsAppliance',
    'IfcElectricDistributionBoard', 'IfcFireSuppressionTerminal']);
  const CEILING_MOUNTED = new Set(['IfcLightFixture', 'IfcFan', 'IfcCableCarrierSegment']);
  const FLOOR_MOUNTED_B = new Set(['IfcPump', 'IfcTank', 'IfcTransformer', 'IfcBoiler', 'IfcChiller',
    'IfcCompressor', 'IfcElectricGenerator']);

  const storeyInfo = {};
  const levels = css.levelsOrSegments || [];
  for (let i = 0; i < levels.length; i++) {
    const elev = levels[i].elevation_m || 0;
    const height = levels[i].height_m || 3.0;
    storeyInfo[levels[i].id] = { elevation: elev, height };
  }

  let mountingCorrections = 0;
  let originGuardCorrections = 0;
  const STANDOFF = 0.05;

  for (const elem of css.elements) {
    if (elem.type !== 'EQUIPMENT') continue;
    const st = elem.semanticType || '';
    const o = elem.placement?.origin;
    if (!o) continue;

    // Origin guard
    if (Math.abs(o.x) < 0.001 && Math.abs(o.y) < 0.001 && Math.abs(o.z) < 0.001) {
      const bbox = css.metadata?.bbox;
      if (bbox) {
        if (!elem.metadata) elem.metadata = {};
        elem.metadata.originalPlacement = { ...o };
        elem.metadata.originError = true;
        elem.placement.origin = {
          x: (bbox.min.x + bbox.max.x) / 2,
          y: (bbox.min.y + bbox.max.y) / 2,
          z: bbox.min.z + 1.0
        };
        originGuardCorrections++;
      }
      continue;
    }

    let mountType = 'NONE';
    if (WALL_MOUNTED.has(st)) mountType = 'WALL';
    else if (CEILING_MOUNTED.has(st)) mountType = 'CEILING';
    else if (FLOOR_MOUNTED_B.has(st)) mountType = 'FLOOR';
    if (mountType === 'NONE') continue;

    if (!elem.metadata) elem.metadata = {};
    elem.metadata.originalPlacement = { ...o };
    const eqHeight = elem.geometry?.profile?.height || elem.geometry?.depth || 0.5;

    const container = elem.container || 'level-1';
    const si = storeyInfo[container] || { elevation: 0, height: 3.0 };

    if (mountType === 'FLOOR') {
      o.z = si.elevation + STANDOFF;
      mountingCorrections++;
    } else if (mountType === 'CEILING') {
      o.z = si.elevation + si.height - eqHeight - STANDOFF;
      mountingCorrections++;
    } else if (mountType === 'WALL') {
      o.z = si.elevation + Math.min(1.5, si.height * 0.5);
      mountingCorrections++;
    }

    elem.metadata.mountingType = mountType;
    elem.metadata._mountType = mountType; // universal geometry contract metadata
    elem.metadata.correctedBy = 'EQUIPMENT_MOUNTING';
    elem.metadata.correctionDelta = {
      dx: Math.round((o.x - elem.metadata.originalPlacement.x) * 100) / 100,
      dy: Math.round((o.y - elem.metadata.originalPlacement.y) * 100) / 100,
      dz: Math.round((o.z - elem.metadata.originalPlacement.z) * 100) / 100
    };
  }

  if (!css.metadata) css.metadata = {};
  css.metadata.equipmentMounting = { mountingCorrections, originGuardCorrections };
  console.log(`applyEquipmentMounting [BUILDING]: ${mountingCorrections} mounting corrections, ${originGuardCorrections} origin guard corrections`);
}

export { applyEquipmentMounting };
