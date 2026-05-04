/**
 * Phase 6B — Wall and Portal Structure Reconstruction
 *
 * v2 (2026-04-27): geometry correctness pass.
 *   * Walls now exactly cap the tunnel opening (bore_w × bore_h), no margin.
 *   * Origin anchored at the bore FLOOR (centerlineZ − bore_h / 2), not the
 *     segment centerline — wall extrudes upward from the floor.
 *   * XY anchor prefers the snapped node coordinate from
 *     spaceReport.nodeGraph; falls back to raw segment endpoint XY.
 *   * Wall thickness defaults to the host segment's shell_t (no longer a
 *     fixed 0.3m default), so the new wall matches the tunnel shell it caps.
 *   * Adds expectedPlanePoint per plan so generation can validate that the
 *     emitted centroid lies on the expected portal / branch plane.
 *
 * v3 (Phase 6B.2 — 2026-04-27): arched wall profile.
 *   * Plans now emit a 2D outer profile that follows the host segment's
 *     arched cross-section (flat floor + vertical sidewalls + semicircular
 *     top), matching the tunnel shell convention used by
 *     clean_tunnel_export._make_arched_hollow_profile.
 *   * profileType ('ARCH' | 'RECTANGLE') tells generate which body to emit.
 *
 * v4 (Phase 6B.3 — 2026-04-28): full wall coverage + correctness.
 *   * THREE wall categories now emitted (was 2):
 *       - PORTAL_WALL          — both mainPortalPair entries, force-emitted
 *       - JUNCTION_WALL        — every node where ROOM segment meets a
 *                                non-room neighbor (corridor/portal/other room)
 *       - TERMINAL_WALL        — every degree-1 endpoint of a ROOM segment
 *   * Anchor is ALWAYS the nodeGraph snapped node — raw segment endpoints
 *     are only used when the node lookup is empty (fail-safe diagnostic).
 *   * Wall normal (thicknessAxis) is locked to the segment axial direction;
 *     lateralAxis is locked to its 90° CCW rotation. Validated per-wall:
 *     |dot(thicknessAxis, segDir)| > 0.99  AND  |dot(lateralAxis, segDir)| < 0.01.
 *   * Arch profile is REQUIRED for tunnel walls — if the bore can't host an
 *     arch (sidewall too short or shell_t too thick), reconstructWalls
 *     throws. Rectangle fallback removed.
 *   * Hard-fail validation: total emitted walls must equal expected count
 *     (= portals + junctions + terminals). Mismatch → throw.
 *
 * Output is written into ``css.metadata.wallReconstruction`` for the Python
 * generate lambda to consume. This module ONLY plans walls — it does not
 * mutate elements, doors, the reconciler, or intent metadata.
 */

const RECONSTRUCTOR_VERSION = '6B.3';

// Wall thickness clamps. Width and height come straight from the host
// segment's bore dimensions — the wall must exactly cap the cross-section.
const WALL_THICKNESS_DEFAULT_M = 0.30;
const WALL_THICKNESS_MIN_M     = 0.15;
const WALL_THICKNESS_MAX_M     = 0.60;

// Sanity floors so we don't emit tiny degenerate walls when CSS dimensions
// are missing.
const MIN_BORE_W = 1.0;
const MIN_BORE_H = 1.5;
const DEFAULT_BORE_W = 4.0;
const DEFAULT_BORE_H = 3.0;

const MIN_AXIS_LENGTH = 1e-6;

// Arch profile parameters — must match clean_tunnel_export.ARCH_*  so the
// wall outline is geometrically consistent with the surrounding tunnel
// shell.
const ARCH_SEGMENTS         = 16;
const ARCH_MIN_SIDEWALL_M   = 0.3;   // below: sidewall too short for clean arch
const ARCH_MAX_SHELL_RATIO  = 0.7;   // shell_t / inner_r threshold

// Phase 6B.3 — orthogonality tolerances for normal correctness.
const ORTHO_DOT_TOL  = 0.01;   // |dot(lateralAxis, segDir)| must be < this
const PARALLEL_DOT_MIN = 0.99; // |dot(thicknessAxis, segDir)| must be > this

