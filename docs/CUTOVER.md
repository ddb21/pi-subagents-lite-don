# Cutover: swap `npm:pi-subagents-lite` for this vendored fork

BLUF: The cutover is a **one-line, fully reversible** edit to
`~/.pi/agent/settings.json` `packages`: replace `"npm:pi-subagents-lite"` with
the absolute path to this vendored package. No build, no `npm install`, no other
file changes. Rollback restores the one line. The edit only takes effect for pi
processes started **after** the edit, so it never disturbs a running session.

Status: this document is the **unapplied** plan. Nothing in `~/.pi` has been
modified. Apply Step 1 manually when ready.

- Vendored package path (absolute):
  `/Users/d0d0npq/puppy_workspace/projects/pi-subagents-lite-don`
- Live settings file: `/Users/d0d0npq/.pi/agent/settings.json`

## Why this works (no build step)

Pi accepts a local absolute path in `packages` and loads it using package rules,
reading the package's `pi` manifest (`"extensions": ["./src/index.ts"]`) and
running the TypeScript directly via its bundled bun runtime. The `@earendil-works/*`
imports are pi core peers; the only third-party import, `@sinclair/typebox`, is
bundled by pi and injected for extensions. All of this was verified by loading
the package from this exact path in an isolated pi run (see "Verification"). Docs:
`.../pi-coding-agent/docs/packages.md` ("Local Paths") and `settings.md`
("packages").

Identity/dedup: pi identifies a local package by its resolved absolute path and
an npm package by its name. They are distinct entries, so removing the
`"npm:pi-subagents-lite"` entry fully unloads the npm copy. Do **not** keep both:
two copies would each register an `Agent` tool and collide.

## Step 1 - Load the vendored package (the cutover)

Back up first, then edit `packages` in `~/.pi/agent/settings.json`.

```bash
cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak.pre-vendor-$(date +%Y%m%d_%H%M%S)
```

Change **only** the one array element. Before (current live state):

```json
  "packages": [
    "npm:@narumitw/pi-goal",
    "npm:pi-chrome",
    "npm:@firstpick/pi-extension-stats",
    "npm:@cad0p/pi-bash-timeout",
    "npm:pi-bg-run",
    "npm:pi-subagents-lite",
    "npm:pi-fetch",
    "npm:@juicesharp/rpiv-btw",
    "npm:pi-powerline-footer"
  ],
```

After (only line 6 of the array changes):

```json
  "packages": [
    "npm:@narumitw/pi-goal",
    "npm:pi-chrome",
    "npm:@firstpick/pi-extension-stats",
    "npm:@cad0p/pi-bash-timeout",
    "npm:pi-bg-run",
    "/Users/d0d0npq/puppy_workspace/projects/pi-subagents-lite-don",
    "npm:pi-fetch",
    "npm:@juicesharp/rpiv-btw",
    "npm:pi-powerline-footer"
  ],
```

`packages` is read at startup. The edit affects only pi processes started after
it; any pi session already running (including a build in progress) keeps the
code it loaded at its own startup. To actually cut over, start a new pi session
(or exit and relaunch). Nothing else in `settings.json` changes.

Alternative form (equivalent): instead of editing `packages`, you may run
`pi install /Users/d0d0npq/puppy_workspace/projects/pi-subagents-lite-don` and
then `pi remove npm:pi-subagents-lite`. This writes the same `settings.json`
result. The manual edit above is preferred because it is atomic and obvious.

## Step 2 - Verify

Deterministic, no-LLM proof of the persistence code (already executed on
2026-07-12, ALL PASS; safe to re-run anytime, touches nothing live):

```bash
cd /Users/d0d0npq/puppy_workspace/projects/pi-subagents-lite-don
./bin/verify-mechanism.sh
```

Confirm the loaded package after cutover (new pi process):

```bash
pi list        # expect the local path listed; expect NO npm:pi-subagents-lite
```

End-to-end, two options:

- Isolated (recommended, no risk to live data): provision a throwaway agent dir
  that loads this fork and has a working provider/models/auth (cloning your live
  agent dir to a temp location is the usual way; that copy is your call), then:

  ```bash
  ./bin/verify.sh --agent-dir /path/to/throwaway-agent-dir
  ```

  It launches one isolated `pi -p` subagent run and asserts a new `.jsonl` under
  `<agent-dir>/sessions-subagents/` with `parentSession` in the header and a
  `session_info` name. It refuses to run against `~/.pi/agent`.

- Live (manual): after cutover, in a normal interactive pi session, spawn any
  subagent, then check for the new persisted file:

  ```bash
  ls -t ~/.pi/agent/sessions-subagents/*.jsonl | head -1
  head -1 "$(ls -t ~/.pi/agent/sessions-subagents/*.jsonl | head -1)" | python3 -m json.tool | grep parentSession
  ```

  Expect a `parentSession` pointing at the parent session `.jsonl`.

What was and was not verified here:

| Check | Method | Result |
|---|---|---|
| Persistence mechanism (header `parentSession`, `session_info` name, in-memory fallback) | `bin/verify-mechanism.sh` against pi's real `SessionManager`, isolated `/tmp` | PASS (2026-07-12) |
| Fork loads from this local path (imports incl. `@sinclair/typebox` resolve) | isolated pi run, throwaway HOME + `PI_CODING_AGENT_DIR`, offline | PASS (reached model call; failed only on throwaway auth) |
| Live end-to-end subagent writes a `sessions-subagents/*.jsonl` | `bin/verify.sh` or the live manual check above | Not run here (needs real provider auth; do this at cutover) |

## Step 3 - Roll back

Reverse Step 1: restore the one array element in `~/.pi/agent/settings.json`.

After (rollback target) - line 6 goes back to the npm spec:

```json
  "packages": [
    "npm:@narumitw/pi-goal",
    "npm:pi-chrome",
    "npm:@firstpick/pi-extension-stats",
    "npm:@cad0p/pi-bash-timeout",
    "npm:pi-bg-run",
    "npm:pi-subagents-lite",
    "npm:pi-fetch",
    "npm:@juicesharp/rpiv-btw",
    "npm:pi-powerline-footer"
  ],
```

Or restore the backup wholesale:

```bash
cp ~/.pi/agent/settings.json.bak.pre-vendor-<stamp> ~/.pi/agent/settings.json
```

Start a new pi session for rollback to take effect. The npm package
`pi-subagents-lite@1.4.6` is still installed under `~/.pi/agent/npm/`, so
rollback needs no reinstall.

Note: the fork writes subagent sessions under `~/.pi/agent/sessions-subagents/`.
Rolling back stops new writes there; existing files are inert and can be left or
deleted. They do not appear in `/resume` (that lists only the default session
tree).
