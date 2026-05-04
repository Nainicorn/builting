// One entry per contract. Adding a contract is a one-line addition here
// plus the matching Zod file, Pydantic file, and fixtures directory.
// The runner picks it up automatically — do not modify run-roundtrip.mjs
// to add a contract.

export const contracts = [
  {
    name: 'claims',
    zodModule: '../zod/claims.mjs',
    zodExport: 'claimsContract',
    pyContract: 'claims',  // matches --contract arg in py_validate.py
    fixturesDir: '../fixtures/claims',
  },
  {
    name: 'cssRaw',
    zodModule: '../zod/cssRaw.mjs',
    zodExport: 'cssRawContract',
    pyContract: 'css_raw',
    fixturesDir: '../fixtures/cssRaw',
    // PR 1 calibration: tunnel cssRaw's elementCounts sum doesn't match
    // elements.length (multi-stage extract appends without bookkeeping).
    // See zod/cssRaw.mjs for the followup plan; cross_field disabled here
    // until extract recomputes elementCounts at write time.
    skipCategories: ['cross_field'],
  },
  {
    name: 'canonical',
    zodModule: '../zod/canonical.mjs',
    zodExport: 'canonicalContract',
    pyContract: 'canonical',
    fixturesDir: '../fixtures/canonical',
  },
  {
    name: 'validatedCss',
    zodModule: '../zod/validatedCss.mjs',
    zodExport: 'validatedCssContract',
    pyContract: 'validated_css',
    fixturesDir: '../fixtures/validatedCss',
    // PR 1 calibration found that the obvious cross-field invariant
    // (modelExtent.elementCount === elements.length) is broken in
    // production due to a known pipeline bug — see comments in
    // zod/validatedCss.mjs. Other candidate invariants (container ref
    // → levelsOrSegments) also drift in production. Skip cross_field
    // until either the pipeline bug is fixed (re-enable elementCount
    // check) or another stable invariant is found.
    skipCategories: ['cross_field'],
  },
  {
    name: 'ifc',
    zodModule: '../zod/ifc.mjs',
    zodExport: 'ifcContract',
    pyContract: 'ifc',
    fixturesDir: '../fixtures/ifc',
  },
];

// Required negative-fixture categories per contract. The runner asserts that
// every contract has at least one fixture in each category — catches drift
// where someone adds a new contract and only writes shape negatives.
export const REQUIRED_NEGATIVE_CATEGORIES = ['shape', 'boundary', 'cross_field'];
