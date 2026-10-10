#!/bin/sh
# Gocpy IDE launcher: picks the binary for this CPU.
DIR="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -m)" in
  arm64) BIN="$DIR/gocpy-ide-arm64" ;;
  *)     BIN="$DIR/gocpy-ide-amd64" ;;
esac
LOG="$HOME/Library/Logs/GocpyIDE.log"
mkdir -p "$HOME/Library/Logs"
# When started from a terminal, keep output in the terminal.
if [ -t 1 ]; then exec "$BIN" "$@"; fi
exec "$BIN" "$@" >>"$LOG" 2>&1
