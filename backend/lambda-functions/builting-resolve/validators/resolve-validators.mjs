/**
 * Resolve-stage validators — all severity: 'warning'.
 *
 * Each function returns an array of validation entries.
 * Caller logs via logValidation() and accumulates summary.
 */

const SEVERITY = 'warning';

/**
 * noOrphanClaims — every input claim must either have contributed to a
 * canonical observation OR appear in droppedClaims. An orphan claim is one
 * that silently fell out of both sets, indicating a resolver bug.
 */
export function noOrphanClaims(inputClaims, observations, droppedClaims) {
  const issues = [];

  const droppedIds = new Set(
    (droppedClaims || []).map(d => d.claim_id || d.id || d).filter(Boolean)
  );

  // Build set of all claim IDs that contributed to at least one observation
  const contributeSet = new Set();
  for (const obs of (observations || [])) {
    // sourceClaims may be an array of objects or strings
    for (const src of (obs.sourceClaims || obs.source_claims || [])) {
      const id = (typeof src === 'string') ? src : (src.claim_id || src.id);
      if (id) contributeSet.add(id);
    }
    // Also check claimIds array (alternate field name)
    for (const id of (obs.claimIds || obs.claim_ids || [])) {
      if (id) contributeSet.add(id);
    }
  }

  for (const claim of (inputClaims || [])) {
    const id = claim.claim_id || claim.id;
    if (!id) continue;
    if (!contributeSet.has(id) && !droppedIds.has(id)) {
      issues.push({
        validator: 'noOrphanClaims',
        element_id: id,
        result: 'warn',
        expected: 'claim_id referenced in observations.sourceClaims or droppedClaims',
        actual: 'not found in either set',
        severity: SEVERITY,
      });
    }
  }
  return issues;
}

/**
 * noContradictoryCanonical — no canonical observation should have a field
 * that the resolver left in an explicit conflict state. The resolver should
 * always pick a winner; a {conflict: true} value means it didn't.
 */
export function noContradictoryCanonical(observations) {
  const issues = [];
  for (const obs of (observations || [])) {
    const fields = obs.fields || obs.properties || obs.values || {};
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      if (fieldValue == null) continue;
      if (typeof fieldValue === 'object' && fieldValue.conflict === true) {
        issues.push({
          validator: 'noContradictoryCanonical',
          element_id: obs.canonical_id || obs.id || '(unknown)',
          result: 'warn',
          expected: `single resolved value for field "${fieldName}"`,
          actual: `conflict marker on "${fieldName}"`,
          severity: SEVERITY,
          params: { field: fieldName, conflictValue: fieldValue },
        });
      }
    }
  }
  return issues;
}

/**
 * runResolveValidators — run all resolve-stage validators.
 * Returns { entries, total, passed, warned, failed }.
 */
export function runResolveValidators(inputClaims, observations, droppedClaims) {
  const entries = [
    ...noOrphanClaims(inputClaims, observations, droppedClaims),
    ...noContradictoryCanonical(observations),
  ];
  const failed = entries.filter(e => e.result === 'fail').length;
  const warned = entries.filter(e => e.result === 'warn').length;
  return { entries, total: entries.length, passed: 0, warned, failed };
}
