/**
 * rule-assertions.mjs — Physical correctness assertion pass.
 *
 * Runs AFTER wall snapping and MEP path routing, BEFORE generate handoff.
 *
 * Checks:
 *   1. Zero-height — walls/columns/beams with depth=0 or profile.height=0 → remove + log
 *   2. Floating    — elements missing finite x,y,z placement → remove + log
 *   3. Wall gaps   — endpoint pairs > 50mm apart after snapping → connection_warning (no removal)
 *   4. MEP containment — ducts/fans/pipes/terminals outside all zone/storey bboxes → mep_placement_warning
 *
 * Returns topology_report. Throws RuleAssertionAbort (name + JSON message) if
 * removed element count exceeds 20% of the input element count.
 */

import {
  canonicalWallDirection, canonicalWallLength,
  vecAdd, vecScale, vecDist
} from './shared.mjs';

const ZERO_HEIGHT_TYPES = new Set(['WALL', 'COLUMN', 'BEAM']);

const MEP_TYPES = new Set(['DUCT', 'FAN', 'PIPE', 'TERMINAL', 'DAMPER', 'VALVE', 'FITTING']);
const MEP_SEMANTICS = new Set([
  'IfcDuctSegment', 'IfcDuctFitting', 'IfcPipeSegment', 'IfcPipeFitting',
  'IfcFlowTerminal', 'IfcAirTerminal', 'IfcFan', 'IfcPump', 'IfcValve',
  'IfcDamper', 'IfcFlowMovingDevice', 'IfcFlowController'
]);

const WALL_GAP_WARN      = 0.05;  // 50mm  — report if gap exceeds this after snapping
const WALL_GAP_CANDIDATE = 0.25;  // 250mm — only consider pairs within this range
const MAX_WALL_GAP_PAIRS = 500;   // skip O(n²) check above this wall count
const STOREY_Z_TOL       = 0.1;   // 100mm tolerance on storey elevation bounds

