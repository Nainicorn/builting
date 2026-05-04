#!/usr/bin/env node
// Contract round-trip runner.
//
// For each contract listed in contracts.config.mjs, for each fixture in its
// fixtures dir:
//   1. Strip top-level _-prefixed metadata keys.
//   2. Validate via Zod (in-process).
//   3. Validate via Pydantic (subprocess to py_validate.py).
//   4. Compare verdicts. Both must pass (positive fixture) or both must
//      fail (negative fixture). Any mismatch is a hard error.
//
// Asserts every contract has at least one fixture in each
// REQUIRED_NEGATIVE_CATEGORIES bucket — catches drift where a new contract
// only writes shape negatives.
//
// Exits 0 when all checks pass, 1 otherwise. Prints a per-fixture report.

import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';

import { contracts, REQUIRED_NEGATIVE_CATEGORIES } from './contracts.config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PY_VALIDATE = join(__dirname, 'py_validate.py');

// ─── Stripping fixture metadata ──────────────────────────────────────────

function stripMeta(payload) {
  // Top-level keys starting with `_` are fixture metadata, never part of the
  // artifact. Production claims.json / canonical.json / etc. have no such
  // keys, so stripping is safe.
  const out = {};
  const meta = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k.startsWith('_')) meta[k] = v;
    else out[k] = v;
  }
  return { payload: out, meta };
}

// ─── Pydantic subprocess ─────────────────────────────────────────────────

