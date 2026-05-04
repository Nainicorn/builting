/**
 * Evidence Reconciliation Pass (evidence-reconciliation/v2)
 *
 * Reconciles raw extracted door/window candidates against authoritative
 * constraints before the engineer-intent resolver runs. Raw extraction
 * treats every candidate as truth; this pass applies a trust hierarchy:
 *
 *   Spec documents (authoritativeConstraints) > size signatures > DXF evidence
 *
 * For TUNNEL domain: zone-aware selection replaces flat top-N. Candidates are
 * grouped by spatial zone (PORTAL, ROOM_TERMINAL, ROOM_JUNCTION, INVALID) and
 * zone quotas are applied before any score-based ranking. This prevents the
 * flat sort from accepting a left-approach junction door over a valid right-room
 * terminal door when all candidates share the same evidence class and score.
 *
 * Zone classification (TUNNEL):
 *   PORTAL       — door within TUNNEL_PORTAL_ZONE_RADIUS_M of either main portal
 *                  (the 2 PORTAL_END_WALL elements farthest apart = main entrances)
 *   ROOM_TERMINAL — not portal; nearest tunnel segment endpoint is degree-1 (free end)
 *   ROOM_JUNCTION — not portal; nearest tunnel segment endpoint is degree ≥ 2
 *   INVALID       — no nearby tunnel geometry
 *
 * Zone quotas:
 *   PORTAL:       up to Type B expectedCount (double-door spec), sorted by
 *                 proximity to nearest main portal wall
 *   ROOM_TERMINAL: up to Type A expectedCount (single-door spec), sorted by score
 *   ROOM_JUNCTION: quota 0 — doors at junction endpoints are misplaced
 *   INVALID:      quota 0
 *
 * Outputs:
 *   - Accepted candidates: metadata.reconciliationStatus = 'accepted'
 *   - Rejected candidates: metadata.reconciliationStatus = 'rejected'
 *   - PORTAL zone accepted: metadata.evidenceZone = 'PORTAL' (consumed by intent-resolver)
 *   - css.metadata.evidenceReconciliation: full audit log (written to S3 separately)
 */

const RECONCILER_VERSION = 'evidence-reconciliation/v2';

// ── Tunnel zone constants ────────────────────────────────────────────────────

const TUNNEL_PORTAL_ZONE_RADIUS_M  = 8.0;  // door ≤ this from a main portal → PORTAL zone
const TUNNEL_ENDPOINT_SNAP_M       = 0.5;  // coordinate rounding for endpoint dedup
const TUNNEL_MAX_ENDPOINT_DIST_M   = 20.0; // door farther than this from any seg endpoint → INVALID

// ── Authoritative door type signatures per domain ───────────────────────────
const DOMAIN_DOOR_SIGNATURES = {
  TUNNEL: [
    {
      name: 'Interior Single (Type A)',
      nominalWidth:  0.810,
      nominalHeight: 2.110,
      tolerancePct:  0.15,
      expectedCount: 3,
      zone: 'ROOM'
    },
    {
      name: 'Double Flush Passage (Type B)',
      nominalWidth:  1.750,
      nominalHeight: 2.000,
      tolerancePct:  0.20,
      expectedCount: 2,
      zone: 'PORTAL'
    }
  ]
};

