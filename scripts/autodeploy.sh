#!/usr/bin/env bash
# Deploy the atlas when origin/main moves. Driven by the map-autodeploy systemd
# timer (every 3 minutes); see README -> Deployment.
#
#   Canonical source : this file, in the repo
#   Installed copy   : /usr/local/bin/map-autodeploy   <- what systemd runs
#
# It runs from an INSTALLED COPY on purpose. This script's own job includes
# `git reset --hard`, and bash reads a script incrementally as it executes -- so a
# push that changed this file while it was running could rewrite the bytes bash
# had not read yet. The installed copy is outside the repo and therefore stable
# for the whole run. deploy.sh is fine to take from the repo because it is exec'd
# fresh AFTER the reset, which is exactly when the new version should be used.
#
# Editing this file has no effect until it is reinstalled:
#   sudo install -m 755 scripts/autodeploy.sh /usr/local/bin/map-autodeploy
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
