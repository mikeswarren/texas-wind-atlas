#!/usr/bin/env bash
# Build and publish the Texas Wind Atlas to /srv/sites/map.hitky.com.
#
#   ./scripts/deploy.sh
#
# Preserves the live config.js (which holds the Mapbox token) rather than
# overwriting it with the repo's empty placeholder -- so a deploy never
# silently takes the map down.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE=/srv/sites/map.hitky.com

cd "$ROOT"

# Match the assignment, not the word "pk." -- the placeholder config.js
# mentions it in a comment, which made an earlier version of this check
# claim it was preserving a token that was never there.
has_token() {
  [ -f "$1" ] && grep -Eq "MAPBOX_TOKEN[[:space:]]*=[[:space:]]*['\"]pk\." "$1"
}

echo "==> Validating style specs"
npm run --silent validate

echo "==> Building"
npm run --silent build

# Vite bakes VITE_MAPBOX_TOKEN into the bundle at build time, and src/config.js
# ranks that above the server-editable window.MAPBOX_TOKEN. A build made from a
# developer .env would therefore ship that token inside an asset served
# `immutable, max-age=31536000` -- silently outranking config.js, and unrotatable
# without a rebuild. The autodeploy clone has no .env, so this only ever fires on
# a hand-run deploy from a working copy.
if grep -rlq 'pk\.eyJ' dist/assets 2>/dev/null; then
  echo >&2
  echo "ERROR: a Mapbox token is compiled into dist/assets/." >&2
  echo "       It came from VITE_MAPBOX_TOKEN in .env, and it would outrank the" >&2
  echo "       token in $SITE/config.js on the live site." >&2
  echo "       Publish without it:  VITE_MAPBOX_TOKEN= ./scripts/deploy.sh" >&2
  echo "       The live token belongs in config.js, which needs no rebuild." >&2
  exit 1
fi

echo "==> Pre-compressing data files"
# Caddy is configured with `precompressed gzip`; a .gz next to each file means
# the edge serves 182 KB from disk instead of gzipping 4.2 MB per cold request.
find dist/data -type f \( -name '*.json' -o -name '*.geojson' \) -print0 |
  while IFS= read -r -d '' f; do
    gzip -9 -k -f "$f"
  done

mkdir -p "$SITE"

# Keep whatever token the live site is already using.
LIVE_CONFIG=""
if has_token "$SITE/config.js"; then
  LIVE_CONFIG="$(cat "$SITE/config.js")"
  echo "==> Preserving the existing Mapbox token in config.js"
fi

echo "==> Publishing to $SITE"
rsync -a --delete dist/ "$SITE/"

if [ -n "$LIVE_CONFIG" ]; then
  printf '%s\n' "$LIVE_CONFIG" > "$SITE/config.js"
fi

echo
echo "Deployed. $(find "$SITE" -type f | wc -l) files, $(du -sh "$SITE" | cut -f1) on disk."

# The site is served by this project's own caddy container, which bind-mounts
# $SITE read-only -- so publishing is a file swap underneath a running process
# and needs no restart, no rebuild, and no window where the root is half-written.
#
# Deliberately a CHECK and not `docker compose up -d`: autodeploy runs this
# script from the build clone at /srv/build, where the git-ignored
# docker-compose.override.yml does not exist. Compose would happily reconcile
# the same project name against the base file alone and re-point the live
# container at that clone's empty dist/.
if command -v docker >/dev/null 2>&1; then
  if ! docker ps --format '{{.Names}}' | grep -qx texas-wind-atlas-caddy; then
    echo
    echo "WARNING: texas-wind-atlas-caddy is not running, so nothing is serving"
    echo "         these files. Start it from a full checkout (NOT the build clone):"
    echo "           cd ~/claude/texas-wind-atlas && docker compose up -d"
  fi
fi
if ! has_token "$SITE/config.js"; then
  echo
  echo "NOTE: no Mapbox token is set. The site will show its setup screen until"
  echo "      you put one in $SITE/config.js:"
  echo "        window.MAPBOX_TOKEN = 'pk....'"
  echo "      No rebuild needed -- that file is served uncached."
fi
