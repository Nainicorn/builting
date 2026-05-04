/**
 * Phase 6A.5 — Acceptance Override (plan-driven reconciliation update)
 *
 * Runs AFTER classifySpacesAndPlanDoors. Reads spaceReport + doorPlan and
 * mutates each DOOR element's `metadata.reconciliationStatus` and
 * `metadata.intent.skipReason` so the IFC emitter sees a state consistent
 * with the architectural rules:
 *
 *   - PORTAL: accept only if intentHost ∈ mainPortalPair; reject otherwise
 *   - MAIN_TUNNEL accepts: reject (corridor segments don't host doors)
 *   - VERTICAL_SHAFT / UNKNOWN accepts: reject
 *   - Room zones (ROOM_TERMINAL / ROOM_INTERIOR): per-room rules are
 *     authoritative. Stability-first: don't demote currently-accepted
 *     doors; only promote rejected candidates when a room is under-filled.
 *
 * Emits unresolved_required_doors[] for unmet expectations:
 *   - missing_room_door — room has fewer accepted than expectedCount
 *   - unresolved_main_portal_door — mainPortalPair member with no accepted door
 *
 * Output: a structured report attached to css.metadata.evidenceReconciliation
 * .planDrivenOverride. Element mutations are limited to:
 *   - element.metadata.reconciliationStatus  ('accepted' | 'rejected')
 *   - element.metadata.intent.skipReason     (set when newly rejected /
 *                                             cleared when newly accepted)
 *   - element.metadata.acceptanceOverride    (per-door audit trail)
 *
 * No mutation of intent host, position, geometry, or any non-door element.
 */

import { resolveSingleDoorIntent } from './intent-resolver.mjs';

const OVERRIDE_VERSION = 'acceptance-override/v1';
const RESOLVER_VERSION = 'engineer-intent/v1';

function ensureMeta(elem) {
  if (!elem.metadata) elem.metadata = {};
  if (!elem.metadata.intent) elem.metadata.intent = {};
  return elem.metadata;
}

function setStatus(elem, status, reason) {
  const md = ensureMeta(elem);
  md.reconciliationStatus = status;
  md.acceptanceOverride = {
    version: OVERRIDE_VERSION,
    reason,
    appliedAt: new Date().toISOString()
  };
}

function setIntentSkip(elem, reason) {
  const md = ensureMeta(elem);
  md.intent.skipReason = reason;
}

function clearIntentSkip(elem) {
  const md = ensureMeta(elem);
  if (md.intent.skipReason) delete md.intent.skipReason;
}

// Mirror a resolver record onto an element's metadata.intent. Mirrors the
// same shape inferEngineerIntent writes in consume-doors mode.
function applyIntent(elem, rec) {
  const md = ensureMeta(elem);
  md.intent = {
    resolver:       RESOLVER_VERSION,
    hostSegmentId:  rec.hostSegmentId,
    hostWallType:   rec.hostWallType,
    hostFaceSide:   rec.hostFaceSide,
    position:       rec.position,
    confidence:     rec.confidence,
    reason:         rec.reason,
    skipReason:     rec.skipReason || null,
    doorType:       rec.doorType || null,
    evidence:       rec.evidence
  };
}

function intentConfidence(elem) {
  return ((elem.metadata || {}).intent || {}).confidence || 0;
}

function intentHostId(elem) {
  return ((elem.metadata || {}).intent || {}).hostSegmentId || null;
}

function isEmittable(elem) {
  const md = elem.metadata || {};
  if (md.reconciliationStatus !== 'accepted') return false;
  const intent = md.intent || {};
  if (intent.skipReason) return false;
  if (!intent.hostSegmentId) return false;
  return true;
}

/**
 * Apply plan-driven acceptance to css elements in place. Returns audit report.
 *
 * @param {Object} css         — CSS already annotated by classifier
 * @param {Object} spaceReport — output of classifySpacesAndPlanDoors
 * @param {Object} doorPlan    — output of classifySpacesAndPlanDoors
 */
