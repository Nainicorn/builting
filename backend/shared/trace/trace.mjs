import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const IFC_BUCKET = process.env.IFC_BUCKET || 'builting-ifc';

// Determine attempt number by counting existing trace files for this stage.
async function getAttemptN(renderId, stage) {
  const prefix = `${renderId}/pipeline_trace/${stage}.`;
  try {
    const result = await s3.send(new ListObjectsV2Command({ Bucket: IFC_BUCKET, Prefix: prefix }));
    return (result.Contents?.length || 0) + 1;
  } catch {
    return 1;
  }
}

/**
 * Write the start trace entry. Returns { key, attemptN } so the caller can
 * pass them to writeTraceEnd without re-listing S3.
 *
 * @param {object} opts
 * @param {string} opts.renderId
 * @param {string} opts.stage       – e.g. 'extract'
 * @param {string} opts.runId       – Lambda awsRequestId (unique per invocation)
 * @param {string} opts.startedAt   – ISO-8601 UTC
 * @param {string} [opts.artifactKey] – S3 key of primary input artifact
 */
export async function writeTraceStart({ renderId, stage, runId, startedAt, artifactKey = null }) {
  const attemptN = await getAttemptN(renderId, stage);
  const key = `${renderId}/pipeline_trace/${stage}.${runId}.${attemptN}.json`;

  await s3.send(new PutObjectCommand({
    Bucket: IFC_BUCKET,
    Key: key,
    Body: JSON.stringify({
      stage,
      phase: 'start',
      runId,
      attemptN,
      startedAt,
      input: { artifactKey, sha256: null },
    }),
    ContentType: 'application/json',
  }));

  console.log(`[trace:start] stage=${stage} runId=${runId} attemptN=${attemptN} key=${key}`);
  return { key, attemptN };
}

/**
 * Overwrite the trace entry with exit data (phase='end').
 * Pass the { key, attemptN } returned from writeTraceStart.
 *
 * @param {object} opts
 * @param {string} opts.traceKey         – S3 key from writeTraceStart
 * @param {string} opts.stage
 * @param {string} opts.runId
 * @param {number} opts.attemptN
 * @param {string} opts.startedAt
 * @param {string} opts.finishedAt       – ISO-8601 UTC
 * @param {string} [opts.outputArtifactKey]
 * @param {object} [opts.counts]         – element/claim counts
 * @param {string[]} [opts.validationFlags]
 * @param {object} [opts.scalars]        – Release 13.2 observability scalars
 * @param {number|null} [opts.scalars.gatePassRate]
 * @param {'pass'|'fail'|null} [opts.scalars.contractStatus]
 * @param {number|null} [opts.scalars.provenanceCompleteness]
 */
export async function writeTraceEnd({
  traceKey,
  stage,
  runId,
  attemptN,
  startedAt,
  finishedAt,
  outputArtifactKey = null,
  counts = {},
  validationFlags = [],
  scalars = {},
}) {
  await s3.send(new PutObjectCommand({
    Bucket: IFC_BUCKET,
    Key: traceKey,
    Body: JSON.stringify({
      stage,
      phase: 'end',
      runId,
      attemptN,
      startedAt,
      finishedAt,
      output: { artifactKey: outputArtifactKey, sha256: null, counts, validationFlags },
      scalars: {
        gatePassRate: scalars.gatePassRate ?? null,
        contractStatus: scalars.contractStatus ?? null,
        provenanceCompleteness: scalars.provenanceCompleteness ?? null,
        validationSummary: scalars.validationSummary ?? null,
      },
    }),
    ContentType: 'application/json',
  }));

  console.log(`[trace:end] stage=${stage} runId=${runId} attemptN=${attemptN}`);
}
