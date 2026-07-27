#!/bin/bash
# Install (or reinstall) the daily pi-session-cleanup launchd job.
# Machine-agnostic: works on the Main Mac and the aighost desk-server (both use
# /Users/d0d0npq). Idempotent: safe to re-run. Creates files + loads the job.
#
#   ./launchd/install.sh          # install + load
#   ./launchd/install.sh --dry    # print actions only, change nothing
#
# Uninstall:
#   launchctl bootout gui/$(id -u)/com.d0d0npq.pi-session-cleanup
#   rm ~/Library/LaunchAgents/com.d0d0npq.pi-session-cleanup.plist
set -euo pipefail

LABEL="com.d0d0npq.pi-session-cleanup"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC_PLIST="$REPO/launchd/$LABEL.plist"
DEST_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WRAPPER="$REPO/launchd/pi-session-cleanup-run.sh"
LOGDIR="$HOME/.pi-cleanup"

DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

run() {
  echo "+ $*"
  [ "$DRY" -eq 1 ] || "$@"
}

[ -f "$SRC_PLIST" ] || { echo "missing plist: $SRC_PLIST" >&2; exit 1; }
[ -f "$WRAPPER" ] || { echo "missing wrapper: $WRAPPER" >&2; exit 1; }

# Runtime resolution mirrors the wrapper: bun runs the .ts sources (Main); node
# runs the prebuilt bundle (aighost, no bun). Refuse to install if neither the
# .ts+bun path nor the node+bundle path is available.
BUN_BIN="$(command -v bun 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/local/bin/node)"
BUNDLE="$REPO/launchd/pi-session-cleanup.bundle.mjs"
if [ -z "$BUN_BIN" ] && { [ ! -x "$NODE_BIN" ] || [ ! -f "$BUNDLE" ]; }; then
  echo "no runtime: need bun, or node + prebuilt $BUNDLE (run 'bun build bin/pi-session-cleanup.ts --target=node --outfile launchd/pi-session-cleanup.bundle.mjs' on a bun machine and sync it here)" >&2
  exit 1
fi

# On a bun machine, rebuild the node bundle from current sources so the synced
# copy aighost consumes is never stale relative to the .ts it was cut from.
if [ -n "$BUN_BIN" ] && [ "$DRY" -eq 0 ]; then
  echo "+ bun build -> $BUNDLE"
  "$BUN_BIN" build "$REPO/bin/pi-session-cleanup.ts" --target=node --outfile "$BUNDLE"
fi

run chmod +x "$WRAPPER"
run mkdir -p "$LOGDIR/history" "$HOME/Library/LaunchAgents"

# The plist hardcodes the Main-Mac repo path; rewrite the ProgramArguments path
# to THIS repo so a differently-located checkout on aighost still works.
if [ "$DRY" -eq 1 ]; then
  echo "+ install plist -> $DEST_PLIST (wrapper: $WRAPPER)"
else
  sed "s#/Users/d0d0npq/puppy_workspace/projects/pi-subagents-lite-don/launchd/pi-session-cleanup-run.sh#$WRAPPER#g" \
    "$SRC_PLIST" > "$DEST_PLIST"
fi

# Reload cleanly (bootout is best-effort; ignore if not currently loaded).
DOMAIN="gui/$(id -u)"
run launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
run launchctl bootstrap "$DOMAIN" "$DEST_PLIST"
run launchctl enable "$DOMAIN/$LABEL"

echo "installed $LABEL (daily 04:30). Dry-run preview:"
if [ "$DRY" -eq 0 ]; then
  if [ -n "$BUN_BIN" ]; then
    (unset PI_CODING_AGENT_DIR; "$BUN_BIN" run "$REPO/bin/pi-session-cleanup.ts" --retention-days 14) || true
  else
    (unset PI_CODING_AGENT_DIR; "$NODE_BIN" "$BUNDLE" --retention-days 14) || true
  fi
fi
echo "done."
