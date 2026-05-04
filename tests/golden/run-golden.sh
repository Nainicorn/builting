#!/usr/bin/env bash
# tests/golden/run-golden.sh — Run golden provenance tests for one or more fixtures.
#
# Usage:
#   bash tests/golden/run-golden.sh [fixture...]
#   bash tests/golden/run-golden.sh tunnel building no-spatial
#   bash tests/golden/run-golden.sh        # defaults to all three
#
# Each fixture is run in order. The script exits 1 if any fixture fails.
#
# Environment (all have defaults pointing at us-gov-east-1 GovCloud):
#   AWS_REGION, S3_DATA_BUCKET, S3_IFC_BUCKET, DYNAMO_TABLE,
#   STATE_MACHINE_ARN, TEST_USER_ID
#
# Prerequisites:
#   - aws CLI configured with appropriate credentials
#   - python3 with ifcopenshell installed (pip install ifcopenshell)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

AWS_REGION="${AWS_REGION:-us-gov-east-1}"
S3_DATA_BUCKET="${S3_DATA_BUCKET:-builting-data}"
S3_IFC_BUCKET="${S3_IFC_BUCKET:-builting-ifc}"
DYNAMO_TABLE="${DYNAMO_TABLE:-builting-renders}"
STATE_MACHINE_ARN="${STATE_MACHINE_ARN:-arn:aws-us-gov:states:us-gov-east-1:008368474482:stateMachine:builting-state-machine}"
TEST_USER_ID="${TEST_USER_ID:-user-1}"
PROFILE="${AWS_PROFILE:-}"
PROFILE_ARGS=""
if [ -n "$PROFILE" ]; then
  PROFILE_ARGS="--profile $PROFILE"
fi

FIXTURES=("${@:-tunnel building no-spatial}")
OVERALL_PASS=true

# ── Helpers ──────────────────────────────────────────────────────────────

log() { echo "[golden] $*"; }

aws_cmd() {
  aws --region "$AWS_REGION" $PROFILE_ARGS "$@"
}

wait_for_execution() {
  local arn="$1"
  local timeout="${2:-600}"  # seconds
  local elapsed=0
  while true; do
    local status
    status=$(aws_cmd stepfunctions describe-execution \
      --execution-arn "$arn" --query 'status' --output text 2>/dev/null)
    if [[ "$status" =~ ^(SUCCEEDED|FAILED|TIMED_OUT|ABORTED)$ ]]; then
      echo "$status"
      return
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "TIMEOUT"
      return
    fi
    sleep 15
    elapsed=$((elapsed + 15))
  done
}