// Zone labels copied from space-classifier.mjs (kept here so we don't have
// to import the whole classifier for a string compare).
const ROOM_ZONES = new Set(['ROOM_TERMINAL', 'ROOM_INTERIOR']);

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safePoint(p) {
  if (!p) return null;
  const x = safeNum(p.x), y = safeNum(p.y), z = safeNum(p.z);
  if (x === null || y === null) return null;
  return { x, y, z: (z === null ? 0 : z) };
}

function xyLen(dx, dy) { return Math.hypot(dx, dy); }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------------------------------------------------------------------------
// Profile + endpoint extraction
// ---------------------------------------------------------------------------

function extractSegmentProfile(elem) {
  const props = (elem && elem.properties) || {};
  const geom  = (elem && elem.geometry)   || {};
  const gp    = (geom && geom.profile)    || {};

  const inner_w = safeNum(gp.width)        || safeNum(props.innerWidth)
                || safeNum(props.bore_width) || safeNum(gp.innerWidth);
  const inner_h = safeNum(gp.height)        || safeNum(props.innerHeight)
                || safeNum(props.bore_height) || safeNum(gp.innerHeight);
  const shell_t = safeNum(gp.wallThickness) || safeNum(props.wallThickness)
                || safeNum(props.shell_thickness);

  return {
    boreW:  inner_w && inner_w >= MIN_BORE_W ? inner_w : DEFAULT_BORE_W,
    boreH:  inner_h && inner_h >= MIN_BORE_H ? inner_h : DEFAULT_BORE_H,
    shellT: shell_t && shell_t > 0 ? shell_t : null
  };
}

function segmentEndpoints(elem) {
  const props = (elem && elem.properties) || {};
  const start = safePoint(props.startPoint);
  const end   = safePoint(props.endPoint);
  if (!start || !end) return null;
  return { start, end };
}

// ---------------------------------------------------------------------------
// Lookups built from spaceReport
// ---------------------------------------------------------------------------

function buildNodeLookup(spaceReport) {
  const m = new Map();
  for (const n of (spaceReport.nodeGraph || [])) {
    m.set(n.id, { x: n.x, y: n.y, degree: n.degree, segKeys: n.segKeys || [] });
  }
  return m;
}

function buildElementLookup(elements) {
  const m = new Map();
  for (const e of elements) {
    const key = e.element_key || e.id;
    if (key) m.set(key, e);
  }
  return m;
}

function buildSegmentZoneLookup(spaceReport) {
  const m = new Map();
  for (const s of (spaceReport.segmentZones || [])) m.set(s.key, s);
  return m;
}

// Phase 6B.3 — STRICTLY snap the anchor to the nodeGraph node. Only fall back
// to the raw segment endpoint when there is no node id at all (which would
// indicate a bad spaceReport, not a normal case).
function resolveAnchorXY(nodeLookup, nodeId, fallback, anchorSourceOut) {
  if (nodeId) {
    const n = nodeLookup.get(nodeId);
    if (n && Number.isFinite(n.x) && Number.isFinite(n.y)) {
      if (anchorSourceOut) anchorSourceOut.value = 'snapped_node';
      return { x: n.x, y: n.y };
    }
  }
  if (anchorSourceOut) anchorSourceOut.value = 'segment_endpoint_fallback';
  return { x: fallback.x, y: fallback.y };
}

// ---------------------------------------------------------------------------
// Arch profile geometry — matches clean_tunnel_export._make_arched_hollow_profile
// ---------------------------------------------------------------------------

function archFitsBore(boreW, boreH, shellT) {
  const innerR = boreW / 2.0;
  const innerSidewallH = boreH - innerR;
  if (!(innerSidewallH >= ARCH_MIN_SIDEWALL_M)) return false;
  if (shellT && shellT > 0) {
    if (!(shellT < innerR * ARCH_MAX_SHELL_RATIO)) return false;
    if (!(shellT < innerSidewallH * 0.5))          return false;
  }
  return true;
}

function round2D(p) {
  return [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))];
}

