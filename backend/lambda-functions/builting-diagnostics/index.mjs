import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { deflateRawSync } from 'zlib';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const IFC_BUCKET = process.env.IFC_BUCKET || 'builting-ifc';
const DATA_BUCKET = process.env.DATA_BUCKET || 'builting-data';
const RENDERS_TABLE = process.env.RENDERS_TABLE || 'builting-renders';
const ZIP_PRESIGN_TTL = 900; // 15 min
const ZIP_CACHE_TTL_MS = 14 * 60 * 1000; // 14 min — just under presigned URL lifetime

export const handler = async (event) => {
  const { userId, renderId } = event;
  if (!userId || !renderId) return { error: 'userId and renderId required', statusCode: 400 };

  const { Item: render } = await dynamo.send(new GetCommand({
    TableName: RENDERS_TABLE,
    Key: { user_id: userId, render_id: renderId },
  }));
  if (!render) return { error: 'Render not found', statusCode: 404 };

  const zipKey = `${renderId}/diagnostics.zip`;

  // Return cached ZIP if still within presigned URL lifetime
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: IFC_BUCKET, Key: zipKey }));
    if (Date.now() - new Date(head.LastModified).getTime() < ZIP_CACHE_TTL_MS) {
      return { downloadUrl: await presign(zipKey, renderId) };
    }
  } catch (_) { /* not cached — assemble below */ }

  const zipBuffer = await assembleZip(userId, renderId, render);

  await s3.send(new PutObjectCommand({
    Bucket: IFC_BUCKET,
    Key: zipKey,
    Body: zipBuffer,
    ContentType: 'application/zip',
  }));

  return { downloadUrl: await presign(zipKey, renderId) };
};

