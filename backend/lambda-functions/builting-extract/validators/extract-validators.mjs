/**
 * Extract-stage validators — all severity: 'warning' (observation only, no halts).
 *
 * Each function returns an array of validation entries matching the audit schema:
 *   { ts, stage, validator, element_id, result, expected, actual, severity, params? }
 * The caller logs them via logValidation() and accumulates the summary.
 */

const SEVERITY = 'warning';

// Fields whose presence marks a claim as spatial
const SPATIAL_FIELD_SET = new Set([
  'x', 'y', 'z', 'coordinates', 'coordinate', 'origin', 'location',
  'position', 'placement', 'from', 'to', 'start', 'end', 'startPoint', 'endPoint',
  'centerX', 'centerY', 'centerZ',
]);

/**
 * coordinateFramePresent — every claim that carries spatial fields should also
 * declare which coordinate frame those values are in.
 */
export function coordinateFramePresent(claims) {
  const issues = [];
  for (const claim of claims) {
    const val = claim.value || {};
    const hasSpatialField = Object.keys(val).some(k => SPATIAL_FIELD_SET.has(k.toLowerCase()));
    if (!hasSpatialField) continue;
    const frame = claim.coordinateFrame || claim.provenance?.coordinateFrame;
    if (!frame) {
      issues.push({
        validator: 'coordinateFramePresent',
        element_id: claim.claim_id || claim.id || '(unknown)',
        result: 'warn',
        expected: 'non-null coordinateFrame on spatial claim',
        actual: null,
        severity: SEVERITY,
      });
    }
  }
  return issues;
}

// Per-type dimension plausibility limits (all in SI: metres, m²)
const DIM_RULES = [
  { subjectKey: 'WALL',   field: 'length_m',    min: 0.01,  max: 10000 },
  { subjectKey: 'WALL',   field: 'height_m',    min: 0.1,   max: 200 },
  { subjectKey: 'WALL',   field: 'thickness_m', min: 0.005, max: 10 },
  { subjectKey: 'DOOR',   field: 'width_m',     min: 0.1,   max: 20 },
  { subjectKey: 'DOOR',   field: 'height_m',    min: 0.1,   max: 20 },
  { subjectKey: 'WINDOW', field: 'width_m',     min: 0.05,  max: 20 },
  { subjectKey: 'WINDOW', field: 'height_m',    min: 0.05,  max: 20 },
  { subjectKey: 'ROOM',   field: 'area_m2',     min: 0.01,  max: 1000000 },
  { subjectKey: 'SPACE',  field: 'area_m2',     min: 0.01,  max: 1000000 },
  { subjectKey: 'SLAB',   field: 'thickness_m', min: 0.01,  max: 5 },
  { subjectKey: 'DUCT',   field: 'diameter_m',  min: 0.05,  max: 10 },
];

/**
 * dimensionPlausible — flag claims where a numeric dimension falls outside
 * physical plausibility bounds (unit errors, parsing artefacts, etc.).
 */
export function dimensionPlausible(claims) {
  const issues = [];
  for (const claim of claims) {
    const subj = (claim.subject || '').toUpperCase();
    const val = claim.value || {};
    for (const rule of DIM_RULES) {
      if (!subj.includes(rule.subjectKey)) continue;
      const raw = val[rule.field];
      if (raw == null) continue;
      const num = Number(raw);
      if (!Number.isFinite(num)) continue;
      if (num < rule.min || num > rule.max) {
        issues.push({
          validator: 'dimensionPlausible',
          element_id: claim.claim_id || claim.id || '(unknown)',
          result: 'warn',
          expected: `${rule.subjectKey}.${rule.field} ∈ [${rule.min}, ${rule.max}]`,
          actual: num,
          severity: SEVERITY,
          params: {
            field: `${rule.subjectKey}.${rule.field}`,
            value: num,
            min: rule.min,
            max: rule.max,
          },
        });
      }
    }
  }
  return issues;
}

/**
 * sourceInInputSet — every claim.provenance.sourceFile must be a file that
 * was actually uploaded for this render.  Catches phantom file references
 * that could indicate a caching bug or confused extraction.
 */
export function sourceInInputSet(claims, uploadManifest) {
  const issues = [];
  if (!uploadManifest || uploadManifest.length === 0) return issues;

  const manifestNames = new Set(
    uploadManifest.map(f => {
      if (typeof f === 'string') return f;
      const n = f.filename || f.key || f.name || '';
      return n.split('/').pop(); // basename only
    }).filter(Boolean)
  );

  for (const claim of claims) {
    const sf = claim.provenance?.sourceFile;
    if (!sf) continue;
    const basename = sf.split('/').pop();
    if (!manifestNames.has(sf) && !manifestNames.has(basename)) {
      issues.push({
        validator: 'sourceInInputSet',
        element_id: claim.claim_id || claim.id || '(unknown)',
        result: 'warn',
        expected: `provenance.sourceFile "${basename}" present in upload manifest`,
        actual: sf,
        severity: SEVERITY,
      });
    }
  }
  return issues;
}

/**
 * runExtractValidators — run all extract-stage validators and return a summary.
 * Returns { total, passed, warned, failed } — caller logs entries via logValidation.
 */
export function runExtractValidators(claimsDoc, uploadManifest) {
  const claims = claimsDoc?.claims || [];
  if (claims.length === 0) return { entries: [], total: 0, passed: 0, warned: 0, failed: 0 };

  const entries = [
    ...coordinateFramePresent(claims),
    ...dimensionPlausible(claims),
    ...sourceInInputSet(claims, uploadManifest),
  ];

  const failed = entries.filter(e => e.result === 'fail').length;
  const warned = entries.filter(e => e.result === 'warn').length;
  return { entries, total: entries.length, passed: 0, warned, failed };
}
