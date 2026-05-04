#!/bin/bash
# Builds builting-contracts-layer.zip for the AWS Lambda Layer.
# Requires: npm install has been run in this directory (node_modules/zod must exist).
#
# Output: builting-contracts-layer.zip alongside this script.
# Publish: aws lambda publish-layer-version --layer-name builting-contracts \
#            --zip-file fileb://builting-contracts-layer.zip \
#            --compatible-runtimes nodejs20.x \
#            --region us-gov-east-1 --profile leidos
set -euo pipefail
CONTRACTS_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "${CONTRACTS_DIR}/node_modules/zod" ]; then
  echo "ERROR: node_modules/zod not found. Run 'npm install' in ${CONTRACTS_DIR} first."
  exit 1
fi

echo "Building builting-contracts Lambda Layer..."
rm -rf "${CONTRACTS_DIR}/.layer-build"
mkdir -p "${CONTRACTS_DIR}/.layer-build/nodejs/node_modules/@builting/contracts"

# Copy contracts source into layer
cp "${CONTRACTS_DIR}/index.mjs"        "${CONTRACTS_DIR}/.layer-build/nodejs/node_modules/@builting/contracts/"
cp "${CONTRACTS_DIR}/contractCheck.mjs" "${CONTRACTS_DIR}/.layer-build/nodejs/node_modules/@builting/contracts/"
cp "${CONTRACTS_DIR}/package.json"      "${CONTRACTS_DIR}/.layer-build/nodejs/node_modules/@builting/contracts/"
cp -r "${CONTRACTS_DIR}/zod"            "${CONTRACTS_DIR}/.layer-build/nodejs/node_modules/@builting/contracts/"

# Copy zod peer dependency
cp -r "${CONTRACTS_DIR}/node_modules/zod" "${CONTRACTS_DIR}/.layer-build/nodejs/node_modules/"

# Zip
cd "${CONTRACTS_DIR}/.layer-build"
zip -r "${CONTRACTS_DIR}/builting-contracts-layer.zip" nodejs/ -q
cd "${CONTRACTS_DIR}"
rm -rf .layer-build

SIZE=$(du -sh builting-contracts-layer.zip | cut -f1)
echo "Done: builting-contracts-layer.zip (${SIZE})"
echo ""
echo "Publish with:"
echo "  aws lambda publish-layer-version \\"
echo "    --layer-name builting-contracts \\"
echo "    --zip-file fileb://builting-contracts-layer.zip \\"
echo "    --compatible-runtimes nodejs20.x \\"
echo "    --region us-gov-east-1 --profile leidos"