// Outer arch outline of the wall face, expressed in the wall's face plane:
// X axis = lateral (sidewall to sidewall), Y axis = vertical (floor up).
// Floor at y=0, crown at y=boreH. CCW ordering (positive signed area).
function buildArchOuterPoints(boreW, boreH, segments) {
  const innerR     = boreW / 2.0;
  const sidewallH  = boreH - innerR;
  if (sidewallH < ARCH_MIN_SIDEWALL_M) return null;

  const pts = [];
  pts.push([-innerR, 0]);              // floor-left
  pts.push([ innerR, 0]);              // floor-right
  pts.push([ innerR, sidewallH]);      // right top of sidewall
  for (let k = 1; k < segments; k++) {
    const theta = Math.PI * k / segments;
    pts.push([innerR * Math.cos(theta), sidewallH + innerR * Math.sin(theta)]);
  }
  pts.push([-innerR, sidewallH]);      // left top of sidewall
  pts.push(pts[0].slice());            // close polyline
  return pts.map(round2D);
}

// Outer outline of the host tunnel SHELL at this plane (bore + 2·shell_t on
// each axis, same arched-shell convention). Used by generate to compute
// max_profile_deviation between the wall outline and the expected shell
// inner contour.
function buildExpectedTunnelOuterPoints(boreW, boreH, shellT, segments) {
  const innerR = boreW / 2.0;
  const sidewallHInner = boreH - innerR;
  if (sidewallHInner < ARCH_MIN_SIDEWALL_M) return null;

  const t      = (shellT && shellT > 0) ? shellT : 0;
  const outerR = innerR + t;
  const outerTotalH    = boreH + 2 * t;
  const outerFloorYRel = -t;
  const archCenterYRel = outerFloorYRel + outerTotalH - outerR;

  const pts = [];
  pts.push([-outerR, outerFloorYRel]);
  pts.push([ outerR, outerFloorYRel]);
  pts.push([ outerR, archCenterYRel]);
  for (let k = 1; k < segments; k++) {
    const theta = Math.PI * k / segments;
    pts.push([outerR * Math.cos(theta), archCenterYRel + outerR * Math.sin(theta)]);
  }
  pts.push([-outerR, archCenterYRel]);
  pts.push(pts[0].slice());
  return pts.map(round2D);
}

// ---------------------------------------------------------------------------
// Wall plan builder — shared by portal / junction / terminal walls
// ---------------------------------------------------------------------------

