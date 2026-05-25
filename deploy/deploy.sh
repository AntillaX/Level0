#!/usr/bin/env bash
# deploy.sh — pull latest main and restart the Level 0 service.
#
# Run on the droplet from anywhere; the script locates its own repo
# root. --ff-only makes the pull fail loudly if local state has
# diverged from main instead of silently producing a merge.
#
# `npm ci` is the slow step (rebuilds node_modules from scratch), so
# we only run it when package-lock.json actually changed in the pull.
# The steady-state deploy (server.js or public/ change) is then just
# pull + restart.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Pulling latest main"
before=$(git rev-parse HEAD)
git pull --ff-only origin main
after=$(git rev-parse HEAD)

if [ "$before" != "$after" ] && \
   git diff --name-only "$before" "$after" | grep -qx 'package-lock.json'; then
  echo "==> package-lock.json changed, reinstalling deps"
  sudo npm ci --omit=dev
else
  echo "==> Deps unchanged, skipping npm ci"
fi

echo "==> Restarting level0.service"
sudo systemctl restart level0.service

echo "==> Done."
