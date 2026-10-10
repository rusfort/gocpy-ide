#!/bin/sh
# Двойной клик: копирует Gocpy IDE в /Applications и снимает карантин Gatekeeper.
set -e
cd "$(dirname "$0")"
APP="Gocpy IDE.app"
DEST="/Applications/$APP"
echo "Устанавливаю $APP в /Applications…"
rm -rf "$DEST"
cp -R "$APP" /Applications/
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
mkdir -p /usr/local/bin 2>/dev/null || true
if ln -sf "$DEST/Contents/MacOS/gocpy-ide" /usr/local/bin/gocpy-ide 2>/dev/null; then
  echo "Команда gocpy-ide добавлена в /usr/local/bin (можно: gocpy-ide ~/my-project)"
fi
echo "Готово. Запускаю…"
open "$DEST"