function runPydantic(contractName, payload) {
  return new Promise((resolveFn, rejectFn) => {
    // Ensure the pydantic package (editable install from pydantic/) is on
    // PYTHONPATH so py_validate.py can import builting_contracts regardless
    // of how Python was installed or which site-packages are active.
    const pydanticRoot = resolve(__dirname, '../pydantic');
    const pythonPath = process.env.PYTHONPATH
      ? `${pydanticRoot}:${process.env.PYTHONPATH}`
      : pydanticRoot;

    const child = spawn('python3', [PY_VALIDATE, `--contract=${contractName}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: pythonPath },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => rejectFn(err));
    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        rejectFn(new Error(`py_validate exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolveFn(JSON.parse(stdout));
      } catch (e) {
        rejectFn(new Error(`py_validate produced non-JSON output: ${stdout}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// ─── Zod validation ──────────────────────────────────────────────────────

function runZod(zodSchema, payload) {
  const result = zodSchema.safeParse(payload);
  if (result.success) return { ok: true };
  const errors = result.error instanceof ZodError
    ? result.error.errors.map((e) => ({
        path: e.path,
        message: e.message,
        type: e.code,
      }))
    : [{ path: [], message: String(result.error) }];
  return { ok: false, errors };
}

// ─── Per-fixture run ─────────────────────────────────────────────────────

async function runFixture({ contract, zodSchema, fixtureName, fixturePath }) {
  const raw = JSON.parse(await readFile(fixturePath, 'utf-8'));
  const { payload, meta } = stripMeta(raw);
  const category = meta._category || (fixtureName.startsWith('negative-') ? 'unknown-negative' : 'positive');
  const expectPass = category === 'positive';

  const zodVerdict = runZod(zodSchema, payload);
  const pyVerdict = await runPydantic(contract.pyContract, payload);

  const zodOk = zodVerdict.ok;
  const pyOk = pyVerdict.ok;

  // Verdicts must match each other AND match expected.
  const verdictsMatch = zodOk === pyOk;
  const verdictMatchesExpected = zodOk === expectPass;

  return {
    contract: contract.name,
    fixture: fixtureName,
    category,
    expectPass,
    zod: zodVerdict,
    pydantic: pyVerdict,
    pass: verdictsMatch && verdictMatchesExpected,
    failureReason: !verdictsMatch
      ? 'verdict_mismatch'
      : !verdictMatchesExpected
        ? (expectPass ? 'positive_fixture_rejected' : 'negative_fixture_accepted')
        : null,
  };
}

// ─── Per-contract run ────────────────────────────────────────────────────

async function runContract(contract) {
  // Dynamically import the Zod schema.
  const zodModule = await import(resolve(__dirname, contract.zodModule));
  const zodSchema = zodModule[contract.zodExport];
  if (!zodSchema) {
    throw new Error(`${contract.name}: Zod export ${contract.zodExport} not found in ${contract.zodModule}`);
  }

  const fixturesDir = resolve(__dirname, contract.fixturesDir);
  const files = (await readdir(fixturesDir)).filter((f) => f.endsWith('.json')).sort();

  const results = [];
  const categoriesSeen = new Set();

  for (const file of files) {
    const fixtureName = file.replace(/\.json$/, '');
    const result = await runFixture({
      contract,
      zodSchema,
      fixtureName,
      fixturePath: join(fixturesDir, file),
    });
    results.push(result);
    if (!result.expectPass) categoriesSeen.add(result.category);
  }

  // Category coverage check. A contract may opt out of categories with
  // documented justification (e.g. a known pipeline drift that prevents
  // a cross-field invariant from holding in production).
  const skip = new Set(contract.skipCategories || []);
  const missingCategories = REQUIRED_NEGATIVE_CATEGORIES
    .filter((c) => !skip.has(c))
    .filter((c) => !categoriesSeen.has(c));
  return { contract: contract.name, results, missingCategories, skippedCategories: [...skip] };
}

// ─── Reporting ───────────────────────────────────────────────────────────

function formatVerdict(label, verdict, expectPass) {
  const ok = verdict.ok;
  const expected = expectPass ? 'PASS' : 'FAIL';
  const actual = ok ? 'PASS' : 'FAIL';
  const marker = ok === expectPass ? '✓' : '✗';
  let line = `    ${label.padEnd(8)}: ${actual} (expected ${expected}) ${marker}`;
  if (!ok && verdict.errors && verdict.errors.length > 0) {
    const first = verdict.errors[0];
    const path = (first.path || []).join('.') || '<root>';
    line += `\n              first error: ${path} — ${first.message}`;
  }
  return line;
}

function printReport(perContract) {
  let totalFixtures = 0;
  let totalFailures = 0;

  for (const cr of perContract) {
    console.log(`\n=== ${cr.contract} ===`);
    for (const r of cr.results) {
      totalFixtures += 1;
      const marker = r.pass ? '✓' : '✗';
      console.log(`  ${marker} ${r.fixture} [${r.category}]`);
      if (!r.pass) {
        totalFailures += 1;
        console.log(`    failure: ${r.failureReason}`);
        console.log(formatVerdict('Zod', r.zod, r.expectPass));
        console.log(formatVerdict('Pydantic', r.pydantic, r.expectPass));
      }
    }
    if (cr.missingCategories.length > 0) {
      totalFailures += 1;
      console.log(`  ✗ category coverage: missing ${cr.missingCategories.join(', ')} in negative fixtures`);
    }
    if (cr.skippedCategories.length > 0) {
      console.log(`  ⊘ skipping categories: ${cr.skippedCategories.join(', ')} (documented in contracts.config.mjs)`);
    }
  }

  console.log('');
  console.log(`Summary: ${totalFixtures - totalFailures}/${totalFixtures} fixtures passed; ${perContract.length} contracts checked.`);
  return totalFailures === 0;
}

// ─── Sanity: registration coverage ───────────────────────────────────────
//
// Catches the "wrote a schema, forgot to register it" failure mode.
// Every *.mjs in zod/ must have a config entry, and every config entry
// must point at an existing file. Same for pydantic/builting_contracts/*.py.
// The Pydantic side is checked indirectly via py_validate.py imports during
// fixture runs — but we still verify the Zod export name resolves before
// running any fixtures.

async function checkRegistration() {
  const errors = [];
  const zodDir = resolve(__dirname, '../zod');
  const pyDir = resolve(__dirname, '../pydantic/builting_contracts');

  const zodFiles = (await readdir(zodDir))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.replace(/\.mjs$/, ''));

  const pyFiles = (await readdir(pyDir))
    .filter((f) => f.endsWith('.py') && f !== '__init__.py')
    .map((f) => f.replace(/\.py$/, ''));

  const configByZod = new Map(contracts.map((c) => {
    const stem = c.zodModule.replace(/^.*\//, '').replace(/\.mjs$/, '');
    return [stem, c];
  }));
  const configByPy = new Map(contracts.map((c) => [c.pyContract, c]));

  for (const stem of zodFiles) {
    if (!configByZod.has(stem)) {
      errors.push(`zod/${stem}.mjs exists but has no entry in contracts.config.mjs`);
    }
  }
  for (const stem of pyFiles) {
    if (!configByPy.has(stem)) {
      errors.push(`pydantic/builting_contracts/${stem}.py exists but has no entry in contracts.config.mjs`);
    }
  }
  for (const c of contracts) {
    const zodStem = c.zodModule.replace(/^.*\//, '').replace(/\.mjs$/, '');
    if (!zodFiles.includes(zodStem)) {
      errors.push(`config "${c.name}" references zod/${zodStem}.mjs which does not exist`);
    }
    if (!pyFiles.includes(c.pyContract)) {
      errors.push(`config "${c.name}" references pydantic ${c.pyContract}.py which does not exist`);
    }
  }
  return errors;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  if (contracts.length === 0) {
    console.error('No contracts configured in contracts.config.mjs');
    process.exit(1);
  }

  const regErrors = await checkRegistration();
  if (regErrors.length > 0) {
    console.error('Registration check failed:');
    for (const e of regErrors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  const perContract = [];
  for (const contract of contracts) {
    perContract.push(await runContract(contract));
  }

  const ok = printReport(perContract);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Runner crashed:', err);
  process.exit(2);
});
