/**
 * builting-resolve — NormalizeClaims + ResolveClaims Lambda.
 * Reads claims.json from S3, normalizes, resolves, and produces:
 *   - normalized_claims.json
 *   - canonical_observed.json
 *   - resolution_report.json
 *   - identity_map.json
 *
 * Phase 2 of the v2 pipeline refactor. During transition, the downstream
 * Transform Lambda still reads CSS — this Lambda writes new artifacts in parallel.
 */

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { normalizeClaims } from './normalize.mjs';
import { resolveClaims } from './resolve.mjs';
import { assignIdentities } from './identity.mjs';
import { buildCanonicalObservedEnvelope } from './schemas.mjs';
import { validateSpatialSchema } from './spatialValidation.mjs';

// Phase 13: Consumer + producer contract checks
import { checkContractAsync, claimsContract, canonicalContract } from '@builting/contracts';
// Phase 13 PR2: Trace writer
import { writeTraceStart, writeTraceEnd } from '@builting/trace';
// Phase 13.5 PR6: Audit log
import { initAudit, flushAudit, logValidation } from '@builting/audit';
// PR 8: Stage validators
import { runResolveValidators } from './validators/resolve-validators.mjs';

const s3 = new S3Client({});
const DATA_BUCKET = process.env.DATA_BUCKET || 'builting-data';

