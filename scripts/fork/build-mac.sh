#!/bin/sh
# Build "Jumble Chad", Chad's own macOS app, from this checkout. Fork-only.
#
#   ./scripts/fork/build-mac.sh            build only
#   ./scripts/fork/build-mac.sh --install  build, then copy to /Applications
#
# The app is at release/chad-<version>/mac-arm64/Jumble Chad.app.
# See scripts/fork/electron-builder.chad.cjs for how it differs from upstream.
set -eu
cd "$(dirname "$0")/../.."

ELECTRON=true npx tsc -b
ELECTRON=true npx vite build --config vite.electron.config.ts
npx electron-builder --config scripts/fork/electron-builder.chad.cjs --mac dir --arm64 --publish never

version=$(node -p 'require("./package.json").version')
app="release/chad-$version/mac-arm64/Jumble Chad.app"
test -d "$app"
echo "Built: $app"

if [ "${1:-}" = "--install" ]; then
  if pgrep -f "/Applications/Jumble Chad.app/" >/dev/null; then
    echo "Jumble Chad is running. Quit it, then run this again." >&2
    exit 1
  fi
  rm -rf "/Applications/Jumble Chad.app"
  ditto "$app" "/Applications/Jumble Chad.app"
  echo "Installed: /Applications/Jumble Chad.app"
fi
