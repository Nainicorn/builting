/**
 * Phase 11 — Structural Integration (Boolean Cuts)
 *
 * Runs AFTER Phase 9 (applyTunnelAnchoredLayout).  Phase 9 *positions* SPACEs,
 * doors, walls, and the shaft relative to the tunnel network.  Phase 11
 * *integrates* them by stamping geometry-cut descriptors so the generate
 * lambda performs real IfcOpeningElement / IfcRelVoidsElement boolean
 * subtractions.  No more adjacency — every SPACE, DOOR, and SHAFT must
 * physically intersect the tunnel hull and carve into it.
 *
 * The pass mutates `properties` only (no element creation) so it composes
 * cleanly with downstream passes.  Generate consumes:
 *
 *   - SPACE.properties.tunnelOpening    = { segmentId, center{x,y,z}, width,
 *                                            height, axis{x,y,z}, normal{x,y,z} }
 *   - DOOR.properties.doorCutApplied    = true            (verified intersection)
 *   - DOOR.properties.spatialFlag       = 'DOOR_REJECTED' (rejected — no
 *                                                          host-wall + tunnel/space
 *                                                          intersection found)
 *   - SHAFT.properties.shaftCutApplied  = true            (and shaftCut{ radius,
 *                                                          segmentId, ceilingZ })
 *   - SPACE.properties.spatialFlag      = 'NOT_INTEGRATED' (skip emit)
 *   - WALL.properties.spatialFlag       = 'WALL_INSIDE_TUNNEL' (skip emit)
 *
 * Validators land in css.metadata.structuralIntegration with success
 * conditions:
 *
 *   spacesIntersectTunnel  ≥ 4
 *   tunnelOpeningsCreated  ≥ 4
 *   doorCutsApplied        ≥ 4
 *   shaftCutsApplied       ≥ 1
 *   floatingSpaces         == 0
 *
 * Wired in index.mjs AFTER applyTunnelAnchoredLayout and BEFORE
 * classifyGeometryBehavior.
 */

import {
  vecAdd, vecSub, vecScale, vecDot, vecCross, vecNormalize, vecLen,
  canonicalWallDirection, canonicalWallLength, canonicalWallThickness,
} from './shared.mjs';

// ─── tunables (metres) ────────────────────────────────────────────────────
const OPENING_SCALE_W              = 0.8;     // §11.1 — width  ≤ 0.8 × tunnelWidth
const OPENING_SCALE_H              = 0.8;     // §11.1 — height ≤ 0.8 × tunnelHeight
const SPACE_TUNNEL_BBOX_PAD_M      = 0.1;     // tolerance when testing SPACE↔tunnel intersection
const SHAFT_PENETRATION_DEPTH_M    = 1.5;     // shaft cut extends 1.5 m below crown
const DEFAULT_OPENING_W_M          = 1.5;
const DEFAULT_OPENING_H_M          = 2.4;
const WALL_INSIDE_MARGIN_M         = 0.2;     // wall origin must be > radius - 0.2 m to be "inside"

// ──────────────────────────────────────────────────────────────────────────
// orchestrator
// ──────────────────────────────────────────────────────────────────────────