// Phase 6B.3 — derive lateralAxis from segmentDir directly (90° CCW rotation
// in XY). Builds wall plan ONLY when the bore can host an arch profile;
// throws otherwise so callers can fail loudly instead of silently degrading.
function buildWallPlan(kind, id, anchorXY, segCenterlineZ, prof, segmentDirXY,
                      outwardSign, hostSegmentKey, hostSegmentEnd, extras) {
  // segmentDirXY is the unit XY direction along the segment axis. The wall's
  // thicknessAxis (normal) points OUTWARD along the axis (away from segment
  // interior); lateralAxis spans the bore perpendicular to the axis.
  const sx = segmentDirXY.x, sy = segmentDirXY.y;

  // thicknessAxis = ±segDir (sign points outward from interior)
  const tx = sx * outwardSign;
  const ty = sy * outwardSign;

  // lateralAxis = perpendicular to segDir (90° CCW). Independent of outward
  // sign so the wall's "right-hand" face is consistent.
  const lx = -sy;
  const ly =  sx;

  // Phase 6B.3 — validate orthogonality. By construction these must hold;
  // any failure indicates upstream data corruption and we should bail loudly.
  const dotLatSeg   = lx * sx + ly * sy;             // expect ≈ 0
  const dotThickSeg = Math.abs(tx * sx + ty * sy);   // expect ≈ 1
  if (Math.abs(dotLatSeg) > ORTHO_DOT_TOL) {
    throw new Error(
      `[6B.3] ${kind} ${id}: lateralAxis not perpendicular to segDir ` +
      `(|dot|=${Math.abs(dotLatSeg).toFixed(4)}, tol=${ORTHO_DOT_TOL})`
    );
  }
  if (dotThickSeg < PARALLEL_DOT_MIN) {
    throw new Error(
      `[6B.3] ${kind} ${id}: thicknessAxis not parallel to segDir ` +
      `(|dot|=${dotThickSeg.toFixed(4)}, min=${PARALLEL_DOT_MIN})`
    );
  }

  // Wall thickness defaults to host shell thickness so the new wall matches
  // the surrounding tunnel shell mass.
  const thickness = clamp(
    prof.shellT || WALL_THICKNESS_DEFAULT_M,
    WALL_THICKNESS_MIN_M,
    WALL_THICKNESS_MAX_M
  );

  // Floor anchor: bore floor sits bore_h/2 below the segment centerline Z.
  const floorZ = segCenterlineZ - prof.boreH / 2.0;

  // Phase 6B.3 — REQUIRE arch profile for tunnel walls. No silent rectangle
  // fallback. If the bore can't host an arch, fail loudly so callers can
  // surface the upstream profile issue instead of emitting a flat plate.
  const archOk = archFitsBore(prof.boreW, prof.boreH, prof.shellT);
  if (!archOk) {
    throw new Error(
      `[6B.3] ${kind} ${id}: arch profile cannot fit bore ` +
      `(w=${prof.boreW.toFixed(3)} h=${prof.boreH.toFixed(3)} ` +
      `shellT=${prof.shellT == null ? 'null' : prof.shellT.toFixed(3)}). ` +
      `Rectangle fallback removed in Phase 6B.3 — fix the upstream profile.`
    );
  }

  const outerProfilePoints = buildArchOuterPoints(
    prof.boreW, prof.boreH, ARCH_SEGMENTS);
  const expectedTunnelProfilePoints = buildExpectedTunnelOuterPoints(
    prof.boreW, prof.boreH, prof.shellT, ARCH_SEGMENTS);

  return Object.assign({
    kind,
    id,
    hostSegmentKey,
    hostSegmentEnd,
    origin:        { x: anchorXY.x, y: anchorXY.y, z: Number(floorZ.toFixed(4)) },
    lateralAxis:   { x: Number(lx.toFixed(6)),    y: Number(ly.toFixed(6)),    z: 0 },
    thicknessAxis: { x: Number(tx.toFixed(6)),    y: Number(ty.toFixed(6)),    z: 0 },
    width:         Number(prof.boreW.toFixed(3)),
    height:        Number(prof.boreH.toFixed(3)),
    thickness:     Number(thickness.toFixed(3)),
    bore:          { w: prof.boreW, h: prof.boreH, shellT: prof.shellT || null },
    profileType:   'ARCH',
    archGeometry: {
      boreW:        Number(prof.boreW.toFixed(3)),
      boreH:        Number(prof.boreH.toFixed(3)),
      innerRadius:  Number((prof.boreW / 2.0).toFixed(3)),
      sidewallH:    Number((prof.boreH - prof.boreW / 2.0).toFixed(3)),
      shellT:       prof.shellT ? Number(prof.shellT.toFixed(3)) : null,
      segments:     ARCH_SEGMENTS
    },
    outerProfilePoints,
    expectedTunnelProfilePoints,
    expectedPlanePoint: {
      x: anchorXY.x,
      y: anchorXY.y,
      z: Number(segCenterlineZ.toFixed(4))
    },
    // Phase 6B.3 — debug payload so generate-side validation can confirm the
    // dot products were checked at plan time.
    orthogonality: {
      dotLateralSegDir:   Number(dotLatSeg.toFixed(6)),
      dotThicknessSegDir: Number((tx * sx + ty * sy).toFixed(6))
    }
  }, extras || {});
}

// Compute unit segment direction (start -> end). Returns null if degenerate.
function segmentUnitDir(eps) {
  const dx = eps.end.x - eps.start.x;
  const dy = eps.end.y - eps.start.y;
  const L  = xyLen(dx, dy);
  if (L < MIN_AXIS_LENGTH) return null;
  return { x: dx / L, y: dy / L, length: L };
}

// ---------------------------------------------------------------------------
// Portal walls — one per portal in mainPortalPair (force-emitted)
// ---------------------------------------------------------------------------

