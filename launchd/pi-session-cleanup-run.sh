#!/bin/bash
# Wrapper for the launchd-scheduled session cleanup. Owns its own logging so
# neither the canonical log nor launchd's stdout grow unbounded:
#   - canonical log is rewritten atomically each run (fresh mtime, bounded size)
#   - a timestamped history copy is kept and pruned after 14 days
# Exit code is propagated so launchd (and the Fleet Monitor) get a real health
# signal instead of merely "a log exists".
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$HOME/.pi-cleanup"
HISTDIR="$LOGDIR/history"
CANON="$LOGDIR/pi-session-cleanup.log"
mkdir -p "$HISTDIR"

# Runtime resolution: prefer bun (runs the .ts sources directly, Main Mac); fall
# back to node running the prebuilt dependency-free bundle dist/pi-session-
# cleanup.mjs (aighost has node v24 but no bun). Node cannot run the .ts sources
# directly because they import ".js" specifiers that bun-only remaps to ".ts".
resolve_bin() {
  local name="$1"; shift
  local found; found="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$found" ] && { echo "$found"; return; }
  for c in "$@"; do [ -x "$c" ] && { echo "$c"; return; }; done
}
BUN="$(resolve_bin bun /opt/homebrew/bin/bun /usr/local/bin/bun "$HOME/.bun/bin/bun")"
NODE="$(resolve_bin node /opt/homebrew/bin/node /usr/local/bin/node)"
BUNDLE="$REPO/launchd/pi-session-cleanup.bundle.mjs"

tmp="$CANON.tmp.$$"
# Clean ALL agent dirs (~/.pi/agent and ~/.pi-lite/agent), existence-filtered by
# the CLI default. Unset PI_CODING_AGENT_DIR so a leaked interactive value can
# never narrow the sweep to a single dir.
unset PI_CODING_AGENT_DIR
# Subagent-session cleanup only. Top-level sessions/ (--include-main) stays OFF
# by default; enable deliberately after reviewing a dry-run.
if [ -n "$BUN" ]; then
  "$BUN" run "$REPO/bin/pi-session-cleanup.ts" \
    --apply --retention-days 14 --trash-retention-days 7 > "$tmp" 2>&1
  rc=$?
elif [ -n "$NODE" ] && [ -f "$BUNDLE" ]; then
  "$NODE" "$BUNDLE" \
    --apply --retention-days 14 --trash-retention-days 7 > "$tmp" 2>&1
  rc=$?
else
  echo "PI_SESSION_CLEANUP status=error reason=no-runtime (need bun, or node + $BUNDLE) at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CANON"
  exit 3
fi

mv -f "$tmp" "$CANON"
cp -f "$CANON" "$HISTDIR/pi-session-cleanup-$(date +%Y-%m-%d_%H%M%S).log"
# Prune history older than 14 days (best-effort).
find "$HISTDIR" -name 'pi-session-cleanup-*.log' -type f -mtime +14 -delete 2>/dev/null

exit $rc
