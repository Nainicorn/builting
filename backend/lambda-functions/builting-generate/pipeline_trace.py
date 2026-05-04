"""
Pipeline trace writer for the generate Lambda container.
Mirrors the Node trace.mjs interface.

Usage:
    from trace import write_trace_start, write_trace_end

    trace_key, attempt_n = write_trace_start(
        render_id, 'generate', run_id, started_at, artifact_key='...'
    )
    # ... do work ...
    write_trace_end(
        trace_key, 'generate', run_id, attempt_n, started_at, finished_at,
        output_artifact_key='...', counts={...}, validation_flags=[...]
    )
"""

import json
import os
import boto3

s3_client = boto3.client('s3')
IFC_BUCKET = os.environ.get('IFC_BUCKET', 'builting-ifc')


def _get_attempt_n(render_id, stage):
    prefix = f"{render_id}/pipeline_trace/{stage}."
    try:
        result = s3_client.list_objects_v2(Bucket=IFC_BUCKET, Prefix=prefix)
        return len(result.get('Contents', [])) + 1
    except Exception:
        return 1


def write_trace_start(render_id, stage, run_id, started_at, artifact_key=None):
    """
    Write start trace entry. Returns (trace_key, attempt_n).
    Pass both to write_trace_end to avoid a second S3 list call.
    """
    attempt_n = _get_attempt_n(render_id, stage)
    key = f"{render_id}/pipeline_trace/{stage}.{run_id}.{attempt_n}.json"

    s3_client.put_object(
        Bucket=IFC_BUCKET,
        Key=key,
        Body=json.dumps({
            'stage': stage,
            'phase': 'start',
            'runId': run_id,
            'attemptN': attempt_n,
            'startedAt': started_at,
            'input': {'artifactKey': artifact_key, 'sha256': None},
        }).encode('utf-8'),
        ContentType='application/json',
    )

    print(f"[trace:start] stage={stage} runId={run_id} attemptN={attempt_n} key={key}")
    return key, attempt_n


def write_trace_end(trace_key, stage, run_id, attempt_n, started_at, finished_at,
                    output_artifact_key=None, counts=None, validation_flags=None,
                    scalars=None):
    """Overwrite the trace entry with exit data (phase='end')."""
    _scalars = scalars or {}
    s3_client.put_object(
        Bucket=IFC_BUCKET,
        Key=trace_key,
        Body=json.dumps({
            'stage': stage,
            'phase': 'end',
            'runId': run_id,
            'attemptN': attempt_n,
            'startedAt': started_at,
            'finishedAt': finished_at,
            'output': {
                'artifactKey': output_artifact_key,
                'sha256': None,
                'counts': counts or {},
                'validationFlags': validation_flags or [],
            },
            'scalars': {
                'gatePassRate': _scalars.get('gatePassRate'),
                'contractStatus': _scalars.get('contractStatus'),
                'provenanceCompleteness': _scalars.get('provenanceCompleteness'),
                'validationSummary': _scalars.get('validationSummary'),
            },
        }).encode('utf-8'),
        ContentType='application/json',
    )

    print(f"[trace:end] stage={stage} runId={run_id} attemptN={attempt_n}")