function planPortalWalls(elementsByKey, spaceReport, nodeLookup, diag) {
  const out = [];
  const portalDiag = spaceReport.mainPortalPair;
  diag.portalCandidatesRaw = Array.isArray(portalDiag) ? portalDiag.length : 0;
  if (!Array.isArray(portalDiag) || portalDiag.length === 0) return out;

  for (const portal of portalDiag) {
    if (!portal) continue;
    const segKey = portal.nearestSegmentKey;
    const segEnd = portal.nearestSegmentEnd;  // 'start' | 'end'
    if (!segKey || !segEnd) {
      diag.portalSkippedNoSegment = (diag.portalSkippedNoSegment || 0) + 1;
      continue;
    }
    const seg = elementsByKey.get(segKey);
    if (!seg) {
      diag.portalSkippedSegMissing = (diag.portalSkippedSegMissing || 0) + 1;
      continue;
    }
    const eps = segmentEndpoints(seg);
    if (!eps) {
      diag.portalSkippedNoEndpoints = (diag.portalSkippedNoEndpoints || 0) + 1;
      continue;
    }
    const segDir = segmentUnitDir(eps);
    if (!segDir) {
      diag.portalSkippedDegenerate = (diag.portalSkippedDegenerate || 0) + 1;
      continue;
    }

    // Outward at this end: 'start' → -segDir, 'end' → +segDir.
    const outwardSign = segEnd === 'start' ? -1 : +1;

    const segPt = segEnd === 'start' ? eps.start : eps.end;
    const anchorSrc = { value: null };
    const anchorXY  = resolveAnchorXY(
      nodeLookup, portal.nearestNodeId || null, segPt, anchorSrc);

    const prof = extractSegmentProfile(seg);
    const id   = `PortalWall_${portal.id || segKey}_${segEnd}`;

    out.push(buildWallPlan(
      'PORTAL_WALL', id, anchorXY, segPt.z, prof,
      { x: segDir.x, y: segDir.y },
      outwardSign,
      segKey, segEnd,
      {
        portalId:     portal.id || null,
        nodeId:       portal.nearestNodeId || null,
        anchorSource: anchorSrc.value,
        snapWithinMax: !!portal.snapWithinMax,
        reason:       'portal_force_emit'
      }
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Junction walls — at each (ROOM segment, junction-node) where a room
// segment meets a non-room neighbor (corridor or another room).
//
// Per Phase 6B.3:
//   - degree >= 2
//   - connects MAIN_TUNNEL ↔ ROOM branch (or ROOM ↔ ROOM at a different room)
//   - one wall per (room segment, junction endpoint) — seals each branch
// ---------------------------------------------------------------------------

function planJunctionWalls(elementsByKey, spaceReport, nodeLookup, diag) {
  const out  = [];
  const rooms = spaceReport.rooms || [];
  diag.junctionCandidatesRaw = 0;
  if (!rooms.length) return out;

  const segZoneByKey = buildSegmentZoneLookup(spaceReport);

  const roomSegSet = new Map();
  for (const r of rooms) roomSegSet.set(r.roomId, new Set(r.segmentKeys || []));

  const seen = new Set();  // (roomId, nodeId, segKey)

  for (const room of rooms) {
    const memberSet = roomSegSet.get(room.roomId);
    for (const segKey of (room.segmentKeys || [])) {
      const seg = elementsByKey.get(segKey);
      if (!seg) continue;
      const eps = segmentEndpoints(seg);
      if (!eps) continue;
      const segMeta = segZoneByKey.get(segKey);
      if (!segMeta) continue;
      const segDir = segmentUnitDir(eps);
      if (!segDir) continue;

      for (const endLabel of ['start', 'end']) {
        const nodeId = endLabel === 'start' ? segMeta.nodeA : segMeta.nodeB;
        if (!nodeId) continue;
        const node = nodeLookup.get(nodeId);
        if (!node) continue;

        diag.junctionCandidatesRaw += 1;

        // Junction filter: degree >= 2 AND at least one neighbor segment is
        // NOT in this room (corridor / portal / other room).
        if (!(node.degree >= 2)) {
          diag.junctionFilteredDegree = (diag.junctionFilteredDegree || 0) + 1;
          continue;
        }
        const others = (node.segKeys || []).filter(k => k !== segKey);
        if (others.length === 0) {
          // node is degree-1 in disguise (only this segment)
          diag.junctionFilteredNoNeighbor = (diag.junctionFilteredNoNeighbor || 0) + 1;
          continue;
        }
        const hasNonRoomNeighbor = others.some(k => !memberSet.has(k));
        if (!hasNonRoomNeighbor) {
          // All neighbors are part of the same room — interior to room, no
          // partition wall needed.
          diag.junctionFilteredInterior = (diag.junctionFilteredInterior || 0) + 1;
          continue;
        }

        const dedupeKey = `${room.roomId}|${nodeId}|${segKey}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // Outward direction = from room INTERIOR back toward CORRIDOR. The
        // room interior is at the "other end" of this segment from the
        // boundary node.
        //   segDir = unit(start -> end)
        //   if endLabel === 'start': boundary is at start, interior is at end.
        //                             outward = -segDir (pointing OUT of room).
        //   if endLabel === 'end'  : boundary is at end, interior is at start.
        //                             outward = +segDir.
        const outwardSign = endLabel === 'start' ? -1 : +1;

        const thisEnd = endLabel === 'start' ? eps.start : eps.end;
        const anchorSrc = { value: null };
        const anchorXY  = resolveAnchorXY(nodeLookup, nodeId, thisEnd, anchorSrc);

        const prof = extractSegmentProfile(seg);
        const id   = `JunctionWall_${room.roomId}_${nodeId}_${segKey}`;

        // Neighbor zone classification — record what this wall is sealing
        // FROM, useful for downstream debug.
        const neighborZones = new Set();
        for (const k of others) {
          const z = segZoneByKey.get(k)?.zone;
          if (z) neighborZones.add(z);
        }

        out.push(buildWallPlan(
          'JUNCTION_WALL', id, anchorXY, thisEnd.z, prof,
          { x: segDir.x, y: segDir.y },
          outwardSign,
          segKey, endLabel,
          {
            roomId:         room.roomId,
            junctionNodeId: nodeId,
            nodeDegree:     node.degree,
            neighborZones:  [...neighborZones],
            anchorSource:   anchorSrc.value
          }
        ));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terminal walls — at every degree-1 endpoint of a ROOM segment (room
// dead-end cap).
// ---------------------------------------------------------------------------

function planTerminalWalls(elementsByKey, spaceReport, nodeLookup, diag) {
  const out  = [];
  diag.terminalCandidatesRaw = 0;
  const segZones = spaceReport.segmentZones || [];
  if (!segZones.length) return out;

  const seen = new Set();

  for (const segMeta of segZones) {
    const zone = segMeta.zone;
    if (!ROOM_ZONES.has(zone)) continue;  // only room branches get terminals

    const seg = elementsByKey.get(segMeta.key);
    if (!seg) continue;
    const eps = segmentEndpoints(seg);
    if (!eps) continue;
    const segDir = segmentUnitDir(eps);
    if (!segDir) continue;

    for (const endLabel of ['start', 'end']) {
      const nodeId = endLabel === 'start' ? segMeta.nodeA : segMeta.nodeB;
      if (!nodeId) continue;
      const node = nodeLookup.get(nodeId);
      if (!node) continue;

      diag.terminalCandidatesRaw += 1;

      // endpointIsFree === true ⇔ degree === 1 (only this segment touches
      // the node). Degree >= 2 endpoints are handled by the junction-wall
      // pass.
      if (node.degree !== 1) {
        diag.terminalFilteredNotFree = (diag.terminalFilteredNotFree || 0) + 1;
        continue;
      }

      const dedupeKey = `${segMeta.key}|${nodeId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Outward direction = from interior toward the dead-end. Same sign
      // convention as junction walls: 'start' boundary => outward = -segDir.
      const outwardSign = endLabel === 'start' ? -1 : +1;

      const thisEnd = endLabel === 'start' ? eps.start : eps.end;
      const anchorSrc = { value: null };
      const anchorXY  = resolveAnchorXY(nodeLookup, nodeId, thisEnd, anchorSrc);

      const prof = extractSegmentProfile(seg);
      const id   = `TerminalWall_${nodeId}_${segMeta.key}_${endLabel}`;

      out.push(buildWallPlan(
        'TERMINAL_WALL', id, anchorXY, thisEnd.z, prof,
        { x: segDir.x, y: segDir.y },
        outwardSign,
        segMeta.key, endLabel,
        {
          terminalNodeId: nodeId,
          roomId:         segMeta.roomId || null,
          zone:           zone,
          anchorSource:   anchorSrc.value,
          endpointIsFree: true
        }
      ));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function reconstructWalls(css, spaceReport) {
  if (!css || !spaceReport) return null;
  const elements = (css && css.elements) || [];
  if (!elements.length) return null;

  const elementsByKey = buildElementLookup(elements);
  const nodeLookup    = buildNodeLookup(spaceReport);

  const diag = {
    portalCandidatesRaw:   0,
    junctionCandidatesRaw: 0,
    terminalCandidatesRaw: 0
  };

  const portalWalls    = planPortalWalls   (elementsByKey, spaceReport, nodeLookup, diag);
  const junctionWalls  = planJunctionWalls (elementsByKey, spaceReport, nodeLookup, diag);
  const terminalWalls  = planTerminalWalls (elementsByKey, spaceReport, nodeLookup, diag);

  const candidatesBeforeFilter =
    diag.portalCandidatesRaw + diag.junctionCandidatesRaw + diag.terminalCandidatesRaw;

  const totalEmitted = portalWalls.length + junctionWalls.length + terminalWalls.length;

  // Phase 6B.3 — REQUIRED debug logging.
  console.log(`[6B.3] candidates_before_filter=${candidatesBeforeFilter} ` +
              `(portals_raw=${diag.portalCandidatesRaw} ` +
              `junctions_raw=${diag.junctionCandidatesRaw} ` +
              `terminals_raw=${diag.terminalCandidatesRaw})`);
  console.log(`[6B.3] portalWalls=${portalWalls.length}`);
  console.log(`[6B.3] junctionWalls=${junctionWalls.length}`);
  console.log(`[6B.3] terminalWalls=${terminalWalls.length}`);
  console.log(`[6B.3] total_walls=${totalEmitted}`);

  // Expected count = portals (always 2 if mainPortalPair exists) + junctions
  // + terminals. We compute expected from the same node/zone topology so a
  // count mismatch points to a bug in this module rather than upstream.
  const expectedPortals = Array.isArray(spaceReport.mainPortalPair)
    ? spaceReport.mainPortalPair.filter(p => !!p).length
    : 0;

  // Expected counts apply the SAME filters as the emitters so we only fail
  // hard on logic bugs, not upstream data inconsistencies. Anything dropped
  // because of missing/degenerate upstream data is logged separately.
  const segZoneByKey = buildSegmentZoneLookup(spaceReport);
  const rooms        = spaceReport.rooms || [];
  const expectedJunctionKeys = new Set();
  let upstreamSkippedJunctions = 0;
  for (const r of rooms) {
    const member = new Set(r.segmentKeys || []);
    for (const segKey of (r.segmentKeys || [])) {
      const segMeta = segZoneByKey.get(segKey);
      if (!segMeta) continue;
      const seg = elementsByKey.get(segKey);
      const eps = seg ? segmentEndpoints(seg) : null;
      const segDir = eps ? segmentUnitDir(eps) : null;
      const segUsable = !!(seg && eps && segDir);
      for (const nid of [segMeta.nodeA, segMeta.nodeB]) {
        if (!nid) continue;
        const node = nodeLookup.get(nid);
        if (!node) continue;
        if (!(node.degree >= 2)) continue;
        const others = (node.segKeys || []).filter(k => k !== segKey);
        if (others.length === 0) continue;
        if (!others.some(k => !member.has(k))) continue;
        if (!segUsable) { upstreamSkippedJunctions += 1; continue; }
        expectedJunctionKeys.add(`${r.roomId}|${nid}|${segKey}`);
      }
    }
  }
  const expectedJunctions = expectedJunctionKeys.size;

  // Terminals: every degree-1 endpoint of a ROOM segment. Dedup matches
  // planTerminalWalls: (segKey, nodeId).
  const expectedTerminalKeys = new Set();
  let upstreamSkippedTerminals = 0;
  for (const segMeta of (spaceReport.segmentZones || [])) {
    if (!ROOM_ZONES.has(segMeta.zone)) continue;
    const seg = elementsByKey.get(segMeta.key);
    const eps = seg ? segmentEndpoints(seg) : null;
    const segDir = eps ? segmentUnitDir(eps) : null;
    const segUsable = !!(seg && eps && segDir);
    for (const nid of [segMeta.nodeA, segMeta.nodeB]) {
      if (!nid) continue;
      const node = nodeLookup.get(nid);
      if (!node) continue;
      if (node.degree !== 1) continue;
      if (!segUsable) { upstreamSkippedTerminals += 1; continue; }
      expectedTerminalKeys.add(`${segMeta.key}|${nid}`);
    }
  }
  const expectedTerminals = expectedTerminalKeys.size;

  if (upstreamSkippedJunctions > 0 || upstreamSkippedTerminals > 0) {
    console.warn(
      `[6B.3] upstream data inconsistency — segments referenced by ` +
      `spaceReport but missing from css.elements: ` +
      `junctions_skipped=${upstreamSkippedJunctions} ` +
      `terminals_skipped=${upstreamSkippedTerminals} ` +
      `(walls not emitted; not counted toward expected)`
    );
  }

  const expectedTotal = expectedPortals + expectedJunctions + expectedTerminals;
  console.log(`[6B.3] expected portals=${expectedPortals} ` +
              `junctions=${expectedJunctions} terminals=${expectedTerminals} ` +
              `total=${expectedTotal}`);

  if (totalEmitted < expectedTotal) {
    throw new Error(
      `[6B.3] wall under-generation: emitted=${totalEmitted} < expected=${expectedTotal} ` +
      `(portals: ${portalWalls.length}/${expectedPortals}, ` +
      `junctions: ${junctionWalls.length}/${expectedJunctions}, ` +
      `terminals: ${terminalWalls.length}/${expectedTerminals}). ` +
      `diag=${JSON.stringify(diag)}`
    );
  }

  // Combined room-partition list (used by structural_walls.py — junction +
  // terminal share the same emit path on the Python side).
  const roomPartitionWalls = [...junctionWalls, ...terminalWalls];

  const report = {
    reconstructor: RECONSTRUCTOR_VERSION,
    generatedAt:   new Date().toISOString(),
    config: {
      sizingRule:        'bore_w x bore_h, anchored at bore_floor (centerline_z - bore_h/2)',
      thicknessRangeM:   [WALL_THICKNESS_MIN_M, WALL_THICKNESS_MAX_M],
      thicknessDefaultM: WALL_THICKNESS_DEFAULT_M,
      anchorXYPolicy:    'snapped node (spaceReport.nodeGraph) — segment endpoint only as fail-safe',
      anchorZPolicy:     'segment_centerline_z - bore_h/2',
      profilePolicy:     'arched required — throws when bore cannot host an arch (no rectangle fallback)',
      archSegments:      ARCH_SEGMENTS,
      archMinSidewallM:  ARCH_MIN_SIDEWALL_M,
      archMaxShellRatio: ARCH_MAX_SHELL_RATIO,
      orthoDotTol:       ORTHO_DOT_TOL,
      parallelDotMin:    PARALLEL_DOT_MIN
    },
    summary: {
      portalWalls:        portalWalls.length,
      junctionWalls:      junctionWalls.length,
      terminalWalls:      terminalWalls.length,
      roomPartitionWalls: roomPartitionWalls.length,
      totalWalls:         totalEmitted,
      expectedTotal,
      candidatesBeforeFilter
    },
    candidatesBeforeFilter: diag,
    portalWalls,
    junctionWalls,
    terminalWalls,
    roomPartitionWalls
  };

  css.metadata = css.metadata || {};
  css.metadata.wallReconstruction = report;

  return report;
}

export const RECONSTRUCTOR_INFO = { version: RECONSTRUCTOR_VERSION };
