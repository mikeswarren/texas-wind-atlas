#!/usr/bin/env bash
# Deploy the atlas when origin/main moves. Driven by the map-autodeploy systemd
# timer (every 3 minutes); see README -> Deployment.
#
# This file is canonical and needs no install step. systemd runs
# scripts/autodeploy-launcher.sh (installed once at /usr/local/bin/map-autodeploy),
# which snapshots this script to a temp file and runs the snapshot -- so the bytes
# bash is reading cannot be rewritten by the `git reset --hard` below, and editing
# this file takes effect on the next run. See that launcher for the full reasoning.
#
# deploy.sh is invoked straight from the repo because it runs AFTER the reset,
# which is exactly when the new version should be used.
#
# The clone it deploys from (/srv/build/texas-wind-atlas) is a build artefact,
# never edited by hand -- which is why `git reset --hard` is safe here and why the
# developer's own working copy is left completely alone.
set -euo pipefail

REPO=${REPO:-/srv/build/texas-wind-atlas}
BRANCH=${BRANCH:-main}

cd "$REPO"

git fetch --quiet origin "$BRANCH"
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$BRANCH")

if [ "$local_sha" = "$remote_sha" ]; then
  echo "up to date at ${local_sha:0:8} -- nothing to deploy"
  exit 0
fi

echo "==> ${local_sha:0:8} -> ${remote_sha:0:8}"
git log --oneline "${local_sha}..${remote_sha}" | sed 's/^/    /'

git reset --quiet --hard "$remote_sha"

# Reinstall dependencies only when the manifest actually moved; npm ci wipes and
# rebuilds node_modules, which is far too slow to do on every content push.
if ! git diff --quiet "$local_sha" "$remote_sha" -- package.json package-lock.json; then
  echo "==> dependencies changed, running npm ci"
  npm ci --silent
fi

# deploy.sh validates the style specs and builds before publishing, and preserves
# the live config.js token -- so a bad push fails here rather than taking the map
# down.
./scripts/deploy.sh

echo "deployed ${remote_sha:0:8}"
