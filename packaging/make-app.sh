#!/bin/sh
# Builds "Gocpy IDE.app" (arm64 + amd64) and a zip in ./dist. Works on macOS and Linux.
set -e
cd "$(dirname "$0")/.."
VERSION="${VERSION:-0.1.0}"
if [ "${SKIP_FRONTEND:-0}" != 1 ]; then
  (cd frontend && [ -d node_modules ] || npm ci) && sh frontend/build.sh
fi
rm -rf dist && mkdir -p "dist/Gocpy IDE.app/Contents/MacOS" "dist/Gocpy IDE.app/Contents/Resources"
APP="dist/Gocpy IDE.app/Contents"
for arch in arm64 amd64; do
  CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$APP/MacOS/gocpy-ide-$arch" .
done
cp packaging/launcher.sh "$APP/MacOS/gocpy-ide" && chmod +x "$APP/MacOS/gocpy-ide"
sed "s/0\.1\.0/$VERSION/g" packaging/Info.plist > "$APP/Info.plist"
cp packaging/AppIcon.icns "$APP/Resources/"
printf 'APPL????' > "$APP/PkgInfo"
cp packaging/install.command dist/ && chmod +x dist/install.command
# ad-hoc signature for the whole bundle when building on a Mac
if command -v codesign >/dev/null 2>&1; then codesign --force --deep -s - "dist/Gocpy IDE.app" || true; fi
echo "built: dist/Gocpy IDE.app"
