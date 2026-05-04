# @builting/contracts

Pipeline boundary contracts. Each contract is defined twice — once in Zod (Node lambdas) and once in Pydantic (Python container for `builting-generate`) — and verified equivalent by a CI round-trip test.

## Why two implementations

The pipeline is mixed-language: extract / resolve / topology-engine / store are Node 20, generate is Python 3.11 in a container. A single source-of-truth schema (e.g. JSON Schema with codegen) was rejected as too much toolchain. The pragmatic answer is parallel hand-written schemas plus a CI test that round-trips fixtures through both validators and fails on verdict divergence.

## Contracts

| Contract | Producer | Consumer | Notes |
|---|---|---|---|
| `claimsContract` | extract | resolve | Validates `claims.json` |
| `cssRawContract` | extract | topology | Validates `css_raw.json` (geometry-path direct from extract) |
| `canonicalContract` | resolve | (none — diagnostic) | Validates `canonical_observed.json`; runs as resolve self-check, logs `contract_self_check_failure` to trace, does NOT halt |
| `validatedCssContract` | topology | generate | Validates `css_processed.json` |
| `ifcContract` | generate | store | Validates the generate→store Step Function event payload |

## Layout

```
zod/                                  Node-side contracts (one file per contract)
pydantic/builting_contracts/          Python-side contracts (one file per contract)
fixtures/<contract>/                  Round-trip fixtures
  positive.json                       MUST validate on both sides
  negative-<category>-<name>.json     MUST fail on both sides; carries _failureReason + _category
ci/
  contracts.config.mjs                One entry per contract — the one-line addition for new contracts
  run-roundtrip.mjs                   Data-driven runner; iterates contracts.config
  py_validate.py                      Subprocess called by the runner for each fixture/Pydantic check
```

## Fixture categories

Every contract has at least one negative fixture in each of three categories:

- **shape** — missing required field, wrong type, extra field under `strict()`. Fails loudly on any reasonable schema.
- **boundary** — `0` where `> 0` is intended, empty string where non-empty intended, length-0 array where min-1 intended. Catches Zod ↔ Pydantic default-behavior drift.
- **cross_field** — conditional implications between fields (e.g. `sourceFileStatus: 'inherited_consensus'` requires `sourceFiles.length >= 2`). Highest-risk drift area.

Total per contract: 1 positive + 4–6 negatives, with all three categories represented.

## Zod ↔ Pydantic default disagreements (must mirror)

These are silent-drift traps. Every contract written here must mirror these settings, or the CI round-trip will fail (and if it doesn't, the missing fixture is the bug, not the validators).

| Behavior | Zod default | Pydantic default | Required setting |
|---|---|---|---|
| String → number coercion | rejects | **coerces silently** | `ConfigDict(strict=True)` on every Pydantic model |
| Extra/unknown keys | **passes silently (strips)** | rejects | `.strict()` on every `z.object({...})` AND `ConfigDict(extra="forbid")` on every Pydantic model |
| Bool string coercion (`"true"` → `True`) | rejects | coerces (without strict) | covered by `strict=True` above |
| `null` value on optional field | needs `.nullable()` | needs `Optional[T]` | both must agree per-field; `.optional()` (Zod) ≠ `.nullable()` |
| Field absent vs `null` | both treated as missing | distinguishes (need explicit `= None` for absent) | for now: every field is required-to-be-present, value can be `null` if `.nullable()`/`Optional[T]` |

Caught in PR 1 by the CI runner on contract one (string-coerced confidence). Documented here so future contracts don't re-derive it.

## Adding a contract

1. Write `zod/<name>.mjs` and `pydantic/builting_contracts/<snake_name>.py` in parallel — write claims schema in both, then fixtures, then run CI locally; only then move to the next.
2. Add fixtures under `fixtures/<name>/`.
3. Add one line to `ci/contracts.config.mjs`.
4. The runner picks it up automatically.

## Running locally

```
cd backend/shared/contracts
npm install                 # Zod + zod-to-json-schema (only Zod side has deps for now)
pip install -e ./pydantic   # Editable install for the Python side
node ci/run-roundtrip.mjs   # Runs every contract × every fixture through both validators
```

Exits non-zero on:
- Any fixture verdict mismatch between Zod and Pydantic.
- Any positive fixture failing on either side.
- Any negative fixture passing on either side.
- A category missing from a contract's negative-fixture set.