async function presign(key, renderId) {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: IFC_BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="diagnostics-${renderId}.zip"`,
    ResponseContentType: 'application/zip',
  }), { expiresIn: ZIP_PRESIGN_TTL });
}

async function assembleZip(userId, renderId, render) {
  const cssKey = `uploads/${userId}/${renderId}/css/css_processed.json`;

  // Parallel list of all S3 prefixes + direct IFC fetch + css_processed.json
  const [traceKeys, auditKeys, inputKeys, ifcBuf, cssProcessedBuf] = await Promise.all([
    listPrefix(IFC_BUCKET, `${renderId}/pipeline_trace/`),
    listPrefix(IFC_BUCKET, `${renderId}/diagnostics/`),
    listPrefix(DATA_BUCKET, `uploads/${userId}/${renderId}/`),
    fetchBuf(IFC_BUCKET, `${userId}/${renderId}/model.ifc`).catch(() => null),
    fetchBuf(DATA_BUCKET, cssKey).catch(() => null),
  ]);

  // Only top-level input files — exclude pipeline/ css/ subdirs
  const inputPfx = `uploads/${userId}/${renderId}/`;
  const rootInputKeys = inputKeys.filter(k => !k.slice(inputPfx.length).includes('/'));

  // Build fetch task list — { bucket, key, zipPath }
  const tasks = [
    ...traceKeys.map(k => ({
      bucket: IFC_BUCKET, key: k,
      zipPath: `diagnostics/${renderId}/trace/${k.split('/').pop()}`,
    })),
    ...auditKeys.map(k => {
      const rel = k.slice(`${renderId}/diagnostics/`.length);
      // contract failures go to contracts/ not audit/
      const zipPath = rel.startsWith('contracts/')
        ? `diagnostics/${renderId}/${rel}`
        : `diagnostics/${renderId}/audit/${rel}`;
      return { bucket: IFC_BUCKET, key: k, zipPath };
    }),
    ...rootInputKeys.map(k => ({
      bucket: DATA_BUCKET, key: k,
      zipPath: `diagnostics/${renderId}/inputs/${k.split('/').pop()}`,
    })),
  ];

  // Parallel fetch — failures are silently skipped (artifact may not exist yet)
  const fetched = (await Promise.all(
    tasks.map(async ({ bucket, key, zipPath }) => {
      const buf = await fetchBuf(bucket, key).catch(() => null);
      return buf ? { zipPath, buf } : null;
    })
  )).filter(Boolean);

  const files = [];

  files.push({ name: `diagnostics/${renderId}/README.md`, data: Buffer.from(buildReadme(renderId, render)) });
  files.push({
    name: `diagnostics/${renderId}/manifest.json`,
    data: Buffer.from(JSON.stringify({
      renderId,
      renderStatus: render.status,
      generatedAt: new Date().toISOString(),
      files: fetched.map(f => f.zipPath),
    }, null, 2)),
  });
  files.push({ name: `diagnostics/${renderId}/bld-query/bld_query.py`, data: Buffer.from(BLD_QUERY_PY) });
  files.push({ name: `diagnostics/${renderId}/bld-query/requirements.txt`, data: Buffer.from(BLD_QUERY_REQUIREMENTS) });

  for (const { zipPath, buf } of fetched) {
    files.push({ name: zipPath, data: buf });
  }

  if (ifcBuf) {
    files.push({ name: `diagnostics/${renderId}/output/output.ifc`, data: ifcBuf });
  }

  if (cssProcessedBuf) {
    files.push({ name: `diagnostics/${renderId}/css/css_processed.json`, data: cssProcessedBuf });
  }

  // Empty placeholder if no contract failures were found in the diagnostics prefix
  const hasContractFailures = auditKeys.some(k => k.includes('/diagnostics/contracts/'));
  if (!hasContractFailures) {
    files.push({ name: `diagnostics/${renderId}/contracts/failures.jsonl`, data: Buffer.alloc(0) });
  }

  return buildZip(files);
}

async function listPrefix(bucket, prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const obj of res.Contents || []) {
      if (obj.Key !== prefix) keys.push(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function fetchBuf(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

// ── README ────────────────────────────────────────────────────────────────────

function buildReadme(renderId, render) {
  return `# Builting Diagnostics Bundle

Render ID: ${renderId}
Status:    ${render.status || 'unknown'}
Generated: ${new Date().toISOString()}

An engineer or Claude Code agent can debug any pipeline issue using only
this bundle. No CloudWatch access required.

---

## Layout

\`\`\`
diagnostics/${renderId}/
  README.md           This file
  manifest.json       Index of all files in this bundle
  trace/              Pipeline stage snapshots (one JSON per stage per attempt)
  audit/              Decision + validation logs per stage (JSONL)
  contracts/          Contract failure records (empty file = all stages passed)
  output/             Generated IFC model (output.ifc)
  inputs/             Original user-uploaded source files
  css/                css_processed.json — post-topology elements (used by bld-query validate)
  bld-query/          Geometric query CLI (bld_query.py + requirements.txt)
\`\`\`

---

## trace/

Files: \`<stage>.<runId>.<attempt>.json\`
Pipeline order: extract → resolve → topology → generate → store

A file with phase="start" only means the lambda crashed before completing.
End entries include:
  startedAt / finishedAt              ISO-8601 UTC wall-clock timestamps
  output.counts                       Element counts produced at this stage
  output.validationFlags              Warning/critical flags emitted
  scalars.gatePassRate                % gates passed (null for extract + store)
  scalars.contractStatus              "pass" or "fail"
  scalars.provenanceCompleteness      % elements with non-"missing" provenance
  scalars.validationSummary           { total, passed, warned, failed } per stage

---

## audit/

Subdirectories: extract/, resolve/, topology/, generate/
Each has: decisions.jsonl, validation.jsonl

Decision entry schema:
  { "ts":"...", "stage":"topology", "pass":"snap", "element_id":"wall_47",
    "action":"endpoint_modified", "before":{...}, "after":{...},
    "reason":"snap_within_tolerance", "params":{"distance_mm":40,"tolerance_mm":50} }

Validation entry schema:
  { "ts":"...", "stage":"topology", "validator":"spatialContainment",
    "element_id":"cable_tray_8", "result":"warn",
    "expected":"element centroid inside host \\"ventsim_branch_235\\" bbox (±5m margin)",
    "actual":"centroid (45.2,89.1,0.9) outside bbox", "severity":"warning" }

Grep for an element across all stages:
  grep "wall_47" audit/*/decisions.jsonl | sort
  grep "cable_tray_8" audit/*/validation.jsonl | jq .

All topology modifications:
  grep '"action"' audit/topology/decisions.jsonl | jq -r .action | sort | uniq -c

---

## contracts/

failures.jsonl — one line per contract failure. Empty file = all stages passed.
Format: { "stage":"...", "contract":"...", "error":"...", "ts":"..." }

---

## output/

output.ifc — IFC4 model. Open in Revit, BIMcollab, or the built-in web viewer.

---

## inputs/

Original files uploaded by the user for this render.

---

## css/

css_processed.json — all elements after topology inference and validation annotation.
Used by bld-query to re-run validators locally without CloudWatch access.

---

## bld-query/

Diagnostic CLI — runs entirely against this local bundle. No network calls.

Install:
  pip install -r bld-query/requirements.txt

Commands:
  python bld-query/bld_query.py history <element_id>
  python bld-query/bld_query.py validate <validator_name>
  python bld-query/bld_query.py overlaps <element_a> <element_b>
  python bld-query/bld_query.py containment <element_id> <x,y,z>

Real examples from a tunnel render:

  # Trace why cable_tray_8 has a spatialContainment warning:
  python bld-query/bld_query.py history cable_tray_8

  # Expected output shows:
  #   [topology] VALIDATION  validator=spatialContainment  result=warn
  #              expected: element centroid inside host "ventsim_branch_235" bbox (±5m margin)
  #              actual:   centroid (45.2,89.1,0.9) outside bbox
  #              host_id: ventsim_branch_235
  #              host bbox X:[55.2, 80.7]  Y:[78.8, 82.8]
  # The host's X range starts at 55m but cable_tray_8 centroid is at X=45m — 10m gap.
  # Root cause: VentSim coordinate frame mismatch.

  # Re-run spatial containment check across all elements:
  python bld-query/bld_query.py validate spatial_containment
  # Reproduces all 25 warnings from the topology stage.

  # Check if ventsim_branch_268 is inside a known-good host:
  python bld-query/bld_query.py history ventsim_branch_268
  # Shows which host was assigned and by what reason.

  # Check if a specific point is inside an element's bbox:
  python bld-query/bld_query.py containment ventsim_branch_235 70.0,80.5,0.0

  # Check if two elements' bboxes intersect (requires output/output.ifc):
  python bld-query/bld_query.py overlaps cable_tray_8 ventsim_branch_235

Available validators:
  spatial_containment     MEP elements whose centroid falls outside declared host bbox
  branch_connectivity     Branch-type elements with 0 network connections
  wall_runs_connected     Wall endpoints near (< 500mm) but not coincident (< 10mm)
  joint_angle_plausible   Path-connection angles outside expected range per joint type
  slab_storey_consistency Slab containers not mapped to a known storey (building domain)

---

## Debugging workflow

1. Open output/output.ifc in a viewer. Note the element GUID or name.
2. Find its element_id:
     grep "<name>" audit/generate/decisions.jsonl
3. Full history across all stages:
     python bld-query/bld_query.py history <element_id>
4. Re-run a validator to confirm or rule out a bug class:
     python bld-query/bld_query.py validate spatial_containment
5. Check topology trace scalars:
     jq '.scalars' trace/topology.*.json
6. Confirm what host was assigned during topology:
     grep "<element_id>" audit/topology/decisions.jsonl | jq .

---

## Known pipeline bugs (do not re-investigate)

1. elementCounts drift
   cssRaw.elementCounts may be stale after extract appends claims.
   validatedCss.elementCounts may drift after the topology v2 adapter runs.
   Cross-field element count checks are DISABLED until fixed.

2. modelExtent drift
   Coordinate-frame normalization in topology can shift centroids, causing a
   mismatch between the declared extent and the actual geometry bounding box.
   Does not affect IFC file validity.

3. VSM host assignment mismatch (25 spatialContainment warnings)
   VentSim branches assigned to hosts 10-36m away — coordinate-frame mismatch
   between VentSim coordinate system and topology model. Use bld-query history
   on cable_tray_8 or ventsim_branch_268 to inspect. Fix is upstream in topology
   host resolution logic (applyEquipmentMounting / applyStructuralIntegration).

---
Generated by builting-diagnostics v2 (PR 9)
`;
}

