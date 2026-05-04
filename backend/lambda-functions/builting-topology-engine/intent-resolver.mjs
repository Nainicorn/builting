/**
 * Engineer-Intent Resolver (engineer-intent/v1)
 *
 * Reads imperfect extracted CSS data and decides what an engineer would have
 * meant — which branch is a room vs a connector, which wall hosts a door,
 * which ducts form one run. Output is the single source of truth for those
 * decisions; downstream consumers (inferOpenings in topology-engine, door/
 * duct emission in builting-generate) read intent and either place exactly
 * where instructed or skip silently. There is no per-element fallback.
 *
 * Phase 6A — report-only:
 *   - Resolver runs and emits engineer_intent_report.json.
 *   - It does NOT annotate element.metadata.intent. Pure observation pass
 *     used to validate decisions against current inferOpenings before any
 *     consumer is wired up.
 *   - Behavior of every other pass is unchanged.
 *
 * Later phases (6B–6D) flip the resolver into write mode, branching on
 * INTENT_RESOLVER_MODE (set in index.mjs from env, mirrored onto CSS metadata
 * so generate sees the same value). See PLAN.md / Phase 6 plan for the full
 * rollout.
 */

import { CONFIDENCE, INTENT_PROFILES } from './config.mjs';
import {
  projectPointToSegment, getWallHorizontalEndpoints, getOrigin,
  hasTunnelSegments, dist3
} from './building-envelope.mjs';

const RESOLVER_VERSION = 'engineer-intent/v1';

/**
 * Pick the intent profile for this CSS. Domain string drives the dispatch;
 * data-driven (TUNNEL_SEGMENT presence) overrides a missing/wrong domain string.
 */
function pickProfile(css) {
  const declared = (css.domain || '').toUpperCase();
  const dataDriven = hasTunnelSegments(css) ? 'TUNNEL' : declared || 'BUILDING';
  const name = INTENT_PROFILES[dataDriven] ? dataDriven : 'BUILDING';
  return { name, profile: INTENT_PROFILES[name] };
}

/**
 * Confidence bucket for summary counts.
 */
function bucket(confidence) {
  if (confidence >= CONFIDENCE.HIGH) return 'high';
  if (confidence >= CONFIDENCE.MEDIUM) return 'medium';
  return 'low';
}

// ── Door intent ─────────────────────────────────────────────────────────────

/**
 * Tunnel-domain door host scoring. Mirrors inferOpenings (tunnel branch) at
 * building-envelope.mjs:1541-1599 — same projection, same portal-priority
 * factor — so 6A's report agrees with what the legacy pass would do today.
 *
 * If the door carries metadata.evidenceZone === 'PORTAL' (set by the evidence
 * reconciler's zone-aware pass), only PORTAL_END_WALL elements are considered
 * as candidate hosts. This forces portal-zone doors onto the correct wall and
 * prevents them from being assigned to adjacent tunnel segment interiors.
 *
 * options.mainPortalIds (Set<string>): when provided AND the door is
 * portal-zone, the candidate pool is further restricted to walls whose
 * element_key/id is in this set. A non-main portal wall cannot win on a small
 * perpendicular-distance advantage — it isn't even considered. Used by
 * acceptance-override (Fix 2) once spaceReport.mainPortalPair is known.
 */
