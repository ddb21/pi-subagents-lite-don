# Persistent session ownership

## Local-path installation

This fork is loaded by absolute project path, not from npm:

- `/Users/d0d0npq/.pi-lite/agent/settings.json`
- `/Users/d0d0npq/.pi/agent/settings.json`

Both settings files must retain:

```json
"/Users/d0d0npq/puppy_workspace/projects/pi-subagents-lite-don"
```

Do not replace it with `npm:pi-subagents-lite`; an npm install would not carry
this fork's persistent-session safeguards. Restart Pi or use `/reload` after
updating this project.

## Cross-process persistent-session ownership

A non-empty `session_key` for an agent declared `session_lifecycle: persistent`
acquires a filesystem lease before the session-key mapping is read, migrated, or
created. The lease is held through `SessionManager.open` or `SessionManager.create`,
the complete `runAgent` lifecycle, and final turn persistence. Mapping writes for
a first-created keyed session therefore occur while the same ownership lease is
held, preventing two Pi processes from creating competing transcripts or racing
the mapping.

Direct `resumeSessionFile` calls that bypass a `session_key` acquire a separate
lease derived from the canonical absolute JSONL path. This protects alternate
resume paths from concurrent writers.

Lease directories live below `<agent-dir>/sessions-subagents/leases/`. Their
`owner.json` contains the process PID, a random token, and acquisition time.
Release removes a lease only when its token and PID still match. A lease may be
reclaimed only after its owner PID is confirmed dead. There is no TTL-only
reclamation; malformed or live ownership fails closed with
`persistent_session_busy`.

`src/agents/persistent-executor.test.ts` covers same-key and direct-resume
contention, post-release acquisition, and stale-owner recovery. The runtime
manager holds the lease until its `runAgent` finalizer, including error and
startup-failure cleanup.

## Upgrade procedure

1. Fetch and review upstream `pi-subagents-lite` changes before copying them
   into this fork.
2. Reapply and test the fork's persistence, session-key lifecycle, and lease
   logic. Do not edit npm-installed source as the durable fix.
3. Run `bun test` and `bun run typecheck` when the local development dependencies
   are available.
4. Confirm both local settings entries above still reference this project.
5. Restart Pi or use `/reload`; do not update while a persistent executor is
   actively running.
