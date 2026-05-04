"""
audit.py — Pipeline audit log writer for the generate Lambda (Python).

init_audit / log_decision / log_validation / flush_audit

Module-level singleton — hard-reset on every init_audit call so warm Lambda
invocations don't carry over decisions from the previous render.

flush_audit is non-throwing. Callers wrap in try/except and log the warning;
audit failure must not fail the render.
"""
import json
import os
from datetime import datetime, timezone

import boto3

_s3 = boto3.client('s3')
_IFC_BUCKET = os.environ.get('IFC_BUCKET', 'builting-ifc')

_render_id = None
_stage = None
_run_id = None
_decisions = []
_validations = []


def init_audit(render_id: str, stage: str, run_id: str) -> None:
    """Call at handler start. Resets all state — required for warm-start safety."""
    global _render_id, _stage, _run_id, _decisions, _validations
    _render_id = render_id
    _stage = stage
    _run_id = run_id
    _decisions = []
    _validations = []


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def log_decision(entry: dict) -> None:
    """Append a decision entry. No-ops if init_audit was never called."""
    if not _render_id:
        return
    _decisions.append({'ts': _now(), 'stage': _stage, **entry})


def log_validation(entry: dict) -> None:
    """Append a validation entry. No-ops if init_audit was never called."""
    if not _render_id:
        return
    _validations.append({'ts': _now(), 'stage': _stage, **entry})


def flush_audit() -> None:
    """
    Write buffered JSONL to S3 and reset state.
    Non-throwing — callers must wrap in try/except.
    """
    global _decisions, _validations
    if not _render_id:
        return

    prefix = f'{_render_id}/diagnostics/{_stage}'

    if _decisions:
        body = '\n'.join(json.dumps(d) for d in _decisions)
        _s3.put_object(
            Bucket=_IFC_BUCKET,
            Key=f'{prefix}/decisions.{_run_id}.jsonl',
            Body=body.encode('utf-8'),
            ContentType='application/x-ndjson',
        )

    if _validations:
        body = '\n'.join(json.dumps(v) for v in _validations)
        _s3.put_object(
            Bucket=_IFC_BUCKET,
            Key=f'{prefix}/validation.{_run_id}.jsonl',
            Body=body.encode('utf-8'),
            ContentType='application/x-ndjson',
        )

    print(f'[audit:flush] stage={_stage} decisions={len(_decisions)} validations={len(_validations)}')

    # Reset so a second flush is a no-op.
    _decisions = []
    _validations = []