function resolveDoorIntentTunnel(door, css, profile, options = {}) {
  const o = getOrigin(door);

  // PORTAL zone doors (set by evidence-reconciler zone-aware pass) must be
  // hosted on a PORTAL_END_WALL. Restrict host candidates accordingly.
  const isPortalZone = door.metadata?.evidenceZone === 'PORTAL';
  const mainPortalIds = options.mainPortalIds;
  const restrictToMainPortal = isPortalZone
    && mainPortalIds && typeof mainPortalIds.has === 'function'
    && mainPortalIds.size > 0;

  const tunnelHosts = css.elements.filter(e => {
    const t = (e.type || '').toUpperCase();
    if (isPortalZone) {
      if (t !== 'WALL' || e.properties?.segmentType !== 'PORTAL_END_WALL') return false;
      if (restrictToMainPortal) {
        const id = e.element_key || e.id;
        return mainPortalIds.has(id);
      }
      return true;
    }
    if (t === 'TUNNEL_SEGMENT' && (e.properties?.branchClass || '').toUpperCase() === 'STRUCTURAL') return true;
    if (t === 'WALL' && e.properties?.segmentType === 'PORTAL_END_WALL') return true;
    return false;
  });

  const candidates = [];
  let best = null;

  for (const host of tunnelHosts) {
    const { start, end } = getWallHorizontalEndpoints(host);
    const proj = projectPointToSegment(o, start, end);
    if (proj.tClamped < 0 || proj.tClamped > 1) continue;
    if (proj.perpDist >= profile.door.perpDistMax) continue;

    const isPortal = host.properties?.segmentType === 'PORTAL_END_WALL';
    const effectiveDist = isPortal ? proj.perpDist * profile.door.portalPriorityFactor : proj.perpDist;
    const hostKey = host.element_key || host.id;
    candidates.push({ id: hostKey, perpDist: proj.perpDist, score: effectiveDist, isPortal });

    if (!best || effectiveDist < best.effectiveDist) {
      best = { host, hostKey, perpDist: proj.perpDist, effectiveDist, isPortal, closest: proj.closest };
    }
  }

  if (!best) {
    const noHostReason = isPortalZone
      ? (restrictToMainPortal ? 'no_main_portal_within_range' : 'no_valid_portal_wall_host')
      : 'no_valid_tunnel_host';
    return {
      id: door.id || door.element_key,
      hostSegmentId: null,
      hostWallType: null,
      hostFaceSide: 'N/A',
      position: null,
      confidence: 0,
      reason: noHostReason,
      skipReason: noHostReason,
      evidence: { candidates: [], rule: 'NEAREST_VALID_WALL' }
    };
  }

  // Snap door Z to tunnel floor like inferOpenings does (mirror only — 6A
  // does not mutate the element). See building-envelope.mjs:1582-1595.
  const hostZ = best.host.placement?.origin?.z ?? 0;
  const hostH = best.host.geometry?.profile?.height ?? 5;
  const shellT = best.host.properties?.shellThickness_m ?? 0.3;
  const floorZ = hostZ - hostH / 2 + shellT;
  const doorH = door.geometry?.profile?.height || door.geometry?.depth || 2.1;
  const resolvedZ = floorZ + doorH / 2;

  // Confidence: closer perp distance → higher confidence; clamp to [0,1].
  const confidence = Math.max(0, Math.min(1, 1 - best.perpDist / profile.door.perpDistMax));

  return {
    id: door.id || door.element_key,
    hostSegmentId: best.hostKey,
    hostWallType: best.isPortal ? 'PORTAL_END_WALL' : 'TUNNEL_SEGMENT',
    hostFaceSide: best.isPortal ? 'EXTERIOR' : 'INTERIOR',
    position: { x: best.closest[0], y: best.closest[1], z: resolvedZ },
    confidence,
    reason: best.isPortal ? 'portal_priority' : 'nearest_tunnel_segment',
    skipReason: confidence < CONFIDENCE.MEDIUM ? 'low_confidence' : null,
    // doorType is determined by evidenceZone only (set by evidence-reconciler).
    // Ignoring best.isPortal here prevents ROOM-zone doors that happen to snap
    // to the portal end wall of a side branch from being tagged as double doors.
    doorType: isPortalZone ? 'double' : 'single',
    evidence: {
      candidates: candidates.slice(0, 5),
      rule: best.isPortal ? 'PORTAL_PRIORITY' : 'NEAREST_VALID_WALL'
    }
  };
}

/**
 * Building-domain door host scoring. Lightweight mirror of the building
 * branch in inferOpenings — perpendicular-distance based, with a configurable
 * salvage threshold. The full _scoreOpeningAgainstWalls heuristic (orientation,
 * width-ratio, ambiguity) is kept inside inferOpenings for now; 6A emits a
 * close approximation so the ≥95% agreement check is meaningful.
 */
function resolveDoorIntentBuilding(door, css, profile, _options = {}) {
  const o = getOrigin(door);
  const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');

  const candidates = [];
  let best = null;
  for (const wall of walls) {
    const { start, end } = getWallHorizontalEndpoints(wall);
    const proj = projectPointToSegment(o, start, end);
    if (proj.tClamped < 0 || proj.tClamped > 1) continue;
    if (proj.perpDist >= profile.door.salvagePerpMax) continue;

    const wallKey = wall.element_key || wall.id;
    candidates.push({ id: wallKey, perpDist: proj.perpDist, score: proj.perpDist });

    if (!best || proj.perpDist < best.perpDist) {
      best = { wall, wallKey, perpDist: proj.perpDist, closest: proj.closest };
    }
  }

  if (!best) {
    return {
      id: door.id || door.element_key,
      hostSegmentId: null,
      hostWallType: null,
      hostFaceSide: 'N/A',
      position: null,
      confidence: 0,
      reason: 'no_valid_building_wall',
      skipReason: 'no_valid_building_wall',
      evidence: { candidates: [], rule: 'NEAREST_VALID_WALL' }
    };
  }

  // Confidence: doors within PERP_DIST_MAX are high-confidence; salvage range
  // (PERP_DIST_MAX..salvagePerpMax) drops linearly into MEDIUM/LOW.
  const isPrimary = best.perpDist < profile.door.perpDistMax;
  const denom = isPrimary ? profile.door.perpDistMax : profile.door.salvagePerpMax;
  const confidence = Math.max(0, Math.min(1, 1 - best.perpDist / denom));

  return {
    id: door.id || door.element_key,
    hostSegmentId: best.wallKey,
    hostWallType: 'WALL',
    hostFaceSide: 'N/A',
    position: { x: best.closest[0], y: best.closest[1], z: o[2] },
    confidence,
    reason: isPrimary ? 'nearest_wall' : 'salvage_snap',
    skipReason: confidence < CONFIDENCE.MEDIUM ? 'low_confidence' : null,
    evidence: {
      candidates: candidates.slice(0, 5),
      rule: isPrimary ? 'NEAREST_VALID_WALL' : 'SALVAGE_SNAP'
    }
  };
}

