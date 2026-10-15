#!/usr/bin/env bash
# Uploads the website files to the portfolio bucket under /restaurantgrader/ and clears the CloudFront cache.
# Usage: scripts/deploy-site.sh <portfolio-bucket-name> <cloudfront-distribution-id>
set -euo pipefail
[ $# -eq 2 ] || { echo "Usage: $0 <bucket> <distribution-id>"; exit 1; }
cd "$(dirname "$0")/.."
aws s3 sync public/ "s3://$1/restaurantgrader/" --cache-control "max-age=300" --exclude ".DS_Store"
aws cloudfront create-invalidation --distribution-id "$2" --paths "/restaurantgrader/*"
echo "Done: https://ahmedfayazwahab.ca/restaurantgrader/"
