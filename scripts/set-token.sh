#!/usr/bin/env bash
# Point the atlas at a Mapbox public token.
#
#   ./scripts/set-token.sh pk.eyJ1...           # local dev (.env)
#   ./scripts/set-token.sh --prod pk.eyJ1...    # live site too
#
# Local dev writes .env, which Vite reads as VITE_MAPBOX_TOKEN.
#
# --prod additionally writes /srv/sites/map.hitky.com/config.js. That file is
# served uncached and read before the bundle, so the deployed map picks the new
# token up on the next page load -- no rebuild, no redeploy. deploy.sh then
# preserves it (see has_token there).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE=/srv/sites/map.hitky.com

PROD=0
TOKEN=""
for arg in "$@"; do
  case "$arg" in
    --prod) PROD=1 ;;
    -h | --help)
      sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      exit 0
      ;;
    *) TOKEN="$arg" ;;
  esac
done

if [ -z "$TOKEN" ]; then
  echo "usage: $0 [--prod] pk.eyJ1..." >&2
  exit 2
fi

# A secret token in a browser bundle is a leaked credential, not a typo -- stop
# hard rather than writing it to a file that ships.
case "$TOKEN" in
  sk.*)
    echo "error: that is a SECRET token. The browser needs a public 'pk.' token." >&2
    exit 1
    ;;
  pk.*) ;;
  *)
    echo "error: a Mapbox public token starts with 'pk.'" >&2
    exit 1
    ;;
esac

# Confirm the token actually works before writing it anywhere. A 401 here is the
# difference between a working map and a setup screen, and it costs one request.
if command -v curl >/dev/null 2>&1; then
  echo "==> Checking the token against the Mapbox API"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    "https://api.mapbox.com/styles/v1/mapbox/standard?access_token=$TOKEN" || echo 000)"
  case "$code" in
    200) echo "    ok -- Mapbox accepted it" ;;
    000) echo "    skipped -- could not reach api.mapbox.com" ;;
    401 | 403)
      echo "error: Mapbox rejected the token (HTTP $code)." >&2
      echo "       If you just added a URL restriction, it also blocks this check." >&2
      exit 1
      ;;
    *) echo "    unexpected HTTP $code -- writing it anyway" ;;
  esac
fi

echo "==> Writing $ROOT/.env"
printf 'VITE_MAPBOX_TOKEN=%s\n' "$TOKEN" > "$ROOT/.env"
chmod 600 "$ROOT/.env"

if [ "$PROD" = 1 ]; then
  if [ ! -d "$SITE" ]; then
    echo "error: $SITE does not exist -- run ./scripts/deploy.sh first." >&2
    exit 1
  fi
  echo "==> Writing $SITE/config.js"
  cat > "$SITE/config.js" <<EOF
/**
 * Runtime Mapbox token -- written by scripts/set-token.sh.
 *
 * Served uncached and read before the app bundle, so editing this one line
 * changes the deployed site's token with no rebuild. deploy.sh preserves it.
 */
window.MAPBOX_TOKEN = '$TOKEN'
EOF
  echo "    live site will use it on the next page load"
fi

echo
echo "Done. npm run dev to check it locally."
