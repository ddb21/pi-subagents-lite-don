#!/usr/bin/env bash
#
# verify.sh - end-to-end acceptance test for the Don fork of pi-subagents-lite.
#
# Given a throwaway pi agent dir that loads THIS vendored package, launch one
# isolated subagent run and assert that a persisted .jsonl appeared under
# <agent-dir>/sessions-subagents/ carrying:
#   1. a `parentSession` field in the session header (line 1), and
#   2. a `session_info` entry with a `name` (the agent label).
#
# SAFETY:
#   - Refuses to run against the live agent dir (~/.pi/agent). The agent dir you
#     pass MUST be a throwaway/clone you provisioned yourself.
#   - Runs pi with PI_CODING_AGENT_DIR pointed at that throwaway dir, so
#     settings/sessions/auth/models all resolve there, never from ~/.pi.
#   - Uses a throwaway cwd (mktemp) unless --cwd is given.
#
# REQUIREMENTS for the agent dir you pass:
#   - settings.json whose `packages` loads this vendored package by absolute
#     path (see docs/CUTOVER.md) and does NOT also list "npm:pi-subagents-lite".
#   - A working provider + models.json + auth.json so an LLM turn can run.
#     (Cloning your live agent dir to a throwaway location is the usual way;
#      that copy is your call and is outside this script.)
#
# Because it drives a real model, whether a subagent is actually spawned depends
# on the model honoring the prompt. If no subagent file appears, that is most
# likely a "model did not call the Agent tool" outcome, not a persistence bug;
# re-run or use bin/verify-mechanism.sh for the deterministic, no-LLM proof.
#
# Usage:
#   bin/verify.sh --agent-dir /path/to/throwaway-agent-dir [--cwd DIR] \
#                 [--model PATTERN] [--prompt TEXT] [--keep]
#
set -euo pipefail

AGENT_DIR=""
RUN_CWD=""
MODEL=""
PROMPT="Spawn exactly one general-purpose subagent whose entire task is to reply with the single word READY. Use your Agent/subagent tool to do it. Do not perform the task yourself. After the subagent returns, stop."
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="${2:-}"; shift 2 ;;
    --cwd)       RUN_CWD="${2:-}"; shift 2 ;;
    --model)     MODEL="${2:-}"; shift 2 ;;
    --prompt)    PROMPT="${2:-}"; shift 2 ;;
    --keep)      KEEP=1; shift ;;
    -h|--help)   sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -n "$AGENT_DIR" ] || fail "--agent-dir is required"
[ -d "$AGENT_DIR" ] || fail "agent dir does not exist: $AGENT_DIR"

command -v pi >/dev/null 2>&1 || fail "pi not on PATH"
command -v python3 >/dev/null 2>&1 || fail "python3 not on PATH"

# --- hard safety guard: never run against the live agent dir ---
resolve() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
LIVE_DIR="$(resolve "${HOME}/.pi/agent")"
REQ_DIR="$(resolve "$AGENT_DIR")"
if [ "$REQ_DIR" = "$LIVE_DIR" ]; then
  fail "refusing to run against the live agent dir ($LIVE_DIR). Pass a throwaway/clone."
fi

SUBDIR="$REQ_DIR/sessions-subagents"

# throwaway cwd unless provided
CLEAN_CWD=0
if [ -z "$RUN_CWD" ]; then
  RUN_CWD="$(mktemp -d "${TMPDIR:-/tmp}/psl-don-verify-cwd-XXXXXX")"
  CLEAN_CWD=1
fi

echo "== pi-subagents-lite-don verify.sh =="
echo "agent dir : $REQ_DIR"
echo "cwd       : $RUN_CWD"
echo "subagents : $SUBDIR"
echo

# snapshot existing subagent session files (may be none)
BEFORE="$(mktemp)"; AFTER="$(mktemp)"
if [ -d "$SUBDIR" ]; then find "$SUBDIR" -type f -name '*.jsonl' | sort > "$BEFORE"; else : > "$BEFORE"; fi

# run one isolated pi print-mode turn against the throwaway agent dir
set +e
PI_ARGS=(-p "$PROMPT")
[ -n "$MODEL" ] && PI_ARGS=(--model "$MODEL" "${PI_ARGS[@]}")
( cd "$RUN_CWD" && PI_CODING_AGENT_DIR="$REQ_DIR" pi "${PI_ARGS[@]}" ) >/tmp/psl-don-verify-pi.out 2>&1
PI_EXIT=$?
set -e
echo "pi exit=$PI_EXIT (output at /tmp/psl-don-verify-pi.out)"

if [ -d "$SUBDIR" ]; then find "$SUBDIR" -type f -name '*.jsonl' | sort > "$AFTER"; else : > "$AFTER"; fi
NEWFILES="$(comm -13 "$BEFORE" "$AFTER" || true)"

cleanup() {
  rm -f "$BEFORE" "$AFTER"
  [ "$CLEAN_CWD" -eq 1 ] && [ "$KEEP" -eq 0 ] && rm -rf "$RUN_CWD" || true
}
trap cleanup EXIT

if [ -z "$NEWFILES" ]; then
  echo
  echo "No new .jsonl under $SUBDIR."
  echo "The model likely did not call the Agent tool (nondeterministic), or the"
  echo "parent session was ephemeral. This is not proof of a persistence bug."
  echo "Use bin/verify-mechanism.sh for the deterministic, no-LLM check."
  exit 1
fi

echo
echo "New subagent session file(s):"
echo "$NEWFILES" | sed 's/^/  /'

# assert header.parentSession and a session_info name on the newest new file
NEWEST="$(echo "$NEWFILES" | tail -1)"
echo
echo "Asserting on: $NEWEST"
python3 - "$NEWEST" <<'PY'
import json, sys
path = sys.argv[1]
lines = [l for l in open(path, encoding="utf-8").read().splitlines() if l.strip()]
assert lines, "file is empty"
header = json.loads(lines[0])
assert header.get("type") == "session", "line 1 is not a session header"
parent = header.get("parentSession")
assert parent, "header has no parentSession"
info = next((json.loads(l) for l in lines
             if json.loads(l).get("type") == "session_info"), None)
assert info is not None, "no session_info entry"
assert info.get("name"), "session_info has no name"
print("PASS header.parentSession =", parent)
print("PASS session_info.name    =", info["name"])
PY

echo
echo "ALL PASS"
