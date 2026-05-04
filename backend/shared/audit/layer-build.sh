#!/bin/bash
# Builds builting-audit-layer.zip for the AWS Lambda Layer.
# No external npm dependencies — uses the AWS SDK already present in the Lambda runtime.
set -euo pipefail
AUDIT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building builting-audit Lambda Layer..."
rm -rf "${AUDIT_DIR}/.layer-build"
mkdir -p "${AUDIT_DIR}/.layer-build/nodejs/node_modules/@builting/audit"

cp "${AUDIT_DIR}/index.mjs"    "${AUDIT_DIR}/.layer-build/nodejs/node_modules/@builting/audit/"
cp "${AUDIT_DIR}/audit.mjs"    "${AUDIT_DIR}/.layer-build/nodejs/node_modules/@builting/audit/"
cp "${AUDIT_DIR}/package.json" "${AUDIT_DIR}/.layer-build/nodejs/node_modules/@builting/audit/"

cd "${AUDIT_DIR}/.layer-build"
zip -r "${AUDIT_DIR}/builting-audit-layer.zip" nodejs/ -q
cd "${AUDIT_DIR}"
rm -rf .layer-build

SIZE=$(du -sh builting-audit-layer.zip | cut -f1)
echo "Done: builting-audit-layer.zip (${SIZE})"
echo ""
echo "Publish with:"
echo "  aws lambda publish-layer-version \\"
echo "    --layer-name builting-audit \\"
echo "    --zip-file fileb://builting-audit-layer.zip \\"
echo "    --compatible-runtimes nodejs20.x \\"
echo "    --region us-gov-east-1 --profile leidos"
