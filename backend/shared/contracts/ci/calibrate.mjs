#!/usr/bin/env node
// Calibration runner — validates the new contracts against REAL artifacts
// from S3 for completed renders. Confirms the contracts match what the
// current pipeline produces before lambda integration ships.
//
// Usage:
//   node ci/calibrate.mjs                          # uses RENDERS below
//   node ci/calibrate.mjs --user=user-1 --render=<uuid>  # validate one
//
// Output: per-render, per-artifact pass/fail. On failure, prints first
// 5 errors with their JSON paths.
//
// This is NOT in the CI workflow — calibration runs manually, ad-hoc,
// against production data. CI uses the synthetic fixtures in fixtures/.

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';

import { claimsContract } from '../zod/claims.mjs';
import { cssRawContract } from '../zod/cssRaw.mjs';
import { canonicalContract } from '../zod/canonical.mjs';
import { validatedCssContract } from '../zod/validatedCss.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PY_VALIDATE = join(__dirname, 'py_validate.py');
const CACHE_DIR = resolve(__dirname, '../.calibration-cache');

// Hand-picked from `aws dynamodb scan ... status='completed'`. Covers a
// hospital (BuildingSpec extract path) + a tunnel (VSM extract path).
const RENDERS = [
  {
    label: 'hospital',
    userId: 'user-1',
    renderId: '174fdb79-4751-4902-9794-1e5a935bcd0f',
    title: 'Cedar Valley Community Hospital — 2-Story Acute Care Hospital',
  },
  {
    label: 'tunnel',
    userId: 'user-1',
    renderId: '2b8e02f0-9944-4eb3-9f56-4afa370f8aa9',
    title: 'Tunnel Network (Zion / Beggars Tomb)',
  },
];

const ARTIFACTS = [
  {
    name: 'claims.json',
    keyTemplate: 'uploads/{userId}/{renderId}/pipeline/v1/claims.json',
    contract: claimsContract,
    pyContract: 'claims',
  },
  {
    name: 'css_raw.json',
    keyTemplate: 'uploads/{userId}/{renderId}/css/css_raw.json',
    contract: cssRawContract,
    pyContract: 'css_raw',
  },
  {
    name: 'canonical_observed.json',
    keyTemplate: 'uploads/{userId}/{renderId}/pipeline/v1/canonical_observed.json',
    contract: canonicalContract,
    pyContract: 'canonical',
  },
  {
    name: 'css_processed.json',
    keyTemplate: 'uploads/{userId}/{renderId}/css/css_processed.json',
    contract: validatedCssContract,
    pyContract: 'validated_css',
  },
];

const BUCKET = 'builting-data';
const REGION = 'us-gov-east-1';
const PROFILE = 'leidos';

// ─── S3 download with local cache ────────────────────────────────────────

function awsS3Download(key, dest) {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn('aws', [
      's3', 'cp', `s3://${BUCKET}/${key}`, dest,
      '--region', REGION, '--profile', PROFILE,
      '--no-progress',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`aws s3 cp ${key} failed: ${stderr}`));
    });
  });
}

async function fetchArtifact(key) {
  const cachePath = join(CACHE_DIR, key.replace(/\//g, '__'));
  if (!existsSync(cachePath)) {
    await mkdir(CACHE_DIR, { recursive: true });
    await awsS3Download(key, cachePath);
  }
  return JSON.parse(await readFile(cachePath, 'utf-8'));
}

// ─── Validators (same as run-roundtrip) ──────────────────────────────────

function runZod(schema, payload) {
  const result = schema.safeParse(payload);
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

function runPydantic(contractName, payload) {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn('python3', [PY_VALIDATE, `--contract=${contractName}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', rejectFn);
    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        rejectFn(new Error(`py_validate exited ${code}: ${stderr || stdout}`));
        return;
      }
      try { resolveFn(JSON.parse(stdout)); }
      catch (e) { rejectFn(new Error(`py_validate non-JSON output: ${stdout}`)); }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// ─── Per-render run ──────────────────────────────────────────────────────

function formatErrors(errors, max = 5) {
  return errors.slice(0, max).map((e) => {
    const path = (e.path || []).join('.') || '<root>';
    return `      ${path} — ${e.message}`;
  }).join('\n');
}

async function validateOne(render, artifact) {
  const key = artifact.keyTemplate
    .replace('{userId}', render.userId)
    .replace('{renderId}', render.renderId);
  let payload;
  try {
    payload = await fetchArtifact(key);
  } catch (e) {
    return { ok: false, fetchError: e.message };
  }

  const zod = runZod(artifact.contract, payload);
  const py = await runPydantic(artifact.pyContract, payload);

  return {
    ok: zod.ok && py.ok,
    zod,
    pydantic: py,
    payloadShapeKeys: Object.keys(payload || {}),
    payloadElementCount: Array.isArray(payload?.elements)
      ? payload.elements.length
      : Array.isArray(payload?.claims)
        ? payload.claims.length
        : Array.isArray(payload?.observations)
          ? payload.observations.length
          : null,
  };
}

async function main() {
  console.log('Calibration: validating real S3 artifacts against PR 1 contracts\n');
  let totalChecks = 0;
  let totalFailures = 0;
  const summary = [];

  for (const render of RENDERS) {
    console.log(`=== ${render.label} (${render.title}) ===`);
    console.log(`    renderId: ${render.renderId}`);
    for (const artifact of ARTIFACTS) {
      totalChecks += 1;
      const result = await validateOne(render, artifact);
      const sizeNote = result.payloadElementCount !== null
        ? ` [${result.payloadElementCount} items]`
        : '';

      if (result.fetchError) {
        totalFailures += 1;
        console.log(`  ✗ ${artifact.name}: FETCH ERROR — ${result.fetchError}`);
        summary.push({ render: render.label, artifact: artifact.name, status: 'fetch_error' });
        continue;
      }

      if (result.ok) {
        console.log(`  ✓ ${artifact.name}${sizeNote}`);
        summary.push({ render: render.label, artifact: artifact.name, status: 'pass' });
      } else {
        totalFailures += 1;
        console.log(`  ✗ ${artifact.name}${sizeNote}`);
        if (!result.zod.ok) {
          console.log(`    Zod errors (${result.zod.errors.length} total, top 5):`);
          console.log(formatErrors(result.zod.errors));
        }
        if (!result.pydantic.ok) {
          console.log(`    Pydantic errors (${result.pydantic.errors.length} total, top 5):`);
          console.log(formatErrors(result.pydantic.errors));
        }
        if (result.zod.ok !== result.pydantic.ok) {
          console.log(`    >>> VERDICT MISMATCH: Zod=${result.zod.ok ? 'PASS' : 'FAIL'}, Pydantic=${result.pydantic.ok ? 'PASS' : 'FAIL'}`);
        }
        summary.push({
          render: render.label,
          artifact: artifact.name,
          status: 'fail',
          zodErrors: result.zod.ok ? 0 : result.zod.errors.length,
          pyErrors: result.pydantic.ok ? 0 : result.pydantic.errors.length,
          verdictMismatch: result.zod.ok !== result.pydantic.ok,
        });
      }
    }
    console.log('');
  }

  console.log(`Summary: ${totalChecks - totalFailures}/${totalChecks} artifacts validated successfully`);
  await writeFile(
    resolve(__dirname, '../.calibration-results.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(`Detail written to .calibration-results.json`);
  process.exit(totalFailures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Calibration crashed:', err);
  process.exit(2);
});