run_pipeline() {
  # Upload input files from fixture inputs/ dir, start pipeline, return IFC path.
  local fixture="$1"
  local render_id="$2"
  local inputs_dir="$SCRIPT_DIR/$fixture/inputs"

  if [ ! -d "$inputs_dir" ]; then
    log "ERROR: $inputs_dir does not exist"
    return 1
  fi

  log "[$fixture] Uploading input files to s3://$S3_DATA_BUCKET/uploads/$TEST_USER_ID/$render_id/"
  for f in "$inputs_dir"/*; do
    aws_cmd s3 cp "$f" \
      "s3://$S3_DATA_BUCKET/uploads/$TEST_USER_ID/$render_id/$(basename "$f")"
  done

  log "[$fixture] Creating DynamoDB record $render_id"
  aws_cmd dynamodb put-item \
    --table-name "$DYNAMO_TABLE" \
    --item "{
      \"user_id\":{\"S\":\"$TEST_USER_ID\"},
      \"render_id\":{\"S\":\"$render_id\"},
      \"status\":{\"S\":\"pending\"},
      \"s3_path\":{\"S\":\"s3://$S3_DATA_BUCKET/uploads/$TEST_USER_ID/$render_id\"},
      \"description\":{\"S\":\"golden-test-$fixture\"},
      \"created_at\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
    }"

  log "[$fixture] Starting Step Function execution"
  local exec_arn
  exec_arn=$(aws_cmd stepfunctions start-execution \
    --state-machine-arn "$STATE_MACHINE_ARN" \
    --input "{\"userId\":\"$TEST_USER_ID\",\"renderId\":\"$render_id\",\"bucket\":\"$S3_DATA_BUCKET\"}" \
    --query 'executionArn' --output text)

  log "[$fixture] Waiting for pipeline (exec: $exec_arn)"
  local final_status
  final_status=$(wait_for_execution "$exec_arn" 480)
  log "[$fixture] Pipeline status: $final_status"

  if [ "$final_status" != "SUCCEEDED" ]; then
    log "[$fixture] ERROR: pipeline $final_status"
    return 1
  fi

  # Retrieve IFC path from DynamoDB.
  local ifc_s3_path
  ifc_s3_path=$(aws_cmd dynamodb get-item \
    --table-name "$DYNAMO_TABLE" \
    --key "{\"user_id\":{\"S\":\"$TEST_USER_ID\"},\"render_id\":{\"S\":\"$render_id\"}}" \
    --query 'Item.ifc_s3_path.S' --output text 2>/dev/null)

  if [ -z "$ifc_s3_path" ] || [ "$ifc_s3_path" = "None" ]; then
    log "[$fixture] ERROR: no ifc_s3_path in DynamoDB after successful execution"
    return 1
  fi

  local local_ifc="/tmp/golden-$fixture-$render_id.ifc"
  aws_cmd s3 cp "$ifc_s3_path" "$local_ifc"
  echo "$local_ifc"
}

# ── Tunnel fixture uses a pre-existing render (no upload needed) ─────────

run_tunnel() {
  local render_id="$1"
  local local_ifc="/tmp/golden-tunnel-$render_id.ifc"

  # Clear S3 IFC cache so generate uses the new code, not a cached artifact.
  log "[tunnel] Clearing S3 IFC cache"
  aws_cmd s3 rm "s3://$S3_IFC_BUCKET/cache/" --recursive 2>/dev/null || true

  log "[tunnel] Starting pipeline for render $render_id"
  local exec_arn
  exec_arn=$(aws_cmd stepfunctions start-execution \
    --state-machine-arn "$STATE_MACHINE_ARN" \
    --input "{\"userId\":\"$TEST_USER_ID\",\"renderId\":\"$render_id\",\"bucket\":\"$S3_DATA_BUCKET\"}" \
    --query 'executionArn' --output text)

  log "[tunnel] Waiting for pipeline"
  local final_status
  final_status=$(wait_for_execution "$exec_arn" 480)

  if [ "$final_status" != "SUCCEEDED" ]; then
    log "[tunnel] ERROR: pipeline $final_status"
    return 1
  fi

  local ifc_s3_path
  ifc_s3_path=$(aws_cmd dynamodb get-item \
    --table-name "$DYNAMO_TABLE" \
    --key "{\"user_id\":{\"S\":\"$TEST_USER_ID\"},\"render_id\":{\"S\":\"$render_id\"}}" \
    --query 'Item.ifc_s3_path.S' --output text 2>/dev/null)

  aws_cmd s3 cp "$ifc_s3_path" "$local_ifc"
  echo "$local_ifc"
}

# ── Run one fixture ───────────────────────────────────────────────────────

run_fixture() {
  local fixture="$1"
  local ifc_path

  log "=== $fixture ==="

  case "$fixture" in
    tunnel)
      # The tunnel fixture re-runs the Beggars Tomb render (existing DynamoDB record).
      local tunnel_render_id="prov-quality-1777769660"
      ifc_path=$(run_tunnel "$tunnel_render_id") || { OVERALL_PASS=false; return; }
      ;;
    building|no-spatial)
      local render_id
      render_id="golden-${fixture}-ci-$(date +%s)"
      ifc_path=$(run_pipeline "$fixture" "$render_id") || { OVERALL_PASS=false; return; }
      ;;
    *)
      log "ERROR: unknown fixture '$fixture'"
      OVERALL_PASS=false
      return
      ;;
  esac

  log "[$fixture] Running assertions against $ifc_path"
  if python3 "$SCRIPT_DIR/runner.py" "$fixture" "$ifc_path"; then
    log "[$fixture] ✓ PASS"
  else
    log "[$fixture] ✗ FAIL"
    OVERALL_PASS=false
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────

for fixture in "${FIXTURES[@]}"; do
  run_fixture "$fixture"
done

if [ "$OVERALL_PASS" = "true" ]; then
  log "All fixtures passed."
  exit 0
else
  log "One or more fixtures FAILED."
  exit 1
fi
