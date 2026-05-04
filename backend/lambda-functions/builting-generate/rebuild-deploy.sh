#!/bin/bash
set -e

echo "Building Docker image with fixes..."

# Build from the correct directory (where Dockerfile + Python sources live)
cd "$(dirname "$0")"

REPO_URI="008368474482.dkr.ecr.us-gov-east-1.amazonaws.com/builting-json-to-ifc"
TAG="fixed-$(date +%s)"

# Login to ECR
echo "Logging in to ECR..."
aws ecr get-login-password --region us-gov-east-1 --profile leidos | \
  docker login --username AWS --password-stdin 008368474482.dkr.ecr.us-gov-east-1.amazonaws.com

# Lambda doesn't accept OCI manifests with provenance/sbom attestations, so we
# force `--provenance=false --sbom=false` and target arm64 explicitly. Build
# directly to the registry via `--push` so the manifest stays single-arch.
echo "Building + pushing $REPO_URI:$TAG"
docker buildx build --platform linux/arm64 --provenance=false --sbom=false \
  -f Dockerfile \
  --build-context pydantic_contracts=../../shared/contracts/pydantic \
  -t "$REPO_URI:$TAG" --push .

# Update Lambda to use new image
echo "Updating Lambda function to use new image..."
aws lambda update-function-code \
  --function-name builting-generate \
  --image-uri "$REPO_URI:$TAG" \
  --region us-gov-east-1 \
  --profile leidos

echo "Deployment complete!"
echo "Image URI: $REPO_URI:$TAG"

# Clear S3 cache (generate caches IFC files by CSS hash; code changes won't
# take effect until the cache is cleared).
echo "Clearing S3 IFC cache..."
aws s3 rm s3://builting-ifc/cache/ --recursive --region us-gov-east-1 --profile leidos

echo "All done. Ready to test with a new render."