export function applyStructuralIntegration(css) {
  if (!css || !Array.isArray(css.elements)) return;
  if (!css.metadata) css.metadata = {};

  const report = {
    enabled: true,
    spacesIntersectTunnel: 0,
    tunnelOpeningsCreated: 0,
    doorCutsApplied: 0,
    doorCutsRejected: 0,
    shaftCutsApplied: 0,
    floatingSpaces: 0,
    interiorWallsRemoved: 0,
    // success criteria (booleans)
    spacesIntersectTunnelOk: false,
    tunnelOpeningsOk: false,
    doorCutsOk: false,
    shaftCutsOk: false,
    floatingSpacesOk: false,
  };
  css.metadata.structuralIntegration = report;

  const backbone = buildBackbone(css);
  if (!backbone || backbone.segments.length === 0) {
    console.log('applyStructuralIntegration: no tunnel network — skipping');
    return;
  }

  computeSpaceTunnelOpenings(css, backbone, report);
  enforceDoorIntegration(css, backbone, report);
  enforceShaftPenetration(css, backbone, report);
  pruneInteriorWalls(css, backbone, report);
  pruneNonIntegratedSpaces(css, report);
  runIntegrationValidators(report);

  console.log(
    `applyStructuralIntegration: spaces=${report.spacesIntersectTunnel} ` +
    `openings=${report.tunnelOpeningsCreated} ` +
    `doorCuts=${report.doorCutsApplied}(rejected=${report.doorCutsRejected}) ` +
    `shaftCuts=${report.shaftCutsApplied} ` +
    `floatingSpaces=${report.floatingSpaces} ` +
    `wallsRemoved=${report.interiorWallsRemoved}`
  );

  if (process.env.PHASE_11_HARD_FAIL === '1') {
    const fails = [];
    if (!report.spacesIntersectTunnelOk) fails.push(`spacesIntersectTunnel<4 (got ${report.spacesIntersectTunnel})`);
    if (!report.tunnelOpeningsOk)        fails.push(`tunnelOpeningsCreated<4 (got ${report.tunnelOpeningsCreated})`);
    if (!report.doorCutsOk)              fails.push(`doorCutsApplied<4 (got ${report.doorCutsApplied})`);
    if (!report.shaftCutsOk)             fails.push(`shaftCutsApplied<1 (got ${report.shaftCutsApplied})`);
    if (!report.floatingSpacesOk)        fails.push(`floatingSpaces!=0 (got ${report.floatingSpaces})`);
    if (fails.length) throw new Error(`Phase 11 hard-fail: ${fails.join(', ')}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Lightweight backbone (do not mutate Phase 9's report)
// ──────────────────────────────────────────────────────────────────────────

function buildBackbone(css) {
  const segs = (css.elements || []).filter(e =>
    (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT'
  );
  if (segs.length === 0) return null;

  const segByKey = new Map();
  const segData = [];
  for (const seg of segs) {
    const key = seg.element_key || seg.id;
    if (!key) continue;
    const ends = segmentEndpoints(seg);
    if (!ends) continue;
    const tangent = vecNormalize(vecSub(ends.end, ends.start));
    if (!tangent) continue;
    const lateral = computeLateral(tangent);
    const profile = seg.geometry?.profile || {};
    const length = vecLen(vecSub(ends.end, ends.start));
    const data = {
      key,
      elem: seg,
      start: ends.start,
      end:   ends.end,
      mid: { x: (ends.start.x + ends.end.x) / 2, y: (ends.start.y + ends.end.y) / 2, z: (ends.start.z + ends.end.z) / 2 },
      tangent, lateral,
      length,
      width: Number(profile.width)  || 4.0,
      height: Number(profile.height) || 4.0,
      thickness: Number(seg.properties?.shellThickness_m || profile.wallThickness) || 0.3,
    };
    segByKey.set(key, data);
    segData.push(data);
  }
  return { segments: segData, segmentByKey: segByKey };
}

function segmentEndpoints(seg) {
  const sp = seg.properties?.startPoint;
  const ep = seg.properties?.endPoint;
  if (sp && ep && [sp.x, sp.y, ep.x, ep.y].every(Number.isFinite)) {
    return {
      start: { x: +sp.x, y: +sp.y, z: +(sp.z ?? 0) },
      end:   { x: +ep.x, y: +ep.y, z: +(ep.z ?? 0) },
    };
  }
  const o = seg.placement?.origin;
  const ax = seg.placement?.axis ? vecNormalize(seg.placement.axis) : null;
  const d  = Number(seg.geometry?.depth) || 0;
  if (o && ax && d > 0) {
    return {
      start: vecAdd(o, vecScale(ax, -d / 2)),
      end:   vecAdd(o, vecScale(ax,  d / 2)),
    };
  }
  return null;
}

function computeLateral(tangent) {
  const up = { x: 0, y: 0, z: 1 };
  let lateral = vecNormalize(vecCross(tangent, up));
  if (!lateral) lateral = { x: 1, y: 0, z: 0 };
  return lateral;
}

// ──────────────────────────────────────────────────────────────────────────
// §11.1 — Tunnel openings for rooms
// ──────────────────────────────────────────────────────────────────────────

/**
 * For every SPACE with a Phase 9 attachedSegmentId we:
 *   1. Test intersection between SPACE bbox and tunnel segment volume
 *      (lateral half = width/2 + thickness, vertical half = height/2 + thickness).
 *   2. If intersecting, stamp `tunnelOpening` describing the void to subtract
 *      from the tunnel shell wall in generate.  Width/height are clamped to
 *      0.8× the tunnel dimensions so the cut never severs the bore.
 *   3. The opening center is the SPACE centroid projected onto the tunnel
 *      centerline, then offset along the lateral normal so the void sits on
 *      the SPACE↔tunnel interface plane.
 *
 * Spaces with no attached segment (Phase 9 attachmentType='UNATTACHED') are
 * skipped here and §11.4 will mark them spatialFlag='NOT_INTEGRATED'.
 */
export function computeSpaceTunnelOpenings(css, backbone, report) {
  const elements = css.elements || [];
  for (const space of elements) {
    if ((space.type || '').toUpperCase() !== 'SPACE') continue;
    const props = space.properties || {};
    const bbox  = props.bbox;
    const segId = props.attachedSegmentId;
    if (!bbox || !segId) continue;
    const seg = backbone.segmentByKey.get(segId);
    if (!seg) continue;

    if (!intersectsSegment(bbox, seg)) continue;

    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const cz = (bbox.minZ + bbox.maxZ) / 2;
    const center = { x: cx, y: cy, z: cz };

    // Project SPACE centroid onto the segment centerline (clamped to length).
    const v = vecSub(center, seg.start);
    const tProj = Math.max(0, Math.min(seg.length, vecDot(v, seg.tangent)));
    const onAxis = vecAdd(seg.start, vecScale(seg.tangent, tProj));

    // Offset along lateral by ±(width/2) so the opening sits on the bore wall
    // facing the SPACE.  Sign comes from Phase 9 attachedSide.
    const sign = (props.attachedSide === 'LATERAL_NEG') ? -1 : 1;
    const onWall = vecAdd(onAxis, vecScale(seg.lateral, sign * (seg.width / 2)));
    onWall.z = onAxis.z;  // anchor opening to the segment elevation

    // Opening extents: project SPACE bbox onto segment local frame.
    const bboxW = bbox.maxX - bbox.minX;
    const bboxD = bbox.maxY - bbox.minY;
    const bboxH = Math.max(bbox.maxZ - bbox.minZ, DEFAULT_OPENING_H_M);
    const spaceWAlongTangent = Math.abs(seg.tangent.x) * bboxW
                             + Math.abs(seg.tangent.y) * bboxD;
    const requestedW = spaceWAlongTangent > 0.5 ? spaceWAlongTangent : DEFAULT_OPENING_W_M;
    const openingW = Math.min(requestedW, seg.width  * OPENING_SCALE_W, seg.length * 0.95);
    const openingH = Math.min(bboxH,      seg.height * OPENING_SCALE_H);

    space.properties.tunnelOpening = {
      segmentId: segId,
      center: { x: +onWall.x, y: +onWall.y, z: +onWall.z },
      width:  +openingW.toFixed(3),
      height: +openingH.toFixed(3),
      axis:   { x: seg.tangent.x, y: seg.tangent.y, z: seg.tangent.z },
      normal: { x: seg.lateral.x * sign, y: seg.lateral.y * sign, z: 0 },
    };
    space.properties.intersectsTunnel = true;
    report.spacesIntersectTunnel++;
    report.tunnelOpeningsCreated++;
  }
}

/**
 * AABB-versus-tunnel-OBB intersection test.
 *
 * Treats the segment as an oriented bounding box (length × width × height)
 * around its centerline.  Tests by transforming the SPACE bbox center into
 * segment-local coords and comparing extents.  Returns true if any SPACE
 * volume sits within (lateralHalf + pad) and (verticalHalf + pad) of the
 * centerline AND within the segment length.
 */
function intersectsSegment(bbox, seg) {
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const cz = (bbox.minZ + bbox.maxZ) / 2;
  const center = { x: cx, y: cy, z: cz };
  const v = vecSub(center, seg.start);
  const tProj = vecDot(v, seg.tangent);
  if (tProj < -SPACE_TUNNEL_BBOX_PAD_M
      || tProj > seg.length + SPACE_TUNNEL_BBOX_PAD_M) return false;

  const tClamped = Math.max(0, Math.min(seg.length, tProj));
  const closest = vecAdd(seg.start, vecScale(seg.tangent, tClamped));
  const perp = vecSub(center, closest);
  const lat  = vecDot(perp, seg.lateral);
  const vert = perp.z;

  const halfW = (bbox.maxX - bbox.minX) / 2;
  const halfD = (bbox.maxY - bbox.minY) / 2;
  const halfH = (bbox.maxZ - bbox.minZ) / 2;
  const halfLat = Math.abs(seg.lateral.x) * halfW + Math.abs(seg.lateral.y) * halfD;

  const segOuterLat  = seg.width  / 2 + seg.thickness + SPACE_TUNNEL_BBOX_PAD_M;
  const segOuterVert = seg.height / 2 + seg.thickness + SPACE_TUNNEL_BBOX_PAD_M;

  return Math.abs(lat)  <= segOuterLat  + halfLat
      && Math.abs(vert) <= segOuterVert + halfH;
}

// ──────────────────────────────────────────────────────────────────────────
// §11.2 — Door true cut
// ──────────────────────────────────────────────────────────────────────────

/**
 * For every DOOR:
 *   - Verify a valid host wall is present (Phase 8/9 stamps hostWallKey).
 *   - Verify the door volume intersects either the tunnel shell (host wall is
 *     a tunnel-shell or enclosure-flush wall) OR a SPACE bbox.
 *   - On success: stamp doorCutApplied=true and (if not already stamped by
 *     Phase 9) alsoCutTunnel=true with tunnelCutSegmentId so generate emits
 *     the second IfcRelVoidsElement on the closest tunnel-shell wall.
 *   - On failure: stamp spatialFlag='DOOR_REJECTED' so generate skips emit.
 *
 * Doors that already passed Phase 9 doorEmbedding's flushTunnel/shellWall
 * branch will arrive with alsoCutTunnel=true → those count as applied.
 */
export function enforceDoorIntegration(css, backbone, report) {
  const elements = css.elements || [];

  const wallByKey = new Map();
  for (const w of elements) {
    if ((w.type || '').toUpperCase() !== 'WALL') continue;
    const k = w.element_key || w.id;
    if (k) wallByKey.set(k, w);
  }

  const spaces = [];
  for (const s of elements) {
    if ((s.type || '').toUpperCase() === 'SPACE' && s.properties?.bbox) {
      spaces.push(s);
    }
  }

  for (const door of elements) {
    if ((door.type || '').toUpperCase() !== 'DOOR') continue;
    const props = door.properties = door.properties || {};
    const o = door.placement?.origin;

    // Already Phase 9 rejected (DOOR_NO_HOST) — leave as-is, count rejection.
    if (props.spatialFlag === 'DOOR_NO_HOST') {
      report.doorCutsRejected++;
      props.spatialFlag = 'DOOR_REJECTED';
      continue;
    }

    const hostKey = props.hostWallKey;
    const wall = hostKey ? wallByKey.get(hostKey) : null;

    let intersectsTunnel = false;
    let tunnelSegId = null;
    if (wall) {
      const flushTunnel = wall.properties?.enclosureFlushWithTunnel === true;
      const isShell = wall.properties?.shellPiece === true
                   || wall.properties?.derivedFromBranch != null;
      tunnelSegId = wall.properties?.attachedSegmentId
                 || (props.tunnelCutSegmentId)
                 || null;
      if (flushTunnel || isShell) intersectsTunnel = true;
    }
    // Fallback: probe the door origin against every primary segment volume.
    if (!intersectsTunnel && o) {
      for (const seg of backbone.segments) {
        if (pointInSegmentVolume(o, seg, /*pad*/ 0.5)) {
          intersectsTunnel = true;
          tunnelSegId = tunnelSegId || seg.key;
          break;
        }
      }
    }

    let intersectsSpace = false;
    if (o) {
      for (const sp of spaces) {
        const b = sp.properties.bbox;
        if (o.x >= b.minX - 0.5 && o.x <= b.maxX + 0.5
         && o.y >= b.minY - 0.5 && o.y <= b.maxY + 0.5
         && o.z >= b.minZ - 0.5 && o.z <= b.maxZ + 0.5) {
          intersectsSpace = true;
          break;
        }
      }
    }

    if (!intersectsTunnel && !intersectsSpace) {
      props.spatialFlag = 'DOOR_REJECTED';
      report.doorCutsRejected++;
      continue;
    }

    // Door is inside a space or tunnel volume but has no host wall assigned.
    // Find the nearest enclosure wall in the same space and assign it so the
    // generate lambda has a concrete host to cut a void into.
    if (!wall && o) {
      let bestWall = null;
      let bestDist = Infinity;
      for (const [k, w] of wallByKey) {
        const wo = w.placement?.origin;
        if (!wo || !Number.isFinite(wo.x)) continue;
        const d = Math.hypot(wo.x - o.x, wo.y - o.y, wo.z - o.z);
        if (d < bestDist) { bestDist = d; bestWall = { key: k, wall: w }; }
      }
      if (bestWall && bestDist < 20.0) {
        props.hostWallKey = bestWall.key;
        if (!door.metadata) door.metadata = {};
        if (!door.metadata.intent) door.metadata.intent = {};
        door.metadata.intent.hostSegmentId = bestWall.key;
        door.metadata.intent.hostFallback = 'nearest_enclosure_wall';
      }
    }

    props.doorCutApplied = true;
    if (intersectsTunnel) {
      props.alsoCutTunnel = true;
      if (tunnelSegId) props.tunnelCutSegmentId = tunnelSegId;
    }
    report.doorCutsApplied++;
  }
}

function pointInSegmentVolume(p, seg, pad = 0) {
  const v = vecSub(p, seg.start);
  const tProj = vecDot(v, seg.tangent);
  if (tProj < -pad || tProj > seg.length + pad) return false;
  const tClamped = Math.max(0, Math.min(seg.length, tProj));
  const closest = vecAdd(seg.start, vecScale(seg.tangent, tClamped));
  const perp = vecSub(p, closest);
  const lat  = vecDot(perp, seg.lateral);
  const vert = perp.z;
  const halfLat  = seg.width  / 2 + seg.thickness + pad;
  const halfVert = seg.height / 2 + seg.thickness + pad;
  return Math.abs(lat) <= halfLat && Math.abs(vert) <= halfVert;
}

// ──────────────────────────────────────────────────────────────────────────
// §11.3 — Shaft penetration
// ──────────────────────────────────────────────────────────────────────────

/**
 * Phase 9 already snapped the shaft to a junction and extended it down to
 * the tunnel ceiling.  Phase 11 enforces the penetration: the shaft base
 * must sit ≤ -SHAFT_PENETRATION_DEPTH_M below the tunnel crown, and we
 * stamp a `shaftCut` descriptor with the cut cylinder geometry generate
 * needs.
 */
export function enforceShaftPenetration(css, backbone, report) {
  const elements = css.elements || [];
  const shaft = elements.find(e =>
    e.properties?.segmentType === 'VERTICAL_SHAFT' ||
    /vertical[-_ ]?shaft/i.test(e.name || '') ||
    /vertical[-_ ]?shaft/i.test(e.id || '') ||
    e.properties?.synthesizedBy === 'VERTICAL_SHAFT'
  );
  if (!shaft) return;
  const o = shaft.placement?.origin;
  if (!o) return;

  // Pick the closest tunnel segment in XY.
  let bestSeg = null, bestD = Infinity;
  for (const s of backbone.segments) {
    const dx = o.x - s.mid.x, dy = o.y - s.mid.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestD) { bestD = d; bestSeg = s; }
  }
  if (!bestSeg) return;

  const segCeilZ = bestSeg.mid.z + bestSeg.height / 2;
  // Force base to penetrate the crown by SHAFT_PENETRATION_DEPTH_M so the
  // boolean opening clears the shell thickness.
  const targetBaseZ = segCeilZ - SHAFT_PENETRATION_DEPTH_M;
  if (o.z > targetBaseZ) o.z = targetBaseZ;

  let depth = Number(shaft.geometry?.depth) || 0;
  if (depth < 1) depth = 8;
  shaft.geometry = shaft.geometry || {};
  shaft.geometry.depth = Math.max(depth, segCeilZ - o.z + 1.0);

  // Cylinder radius from existing profile, fallback 1.0 m.
  const prof = shaft.geometry.profile || {};
  let radius = Number(prof.radius);
  if (!Number.isFinite(radius) || radius <= 0) {
    const w = Number(prof.width), h = Number(prof.height);
    if (Number.isFinite(w) && w > 0) radius = w / 2;
    else if (Number.isFinite(h) && h > 0) radius = h / 2;
    else radius = 1.0;
  }

  shaft.properties = shaft.properties || {};
  shaft.properties.cutTunnelCeiling = true;
  shaft.properties.tunnelCeilingSegmentId = bestSeg.key;
  shaft.properties.shaftCutApplied = true;
  shaft.properties.shaftCut = {
    segmentId: bestSeg.key,
    radius:    +radius.toFixed(3),
    ceilingZ:  +segCeilZ.toFixed(3),
    baseZ:     +o.z.toFixed(3),
  };
  report.shaftCutsApplied++;
}

// ──────────────────────────────────────────────────────────────────────────
// §11.5 — Clean wall overlaps (interior tunnel walls)
// ──────────────────────────────────────────────────────────────────────────

/**
 * A WALL is removed (spatialFlag='WALL_INSIDE_TUNNEL') if its origin sits
 * inside any tunnel segment's outer volume AND the wall is not part of a
 * Phase 9 enclosure, not a tunnel shell piece, and not derived from a chain
 * branch.  The shell pieces are the tunnel walls themselves; enclosure walls
 * are the SPACE perimeters; chain-derived walls are part of the tunnel
 * topology — none of those should be removed here.
 */
export function pruneInteriorWalls(css, backbone, report) {
  const elements = css.elements || [];
  for (const w of elements) {
    if ((w.type || '').toUpperCase() !== 'WALL') continue;
    const props = w.properties || (w.properties = {});
    if (props.phase9Enclosure) continue;
    if (props.shellPiece)      continue;
    if (props.derivedFromBranch != null) continue;
    if (props.spatialFlag === 'WALL_INSIDE_TUNNEL') continue;
    const o = w.placement?.origin;
    if (!o) continue;

    // "Inside" means strictly inside (not just inside the outer shell).
    let inside = false;
    for (const seg of backbone.segments) {
      const v = vecSub(o, seg.start);
      const tProj = vecDot(v, seg.tangent);
      if (tProj < 0 || tProj > seg.length) continue;
      const closest = vecAdd(seg.start, vecScale(seg.tangent, tProj));
      const perp = vecSub(o, closest);
      const lat  = vecDot(perp, seg.lateral);
      const vert = perp.z;
      const innerLat  = Math.max(0, seg.width  / 2 - WALL_INSIDE_MARGIN_M);
      const innerVert = Math.max(0, seg.height / 2 - WALL_INSIDE_MARGIN_M);
      if (Math.abs(lat) < innerLat && Math.abs(vert) < innerVert) {
        inside = true;
        break;
      }
    }
    if (inside) {
      props.spatialFlag = 'WALL_INSIDE_TUNNEL';
      report.interiorWallsRemoved++;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §11.4 — Remove non-integrated SPACEs
// ──────────────────────────────────────────────────────────────────────────

/**
 * Any SPACE without §11.1's `tunnelOpening` descriptor is unintegrated —
 * Phase 9 either failed to attach it to the tunnel, or the bbox didn't
 * intersect the segment volume in §11.1.  Tag it spatialFlag='NOT_INTEGRATED'
 * so generate skips emit (no floating rooms).  Pre-existing 'FLOATING'
 * SPACE flags are upgraded to 'NOT_INTEGRATED' for the same emit-skip path.
 */
export function pruneNonIntegratedSpaces(css, report) {
  const elements = css.elements || [];
  for (const sp of elements) {
    if ((sp.type || '').toUpperCase() !== 'SPACE') continue;
    const props = sp.properties || (sp.properties = {});
    if (props.tunnelOpening) continue;  // §11.1 stamped — keep
    // Phase 11B: a SPACE-typed element that actually represents a shaft
    // (vertical-shaft, ceiling-cut applied, etc.) is integrated through the
    // shaft cut path, not through a tunnel-side opening.  Don't tag it
    // NOT_INTEGRATED — generate's semantic-shaft pickup loop needs to see
    // the element with no emit-skip flag so the ceiling cut can fire.
    if (props.shaftCutApplied
        || props.cutTunnelCeiling
        || props.synthesizedBy === 'VERTICAL_SHAFT'
        || props.segmentType === 'VERTICAL_SHAFT') {
      continue;
    }
    // Anything else is unintegrated.
    if (props.spatialFlag !== 'NOT_INTEGRATED') {
      props.spatialFlag = 'NOT_INTEGRATED';
    }
    report.floatingSpaces++;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §11.6 — Validators
// ──────────────────────────────────────────────────────────────────────────

function runIntegrationValidators(report) {
  report.spacesIntersectTunnelOk = report.spacesIntersectTunnel >= 4;
  report.tunnelOpeningsOk        = report.tunnelOpeningsCreated >= 4;
  report.doorCutsOk              = report.doorCutsApplied       >= 4;
  report.shaftCutsOk             = report.shaftCutsApplied      >= 1;
  report.floatingSpacesOk        = report.floatingSpaces        === 0;
}
