#!/usr/bin/env bash
#
# verify-mechanism.sh - deterministic, no-LLM proof of the fork's one change.
#
# Resolves pi's bundled runtime packages, then runs bin/verify-mechanism.mjs
# which drives pi's real SessionManager exactly as the patched initSession()
# does, in a throwaway temp dir. No LLM, no pi process, no ~/.pi writes.
#
# Resolution:
#   - @earendil-works/pi-coding-agent: from the global npm root next to `pi`
#     (e.g. /opt/homebrew/lib/node_modules), overridable via PI_LIB.
#   - peer deps (pi-agent-core / pi-ai / pi-tui): from ~/.pi/agent/npm/node_modules,
#     overridable via PI_PEER_MODULES.
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

command -v bun >/dev/null 2>&1 || { echo "bun not on PATH" >&2; exit 2; }

# global npm root next to the pi binary
if [ -z "${PI_LIB:-}" ]; then
  PI_BIN="$(command -v pi || true)"
  if [ -n "$PI_BIN" ]; then
    PREFIX="$(cd "$(dirname "$(dirname "$PI_BIN")")" && pwd)"
    PI_LIB="$PREFIX/lib/node_modules"
  else
    PI_LIB="/opt/homebrew/lib/node_modules"
  fi
fi
PI_PEER_MODULES="${PI_PEER_MODULES:-$HOME/.pi/agent/npm/node_modules}"

echo "PI_LIB          = $PI_LIB"
echo "PI_PEER_MODULES = $PI_PEER_MODULES"
[ -d "$PI_LIB/@earendil-works/pi-coding-agent" ] || echo "warn: pi-coding-agent not found under PI_LIB" >&2
[ -d "$PI_PEER_MODULES/@earendil-works/pi-agent-core" ] || echo "warn: pi-agent-core not found under PI_PEER_MODULES" >&2
echo

NODE_PATH="$PI_LIB:$PI_PEER_MODULES" exec bun "$HERE/verify-mechanism.mjs"