function resolveDoorIntent(css, profile) {
  const isTunnel = hasTunnelSegments(css);
  const doors = (css.elements || []).filter(e => {
    const t = (e.type || '').toUpperCase();
    return t === 'DOOR' || t === 'WINDOW';
  });
  return doors.map(d => {
    // Short-circuit: evidence reconciler already rejected this candidate.
    // Emit a stub record so it appears in the report's rejected[] list rather
    // than disappearing silently, and so consume-doors mode can annotate its
    // intent.skipReason for the generate lambda.
    if (d.metadata?.reconciliationStatus === 'rejected') {
      return {
        id:             d.id || d.element_key,
        hostSegmentId:  null,
        hostWallType:   null,
        hostFaceSide:   'N/A',
        position:       null,
        confidence:     0,
        reason:         'reconciler_rejected',
        skipReason:     'reconciler_rejected',
        evidence:       { candidates: [], rule: 'EVIDENCE_RECONCILER' }
      };
    }
    return isTunnel
      ? resolveDoorIntentTunnel(d, css, profile)
      : resolveDoorIntentBuilding(d, css, profile);
  });
}

/**
 * Re-resolve intent for a single door element. Used by acceptance-override:
 *   - Fix 1: a previously reconciler-rejected door is promoted by the per-room
 *     quota pass; its intent stub (hostSegmentId=null) needs replacement.
 *   - Fix 2: a portal-zone door's host must be confirmed against the main
 *     portal pair; pass options.mainPortalIds to restrict candidate hosts.
 *
 * Bypasses the reconciler-rejected short-circuit in resolveDoorIntent — the
 * caller is responsible for deciding when re-resolution is allowed.
 *
 * @param {Object} door
 * @param {Object} css
 * @param {Object} [options]
 * @param {Set<string>} [options.mainPortalIds]
 * @returns {Object} intent record (same shape as inferEngineerIntent doors[])
 */
export function resolveSingleDoorIntent(door, css, options = {}) {
  const isTunnel = hasTunnelSegments(css);
  const { profile } = pickProfile(css);
  return isTunnel
    ? resolveDoorIntentTunnel(door, css, profile, options)
    : resolveDoorIntentBuilding(door, css, profile, options);
}

// ── Branch / room role tagging ──────────────────────────────────────────────
//
// Phase 6A scope: emit a coarse role classification so the report carries the
// engineer-intent picture even before doors consume intent. Heuristics are
// intentionally light — refined in 6B once consumers exist to validate them.

