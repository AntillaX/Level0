#!/usr/bin/env bash
# deploy.sh — pull latest main and restart the Level 0 service.
#
# Safe to run on a timer as well as by hand. Two things make that true:
#
#   1. It exits early when the pull brought nothing new, so it does not
#      restart the service on every tick.
#   2. It waits while a game is in progress. Rooms live in memory, so a
#      restart mid-tournament destroys it. After DEPLOY_DEFER_LIMIT_MIN
#      of waiting it goes ahead anyway, so a table left open overnight
#      can't block a deploy forever.
#
# `npm ci` is the slow step (rebuilds node_modules from scratch), so we
# only run it when package-lock.json actually changed in the pull.
#
# Run on the droplet from anywhere; the script locates its own repo
# root. --ff-only makes the pull fail loudly if local state has diverged
# from main instead of silently producing a merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${LEVEL0_PORT:-3200}"
DEFER_LIMIT_MIN="${DEPLOY_DEFER_LIMIT_MIN:-45}"
DEFER_STAMP="/tmp/level0-deploy-deferred-since"

# Under systemd we're already root; run by hand we need sudo.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

echo "==> Fetching origin/main"
before=$(git rev-parse HEAD)
git pull --ff-only origin main
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
  echo "==> Already up to date — nothing to deploy"
  rm -f "$DEFER_STAMP"
  exit 0
fi

echo "==> New commits:"
git --no-pager log --oneline "$before".."$after" | sed 's/^/      /'

# ── Hold off while people are playing ────────────────────────────────

busy=""
if command -v curl >/dev/null 2>&1; then
  busy="$(curl -sS --max-time 3 "http://127.0.0.1:${PORT}/api/status" 2>/dev/null \
          | grep -o '"busy":[a-z]*' | cut -d: -f2 || true)"
fi

if [ "$busy" = "true" ]; then
  now=$(date +%s)
  [ -f "$DEFER_STAMP" ] || echo "$now" > "$DEFER_STAMP"
  since="$(cat "$DEFER_STAMP")"
  waited_min=$(( (now - since) / 60 ))

  if [ "$waited_min" -lt "$DEFER_LIMIT_MIN" ]; then
    echo "==> A game is in progress — deferring (${waited_min}/${DEFER_LIMIT_MIN} min)"
    # Roll back so the next run re-pulls this range and re-checks. The
    # working tree is untouched otherwise, so this is safe to repeat.
    git reset --hard "$before" >/dev/null
    exit 0
  fi
  echo "==> Game still in progress after ${waited_min} min — deploying anyway"
fi
rm -f "$DEFER_STAMP"

# ── Deploy ───────────────────────────────────────────────────────────

if git diff --name-only "$before" "$after" | grep -qx 'package-lock.json'; then
  echo "==> package-lock.json changed, reinstalling deps"
  $SUDO npm ci --omit=dev
else
  echo "==> Deps unchanged, skipping npm ci"
fi

echo "==> Restarting level0.service"
$SUDO systemctl restart level0.service

sleep 2
if $SUDO systemctl is-active --quiet level0.service; then
  echo "==> Deployed $(git rev-parse --short HEAD) — service is up"
else
  echo "!!! level0.service is not running after restart" >&2
  $SUDO systemctl status level0.service --no-pager --lines 20 >&2 || true
  exit 1
fi
