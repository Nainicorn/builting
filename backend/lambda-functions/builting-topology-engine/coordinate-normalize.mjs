/**
 * Phase 10 — Source Coordinate Normalization
 *
 * Resolves the most common cross-source defect we've seen: text/DXF-derived
 * elements live in a coordinate frame that's offset (and possibly rotated /
 * scaled) from the VSM tunnel-simulation frame.  Phase 9 cannot attach
 * rooms to the tunnel because spaces sit ~100 m away from the tunnel
 * network in a different coordinate system.
 *
 * This pass runs at the very top of the topology pipeline (after repair,
 * before normalizeGeometry) and produces aligned coordinates so every
 * downstream step — Phase 8 placement, Phase 9 layout, equipment mounting,
 * etc. — operates on a single project frame.
 *
 * Pipeline:
 *   detectSourceFrames    → group elements by source; bbox + centroid each
 *   pickCanonicalFrame    → VSM tunnel frame (most TUNNEL_SEGMENTs)
 *   computeTransform      → translation only (rotation / scale gated by
 *                           validation hooks, not yet wired)
 *   applyTransform        → translate every non-canonical, non-default
 *                           element (SPACE/WALL/DOOR/EQUIPMENT/SLAB/COVERING/
 *                           SHAFT/DUCT/DUCT_FITTING/etc.)
 *   banDefaultOriginSpaces→ SPACEs with origin near (0,0,0) or (3.75,2.25)
 *                           get spatialFlag=FLOATING + coordinateStatus=
 *                           NEEDS_COORDINATE_RESOLUTION + placement.origin=null
 *
 * Counters land in css.metadata.coordinateNormalization.  The full per-source
 * report lands in css.metadata.coordinateFrameReport (and is also written
 * out to S3 alongside other pipeline artifacts).
 */

const DEFAULT_ORIGIN_PATTERNS = [
  { x: 0,    y: 0,    z: 0,   r: 0.5 },
  { x: 3.75, y: 2.25, z: 0,   r: 0.5 },
  { x: 3.8,  y: 2.2,  z: 0,   r: 0.5 },
];

// Distinctive room/zone keywords used for anchor matching.  Each entry is
// [regex, keyword].  A name produces a Set of keywords that can be compared
// across sources (e.g. SPEC_TEXT "AC Room" → {ac}; VSM "AC Fan" → {ac, fan}).
// Matches are scored by intersection size so the most-specific anchor wins
// (e.g. "Cable Tray - Diesel Gen Room" with {diesel,generator} beats
// "Diesel Exhaust Fan" with just {diesel}).  Ambiguous keywords like
// "exhaust" / "fan" are intentionally omitted; they cause false matches
// (Office Chamber binding to Diesel Exhaust Fan).
const ANCHOR_KEYWORD_PATTERNS = [
  [/\bac\b/i,                                'ac'],
  [/diesel/i,                                'diesel'],
  [/(?:generator|gen[\s_-]*room)/i,          'generator'],
  [/(?:shaft|vertical[\s_-]*shaft)/i,        'shaft'],
  [/west[\s_-]*portal/i,                     'west_portal'],
  [/east[\s_-]*portal/i,                     'east_portal'],
  [/portal/i,                                'portal'],
  [/northwest/i,                             'northwest'],
  [/northeast/i,                             'northeast'],
  [/southwest/i,                             'southwest'],
  [/southeast/i,                             'southeast'],
];

// ──────────────────────────────────────────────────────────────────────────
// orchestrator
// ──────────────────────────────────────────────────────────────────────────