export function runRuleAssertions(css, elementCountIn) {
  const zeroHeightRemoved  = [];
  const floatingRemoved    = [];
  const connectionWarnings = [];
  const mepPlacementWarnings = [];

  // ── Checks 1 & 2: remove zero-height and floating elements ────────────────
  const keep = [];
  for (const elem of css.elements) {
    const type   = (elem.type || '').toUpperCase();
    const geom   = elem.geometry || {};
    const origin = elem.placement?.origin;
    const eid    = elem.element_key || elem.id || 'unknown';

    // Check 2: non-finite or missing placement coordinates
    if (
      !origin ||
      !Number.isFinite(origin.x) ||
      !Number.isFinite(origin.y) ||
      !Number.isFinite(origin.z)
    ) {
      // SPACE elements are BIM containment containers — removing them loses
      // the spatial hierarchy. Keep them with a fallback origin so generate
      // can still emit IfcSpace with a placeholder placement.
      if (type === 'SPACE') {
        console.log(`ruleAssertions: floating SPACE kept — ${eid} (no placement, using origin 0,0,0)`);
        if (!elem.placement) elem.placement = {};
        elem.placement.origin = { x: 0, y: 0, z: 0 };
        keep.push(elem);
        continue;
      }
      floatingRemoved.push({ id: eid, type: elem.type || 'UNKNOWN' });
      console.log(`ruleAssertions: floating removed — ${eid} (${elem.type})`);
      continue;
    }

    // Check 1: zero-height structural elements
    if (ZERO_HEIGHT_TYPES.has(type)) {
      const depth        = geom.depth ?? -1;
      const profileH     = geom.profile?.height ?? -1;
      if (depth === 0 || profileH === 0) {
        const reason = depth === 0 ? 'zero_depth' : 'zero_profile_height';
        zeroHeightRemoved.push({
          id: eid, type, reason,
          depth: geom.depth ?? null,
          profile_height: geom.profile?.height ?? null
        });
        console.log(`ruleAssertions: zero-height ${type} removed — ${eid} (${reason})`);
        continue;
      }
    }

    keep.push(elem);
  }
  css.elements = keep;

  const totalRemoved = zeroHeightRemoved.length + floatingRemoved.length;

  // ── Abort gate: > 20% removed ─────────────────────────────────────────────
  if (elementCountIn > 0 && totalRemoved / elementCountIn > 0.2) {
    const pct = ((totalRemoved / elementCountIn) * 100).toFixed(1);
    console.error(`ruleAssertions: ABORT — ${totalRemoved}/${elementCountIn} removed (${pct}%) exceeds 20% threshold`);
    const err = new Error(JSON.stringify({
      type: 'RULE_ASSERTION_ABORT',
      message: `Pipeline aborted: rule assertions removed ${totalRemoved} of ${elementCountIn} elements (${pct}%) — exceeds 20% threshold. Too many structurally invalid elements to produce a usable render.`,
      removed_zero_height: zeroHeightRemoved.length,
      removed_floating: floatingRemoved.length,
      element_count_in: elementCountIn,
      percent_removed: parseFloat(pct)
    }));
    err.name = 'RuleAssertionAbort';
    throw err;
  }

  // ── Check 3: wall connection gaps (building/non-tunnel only) ──────────────
  const hasTunnelElems = (css.elements || []).some(e => e.type === 'TUNNEL_SEGMENT');
  if (!hasTunnelElems) {
    const walls = css.elements.filter(e => (e.type || '').toUpperCase() === 'WALL');
    if (walls.length <= MAX_WALL_GAP_PAIRS) {
      // Compute endpoints using the same canonical helpers as snapWallEndpoints
      const wallData = walls.map(w => {
        const dir = canonicalWallDirection(w);
        const o   = w.placement?.origin;
        if (!dir || !o) return null;
        const len = canonicalWallLength(w);
        if (len <= 0) return null;
        return {
          id:    w.element_key || w.id,
          start: vecAdd(o, vecScale(dir, -len / 2)),
          end:   vecAdd(o, vecScale(dir,  len / 2))
        };
      }).filter(Boolean);

      for (let i = 0; i < wallData.length; i++) {
        for (let j = i + 1; j < wallData.length; j++) {
          const a = wallData[i], b = wallData[j];
          const pairs = [
            [a.start, b.start], [a.start, b.end],
            [a.end,   b.start], [a.end,   b.end]
          ];
          for (const [pa, pb] of pairs) {
            const d = vecDist(pa, pb);
            if (d > WALL_GAP_WARN && d <= WALL_GAP_CANDIDATE) {
              connectionWarnings.push({
                wall_a: a.id,
                wall_b: b.id,
                gap_m: Math.round(d * 1000) / 1000
              });
              break; // one warning per wall pair
            }
          }
        }
      }
    } else {
      console.warn(`ruleAssertions: wall gap check skipped — ${walls.length} walls exceeds O(n²) limit (${MAX_WALL_GAP_PAIRS}). Undetected connection gaps may degrade render quality.`);
    }
  }

  // ── Check 4: MEP zone/storey containment ──────────────────────────────────
  const storeys = (css.levelsOrSegments || []).filter(l => (l.elevation_m !== undefined && l.elevation_m !== null) || l.type === 'STOREY');
  const zones   = (css.zones || []).filter(z => z.bbox?.min && z.bbox?.max);

  for (const elem of css.elements) {
    const type = (elem.type || '').toUpperCase();
    const st   = elem.semanticType || '';
    if (!MEP_TYPES.has(type) && !MEP_SEMANTICS.has(st)) continue;

    const o = elem.placement?.origin;
    if (!o) continue; // already removed floating elements above

    let contained = false;

    for (const zone of zones) {
      const { min, max } = zone.bbox;
      if (
        o.x >= min.x && o.x <= max.x &&
        o.y >= min.y && o.y <= max.y &&
        o.z >= min.z && o.z <= max.z
      ) {
        contained = true;
        break;
      }
    }

    if (!contained && storeys.length > 0) {
      for (const storey of storeys) {
        const elev   = storey.elevation_m ?? 0;
        const height = storey.height_m ?? 4;
        if (o.z >= elev - STOREY_Z_TOL && o.z <= elev + height + STOREY_Z_TOL) {
          contained = true;
          break;
        }
      }
    }

    if (!contained) {
      if (!elem.metadata) elem.metadata = {};
      elem.metadata.mep_placement_warning = true;
      mepPlacementWarnings.push({
        id:   elem.element_key || elem.id || 'unknown',
        type: elem.type || 'UNKNOWN',
        z:    o.z
      });
    }
  }

  if (connectionWarnings.length > 0)
    console.log(`ruleAssertions: ${connectionWarnings.length} wall connection gap warning(s)`);
  if (mepPlacementWarnings.length > 0)
    console.log(`ruleAssertions: ${mepPlacementWarnings.length} MEP containment warning(s)`);

  return {
    generated_at: new Date().toISOString(),
    input_element_count: elementCountIn,
    removed_count: totalRemoved,
    pass: totalRemoved === 0 && connectionWarnings.length === 0 && mepPlacementWarnings.length === 0,
    checks: {
      zero_height:    { removed_count: zeroHeightRemoved.length,    removed:  zeroHeightRemoved },
      floating:       { removed_count: floatingRemoved.length,       removed:  floatingRemoved },
      connection_gaps:{ warning_count: connectionWarnings.length,    warnings: connectionWarnings },
      mep_containment:{ warning_count: mepPlacementWarnings.length,  warnings: mepPlacementWarnings }
    }
  };
}