// ── bld-query CLI ─────────────────────────────────────────────────────────────

const BLD_QUERY_PY = `#!/usr/bin/env python3
"""
bld_query.py -- Builting diagnostics CLI
Runs against the local diagnostics bundle. No network calls.

Usage:
  python bld_query.py history <element_id>
  python bld_query.py validate <validator_name>
  python bld_query.py overlaps <element_a> <element_b>
  python bld_query.py containment <element_id> <x,y,z>
"""

import glob
import json
import math
import os
import re
import sys

# Bundle root: diagnostics/<renderId>/  (two levels up from bld-query/bld_query.py)
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
BUNDLE_ROOT = os.path.dirname(SCRIPT_DIR)
AUDIT_DIR   = os.path.join(BUNDLE_ROOT, 'audit')
CSS_FILE    = os.path.join(BUNDLE_ROOT, 'css', 'css_processed.json')
IFC_FILE    = os.path.join(BUNDLE_ROOT, 'output', 'output.ifc')


# ── helpers ------------------------------------------------------------------

def _load_css():
    if not os.path.exists(CSS_FILE):
        print(f"ERROR: css_processed.json not found at {CSS_FILE}", file=sys.stderr)
        sys.exit(1)
    with open(CSS_FILE) as f:
        return json.load(f)


def _iter_jsonl(path):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    pass


def _scan_all_jsonl():
    entries = []
    for jsonl_path in glob.glob(os.path.join(AUDIT_DIR, '**', '*.jsonl'), recursive=True):
        for entry in _iter_jsonl(jsonl_path):
            entries.append(entry)
    return sorted(entries, key=lambda e: e.get('ts', ''))


def _elem_id(e):
    return e.get('element_key') or e.get('id') or '(unknown)'


def _dist3(a, b):
    dx = (a.get('x') or 0) - (b.get('x') or 0)
    dy = (a.get('y') or 0) - (b.get('y') or 0)
    dz = (a.get('z') or 0) - (b.get('z') or 0)
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def _path_midpoint(pp):
    if not pp:
        return None
    m = pp[len(pp) // 2]
    return {'x': m.get('x', 0), 'y': m.get('y', 0), 'z': m.get('z', 0)}


def _elem_bbox(elem):
    geom    = elem.get('geometry') or {}
    pp      = geom.get('pathPoints')
    profile = geom.get('profile') or {}
    half_w  = max(profile.get('width', 0), profile.get('radius', 0) * 2, 0.2) / 2

    if pp and len(pp) >= 2:
        xs = [p.get('x', 0) for p in pp]
        ys = [p.get('y', 0) for p in pp]
        zs = [p.get('z', 0) for p in pp]
        return {
            'minX': min(xs) - half_w, 'maxX': max(xs) + half_w,
            'minY': min(ys) - half_w, 'maxY': max(ys) + half_w,
            'minZ': min(zs) - half_w, 'maxZ': max(zs) + half_w,
        }

    o        = (elem.get('placement') or {}).get('origin') or {}
    half_len = (geom.get('depth') or 1) / 2
    return {
        'minX': (o.get('x', 0)) - half_len, 'maxX': (o.get('x', 0)) + half_len,
        'minY': (o.get('y', 0)) - half_w,   'maxY': (o.get('y', 0)) + half_w,
        'minZ': (o.get('z', 0)) - half_w,   'maxZ': (o.get('z', 0)) + half_w,
    }


# ── command: history ---------------------------------------------------------

def cmd_history(element_id):
    if not os.path.isdir(AUDIT_DIR):
        print(f"ERROR: audit/ dir not found at {AUDIT_DIR}", file=sys.stderr)
        sys.exit(1)

    all_entries = _scan_all_jsonl()
    matching    = [e for e in all_entries if e.get('element_id') == element_id]

    if not matching:
        print(f"No audit entries found for element_id='{element_id}'")
        return

    print(f"=== Audit history for '{element_id}' ({len(matching)} entries) ===")
    print()
    for entry in matching:
        ts    = entry.get('ts', '?')
        stage = entry.get('stage', '?')

        if 'action' in entry:
            action = entry.get('action', '?')
            reason = entry.get('reason', '?')
            params = entry.get('params') or {}
            print(f"[{ts}] [{stage}] DECISION  action={action}  reason={reason}")
            for k, v in params.items():
                print(f"           {k}: {v}")
        elif 'validator' in entry:
            validator = entry.get('validator', '?')
            result    = entry.get('result', '?')
            expected  = entry.get('expected', '?')
            actual    = entry.get('actual', '?')
            severity  = entry.get('severity', '?')
            params    = entry.get('params') or {}
            print(f"[{ts}] [{stage}] VALIDATION  validator={validator}  result={result}  severity={severity}")
            print(f"           expected: {expected}")
            print(f"           actual:   {actual}")
            for k, v in params.items():
                print(f"           {k}: {v}")
        else:
            print(f"[{ts}] [{stage}] {json.dumps(entry)}")
        print()


# ── validators (mirrors topology-validators.mjs) ------------------------------

VALIDATORS = {}

def _register(name):
    def dec(fn):
        VALIDATORS[name] = fn
        return fn
    return dec


@_register('spatial_containment')
def validate_spatial_containment(elements, css=None):
    MEP_TYPES = {'DUCT', 'PIPE', 'CABLE_TRAY', 'EQUIPMENT', 'FAN', 'PUMP', 'LIGHT'}
    MARGIN    = 5.0
    issues    = []
    by_key    = {_elem_id(e): e for e in elements if _elem_id(e) != '(unknown)'}

    for elem in elements:
        etype = (elem.get('type') or '').upper()
        if etype not in MEP_TYPES:
            continue

        geom  = elem.get('geometry')  or {}
        meta  = elem.get('metadata')  or {}
        props = elem.get('properties') or {}

        host_key = (meta.get('parentSegment')             or
                    meta.get('hostSegmentId')              or
                    props.get('hostStructuralBranchMatched') or
                    props.get('derivedFromBranch')          or
                    props.get('hostBranch'))
        if not host_key:
            continue
        host = by_key.get(host_key)
        if not host:
            continue

        pp       = geom.get('pathPoints')
        centroid = _path_midpoint(pp) or (elem.get('placement') or {}).get('origin')
        if not centroid:
            continue

        bbox = _elem_bbox(host)
        cx, cy, cz = centroid.get('x', 0), centroid.get('y', 0), centroid.get('z', 0)

        if (cx < bbox['minX'] - MARGIN or cx > bbox['maxX'] + MARGIN or
                cy < bbox['minY'] - MARGIN or cy > bbox['maxY'] + MARGIN or
                cz < bbox['minZ'] - MARGIN or cz > bbox['maxZ'] + MARGIN):
            issues.append({
                'validator': 'spatialContainment',
                'element_id': _elem_id(elem),
                'result': 'warn',
                'expected': f'centroid inside host "{host_key}" bbox (+/-{MARGIN}m margin)',
                'actual': f'centroid ({cx:.1f},{cy:.1f},{cz:.1f}) outside bbox',
                'severity': 'warning',
                'params': {
                    'element_id': _elem_id(elem),
                    'host_id': host_key,
                    'element_centroid': centroid,
                    'host_bbox': bbox,
                },
            })
    return issues


@_register('branch_connectivity')
def validate_branch_connectivity(elements, css=None):
    BRANCH_TYPES         = {'TUNNEL_SEGMENT', 'DUCT', 'PIPE'}
    referenced_as_target = set()
    for e in elements:
        for rel in (e.get('relationships') or []):
            if rel.get('target'):
                referenced_as_target.add(rel['target'])

    issues = []
    for elem in elements:
        etype = (elem.get('type') or '').upper()
        if etype not in BRANCH_TYPES:
            continue
        props = elem.get('properties') or {}
        meta  = elem.get('metadata')  or {}
        if props.get('isTerminal') or meta.get('isTerminal') or props.get('branchClass') == 'TERMINAL':
            continue
        k           = _elem_id(elem)
        has_outgoing = any(
            r.get('target') and (r.get('type') == 'PATH' or r.get('connectionType'))
            for r in (elem.get('relationships') or [])
        )
        if not has_outgoing and k not in referenced_as_target:
            issues.append({
                'validator': 'branchConnectivity',
                'element_id': k,
                'result': 'warn',
                'expected': 'element has >= 1 path connection or is referenced as a target',
                'actual': '0 connections and not referenced by any element',
                'severity': 'warning',
                'params': {'branch_id': k, 'unconnected_endpoints': ['start', 'end']},
            })
    return issues


@_register('wall_runs_connected')
def validate_wall_runs_connected(elements, css=None):
    SNAP  = 0.5
    COIN  = 0.01
    issues = []

    walls = [e for e in elements
             if (e.get('type') or '').upper() == 'WALL'
             and (e.get('placement') or {}).get('origin')]
    if not walls:
        return issues

    wall_endpoints = []
    for w in walls:
        o  = w['placement']['origin']
        sp = (w.get('properties') or {}).get('startPoint') or (w.get('geometry') or {}).get('startPoint')
        ep = (w.get('properties') or {}).get('endPoint')   or (w.get('geometry') or {}).get('endPoint')
        if sp and ep and isinstance(sp, dict) and isinstance(ep, dict):
            wall_endpoints.append({'elem': w, 'pts': [sp, ep]})
        else:
            half_len = (w.get('geometry') or {}).get('depth', 0) / 2
            if half_len > 0.001:
                pts = [
                    {'x': o.get('x', 0) - half_len, 'y': o.get('y', 0), 'z': o.get('z', 0)},
                    {'x': o.get('x', 0) + half_len, 'y': o.get('y', 0), 'z': o.get('z', 0)},
                ]
            else:
                pts = [{'x': o.get('x', 0), 'y': o.get('y', 0), 'z': o.get('z', 0)}]
            wall_endpoints.append({'elem': w, 'pts': pts})

    for i, wi in enumerate(wall_endpoints):
        for pt in wi['pts']:
            nearest_dist = float('inf')
            nearest_id   = None
            coincident   = False
            for j, wj in enumerate(wall_endpoints):
                if i == j:
                    continue
                for pt2 in wj['pts']:
                    d = _dist3(pt, pt2)
                    if d < COIN:
                        coincident = True
                        break
                    if d < nearest_dist:
                        nearest_dist = d
                        nearest_id   = _elem_id(wj['elem'])
                if coincident:
                    break
            if not coincident and nearest_dist < SNAP:
                issues.append({
                    'validator': 'wallRunsConnected',
                    'element_id': _elem_id(wi['elem']),
                    'result': 'warn',
                    'expected': 'wall endpoint coincident with neighbor (< 10mm)',
                    'actual': f'nearest endpoint {round(nearest_dist * 1000)}mm away',
                    'severity': 'warning',
                    'params': {
                        'wall_id': _elem_id(wi['elem']),
                        'endpoint': pt,
                        'nearest_wall_id': nearest_id,
                        'distance_mm': round(nearest_dist * 1000),
                    },
                })
                break
    return issues


@_register('joint_angle_plausible')
def validate_joint_angle_plausible(elements, css=None):
    JOINT_RULES = {
        'MITRE': {'center': 45, 'tol': 10},
        'BUTT':  {'center': 90, 'tol': 5},
        'TEE':   {'center': 90, 'tol': 15},
    }
    issues = []
    for elem in elements:
        for rel in (elem.get('relationships') or []):
            angle  = rel.get('connectionAngle')
            j_type = (rel.get('connectionType') or '').upper()
            if angle is None or j_type not in JOINT_RULES:
                continue
            rule      = JOINT_RULES[j_type]
            deviation = abs(angle - rule['center'])
            if deviation > rule['tol']:
                issues.append({
                    'validator': 'jointAnglePlausible',
                    'element_id': _elem_id(elem),
                    'result': 'warn',
                    'expected': f'{j_type} angle within +/-{rule["tol"]} of {rule["center"]} deg',
                    'actual': f'{angle} deg (deviation {round(deviation)} deg)',
                    'severity': 'warning',
                    'params': {
                        'element_id': _elem_id(elem),
                        'joint_type': j_type,
                        'actual_angle': angle,
                        'expected_range': [rule['center'] - rule['tol'], rule['center'] + rule['tol']],
                    },
                })
    return issues


@_register('slab_storey_consistency')
def validate_slab_storey_consistency(elements, css=None):
    domain     = ((css or {}).get('domain') or '').upper()
    storey_ids = set()
    for ls in ((css or {}).get('levelsOrSegments') or []):
        if ls.get('type') in ('STOREY', 'LEVEL', 'FLOOR'):
            storey_ids.add(ls.get('id'))
    for e in elements:
        if (e.get('type') or '').upper() in ('STOREY', 'LEVEL'):
            storey_ids.add(_elem_id(e))

    issues = []
    for elem in elements:
        if (elem.get('type') or '').upper() != 'SLAB':
            continue
        container = elem.get('container')
        if not container:
            issues.append({
                'validator': 'slabStoreyConsistency',
                'element_id': _elem_id(elem),
                'result': 'fail',
                'expected': 'slab.container references a storey',
                'actual': 'null',
                'severity': 'warning',
            })
        elif domain != 'TUNNEL' and container not in storey_ids:
            issues.append({
                'validator': 'slabStoreyConsistency',
                'element_id': _elem_id(elem),
                'result': 'warn',
                'expected': f'container "{container}" is a known storey/level',
                'actual': f'"{container}" not in storey registry',
                'severity': 'warning',
            })
    return issues


# ── command: validate ---------------------------------------------------------

def cmd_validate(validator_name):
    # Accept both snake_case and camelCase
    key = re.sub(r'([A-Z])', lambda m: '_' + m.group(1).lower(), validator_name).lstrip('_').lower()

    fn = VALIDATORS.get(key)
    if fn is None:
        available = ', '.join(sorted(VALIDATORS.keys()))
        print(f"ERROR: unknown validator '{validator_name}'. Available: {available}", file=sys.stderr)
        sys.exit(1)

    css      = _load_css()
    elements = css.get('elements') or []
    if not elements:
        print("ERROR: css_processed.json has no elements", file=sys.stderr)
        sys.exit(1)

    print(f"Running validator: {key}  ({len(elements)} elements)")
    print()
    try:
        issues = fn(elements, css)
    except TypeError:
        issues = fn(elements)

    total  = len(issues)
    warned = sum(1 for i in issues if i.get('result') == 'warn')
    failed = sum(1 for i in issues if i.get('result') == 'fail')

    print(f"Results: total={total} warned={warned} failed={failed}")
    print()
    for issue in issues:
        eid    = issue.get('element_id', '?')
        result = issue.get('result', '?')
        actual = issue.get('actual', '?')
        print(f"  [{result}] {eid}")
        print(f"         actual:   {actual}")
        params = issue.get('params') or {}
        if 'host_id' in params:
            bbox = params.get('host_bbox') or {}
            c    = params.get('element_centroid') or {}
            print(f"         host:     {params['host_id']}")
            print(f"         centroid: ({c.get('x', 0):.1f}, {c.get('y', 0):.1f}, {c.get('z', 0):.1f})")
            print(f"         host X:   [{bbox.get('minX', 0):.1f}, {bbox.get('maxX', 0):.1f}]  "
                  f"Y: [{bbox.get('minY', 0):.1f}, {bbox.get('maxY', 0):.1f}]")
        print()


# ── command: overlaps ---------------------------------------------------------

def cmd_overlaps(elem_a, elem_b):
    if not os.path.exists(IFC_FILE):
        print(f"ERROR: IFC file not found at {IFC_FILE}", file=sys.stderr)
        sys.exit(1)

    try:
        import ifcopenshell
        import ifcopenshell.geom as ifc_geom
    except ImportError:
        print("ERROR: ifcopenshell not installed. Run: pip install ifcopenshell", file=sys.stderr)
        sys.exit(1)

    ifc      = ifcopenshell.open(IFC_FILE)
    settings = ifc_geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)

    def find_product(name_suffix):
        for p in ifc.by_type('IfcProduct'):
            nm = p.Name or ''
            if nm == name_suffix or name_suffix in nm:
                return p
        return None

    def product_bbox(product):
        try:
            shape = ifc_geom.create_shape(settings, product)
            vs    = shape.geometry.verts
            xs, ys, zs = vs[0::3], vs[1::3], vs[2::3]
            return min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)
        except Exception:
            return None

    pa = find_product(elem_a)
    pb = find_product(elem_b)

    if pa is None:
        print(f"ERROR: '{elem_a}' not found in IFC", file=sys.stderr)
        sys.exit(1)
    if pb is None:
        print(f"ERROR: '{elem_b}' not found in IFC", file=sys.stderr)
        sys.exit(1)

    ba = product_bbox(pa)
    bb = product_bbox(pb)

    if ba is None or bb is None:
        print("Cannot determine overlap — geometry unavailable for one or both elements.")
        return

    overlaps = (ba[0] <= bb[1] and ba[1] >= bb[0] and
                ba[2] <= bb[3] and ba[3] >= bb[2] and
                ba[4] <= bb[5] and ba[5] >= bb[4])

    print(f"Element A: {elem_a}")
    print(f"  bbox X:[{ba[0]:.2f}, {ba[1]:.2f}]  Y:[{ba[2]:.2f}, {ba[3]:.2f}]  Z:[{ba[4]:.2f}, {ba[5]:.2f}]")
    print(f"Element B: {elem_b}")
    print(f"  bbox X:[{bb[0]:.2f}, {bb[1]:.2f}]  Y:[{bb[2]:.2f}, {bb[3]:.2f}]  Z:[{bb[4]:.2f}, {bb[5]:.2f}]")
    print()
    print(f"Overlap: {'YES' if overlaps else 'NO'}")


# ── command: containment ------------------------------------------------------

def cmd_containment(element_id, point_str):
    try:
        coords = [float(c.strip()) for c in point_str.split(',')]
        if len(coords) != 3:
            raise ValueError
    except ValueError:
        print("ERROR: point must be 'x,y,z' (e.g. '10.5,5.0,2.0')", file=sys.stderr)
        sys.exit(1)

    px, py, pz = coords
    css        = _load_css()
    elements   = css.get('elements') or []
    by_key     = {_elem_id(e): e for e in elements}

    elem = by_key.get(element_id)
    if elem is None:
        print(f"ERROR: element '{element_id}' not found in css_processed.json", file=sys.stderr)
        print(f"First 20 keys: {list(by_key.keys())[:20]}", file=sys.stderr)
        sys.exit(1)

    bbox   = _elem_bbox(elem)
    inside = (bbox['minX'] <= px <= bbox['maxX'] and
              bbox['minY'] <= py <= bbox['maxY'] and
              bbox['minZ'] <= pz <= bbox['maxZ'])

    print(f"Element: {element_id}  (type: {elem.get('type', '?')})")
    print(f"  bbox X:[{bbox['minX']:.2f}, {bbox['maxX']:.2f}]")
    print(f"  bbox Y:[{bbox['minY']:.2f}, {bbox['maxY']:.2f}]")
    print(f"  bbox Z:[{bbox['minZ']:.2f}, {bbox['maxZ']:.2f}]")
    print(f"Point: ({px}, {py}, {pz})")
    print()
    print(f"Containment: {'INSIDE' if inside else 'OUTSIDE'}")


# ── main ---------------------------------------------------------------------

USAGE = """bld_query.py -- Builting diagnostics CLI

Usage:
  python bld_query.py history <element_id>
  python bld_query.py validate <validator_name>
  python bld_query.py overlaps <element_a> <element_b>
  python bld_query.py containment <element_id> <x,y,z>

Examples:
  python bld_query.py history cable_tray_8
  python bld_query.py history ventsim_branch_268
  python bld_query.py validate spatial_containment
  python bld_query.py validate branchConnectivity
  python bld_query.py overlaps cable_tray_8 ventsim_branch_235
  python bld_query.py containment ventsim_branch_235 70.0,80.5,0.0

Available validators:
  spatial_containment       MEP elements outside declared host bbox
  branch_connectivity       Branch elements with 0 network connections
  wall_runs_connected       Wall endpoints near but not coincident
  joint_angle_plausible     Path-connection angles outside expected range
  slab_storey_consistency   Slab containers not mapped to a known storey
"""


def main():
    if len(sys.argv) < 3:
        print(USAGE)
        sys.exit(0 if len(sys.argv) == 1 else 1)

    cmd = sys.argv[1].lower()

    if cmd == 'history':
        cmd_history(sys.argv[2])
    elif cmd == 'validate':
        cmd_validate(sys.argv[2])
    elif cmd == 'overlaps':
        if len(sys.argv) < 4:
            print("Usage: python bld_query.py overlaps <element_a> <element_b>", file=sys.stderr)
            sys.exit(1)
        cmd_overlaps(sys.argv[2], sys.argv[3])
    elif cmd == 'containment':
        if len(sys.argv) < 4:
            print("Usage: python bld_query.py containment <element_id> <x,y,z>", file=sys.stderr)
            sys.exit(1)
        cmd_containment(sys.argv[2], sys.argv[3])
    else:
        print(f"Unknown command: {cmd}\\n\\n{USAGE}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
`;