export const handler = async (event, context) => {
  console.log('ResolveClaims input:', JSON.stringify({
    claimsS3Key: event.claimsS3Key,
    userId: event.userId,
    renderId: event.renderId,
    bucket: event.bucket,
  }));

  const { claimsS3Key, userId, renderId, bucket } = event;
  const dataBucket = bucket || DATA_BUCKET;
  const revision = event.renderRevision || 1;

  // Idempotency: if output artifacts already exist, return cached result
  const prefix = `uploads/${userId}/${renderId}/pipeline/v${revision}`;
  const idempotencyKey = `${prefix}/normalized_claims.json`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: dataBucket, Key: idempotencyKey }));
    console.log(`[idempotency] normalized_claims.json exists — returning cached result`);
    const reportObj = await s3.send(new GetObjectCommand({ Bucket: dataBucket, Key: `${prefix}/resolution_report.json` }));
    const report = JSON.parse(await reportObj.Body.transformToString());
    return {
      normalizedClaimsS3Key: `${prefix}/normalized_claims.json`,
      canonicalObservedS3Key: `${prefix}/canonical_observed.json`,
      resolutionReportS3Key: `${prefix}/resolution_report.json`,
      identityMapS3Key: `${prefix}/identity_map.json`,
      observationCount: report.summary?.observationsProduced || 0,
      rejectedCount: report.droppedClaims?.length || 0,
      ambiguousCount: report.summary?.ambiguousGroups || 0,
    };
  } catch (err) {
    if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) throw err;
  }

  // Phase 13 PR2: Trace start — written after idempotency/no-op guards so only real runs are traced.
  const _traceRunId = context?.awsRequestId || `resolve-${Date.now()}`;
  const _traceStartedAt = new Date().toISOString();
  let _traceKey = null; let _traceAttemptN = 1;

  // No-op if claims weren't produced (legacy renders before Phase 1)
  if (!claimsS3Key) {
    console.log('No claimsS3Key — skipping resolve (legacy render)');
    return {
      normalizedClaimsS3Key: null,
      canonicalObservedS3Key: null,
      resolutionReportS3Key: null,
      identityMapS3Key: null,
      observationCount: 0,
      rejectedCount: 0,
      ambiguousCount: 0,
    };
  }

  const startTime = Date.now();

  try {
    ({ key: _traceKey, attemptN: _traceAttemptN } = await writeTraceStart({
      renderId, stage: 'resolve', runId: _traceRunId, startedAt: _traceStartedAt,
      artifactKey: claimsS3Key,
    }));
  } catch (te) { console.warn('[trace] start write failed (non-fatal):', te.message); }
  initAudit(renderId, 'resolve', _traceRunId);

  try {
    // 1. Read claims.json from S3
    console.log(`Reading claims from s3://${dataBucket}/${claimsS3Key}`);
    const claimsObj = await s3.send(new GetObjectCommand({
      Bucket: dataBucket,
      Key: claimsS3Key,
    }));
    const claimsBody = await claimsObj.Body.transformToString();
    const claimsDoc = JSON.parse(claimsBody);
    console.log(`Claims loaded: ${claimsDoc.claims?.length || 0} claims, domain=${claimsDoc.domain}`);

    // Consumer contract check: validate claims.json on entry (halting).
    await checkContractAsync('claimsContract', claimsContract, claimsDoc, {
      halting: true,
      renderId,
      stage: 'resolve-entry',
    });
    const normalizedDoc = normalizeClaims(claimsDoc);

    // 3. Spatial schema validation — after normalization, before resolve
    const { validatedDoc, validationSummary } = validateSpatialSchema(normalizedDoc);

    // 4. Resolve claims → observations + report
    const { observations, resolutionReport } = resolveClaims(validatedDoc);

    // 5. Assign identities
    const { identityMap, observationsWithIds } = assignIdentities(observations, { revision });

    // Update resolution report with identity assignments
    resolutionReport.identityAssignments = identityMap.assignments.map(a => ({
      canonicalId: a.canonical_id,
      matchMethod: 'new_assignment',
      matchedFrom: null,
      matched_from_revision: a.matched_from_revision,
      match_confidence: a.match_confidence,
      match_reason: a.match_reason,
      newAssignment: true,
    }));

    // 6. Build canonical_observed envelope (validatedDoc carries the validated claims)
    const facility = validatedDoc.facilityMeta ? {
      name: validatedDoc.facilityMeta.name,
      type: validatedDoc.facilityMeta.type,
      description: validatedDoc.facilityMeta.description,
      units: validatedDoc.facilityMeta.units || 'M',
      origin: validatedDoc.facilityMeta.origin || { x: 0, y: 0, z: 0 },
      axes: validatedDoc.facilityMeta.axes || 'RIGHT_HANDED_Z_UP',
    } : null;

    const canonicalObserved = {
      ...buildCanonicalObservedEnvelope(
        observationsWithIds,
        validatedDoc.domain,
        facility,
        {
          claimsConsumed: validatedDoc.claims?.length || 0,
          observationsProduced: observationsWithIds.length,
          rejectedClaims: resolutionReport.droppedClaims.length,
        }
      ),
      validation_summary: validationSummary,
    };

    // 7. Write all 4 artifacts to S3 in parallel
    const prefix = `uploads/${userId}/${renderId}/pipeline/v${revision}`;
    const keys = {
      normalizedClaims: `${prefix}/normalized_claims.json`,
      canonicalObserved: `${prefix}/canonical_observed.json`,
      resolutionReport: `${prefix}/resolution_report.json`,
      identityMap: `${prefix}/identity_map.json`,
    };

    await Promise.all([
      writeToS3(dataBucket, keys.normalizedClaims, validatedDoc),
      writeToS3(dataBucket, keys.canonicalObserved, canonicalObserved),
      writeToS3(dataBucket, keys.resolutionReport, resolutionReport),
      writeToS3(dataBucket, keys.identityMap, identityMap),
    ]);

    // Producer self-check: canonical_observed (non-halting — diagnostic only,
    // no downstream consumer reads this artifact in the current pipeline).
    const _canonicalContractStatus = await checkContractAsync('canonicalContract', canonicalContract, canonicalObserved, {
      halting: false,
      renderId,
      stage: 'resolve',
    });

    // Release 13.2: provenance completeness from observations
    const _obsTotal = observationsWithIds.length;
    let _obsProvPct = null;
    if (_obsTotal > 0) {
      const _obsAttributed = observationsWithIds.filter(
        o => o.provenance?.sourceFileStatus && o.provenance.sourceFileStatus !== 'missing'
      ).length;
      _obsProvPct = Math.round(100 * _obsAttributed / _obsTotal);
    }

    const durationMs = Date.now() - startTime;
    console.log(`ResolveClaims complete in ${durationMs}ms: ${observationsWithIds.length} observations, ${resolutionReport.droppedClaims.length} dropped, ${resolutionReport.summary.ambiguousGroups} ambiguous`);

    // PR 8: Run resolve validators (all warning — non-halting)
    let _resolveValSummary = { total: 0, passed: 0, warned: 0, failed: 0 };
    try {
      const _vr = runResolveValidators(
        validatedDoc.claims,
        observationsWithIds,
        resolutionReport.droppedClaims,
      );
      for (const entry of _vr.entries) logValidation(entry);
      _resolveValSummary = { total: _vr.total, passed: _vr.passed, warned: _vr.warned, failed: _vr.failed };
    } catch (ve) { console.warn('[validators:resolve] Non-fatal:', ve.message); }

    // Phase 13 PR2: Trace end (Release 13.2: + scalars)
    try { await flushAudit(); } catch (ae) { console.warn('[audit:flush_failed]', ae.message); }
    if (_traceKey) {
      try {
        await writeTraceEnd({
          traceKey: _traceKey, stage: 'resolve', runId: _traceRunId, attemptN: _traceAttemptN,
          startedAt: _traceStartedAt, finishedAt: new Date().toISOString(),
          outputArtifactKey: keys.canonicalObserved,
          counts: { observations: observationsWithIds.length, rejected: resolutionReport.droppedClaims.length },
          validationFlags: [],
          scalars: {
            gatePassRate: null,
            contractStatus: _canonicalContractStatus ?? 'pass',
            provenanceCompleteness: _obsProvPct,
            validationSummary: _resolveValSummary,
          },
        });
      } catch (te) { console.warn('[trace] end write failed (non-fatal):', te.message); }
    }

    return {
      normalizedClaimsS3Key: keys.normalizedClaims,
      canonicalObservedS3Key: keys.canonicalObserved,
      resolutionReportS3Key: keys.resolutionReport,
      identityMapS3Key: keys.identityMap,
      observationCount: observationsWithIds.length,
      rejectedCount: resolutionReport.droppedClaims.length,
      ambiguousCount: resolutionReport.summary.ambiguousGroups,
    };
  } catch (error) {
    console.error('ResolveClaims error:', error);
    throw error;
  }
};

/**
 * Write JSON to S3.
 */
async function writeToS3(bucket, key, data) {
  const body = JSON.stringify(data);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/json',
  }));
  console.log(`Saved: s3://${bucket}/${key} (${body.length} bytes)`);
}