export function applyCoordinateNormalization(css) {
  if (!css || !Array.isArray(css.elements)) return;
  if (!css.metadata) css.metadata = {};

  const report = {
    enabled: true,
    coordinateFramesDetected: 0,
    canonicalSource: null,
    transformsApplied: {},
    elementsTransformed: 0,
    spacesBanned: 0,
    defaultOriginSpaces: 0,
    transformAppliedToDXF: false,
    transformAppliedToText: false,
    perSource: {},
    // Phase 10 success gates
    coordinateFramesDetectedOK: false,
    transformAppliedToDXFOK: false,
    defaultOriginSpacesOK: false,
  };
  css.metadata.coordinateNormalization = report;

  const groups = detectSourceFrames(css);
  report.coordinateFramesDetected = groups.size;
  for (const [src, g] of groups) {
    report.perSource[src] = {
      elementCount: g.elements.length,
      validOriginCount: g.validOrigins.length,
      bbox: g.bbox,
      centroid: g.centroid,
    };
  }
  // Persisted as a separate artifact so debugging can read it without
  // pulling the entire css.
  css.metadata.coordinateFrameReport = JSON.parse(JSON.stringify(report.perSource));

  if (groups.size === 0) {
    console.log('applyCoordinateNormalization: no elements — skipping');
    return;
  }

  const canonical = pickCanonicalFrame(groups);
  if (!canonical) {
    console.log('applyCoordinateNormalization: no canonical frame found — skipping');
    return;
  }
  report.canonicalSource = canonical.source;

  // Phase 10.3a — Name-anchor matching FIRST.  For each non-canonical SPACE,
  // find the canonical-frame element whose name shares the most distinctive
  // room-keywords (AC, Diesel, Shaft, Portal, ...).  When a match is found,
  // the SPACE inherits that anchor's origin verbatim — no aggregate
  // translation is needed for it.
  report.spacesAnchored = anchorMatchSpaces(css, canonical, report);

  // Phase 10.3b — Centroid translation for un-anchored, non-default-origin
  // elements (typically text-extracted DOOR / DUCT / EQUIPMENT / SPACE that
  // have a coordinate but no keyword match).  Use the ORIGINAL pre-anchor
  // group centroid so the translation lands in the same frame the elements
  // were extracted in; applyTransform skips already-anchored elements.
  for (const [source, group] of groups) {
    if (source === canonical.source) continue;
    if (group.validOrigins.length < 1) {
      report.transformsApplied[source] = { kind: 'skipped', reason: 'no_valid_origins' };
      continue;
    }
    const transform = computeTransform(group, canonical);
    const applied = applyTransform(css, group, transform);
    report.transformsApplied[source] = {
      kind: 'translation',
      translation: transform.translation,
      anchorBasis: transform.anchorBasis,
      elementsTransformed: applied,
    };
    report.elementsTransformed += applied;
    if (/^DXF/i.test(source))                 report.transformAppliedToDXF = true;
    if (/^(SPEC_TEXT|TEXT|LLM)/i.test(source)) report.transformAppliedToText = true;
  }

  banDefaultOriginSpaces(css, report);

  // Phase 10 success gates
  report.coordinateFramesDetectedOK = report.coordinateFramesDetected >= 2;
  report.transformAppliedToDXFOK    = report.transformAppliedToDXF
                                   || report.transformAppliedToText;
  report.defaultOriginSpacesOK      = report.defaultOriginSpaces === 0;

  console.log(
    `applyCoordinateNormalization: frames=${report.coordinateFramesDetected} ` +
    `canonical=${report.canonicalSource} ` +
    `transformed=${report.elementsTransformed} ` +
    `bannedSpaces=${report.spacesBanned} ` +
    `defaultOriginSpaces=${report.defaultOriginSpaces} ` +
    `gates: frames=${report.coordinateFramesDetectedOK} dxf=${report.transformAppliedToDXFOK} default=${report.defaultOriginSpacesOK}`
  );

  if (process.env.PHASE_10_HARD_FAIL === '1') {
    const fails = [];
    if (!report.coordinateFramesDetectedOK) fails.push('frames<2');
    if (!report.transformAppliedToDXFOK)    fails.push('no_dxf_transform');
    if (!report.defaultOriginSpacesOK)      fails.push('default_origin_spaces');
    if (fails.length) throw new Error(`Phase 10 hard-fail: ${fails.join(', ')}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §10.1 — Detect source frames
// ──────────────────────────────────────────────────────────────────────────

/**
 * Group elements by `source` (with a couple of file-suffix overrides for
 * legacy renders that didn't stamp `source`).  For each group, collect:
 *   - elements                — every element in this source bucket
 *   - validOrigins            — the subset whose placement.origin is set
 *                               and NOT in any DEFAULT_ORIGIN_PATTERN
 *   - bbox / centroid         — computed from validOrigins only.  An origin
 *                               at default doesn't carry frame information,
 *                               so it must not skew the centroid.
 */
function detectSourceFrames(css) {
  const groups = new Map();
  for (const e of (css.elements || [])) {
    const src = pickSource(e);
    if (!groups.has(src)) groups.set(src, { source: src, elements: [], validOrigins: [], allOrigins: [] });
    const g = groups.get(src);
    g.elements.push(e);

    const origins = collectOriginPoints(e);
    for (const o of origins) {
      g.allOrigins.push(o);
      if (!isDefaultOrigin(o)) g.validOrigins.push(o);
    }
  }

  for (const g of groups.values()) {
    if (g.validOrigins.length === 0) {
      g.bbox = null;
      g.centroid = null;
      continue;
    }
    let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let sx = 0, sy = 0, sz = 0;
    for (const p of g.validOrigins) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      sx += p.x; sy += p.y; sz += p.z;
    }
    const n = g.validOrigins.length;
    g.bbox = { minX, maxX, minY, maxY, minZ, maxZ };
    g.centroid = { x: sx / n, y: sy / n, z: sz / n };
  }

  return groups;
}

function pickSource(e) {
  const sf = (e.sourceFile || '').toLowerCase();
  // Room-layout text files (e.g. BT_Room_Layout.txt) document Revit/DXF project
  // coordinates — group them with DXF so they receive the same centroid-to-centroid
  // translation, not the generic SPEC_TEXT centroid which mixes coordinate frames.
  if (/bt_room_layout/i.test(sf)) return 'DXF';

  const explicit = (e.source || '').toUpperCase();
  if (explicit) return explicit;
  if (/\.vsm$/.test(sf))            return 'VSM';
  if (/\.dxf$/.test(sf))            return 'DXF';
  if (/\.(txt|md|docx)$/.test(sf))  return 'SPEC_TEXT';
  return 'UNKNOWN';
}

function collectOriginPoints(e) {
  const points = [];
  const o = e.placement?.origin;
  if (o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z)) {
    points.push({ x: +o.x, y: +o.y, z: +o.z });
  }
  // Tunnel segments often carry start/end on properties — those are part of
  // the same coordinate frame, so include them when computing the centroid.
  for (const k of ['startPoint', 'endPoint']) {
    const p = e.properties?.[k];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      points.push({ x: +p.x, y: +p.y, z: +(p.z ?? 0) });
    }
  }
  return points;
}

function isDefaultOrigin(p) {
  for (const d of DEFAULT_ORIGIN_PATTERNS) {
    const dx = p.x - d.x, dy = p.y - d.y, dz = p.z - d.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= d.r) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// §10.2 — Pick canonical frame
// ──────────────────────────────────────────────────────────────────────────

/**
 * The VSM tunnel network is the project anchor — it carries the largest
 * volume of structurally-significant elements (TUNNEL_SEGMENT, EQUIPMENT
 * mounted on tunnel walls, ducts).  Pick the source bucket with the most
 * TUNNEL_SEGMENT elements; tie-break on element count.
 */
function pickCanonicalFrame(groups) {
  let best = null;
  let bestTunnelCount = -1;
  let bestSize = -1;
  for (const g of groups.values()) {
    if (!g.centroid) continue;
    const tunnels = g.elements.filter(e =>
      (e.type || '').toUpperCase() === 'TUNNEL_SEGMENT'
    ).length;
    if (
      tunnels > bestTunnelCount ||
      (tunnels === bestTunnelCount && g.elements.length > bestSize)
    ) {
      best = g;
      bestTunnelCount = tunnels;
      bestSize = g.elements.length;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────
// §10.3 — Compute transform
// ──────────────────────────────────────────────────────────────────────────

/**
 * Translation-only transform.  Anchor basis:
 *   - centroid_to_centroid       (default; valid-origin centroid alignment)
 *
 * Rotation and scale are intentionally NOT applied in this pass — a single
 * shared frame for sub-100m-class projects is well-served by translation,
 * and inferring rotation requires at least 2 reliable anchor pairs that we
 * don't yet have.  When we do, the validation gates will fail and we'll
 * extend this function.
 */
function computeTransform(group, canonical) {
  const dx = canonical.centroid.x - group.centroid.x;
  const dy = canonical.centroid.y - group.centroid.y;
  // Z is left alone — most cross-frame defects are planar in our renders,
  // and shifting Z would mis-place elements that already inherit a correct
  // storey elevation from text extraction (e.g. portal storey at 4 m).
  return {
    translation: { x: +dx.toFixed(4), y: +dy.toFixed(4), z: 0 },
    anchorBasis: 'centroid_to_centroid',
  };
}

// ──────────────────────────────────────────────────────────────────────────
// §10.3a — Name-anchor matching for SPACE elements
// ──────────────────────────────────────────────────────────────────────────

/**
 * For each non-canonical SPACE, find the canonical-frame element whose name
 * shares the most distinctive room-keywords and inherit that element's
 * origin.  Anchors are evaluated against canonical-frame elements with a
 * non-default origin and a name that produces ≥1 keyword.
 *
 * Match score = |keywords(space) ∩ keywords(anchor)|.  Highest score wins;
 * ties prefer TUNNEL_SEGMENT > EQUIPMENT (segments better represent the
 * actual room footprint than equipment mounted inside it).
 *
 * Stamps:
 *   placement.origin            = anchor.origin
 *   properties.coordinateAnchor = anchor element_key/id
 *   properties.coordinateFrame  = 'CANONICAL'
 */
function anchorMatchSpaces(css, canonical, report) {
  const elements = css.elements || [];

  const anchors = [];
  for (const e of elements) {
    if (pickSource(e) !== canonical.source) continue;
    const o = e.placement?.origin;
    if (!o || isDefaultOrigin(o)) continue;
    const kws = extractAnchorKeywords(e.name || '');
    if (kws.size === 0) continue;
    anchors.push({
      element: e,
      origin: { x: +o.x, y: +o.y, z: +(o.z ?? 0) },
      keywords: kws,
      type: (e.type || '').toUpperCase(),
      name: e.name || '',
    });
  }
  if (anchors.length === 0) return 0;

  const TYPE_PREFERENCE = { TUNNEL_SEGMENT: 3, SPACE: 2, EQUIPMENT: 1 };
  let matched = 0;
  const matches = [];

  for (const e of elements) {
    if ((e.type || '').toUpperCase() !== 'SPACE') continue;
    if (pickSource(e) === canonical.source) continue;
    const kws = extractAnchorKeywords(e.name || '');
    if (kws.size === 0) continue;

    let bestAnchor = null, bestScore = 0, bestTypePref = -1;
    for (const a of anchors) {
      let overlap = 0;
      for (const k of kws) if (a.keywords.has(k)) overlap++;
      if (overlap === 0) continue;
      const typePref = TYPE_PREFERENCE[a.type] || 0;
      if (
        overlap > bestScore ||
        (overlap === bestScore && typePref > bestTypePref)
      ) {
        bestAnchor = a;
        bestScore = overlap;
        bestTypePref = typePref;
      }
    }
    if (!bestAnchor) continue;

    e.placement = e.placement || {};
    e.placement.origin = {
      x: bestAnchor.origin.x,
      y: bestAnchor.origin.y,
      z: bestAnchor.origin.z,
    };
    e.properties = e.properties || {};
    e.properties.coordinateAnchor =
      bestAnchor.element.element_key || bestAnchor.element.id;
    e.properties.coordinateAnchorName = bestAnchor.name;
    e.properties.coordinateFrame = 'CANONICAL';
    e.properties.coordinateTransform = 'name_anchor';
    matched++;
    matches.push({
      space: e.name || e.id,
      anchor: bestAnchor.name,
      anchorType: bestAnchor.type,
      score: bestScore,
      origin: e.placement.origin,
    });
  }
  report.anchorMatches = matches;
  return matched;
}

function extractAnchorKeywords(name) {
  const kws = new Set();
  if (!name) return kws;
  for (const [re, k] of ANCHOR_KEYWORD_PATTERNS) {
    if (re.test(name)) kws.add(k);
  }
  return kws;
}

// ──────────────────────────────────────────────────────────────────────────
// §10.4 — Apply transform
// ──────────────────────────────────────────────────────────────────────────

/**
 * Translate every element in the group whose origin is NOT a default
 * (default-origin elements have no meaningful coordinates yet — they'll be
 * banned in §10.5 instead of being shifted to a wrong place).  Endpoints,
 * pathPoints, and bbox in `properties` are translated alongside origin so
 * downstream passes see fully-transformed geometry.
 */
function applyTransform(css, group, transform) {
  const { x: tx, y: ty, z: tz } = transform.translation;
  let count = 0;

  for (const e of group.elements) {
    // Skip elements already placed by name-anchor matching (§10.3a) — they
    // already carry a canonical-frame origin; translating again would push
    // them off the anchor.
    if (e.properties?.coordinateTransform === 'name_anchor') continue;

    const o = e.placement?.origin;
    const hasOrigin = o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);
    if (hasOrigin && !isDefaultOrigin(o)) {
      o.x += tx; o.y += ty; o.z += tz;
      count++;
    }
    // properties.startPoint / endPoint
    for (const k of ['startPoint', 'endPoint']) {
      const p = e.properties?.[k];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && !isDefaultOrigin({ x: p.x, y: p.y, z: p.z ?? 0 })) {
        p.x += tx; p.y += ty;
        if (Number.isFinite(p.z)) p.z += tz;
      }
    }
    // pathPoints / path (used by SWEEP geometry).
    const path = e.geometry?.path;
    if (Array.isArray(path)) {
      for (const p of path) {
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && !isDefaultOrigin({ x: p.x, y: p.y, z: p.z ?? 0 })) {
          p.x += tx; p.y += ty;
          if (Number.isFinite(p.z)) p.z += tz;
        }
      }
    }
    const pathPts = e.geometry?.pathPoints;
    if (Array.isArray(pathPts)) {
      for (const p of pathPts) {
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && !isDefaultOrigin({ x: p.x, y: p.y, z: p.z ?? 0 })) {
          p.x += tx; p.y += ty;
          if (Number.isFinite(p.z)) p.z += tz;
        }
      }
    }
    // Pre-existing bbox in properties (rare at this point, but defensively).
    const b = e.properties?.bbox;
    if (b && Number.isFinite(b.minX)) {
      b.minX += tx; b.maxX += tx;
      b.minY += ty; b.maxY += ty;
    }
    // Stamp coordinate-frame provenance for debugging.
    if (!e.properties) e.properties = {};
    e.properties.coordinateFrame = 'CANONICAL';
    e.properties.coordinateTransform = transform.anchorBasis;
  }

  return count;
}

// ──────────────────────────────────────────────────────────────────────────
// §10.5 — Ban default-origin spaces
// ──────────────────────────────────────────────────────────────────────────

/**
 * For every SPACE whose origin is still in a DEFAULT_ORIGIN_PATTERN after
 * the transform pass:
 *
 *   - properties.coordinateStatus = 'NEEDS_COORDINATE_RESOLUTION'
 *   - properties.spatialFlag      = 'FLOATING'   ← IFC generator skip
 *   - placement.origin            = null         ← Phase 8 bbox-stamp skip
 *
 * The triple-stamp ensures the SPACE doesn't propagate a fake origin
 * anywhere downstream.  No geometry will be emitted for it; the validation
 * report carries the count.
 */
function banDefaultOriginSpaces(css, report) {
  for (const e of (css.elements || [])) {
    if ((e.type || '').toUpperCase() !== 'SPACE') continue;
    const o = e.placement?.origin;
    if (o && Number.isFinite(o.x) && !isDefaultOrigin(o)) continue;
    if (!e.properties) e.properties = {};
    e.properties.coordinateStatus = 'NEEDS_COORDINATE_RESOLUTION';
    e.properties.spatialFlag = 'FLOATING';
    e.placement = e.placement || {};
    e.placement.origin = null;
    report.spacesBanned++;
    report.defaultOriginSpaces++;
  }
}
