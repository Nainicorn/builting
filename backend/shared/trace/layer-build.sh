#!/bin/bash
# Builds builting-trace-layer.zip for the AWS Lambda Layer.
# No external npm dependencies — uses the AWS SDK already present in the Lambda runtime.
#
# Output: builting-trace-layer.zip alongside this script.
# Publish: aws lambda publish-layer-version --layer-name builting-trace \
#            --zip-file fileb://builting-trace-layer.zip \
#            --compatible-runtimes nodejs20.x \
#            --region us-gov-east-1 --profile leidos
set -euo pipefail
TRACE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building builting-trace Lambda Layer..."
rm -rf "${TRACE_DIR}/.layer-build"
mkdir -p "${TRACE_DIR}/.layer-build/nodejs/node_modules/@builting/trace"

cp "${TRACE_DIR}/index.mjs"    "${TRACE_DIR}/.layer-build/nodejs/node_modules/@builting/trace/"
cp "${TRACE_DIR}/trace.mjs"    "${TRACE_DIR}/.layer-build/nodejs/node_modules/@builting/trace/"
cp "${TRACE_DIR}/package.json" "${TRACE_DIR}/.layer-build/nodejs/node_modules/@builting/trace/"

cd "${TRACE_DIR}/.layer-build"
zip -r "${TRACE_DIR}/builting-trace-layer.zip" nodejs/ -q
cd "${TRACE_DIR}"
rm -rf .layer-build

SIZE=$(du -sh builting-trace-layer.zip | cut -f1)
echo "Done: builting-trace-layer.zip (${SIZE})"
echo ""
echo "Publish with:"
echo "  aws lambda publish-layer-version \\"
echo "    --layer-name builting-trace \\"
echo "    --zip-file fileb://builting-trace-layer.zip \\"
echo "    --compatible-runtimes nodejs20.x \\"
echo "    --region us-gov-east-1 --profile leidos"
