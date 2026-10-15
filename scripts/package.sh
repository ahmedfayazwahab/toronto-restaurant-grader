#!/usr/bin/env bash
# Builds dist/restaurantgrader-lambda.zip (the backend only; the website files are uploaded separately).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/build/data
cp -R app.js lambda.js package.json package-lock.json lib dist/build/
cp data/establishments.json data/grades.json dist/build/data/
( cd dist/build && npm ci --omit=dev --silent )
( cd dist/build && zip -qr ../restaurantgrader-lambda.zip . -x '*.DS_Store' )
ls -lh dist/restaurantgrader-lambda.zip
