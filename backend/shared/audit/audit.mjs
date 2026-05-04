import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const IFC_BUCKET = process.env.IFC_BUCKET || 'builting-ifc';

// Module-level state — hard-reset on every initAudit call so warm Lambda
// invocations don't carry over decisions from the previous render.
let _renderId = null;
let _stage = null;
let _runId = null;
let _decisions = [];
let _validations = [];

/**
 * Call at handler start. Resets all state — required for warm-start safety.
 */
export function initAudit(renderId, stage, runId) {
  _renderId = renderId;
  _stage = stage;
  _runId = runId;
  _decisions = [];
  _validations = [];
}

/**
 * Append a decision entry. Silently no-ops if initAudit was never called.
 *
 * Required fields: pass, element_id, action, reason
 * Optional fields: before, after, params
 */
export function logDecision(entry) {
  if (!_renderId) return;
  _decisions.push({ ts: new Date().toISOString(), stage: _stage, ...entry });
}

/**
 * Append a validation entry.
 *
 * Required fields: validator, element_id, result, expected, actual, severity
 */
export function logValidation(entry) {
  if (!_renderId) return;
  _validations.push({ ts: new Date().toISOString(), stage: _stage, ...entry });
}

/**
 * Write buffered JSONL files to S3. Non-throwing — audit failure must not
 * fail the render. Resets state so a second call is a no-op.
 */
export async function flushAudit() {
  if (!_renderId) return;
  const prefix = `${_renderId}/diagnostics/${_stage}`;
  const writes = [];

  if (_decisions.length > 0) {
    writes.push(s3.send(new PutObjectCommand({
      Bucket: IFC_BUCKET,
      Key: `${prefix}/decisions.${_runId}.jsonl`,
      Body: _decisions.map(d => JSON.stringify(d)).join('\n'),
      ContentType: 'application/x-ndjson',
    })));
  }

  if (_validations.length > 0) {
    writes.push(s3.send(new PutObjectCommand({
      Bucket: IFC_BUCKET,
      Key: `${prefix}/validation.${_runId}.jsonl`,
      Body: _validations.map(v => JSON.stringify(v)).join('\n'),
      ContentType: 'application/x-ndjson',
    })));
  }

  await Promise.all(writes);
  console.log(`[audit:flush] stage=${_stage} decisions=${_decisions.length} validations=${_validations.length}`);

  // Reset so a second flush (e.g. in error path) is a no-op.
  _decisions = [];
  _validations = [];
}
