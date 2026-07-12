# pi-subagents-lite-don

BLUF: A Don-owned vendored fork of `pi-subagents-lite@1.4.6` with exactly one
behavioral change: each subagent now runs on a **persisted** session (with
parent lineage) instead of an in-memory one, so usage/session scrapers can see
and classify subagent runs. Everything else is byte-identical to upstream.

- Provenance: forked from `pi-subagents-lite` version **1.4.6**
  (`git+https://github.com/AlexParamonov/pi-subagents-lite.git`, MIT).
- Source copied from `~/.pi/agent/npm/node_modules/pi-subagents-lite/` on
  2026-07-12.
- Rationale, cited APIs, and options analysis:
  `~/puppy_workspace/projects/llm-usage-tracker/docs/subagent-persistence-findings.md`
  (this fork implements that doc's Option A + the "Shared core edit").

## The one behavioral change

File: `src/agents/agent-runner.ts`, function `initSession()`.

Upstream created every subagent session in memory, so nothing was ever written
to disk:

```ts
sessionManager: SessionManager.inMemory(cwd),
```

This fork persists the subagent session under a dedicated subdir, tagged with
the parent session for lineage, and falls back to the old in-memory behavior
when there is no parent session (for example `pi -p --no-session`):

```ts
const parent = ctx.sessionManager.getSessionFile();
const subagentDir = path.join(agentDir, "sessions-subagents");
const sessionManager = parent
  ? SessionManager.create(cwd, subagentDir, { parentSession: parent })
  : SessionManager.inMemory(cwd);
```

The full diff is `patch/persist.diff`. No imports were added (`path`,
`getAgentDir`, and `SessionManager` were already imported). The existing
`session.setSessionName(...)` call is unchanged; once the manager persists, that
call emits a `session_info` entry naming the session after the agent
(for example `qa#a1b2c3d4`).

Result per subagent run (when the parent session is persisted): one `.jsonl`
under `<agent-dir>/sessions-subagents/` whose header carries
`parentSession = <parent .jsonl path>`, a `session_info` name entry, and
assistant messages carrying per-turn `usage` (tokens/cost).

Note on style: the patch reuses the `agentDir` local already computed two lines
above (`const agentDir = getAgentDir();`) rather than calling `getAgentDir()`
again. This is semantically identical to the findings-doc snippet and matches
the surrounding code, which already uses `agentDir`.

## How pi loads this fork (no build step)

Pi consumes the package's TypeScript `src/` directly (via its bundled bun
runtime). The package manifest declares the entry in `package.json`:

```json
"pi": { "extensions": ["./src/index.ts"] }
```

There is no `dist/`, no compile, and no `npm install`:

- The `@earendil-works/*` imports are pi core packages (peer dependencies) that
  pi provides to every extension.
- The only third-party import is `@sinclair/typebox` (in
  `src/registration.ts`). Pi bundles it at
  `.../pi-coding-agent/node_modules/typebox` and injects it for extensions, so
  it resolves even for a package loaded from an arbitrary local path. Verified
  empirically (see "Verification").

To activate the fork, point pi at this directory with an absolute local path in
`settings.json` `packages` (replacing `"npm:pi-subagents-lite"`). Exact,
reversible steps are in `docs/CUTOVER.md`. This fork is a true drop-in: it reads
the same `~/.pi/agent/subagents-lite.json` config and registers the same
`/agents` command, so all existing agent definitions and settings carry over.

## Verification

Two levels; see `docs/CUTOVER.md` for how they fit the cutover.

1. Deterministic, no-LLM mechanism proof (safe to run anytime):

   ```bash
   ./bin/verify-mechanism.sh
   ```

   Drives pi's real `SessionManager` exactly as the patched `initSession()`
   does, in a throwaway temp dir, and asserts the persisted `.jsonl` has
   `parentSession` in the header plus a `session_info` name entry, and that the
   no-parent branch stays in-memory. No pi process, no LLM, no `~/.pi` writes.

2. End-to-end integration proof (needs a provisioned throwaway agent dir):

   ```bash
   ./bin/verify.sh --agent-dir /path/to/throwaway-agent-dir
   ```

   Launches one isolated `pi -p` subagent run against a throwaway agent dir that
   loads this fork, then asserts a new `.jsonl` under `sessions-subagents/`.
   Refuses to run against the live `~/.pi/agent`.

## Re-syncing with upstream later

Upstream is a single-file change, so re-sync is cheap.

1. Note the upstream version you are moving to and refresh the source:

   ```bash
   # Upstream pristine agent-runner.ts sha256 this fork was cut from (1.4.6):
   #   4c312cb77c919f3d185094bb516316ac554b2fd7c5f9e73e91f55bc3b4c9cb6b
   UP=~/.pi/agent/npm/node_modules/pi-subagents-lite   # or a fresh npm/git checkout
   shasum -a 256 "$UP/src/agents/agent-runner.ts"      # compare to the hash above
   rsync -a --delete "$UP/src/" src/                   # bring in the new upstream src
   cp "$UP/README.md" UPSTREAM_README.md
   ```

2. Re-apply the one change:

   ```bash
   git apply patch/persist.diff        # clean re-apply if initSession() is unchanged
   ```

   If upstream refactored `initSession()` and the patch does not apply, redo the
   edit by hand: replace `sessionManager: SessionManager.inMemory(cwd)` in
   `initSession()` with the parent-aware block shown above, then regenerate the
   patch:

   ```bash
   diff -u --label a/src/agents/agent-runner.ts --label b/src/agents/agent-runner.ts \
     "$UP/src/agents/agent-runner.ts" src/agents/agent-runner.ts > patch/persist.diff
   ```

3. Re-verify and commit:

   ```bash
   ./bin/verify-mechanism.sh
   git add src patch/persist.diff UPSTREAM_README.md
   git commit -m "resync: pi-subagents-lite <old> -> <new>, reapply persist change"
   ```

## Layout

| Path | Purpose |
|---|---|
| `src/` | Vendored upstream source with the one change applied |
| `patch/persist.diff` | The applied change, for reference and re-apply |
| `docs/CUTOVER.md` | Exact reversible load / verify / rollback steps |
| `bin/verify-mechanism.sh` + `.mjs` | Deterministic no-LLM persistence proof |
| `bin/verify.sh` | End-to-end isolated subagent run + assertions |
| `UPSTREAM_README.md` | Upstream README, verbatim, for provenance |
| `LICENSE` | Upstream MIT license, retained |

## License

MIT, inherited from upstream (`LICENSE`).