// ── Geometry helpers ─────────────────────────────────────────────────────────

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function getOrigin2D(element) {
  const o = (element.placement || {}).origin || {};
  const x = Number(o.x), y = Number(o.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

// ── Tunnel zone helpers ──────────────────────────────────────────────────────

/**
 * Find the 2 PORTAL_END_WALL elements that are farthest apart — these are the
 * main tunnel entrances (the portals at the two ends of the primary corridor).
 * Returns [{ element, origin2D }, { element, origin2D }] or null if <2 found.
 */
function findMainPortalPair(elements) {
  const portals = elements
    .filter(e =>
      (e.type || '').toUpperCase() === 'WALL' &&
      (e.properties || {}).segmentType === 'PORTAL_END_WALL'
    )
    .map(e => ({ element: e, o: getOrigin2D(e) }))
    .filter(p => p.o !== null);

  if (portals.length < 2) return null;

  let bestDist = -1, pA = null, pB = null;
  for (let i = 0; i < portals.length; i++) {
    for (let j = i + 1; j < portals.length; j++) {
      const d = dist2(portals[i].o.x, portals[i].o.y, portals[j].o.x, portals[j].o.y);
      if (d > bestDist) { bestDist = d; pA = portals[i]; pB = portals[j]; }
    }
  }
  return [pA, pB];
}

/**
 * Build a map from rounded endpoint coordinate → Set<segmentKey> for all
 * TUNNEL_SEGMENT start and end points. Used to determine whether an endpoint
 * is a free end (degree 1) or a junction (degree ≥ 2).
 */
function buildSegmentEndpointMap(elements) {
  const snap = v => Math.round(v / TUNNEL_ENDPOINT_SNAP_M) * TUNNEL_ENDPOINT_SNAP_M;
  const map = new Map();

  for (const e of elements) {
    if ((e.type || '').toUpperCase() !== 'TUNNEL_SEGMENT') continue;
    const key  = e.element_key || e.id;
    const props = e.properties || {};

    for (const field of ['startPoint', 'endPoint']) {
      const pt = props[field] || {};
      const px = Number(pt.x), py = Number(pt.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const k = `${snap(px)},${snap(py)}`;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(key);
    }
  }
  return map;
}

/**
 * Compute the centroid of the two main portal positions. Used for relative
 * direction labelling in the report.
 */
function portalCentroid(mainPortalPair) {
  if (!mainPortalPair) return null;
  const [pA, pB] = mainPortalPair;
  return { x: (pA.o.x + pB.o.x) / 2, y: (pA.o.y + pB.o.y) / 2 };
}

/**
 * Compute a human-readable compass label for a door position relative to
 * the tunnel centroid. Used only for the report's zoneLabel field.
 */
function compassLabel(doorX, doorY, centroid) {
  if (!centroid) return 'unknown';
  const dx = doorX - centroid.x, dy = doorY - centroid.y;
  const absDx = Math.abs(dx), absDy = Math.abs(dy);
  if (absDy > absDx) return dy > 0 ? 'back_room'   : 'south_spur';
  return                         dx > 0 ? 'east_approach' : 'west_approach';
}

/**
 * Classify a single door candidate into a tunnel spatial zone.
 *
 * Returns:
 *   { zone, distToMainPortal, distToNearestEndpoint,
 *     endpointIsFree, nearestSegKey, nearestEndpointXY }
 */
function classifyDoorZoneTunnel(door, mainPortalPair, elements, endpointMap) {
  const snap = v => Math.round(v / TUNNEL_ENDPOINT_SNAP_M) * TUNNEL_ENDPOINT_SNAP_M;
  const o = getOrigin2D(door);

  if (!o) {
    return {
      zone: 'INVALID', distToMainPortal: Infinity,
      distToNearestEndpoint: Infinity, endpointIsFree: false,
      nearestSegKey: null, nearestEndpointXY: null
    };
  }

  // ── Step 1: proximity to main portal walls ───────────────────────────────
  let distToMainPortal = Infinity;
  let nearestMainPortalKey = null;
  if (mainPortalPair) {
    const [pA, pB] = mainPortalPair;
    const dA = dist2(o.x, o.y, pA.o.x, pA.o.y);
    const dB = dist2(o.x, o.y, pB.o.x, pB.o.y);
    if (dA < dB) {
      distToMainPortal = dA;
      nearestMainPortalKey = pA.element.element_key || pA.element.id;
    } else {
      distToMainPortal = dB;
      nearestMainPortalKey = pB.element.element_key || pB.element.id;
    }
  }

  if (distToMainPortal <= TUNNEL_PORTAL_ZONE_RADIUS_M) {
    return {
      zone: 'PORTAL', distToMainPortal,
      nearestMainPortalKey,
      distToNearestEndpoint: Infinity, endpointIsFree: false,
      nearestSegKey: null, nearestEndpointXY: null
    };
  }

  // ── Step 2: find nearest tunnel segment endpoint ─────────────────────────
  const tunnelSegs = elements.filter(e => (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT');
  let bestDist = Infinity, bestPt = null, bestSegKey = null;

  for (const seg of tunnelSegs) {
    const segKey = seg.element_key || seg.id;
    const props  = seg.properties || {};
    for (const field of ['startPoint', 'endPoint']) {
      const pt = props[field] || {};
      const px = Number(pt.x), py = Number(pt.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const d = dist2(o.x, o.y, px, py);
      if (d < bestDist) { bestDist = d; bestPt = { x: px, y: py }; bestSegKey = segKey; }
    }
  }

  if (!bestPt || bestDist > TUNNEL_MAX_ENDPOINT_DIST_M) {
    return {
      zone: 'INVALID', distToMainPortal,
      distToNearestEndpoint: bestDist, endpointIsFree: false,
      nearestSegKey: bestSegKey, nearestEndpointXY: bestPt
    };
  }

  // ── Step 3: is the nearest endpoint a free end or a junction? ────────────
  const epKey = `${snap(bestPt.x)},${snap(bestPt.y)}`;
  const segsAtEndpoint = endpointMap.get(epKey);
  const degree = segsAtEndpoint ? segsAtEndpoint.size : 0;
  const endpointIsFree = degree <= 1;
  const zone = endpointIsFree ? 'ROOM_TERMINAL' : 'ROOM_JUNCTION';

  return {
    zone, distToMainPortal,
    nearestMainPortalKey: null,
    distToNearestEndpoint: bestDist, endpointIsFree,
    nearestSegKey: bestSegKey, nearestEndpointXY: bestPt,
    endpointDegree: degree
  };
}

/**
 * Zone-aware reconciliation for TUNNEL domain.
 *
 * Applies per-zone quotas instead of a flat top-N sort:
 *   PORTAL zone       → up to portalQuota (Type B count), sorted by distToMainPortal
 *   ROOM_TERMINAL zone → up to roomQuota (Type A count), sorted by score desc
 *   ROOM_JUNCTION/INVALID → quota 0, always rejected
 *
 * Mutates element metadata (reconciliationStatus, evidenceZone) and returns a
 * zone-annotated candidate list plus a zone summary for the report.
 */
function zoneAwareReconcileTunnel(candidates, signatures, expectedTotalCount, elements) {
  const mainPortalPair = findMainPortalPair(elements);
  const endpointMap    = buildSegmentEndpointMap(elements);
  const centroid       = portalCentroid(mainPortalPair);

  // Infer per-zone quotas from type signatures
  let portalQuota = 0, roomQuota = 0;
  for (const sig of signatures) {
    if (sig.zone === 'PORTAL') portalQuota += sig.expectedCount || 0;
    else                       roomQuota  += sig.expectedCount || 0;
  }
  // Fallback: if signatures lack zone field, split evenly or use total
  if (portalQuota === 0 && roomQuota === 0) {
    portalQuota = Math.floor(expectedTotalCount / 2);
    roomQuota   = expectedTotalCount - portalQuota;
  }

  // ── Classify every candidate by zone ─────────────────────────────────────
  for (const c of candidates) {
    const zInfo = classifyDoorZoneTunnel(c.door, mainPortalPair, elements, endpointMap);
    c.zoneInfo  = zInfo;
    c.zone      = zInfo.zone;
    c.doorX     = getOrigin2D(c.door)?.x ?? null;
    c.doorY     = getOrigin2D(c.door)?.y ?? null;
    c.zoneLabel = (() => {
      if (zInfo.zone === 'PORTAL') {
        const side = centroid && c.doorX !== null
          ? (c.doorX > centroid.x ? 'east' : 'west')
          : 'unknown';
        return `${side}_entrance_portal`;
      }
      return compassLabel(c.doorX ?? 0, c.doorY ?? 0, centroid);
    })();
  }

  // ── Split by zone ─────────────────────────────────────────────────────────
  const portalCands   = candidates.filter(c => c.zone === 'PORTAL');
  const terminalCands = candidates.filter(c => c.zone === 'ROOM_TERMINAL');
  const junctionCands = candidates.filter(c => c.zone === 'ROOM_JUNCTION');
  const invalidCands  = candidates.filter(c => c.zone === 'INVALID');

  // Sort PORTAL by proximity to nearest main portal wall (closest first)
  portalCands.sort((a, b) => a.zoneInfo.distToMainPortal - b.zoneInfo.distToMainPortal);

  // Sort ROOM_TERMINAL by score desc; break ties by proximity to nearest endpoint
  terminalCands.sort((a, b) => {
    const sd = b.score - a.score;
    if (Math.abs(sd) > 0.001 && Number.isFinite(b.score) && Number.isFinite(a.score)) return sd;
    return a.zoneInfo.distToNearestEndpoint - b.zoneInfo.distToNearestEndpoint;
  });

  // ── Apply quotas ──────────────────────────────────────────────────────────
  const acceptedPortal   = portalCands.slice(0, portalQuota);
  const rejectedPortal   = portalCands.slice(portalQuota);

  const remainingRoomQuota = Math.max(0, expectedTotalCount - acceptedPortal.length);
  const effectiveRoomQuota = Math.min(roomQuota, remainingRoomQuota);
  const acceptedTerminal   = terminalCands.slice(0, effectiveRoomQuota);
  const rejectedTerminal   = terminalCands.slice(effectiveRoomQuota);

  const accepted = [...acceptedPortal, ...acceptedTerminal];
  const rejected = [...rejectedPortal, ...rejectedTerminal, ...junctionCands, ...invalidCands];

  // ── Annotate elements ─────────────────────────────────────────────────────
  for (const c of accepted) {
    c.door.metadata = c.door.metadata || {};
    c.door.metadata.evidenceClass        = c.evidenceClass;
    c.door.metadata.evidenceMatchedType  = c.matchedTypeName;
    c.door.metadata.reconciliationStatus = 'accepted';
    c.door.metadata.evidenceZone         = c.zone === 'PORTAL' ? 'PORTAL' : 'ROOM';
    c.door.metadata.evidenceZoneLabel    = c.zoneLabel;
    c.acceptReason = c.zone === 'PORTAL'
      ? `portal_zone_accepted_rank_${portalCands.indexOf(c) + 1}_dist_${c.zoneInfo.distToMainPortal.toFixed(1)}m`
      : `room_terminal_accepted_rank_${terminalCands.indexOf(c) + 1}`;
  }

  for (const c of rejected) {
    c.door.metadata = c.door.metadata || {};
    c.door.metadata.evidenceClass        = c.evidenceClass;
    c.door.metadata.evidenceMatchedType  = c.matchedTypeName;
    c.door.metadata.reconciliationStatus = 'rejected';
    c.door.metadata.evidenceZone         = c.zone;
    c.door.metadata.evidenceZoneLabel    = c.zoneLabel;
    c.rejectReason = (() => {
      if (c.zone === 'PORTAL')        return `excess_portal_zone_capped_at_${portalQuota}`;
      if (c.zone === 'ROOM_TERMINAL') return `excess_room_terminal_capped_at_${effectiveRoomQuota}`;
      if (c.zone === 'ROOM_JUNCTION') return 'room_junction_quota_zero_misplaced_at_interior_junction';
      return 'invalid_no_nearby_tunnel_geometry';
    })();
    c.door.metadata.reconciliationReason = c.rejectReason;
  }

  // ── Build zone summary for report ─────────────────────────────────────────
  const zoneSummary = {
    PORTAL: {
      quota: portalQuota, candidates: portalCands.length,
      accepted: acceptedPortal.length, rejected: rejectedPortal.length,
      expectedZoneLabel: 'entrance_portal (double door)'
    },
    ROOM_TERMINAL: {
      quota: effectiveRoomQuota, candidates: terminalCands.length,
      accepted: acceptedTerminal.length, rejected: rejectedTerminal.length,
      expectedZoneLabel: 'room with free-end branch (single door)'
    },
    ROOM_JUNCTION: {
      quota: 0, candidates: junctionCands.length,
      accepted: 0, rejected: junctionCands.length,
      expectedZoneLabel: 'none — interior junction doors are misplaced'
    },
    INVALID: {
      quota: 0, candidates: invalidCands.length,
      accepted: 0, rejected: invalidCands.length,
      expectedZoneLabel: 'none — no valid tunnel geometry nearby'
    }
  };

  return { accepted, rejected, zoneSummary, portalQuota, roomQuota: effectiveRoomQuota };
}

// ── Dimension helpers ─────────────────────────────────────────────────────────

function dimensionOf(door) {
  const geom  = door.geometry  || {};
  const prof  = geom.profile   || {};
  const props = door.properties || {};

  const w = prof.width      ?? props.width_m      ?? props.nominalWidth  ?? geom.width  ?? null;
  const h = prof.height     ?? props.height_m     ?? props.nominalHeight ?? geom.height ??
            geom.depth      ?? null;

  return {
    w: w !== null ? Number(w) : null,
    h: h !== null ? Number(h) : null
  };
}

function matchDoorType(door, signatures) {
  const { w, h } = dimensionOf(door);
  let best = { matched: false, sig: null, sizeDelta: Infinity };

  for (const sig of signatures) {
    const tolW = sig.nominalWidth  * sig.tolerancePct;
    const tolH = sig.nominalHeight * sig.tolerancePct;

    const wOk = w === null || Math.abs(w - sig.nominalWidth)  <= tolW;
    const hOk = h === null || Math.abs(h - sig.nominalHeight) <= tolH;

    if ((w === null && h === null) || !wOk || !hOk) continue;

    const deltaW = w !== null ? Math.abs(w - sig.nominalWidth)  / sig.nominalWidth  : 0;
    const deltaH = h !== null ? Math.abs(h - sig.nominalHeight) / sig.nominalHeight : 0;
    const sizeDelta = deltaW + deltaH;

    if (sizeDelta < best.sizeDelta) {
      best = { matched: true, sig, sizeDelta };
    }
  }
  return best;
}

function classifyEvidence(door, signatures) {
  const props     = door.properties || {};
  const meta      = door.metadata   || {};
  const placement = door.placement  || {};
  const origin    = placement.origin || {};

  const hasValidPlacement =
    Number.isFinite(Number(origin.x)) &&
    Number.isFinite(Number(origin.y)) &&
    Number.isFinite(Number(origin.z));

  const srcStr = String(props.source || meta.source || '').toLowerCase();
  const isDxf  = srcStr.includes('dxf') ||
                 props._fromDxf === true ||
                 meta._fromDxf  === true;

  const hasContainer = !!(door.container || props.room || props.container || meta.room);

  const { matched: hasSpecMatch, sig: matchedSig, sizeDelta } = matchDoorType(door, signatures);

  const confidence = typeof door.confidence === 'number'
    ? Math.max(0, Math.min(1, door.confidence))
    : 0.5;

  let evidenceClass;
  if (hasSpecMatch && (isDxf || confidence >= 0.7) && hasValidPlacement) {
    evidenceClass = 'strong';
  } else if (hasSpecMatch || (hasContainer && hasValidPlacement)) {
    evidenceClass = 'medium';
  } else {
    evidenceClass = 'weak';
  }

  const classScore = evidenceClass === 'strong' ? 3 : evidenceClass === 'medium' ? 2 : 1;
  // Guard against Infinity sizeDelta producing -Infinity score (serialises as null in JSON)
  const sizePenalty = Number.isFinite(sizeDelta) ? sizeDelta * 0.3 : 0;
  const score = classScore
    + (hasValidPlacement ? 0.3 : 0)
    + confidence * 0.2
    - sizePenalty;

  return {
    evidenceClass,
    score,
    matchedTypeName: matchedSig?.name ?? null,
    isDxf,
    hasContainer,
    hasSpecMatch,
    hasValidPlacement,
    sizeDelta,
    confidence
  };
}

// ── Public entry ─────────────────────────────────────────────────────────────

export function reconcileElementEvidence(css) {
  const domain   = (css.domain || '').toUpperCase();
  const elements = css.elements || [];
  const isTunnel = domain === 'TUNNEL';

  const doorIndices = [];
  for (let i = 0; i < elements.length; i++) {
    const t = (elements[i].type || '').toUpperCase();
    if (t === 'DOOR' || t === 'WINDOW') doorIndices.push(i);
  }
  const rawCount = doorIndices.length;

  // ── Resolve authoritative constraints ─────────────────────────────────────
  const authMeta = css.metadata?.authoritativeConstraints?.doors;
  let expectedTotalCount = authMeta?.totalCount ?? null;
  let signatures = [];

  if (authMeta?.types?.length) {
    signatures = authMeta.types.map(t => ({
      name:          t.name,
      nominalWidth:  t.width      ?? t.nominalWidth,
      nominalHeight: t.height     ?? t.nominalHeight,
      tolerancePct:  t.tolerancePct ?? 0.15,
      expectedCount: t.count      ?? t.expectedCount ?? 1,
      zone:          t.zone       ?? null
    }));
  } else {
    signatures = DOMAIN_DOOR_SIGNATURES[domain] || [];
  }

  if (expectedTotalCount === null && signatures.length > 0) {
    expectedTotalCount = signatures.reduce((s, t) => s + (t.expectedCount || 0), 0);
  }

  // ── No constraints — pass through ─────────────────────────────────────────
  if (expectedTotalCount === null && signatures.length === 0) {
    css.metadata = css.metadata || {};
    css.metadata.evidenceReconciliation = {
      version:      RECONCILER_VERSION,
      domain,
      rawCount,
      expectedCount: null,
      acceptedCount: rawCount,
      rejectedCount: 0,
      countMatch:    null,
      note:          'no_authoritative_constraints',
      rawDoorCandidates: doorIndices.map(i => ({ id: elements[i].id || elements[i].element_key })),
      acceptedDoors:     doorIndices.map(i => ({ id: elements[i].id || elements[i].element_key })),
      rejectedDuplicateOrSymbolicDoors: []
    };
    console.log('EvidenceReconciler: no authoritative constraints — pass-through');
    return;
  }

  // ── Classify all candidates ────────────────────────────────────────────────
  const candidates = doorIndices.map(i => {
    const door = elements[i];
    const ev   = classifyEvidence(door, signatures);
    return { i, door, ...ev };
  });

  // ── Select accepted/rejected ───────────────────────────────────────────────
  let accepted, rejected, zoneSummary = null;

  if (isTunnel && signatures.some(s => s.zone)) {
    // Zone-aware selection for TUNNEL domain
    const zoneResult = zoneAwareReconcileTunnel(
      candidates, signatures, expectedTotalCount ?? rawCount, elements
    );
    accepted    = zoneResult.accepted;
    rejected    = zoneResult.rejected;
    zoneSummary = zoneResult.zoneSummary;
  } else {
    // Flat top-N selection (non-tunnel or no zone info in signatures)
    candidates.sort((a, b) => b.score - a.score);
    const acceptLimit = expectedTotalCount ?? rawCount;
    accepted = candidates.slice(0, acceptLimit);
    rejected = candidates.slice(acceptLimit);

    // Annotate accepted
    for (const c of accepted) {
      c.door.metadata = c.door.metadata || {};
      c.door.metadata.evidenceClass       = c.evidenceClass;
      c.door.metadata.evidenceMatchedType = c.matchedTypeName;
      c.door.metadata.reconciliationStatus = 'accepted';
    }
    // Annotate rejected
    for (const c of rejected) {
      c.door.metadata = c.door.metadata || {};
      c.door.metadata.evidenceClass        = c.evidenceClass;
      c.door.metadata.evidenceMatchedType  = c.matchedTypeName;
      c.door.metadata.reconciliationStatus = 'rejected';
      c.door.metadata.reconciliationReason = expectedTotalCount !== null
        ? `excess_candidate_count_capped_at_${expectedTotalCount}`
        : 'weak_evidence_no_spec_match';
    }
  }

  const countMatch = expectedTotalCount !== null
    ? accepted.length === expectedTotalCount
    : null;

  // ── Build audit log ────────────────────────────────────────────────────────
  css.metadata = css.metadata || {};
  css.metadata.evidenceReconciliation = {
    version:       RECONCILER_VERSION,
    domain,
    selectionMode: isTunnel && zoneSummary ? 'zone_aware_tunnel' : 'flat_top_n',
    rawCount,
    expectedCount: expectedTotalCount,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    countMatch,
    knownTypes: signatures.map(s => ({
      name:          s.name,
      nominalWidth:  s.nominalWidth,
      nominalHeight: s.nominalHeight,
      expectedCount: s.expectedCount,
      zone:          s.zone ?? null
    })),
    ...(zoneSummary ? { zoneSummary } : {}),
    rawDoorCandidates: candidates.map(c => ({
      id:               c.door.id || c.door.element_key,
      type:             c.door.type,
      evidenceClass:    c.evidenceClass,
      score:            Number.isFinite(c.score) ? Number(c.score.toFixed(3)) : null,
      matchedType:      c.matchedTypeName,
      isDxf:            c.isDxf,
      hasContainer:     c.hasContainer,
      hasSpecMatch:     c.hasSpecMatch,
      hasValidPlacement: c.hasValidPlacement,
      confidence:       c.confidence,
      width:            dimensionOf(c.door).w,
      height:           dimensionOf(c.door).h,
      ...(c.zone ? {
        zone:      c.zone,
        zoneLabel: c.zoneLabel,
        distToMainPortal:      Number.isFinite(c.zoneInfo?.distToMainPortal)      ? Number(c.zoneInfo.distToMainPortal.toFixed(2))      : null,
        distToNearestEndpoint: Number.isFinite(c.zoneInfo?.distToNearestEndpoint) ? Number(c.zoneInfo.distToNearestEndpoint.toFixed(2)) : null,
        endpointIsFree: c.zoneInfo?.endpointIsFree ?? null,
        nearestSegKey:  c.zoneInfo?.nearestSegKey  ?? null
      } : {})
    })),
    acceptedDoors: accepted.map(c => ({
      id:            c.door.id || c.door.element_key,
      evidenceClass: c.evidenceClass,
      matchedType:   c.matchedTypeName,
      score:         Number.isFinite(c.score) ? Number(c.score.toFixed(3)) : null,
      zone:          c.zone      ?? null,
      zoneLabel:     c.zoneLabel ?? null,
      acceptReason:  c.acceptReason ?? null
    })),
    rejectedDuplicateOrSymbolicDoors: rejected.map(c => ({
      id:            c.door.id || c.door.element_key,
      evidenceClass: c.evidenceClass,
      score:         Number.isFinite(c.score) ? Number(c.score.toFixed(3)) : null,
      zone:          c.zone      ?? null,
      zoneLabel:     c.zoneLabel ?? null,
      reason:        c.rejectReason ?? c.door.metadata?.reconciliationReason
    }))
  };

  console.log(
    `EvidenceReconciler: raw=${rawCount} expected=${expectedTotalCount} ` +
    `accepted=${accepted.length} rejected=${rejected.length} ` +
    `countMatch=${countMatch} mode=${isTunnel && zoneSummary ? 'zone_aware' : 'flat'}`
  );
  if (rejected.length > 0) {
    console.log(`EvidenceReconciler rejected: ${
      rejected.map(c => c.door.id || c.door.element_key).join(', ')
    }`);
  }
  if (zoneSummary) {
    for (const [zone, info] of Object.entries(zoneSummary)) {
      console.log(`EvidenceReconciler zone ${zone}: candidates=${info.candidates} accepted=${info.accepted} quota=${info.quota}`);
    }
  }
}
