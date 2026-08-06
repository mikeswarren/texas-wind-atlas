#!/usr/bin/env bash
# Stable launcher for the autodeploy job. This is what systemd runs:
#
#   Installed copy : /usr/local/bin/map-autodeploy   <- this file
#   Real logic     : $REPO/scripts/autodeploy.sh     <- canonical, edited freely
#
# WHY THE INDIRECTION
#
# autodeploy.sh runs `git reset --hard`, and bash reads a script incrementally as
# it executes -- so a push that changed autodeploy.sh while it was running could
# rewrite the bytes bash had not read yet. The old fix was to install a *copy* of
# autodeploy.sh here, which worked but meant every edit silently did nothing until
# someone remembered to reinstall it.
#
# So this launcher snapshots the repo's autodeploy.sh to a temp file and runs the
# snapshot. The executing bytes are immutable for the whole run, and the repo copy
# is once again the only thing anyone has to edit.
#
# This file has no project logic in it and should essentially never change. If it
# ever does, reinstall it -- and only it:
#   sudo install -m 755 scripts/autodeploy-launcher.sh /usr/local/bin/map-autodeploy
#
# The snapshot is taken BEFORE the fetch, so a push that edits autodeploy.sh takes
# effect on the following run (<= 3 minutes later), never mid-flight.
set -euo pipefail

REPO=${REPO:-/srv/build/texas-wind-atlas}
SCRIPT="$REPO/scripts/autodeploy.sh"

if [ ! -r "$SCRIPT" ]; then
  echo "map-autodeploy: $SCRIPT is missing or unreadable" >&2
  exit 1
fi

snapshot=$(mktemp "${TMPDIR:-/tmp}/map-autodeploy.XXXXXX")
trap 'rm -f "$snapshot"' EXIT

cat "$SCRIPT" > "$snapshot"

# Deliberately not `exec` -- exec would replace this shell and the EXIT trap
# would never fire, leaking a temp file every three minutes. `set -e` propagates
# the exit status, which is all exec was buying.
bash "$snapshot"
