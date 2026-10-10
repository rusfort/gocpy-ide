#!/bin/sh
set -e
cd "$(dirname "$0")"
OUT=../web/dist
rm -rf "$OUT" && mkdir -p "$OUT"
npx esbuild src/main.js --bundle --minify --format=iife --target=chrome110,safari16 --outfile="$OUT/app.js" --loader:.css=css --legal-comments=none
cp src/index.html src/icon.svg "$OUT/"
ls -la "$OUT"