const BLD_QUERY_REQUIREMENTS = `ifcopenshell
`;

// ── ZIP builder (pure Node.js — no external deps) ─────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosNow() {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function buildZip(files) {
  const parts = [];
  const cdirs = [];
  let offset = 0;
  const { time, date } = dosNow();

  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const useDeflate = data.length > 0;
    const compressed = useDeflate ? deflateRawSync(data, { level: 6 }) : Buffer.alloc(0);
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    // Local file header (30 bytes + filename)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);           // signature
    local.writeUInt16LE(20, 4);                    // version needed
    local.writeUInt16LE(0, 6);                     // general purpose bit flag
    local.writeUInt16LE(method, 8);                // compression method
    local.writeUInt16LE(time, 10);                 // mod time
    local.writeUInt16LE(date, 12);                 // mod date
    local.writeUInt32LE(crc, 14);                  // CRC-32
    local.writeUInt32LE(compressed.length, 18);    // compressed size
    local.writeUInt32LE(data.length, 22);          // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);     // filename length
    local.writeUInt16LE(0, 28);                    // extra field length
    nameBytes.copy(local, 30);

    // Central directory header (46 bytes + filename)
    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);               // signature
    cd.writeUInt16LE(20, 4);                       // version made by
    cd.writeUInt16LE(20, 6);                       // version needed
    cd.writeUInt16LE(0, 8);                        // general purpose bit flag
    cd.writeUInt16LE(method, 10);                  // compression method
    cd.writeUInt16LE(time, 12);                    // mod time
    cd.writeUInt16LE(date, 14);                    // mod date
    cd.writeUInt32LE(crc, 16);                     // CRC-32
    cd.writeUInt32LE(compressed.length, 20);       // compressed size
    cd.writeUInt32LE(data.length, 24);             // uncompressed size
    cd.writeUInt16LE(nameBytes.length, 28);        // filename length
    cd.writeUInt16LE(0, 30);                       // extra field length
    cd.writeUInt16LE(0, 32);                       // file comment length
    cd.writeUInt16LE(0, 34);                       // disk number start
    cd.writeUInt16LE(0, 36);                       // internal file attributes
    cd.writeUInt32LE(0, 38);                       // external file attributes
    cd.writeUInt32LE(offset, 42);                  // local header offset
    nameBytes.copy(cd, 46);

    parts.push(local, compressed);
    cdirs.push(cd);
    offset += local.length + compressed.length;
  }

  const cdBuf = Buffer.concat(cdirs);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);              // signature
  eocd.writeUInt16LE(0, 4);                       // disk number
  eocd.writeUInt16LE(0, 6);                       // disk with central dir
  eocd.writeUInt16LE(files.length, 8);            // entries on this disk
  eocd.writeUInt16LE(files.length, 10);           // total entries
  eocd.writeUInt32LE(cdBuf.length, 12);           // central dir size
  eocd.writeUInt32LE(offset, 16);                 // central dir offset
  eocd.writeUInt16LE(0, 20);                      // comment length

  return Buffer.concat([...parts, cdBuf, eocd]);
}