export function applyPlanDrivenAcceptance(css, spaceReport, doorPlan) {
  const elements = (css && css.elements) || [];
  const doorElements = elements.filter(e => (e.type || '').toUpperCase() === 'DOOR');
  const elemById = new Map(doorElements.map(e => [e.element_key || e.id, e]));
  const candByID = new Map((doorPlan.candidateAssignments || []).map(c => [c.id, c]));

  const mainPortalIds = new Set((spaceReport.mainPortalPair || []).map(p => p.id));
  const perRoom       = doorPlan.perRoom || [];

  // Snapshot pre-override state for audit
  const preState = doorElements.map(d => ({
    id: d.element_key || d.id,
    status: (d.metadata || {}).reconciliationStatus || null,
    intentHost: intentHostId(d),
    intentSkipReason: ((d.metadata || {}).intent || {}).skipReason || null
  }));

  const decisions = [];     // per-door audit
  const unresolved = [];    // unmet rule expectations
  const portalReanchored = [];  // Fix 2 audit: portal-zone re-resolutions

  // ── Pass 0: re-anchor PORTAL-zone doors to mainPortalPair ───────────────────
  // Fix 2: the intent resolver runs before mainPortalPair is known, so a
  // portal-zone door (evidenceZone='PORTAL') can land on a non-main
  // PORTAL_END_WALL when that wall is fractionally closer in perpendicular
  // distance. Re-resolve such doors with mainPortalIds restriction so a non-
  // main portal wall can never win on a small distance advantage. We only
  // overwrite intent when a valid main-portal host is found; doors with no
  // main-portal in range fall through to Pass 1's existing reject path.
  if (mainPortalIds.size > 0) {
    for (const door of doorElements) {
      if ((door.metadata || {}).evidenceZone !== 'PORTAL') continue;
      const id = door.element_key || door.id;
      const oldHost = (door.metadata?.intent?.hostSegmentId) || null;
      if (oldHost && mainPortalIds.has(oldHost)) continue;  // already correct

      const rec = resolveSingleDoorIntent(door, css, { mainPortalIds });
      if (rec.hostSegmentId && mainPortalIds.has(rec.hostSegmentId)) {
        applyIntent(door, rec);
        portalReanchored.push({
          id,
          oldHost,
          newHost:    rec.hostSegmentId,
          confidence: rec.confidence,
          reason:     rec.reason
        });
        // Update candidateAssignments so Pass 1 sees the new host/zone.
        const c = candByID.get(id);
        if (c) {
          c.currentIntentHost = rec.hostSegmentId;
          c.assignedZone      = 'PORTAL';
        }
      }
    }
  }

  // ── Pass 1: zone-level rules (PORTAL, MAIN_TUNNEL, VERTICAL_SHAFT, UNKNOWN) ──
  for (const door of doorElements) {
    const id = door.element_key || door.id;
    const c  = candByID.get(id);
    if (!c) continue;
    const zone       = c.assignedZone;
    const intentHost = c.currentIntentHost;
    const oldStatus  = (door.metadata || {}).reconciliationStatus || null;
    let newStatus = oldStatus;
    let reason = null;

    if (zone === 'PORTAL') {
      if (intentHost && mainPortalIds.has(intentHost)) {
        newStatus = 'accepted';
        reason = 'portal_door_on_main_portal';
      } else {
        newStatus = 'rejected';
        reason = 'portal_zone_but_not_on_main_portal';
      }
    } else if (zone === 'MAIN_TUNNEL') {
      newStatus = 'rejected';
      reason = 'accepted_on_MAIN_TUNNEL_not_true_portal';
    } else if (zone === 'VERTICAL_SHAFT') {
      newStatus = 'rejected';
      reason = 'accepted_on_VERTICAL_SHAFT';
    } else if (zone === 'UNKNOWN') {
      newStatus = 'rejected';
      reason = 'accepted_on_UNKNOWN_zone';
    } else {
      // Room zones — defer to pass 2
      continue;
    }

    if (newStatus !== oldStatus) {
      setStatus(door, newStatus, reason);
      if (newStatus === 'rejected' && oldStatus === 'accepted') {
        setIntentSkip(door, `plan_override:${reason}`);
      } else if (newStatus === 'accepted' && oldStatus === 'rejected') {
        clearIntentSkip(door);
      }
      decisions.push({ id, oldStatus, newStatus, zone, intentHost, reason });
    }
  }

  // ── Pass 2: per-room quota enforcement (stability-first) ─────────────────────
  for (const room of perRoom) {
    const expected = room.expectedCount;
    const ids = ((doorPlan.byRoom || {})[room.roomId] || {}).candidateIds || [];
    const inRoom = ids.map(id => elemById.get(id)).filter(Boolean);

    // Currently-accepted doors in this room (after pass 1) — keep these
    const accepted = inRoom.filter(d => (d.metadata || {}).reconciliationStatus === 'accepted');
    let acceptedCount = accepted.length;

    if (acceptedCount > expected) {
      // De-accept excess (lowest confidence first)
      const sorted = [...accepted].sort((a, b) => intentConfidence(a) - intentConfidence(b));
      const toDemote = sorted.slice(0, acceptedCount - expected);
      for (const door of toDemote) {
        const id = door.element_key || door.id;
        setStatus(door, 'rejected', `per_room_quota_exceeded(${room.roomId},expected=${expected})`);
        setIntentSkip(door, `plan_override:per_room_quota_exceeded`);
        decisions.push({
          id, oldStatus: 'accepted', newStatus: 'rejected',
          zone: 'ROOM', roomId: room.roomId,
          reason: `per_room_quota_exceeded(${room.roomId},expected=${expected})`
        });
        acceptedCount--;
      }
    } else if (acceptedCount < expected) {
      // Promote rejected candidates (highest confidence first; tie-break: any
      // valid host > no host so the emitter can place them)
      const eligible = inRoom.filter(d => (d.metadata || {}).reconciliationStatus !== 'accepted');
      eligible.sort((a, b) => {
        const ha = intentHostId(a) ? 1 : 0;
        const hb = intentHostId(b) ? 1 : 0;
        if (hb !== ha) return hb - ha;
        return intentConfidence(b) - intentConfidence(a);
      });
      const slotsToFill = expected - acceptedCount;
      const toPromote = eligible.slice(0, slotsToFill);
      for (const door of toPromote) {
        const id = door.element_key || door.id;
        const reason = `per_room_promote(${room.roomId},slot=${acceptedCount + 1}/${expected})`;
        setStatus(door, 'accepted', reason);
        clearIntentSkip(door);

        // Fix 1: a previously reconciler-rejected door's intent record is a
        // stub with hostSegmentId=null (set by resolveDoorIntent's
        // reconciler-rejected short-circuit). Now that the override has
        // promoted it, re-resolve intent so the resolver can pick a real
        // host. Without this, _inferOpeningsFromIntent skips the door for
        // having no hostSegmentId and the emitter sees an accepted-but-no-
        // host record.
        const rec = resolveSingleDoorIntent(door, css);
        applyIntent(door, rec);

        decisions.push({
          id, oldStatus: 'rejected', newStatus: 'accepted',
          zone: 'ROOM', roomId: room.roomId,
          reason,
          hasIntentHost: !!rec.hostSegmentId,
          intentReason:  rec.reason
        });
        acceptedCount++;
      }
      // Track missing slots
      const missing = expected - acceptedCount;
      if (missing > 0) {
        unresolved.push({
          kind:          'missing_room_door',
          roomId:        room.roomId,
          slotsExpected: expected,
          slotsFilled:   acceptedCount,
          slotsMissing:  missing,
          reasonCode:    'source_data_absent',
          reason:        `room ${room.roomId} expects ${expected} door(s); only ${acceptedCount} accepted; ${missing} unresolved (source_data_absent — no extracted candidate to promote)`
        });
      }
    }
  }

  // ── Pass 3: unresolved main-portal door requirements ────────────────────────
  if (mainPortalIds.size > 0) {
    const portalAcceptedHosts = new Set();
    for (const door of doorElements) {
      const md = door.metadata || {};
      if (md.reconciliationStatus !== 'accepted') continue;
      const id = door.element_key || door.id;
      const c  = candByID.get(id);
      if (!c) continue;
      if (c.assignedZone === 'PORTAL' && c.currentIntentHost) {
        portalAcceptedHosts.add(c.currentIntentHost);
      }
    }
    for (const portalId of mainPortalIds) {
      if (!portalAcceptedHosts.has(portalId)) {
        unresolved.push({
          kind:    'unresolved_main_portal_door',
          portalId,
          reason:  `no accepted door hosted on main portal ${portalId}`
        });
      }
    }
  }

  // ── Pass 4: post-state summary ──────────────────────────────────────────────
  const acceptedIds = [];
  const rejectedIds = [];
  const emittableIds = [];        // accepted ∧ has host ∧ no skipReason
  const acceptedNoHostIds = [];   // accepted but emitter will skip (missing intent)
  for (const door of doorElements) {
    const id = door.element_key || door.id;
    const status = (door.metadata || {}).reconciliationStatus;
    if (status === 'accepted') {
      acceptedIds.push(id);
      if (isEmittable(door)) emittableIds.push(id);
      else acceptedNoHostIds.push(id);
    } else if (status === 'rejected') {
      rejectedIds.push(id);
    }
  }

  // Cross-link unresolved → element ids that are accepted-but-not-emittable
  // (so a room with d1a promoted but no host is traced)
  const acceptedNoHostByRoom = {};
  for (const door of doorElements) {
    if (!isEmittable(door) && (door.metadata || {}).reconciliationStatus === 'accepted') {
      const id = door.element_key || door.id;
      const c  = candByID.get(id);
      const rid = c?.assignedRoom;
      if (rid) {
        if (!acceptedNoHostByRoom[rid]) acceptedNoHostByRoom[rid] = [];
        acceptedNoHostByRoom[rid].push(id);
      }
    }
  }

  return {
    override:  OVERRIDE_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      preAccepted:  preState.filter(s => s.status === 'accepted').length,
      preRejected:  preState.filter(s => s.status === 'rejected').length,
      postAccepted: acceptedIds.length,
      postRejected: rejectedIds.length,
      postEmittable: emittableIds.length,
      postAcceptedNoHost: acceptedNoHostIds.length,
      decisions: decisions.length,
      unresolved: unresolved.length,
      portalReanchored: portalReanchored.length
    },
    mainPortalIds: [...mainPortalIds],
    acceptedIds,
    rejectedIds,
    emittableIds,
    acceptedNoHostIds,
    acceptedNoHostByRoom,
    unresolved_required_doors: unresolved,
    portalReanchored,
    decisions
  };
}