function classifyBranches(css) {
  const segments = (css.elements || []).filter(e => (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT');
  return segments.map(seg => {
    const branchClass = (seg.properties?.branchClass || '').toUpperCase() || 'UNCLASSIFIED';
    const id = seg.element_key || seg.id;
    return {
      id,
      branchClass: ['STRUCTURAL', 'CROSSCUT', 'ANCILLARY'].includes(branchClass) ? branchClass : 'UNCLASSIFIED',
      endpoints: [seg.properties?.startNodeId || null, seg.properties?.endNodeId || null],
      confidence: branchClass ? 0.8 : 0.3
    };
  });
}

function classifyRooms(css) {
  // Coarse v1: every TUNNEL_SEGMENT with branchClass=ANCILLARY is a room
  // candidate; every STRUCTURAL is a connector; PORTAL_END_WALLs flag PORTAL.
  const rooms = [];
  for (const e of (css.elements || [])) {
    const t = (e.type || '').toUpperCase();
    if (t === 'TUNNEL_SEGMENT') {
      const bc = (e.properties?.branchClass || '').toUpperCase();
      const role = bc === 'ANCILLARY' ? 'ROOM' : bc === 'STRUCTURAL' ? 'CONNECTOR' : null;
      if (role) {
        rooms.push({
          id: e.element_key || e.id,
          role,
          containerId: e.containerId || null,
          confidence: 0.7,
          reason: `branchClass=${bc}`
        });
      }
    } else if (t === 'WALL' && e.properties?.segmentType === 'PORTAL_END_WALL') {
      rooms.push({
        id: e.element_key || e.id,
        role: 'PORTAL',
        containerId: e.containerId || null,
        confidence: 0.8,
        reason: 'portal_end_wall'
      });
    }
  }
  return rooms;
}

// ── Public entry ────────────────────────────────────────────────────────────

/**
 * Run the engineer-intent resolver for the given phase.
 *
 * Phase 6A: only `phase: 'structural'` is wired. The function always returns a
 * report object; whether it mutates element.metadata.intent depends on
 * `mode` (per the rollout plan, 6A passes mode='report' which is observe-only).
 *
 * @param {Object} css
 * @param {Object} opts
 * @param {('structural'|'mep')} opts.phase
 * @param {('off'|'report'|'consume-doors'|'consume-mep'|'consume-all')} [opts.mode='report']
 * @returns {Object} report (the full engineer_intent_report.json body)
 */
export function inferEngineerIntent(css, opts = {}) {
  const phase = opts.phase || 'structural';
  const mode = opts.mode || 'report';
  const { name: profileName, profile } = pickProfile(css);

  const elements = css.elements || [];
  const doorElements = elements.filter(e => ['DOOR', 'WINDOW'].includes((e.type || '').toUpperCase()));
  const ductElements = elements.filter(e => ['DUCT', 'PIPE'].includes((e.type || '').toUpperCase()));
  const slabElements = elements.filter(e => (e.type || '').toUpperCase() === 'SLAB');

  // Phase 6A: structural-phase resolution only. MEP phase is wired in 6C.
  const doors = phase === 'structural' ? resolveDoorIntent(css, profile) : [];
  const branches = phase === 'structural' ? classifyBranches(css) : [];
  const rooms = phase === 'structural' ? classifyRooms(css) : [];

  // Tally summary buckets
  const doorBuckets = { high: 0, medium: 0, low: 0, skipped: 0 };
  const rejected = [];
  for (const d of doors) {
    if (d.skipReason) {
      doorBuckets.skipped++;
      rejected.push({
        id: d.id,
        type: 'DOOR',
        reason: d.skipReason,
        candidates: d.evidence?.candidates || []
      });
    } else {
      doorBuckets[bucket(d.confidence)]++;
    }
  }

  // Count reconciler-accepted vs rejected for the report input block
  const reconciledAccepted = doorElements.filter(e => e.metadata?.reconciliationStatus === 'accepted').length;
  const reconciledRejected = doorElements.filter(e => e.metadata?.reconciliationStatus === 'rejected').length;
  const reconciledTotal    = reconciledAccepted + reconciledRejected;

  const report = {
    schemaVersion: '1.0',
    resolver: RESOLVER_VERSION,
    stage: 'topology_engine',
    phase,
    mode,
    generatedAt: new Date().toISOString(),
    domain: (css.domain || '').toUpperCase() || 'UNKNOWN',
    profile: profileName,
    input: {
      elementCount: elements.length,
      doorCount: doorElements.length,
      ductCount: ductElements.length,
      slabCount: slabElements.length,
      evidenceReconciliation: reconciledTotal > 0
        ? { accepted: reconciledAccepted, rejected: reconciledRejected }
        : null
    },
    summary: {
      doorsResolved: doorBuckets,
      ductsResolved: { high: 0, medium: 0, low: 0, skipped: 0 },
      accessResolved: { inferred: 0, unresolved: 0 }
    },
    rooms,
    branches,
    doors: doors.filter(d => !d.skipReason),
    ducts: [],
    access: [],
    rejected,
    unresolved: [],
    thresholds: { high: CONFIDENCE.HIGH, medium: CONFIDENCE.MEDIUM }
  };

  // Phase 6B: in consume-* modes, annotate every DOOR/WINDOW element with its
  // intent record. Resolved doors get a full record; rejected doors get a
  // placeholder with skipReason so consumers can see "considered but skipped"
  // rather than "no intent at all" — the latter would also skip placement,
  // but tracking the difference helps diagnose pipeline drift.
  if (mode === 'consume-doors' || mode === 'consume-mep' || mode === 'consume-all') {
    const elemById = {};
    for (const e of elements) elemById[e.id || e.element_key] = e;
    const annotate = (rec) => {
      const elem = elemById[rec.id];
      if (!elem) return;
      if (!elem.metadata) elem.metadata = {};
      elem.metadata.intent = {
        resolver: RESOLVER_VERSION,
        hostSegmentId: rec.hostSegmentId,
        hostWallType: rec.hostWallType,
        hostFaceSide: rec.hostFaceSide,
        position: rec.position,
        confidence: rec.confidence,
        reason: rec.reason,
        skipReason: rec.skipReason || null,
        doorType: rec.doorType || null,
        evidence: rec.evidence
      };
    };
    for (const d of doors) annotate(d);
  }

  return report;
}
