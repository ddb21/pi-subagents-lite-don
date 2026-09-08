// Don fork: disk index and resume repair for named persistent subagent sessions.

import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

const SUBAGENT_SESSION_DIR = "sessions-subagents";
const SESSION_KEY_INDEX_FILE = "session-keys.json";
type SessionKeyIndex = Record<string, string>;
export type PersistentSessionLease = { lockPath: string; sessionFile?: string; release(): void };

export function getSubagentSessionDir(agentDir: string): string {
  return path.join(agentDir, SUBAGENT_SESSION_DIR);
}

/** Key sessions by normalized parent cwd, canonical resolved agent type, and caller key. */
export function getSessionKeyIndexKey(cwd: string, canonicalAgentType: string, sessionKey: string): string {
  return `${path.resolve(cwd)}|${canonicalAgentType.toLowerCase()}|${sessionKey}`;
}

function getLegacySessionKeyIndexKey(cwd: string, sessionKey: string): string {
  return `${path.resolve(cwd)}|${sessionKey}`;
}

export function getSessionKeyIndexFile(agentDir: string): string {
  return path.join(getSubagentSessionDir(agentDir), SESSION_KEY_INDEX_FILE);
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function leasePath(agentDir: string, identity: string): string { return path.join(getSubagentSessionDir(agentDir), "leases", `${createHash("sha256").update(identity).digest("hex")}.lock`); }
function acquireLease(pathname: string): PersistentSessionLease {
  fs.mkdirSync(path.dirname(pathname), { recursive: true }); const token = randomUUID();
  for (;;) {
    try { fs.mkdirSync(pathname); break; } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: unknown; token?: unknown } | undefined;
      try { owner = JSON.parse(fs.readFileSync(path.join(pathname, "owner.json"), "utf8")); } catch {}
      if (!owner || typeof owner.pid !== "number" || typeof owner.token !== "string" || processAlive(owner.pid)) throw new Error(`persistent_session_busy:${pathname}`);
      const stale = `${pathname}.stale.${Date.now()}.${randomUUID()}`;
      try { fs.renameSync(pathname, stale); fs.rmSync(stale, { recursive: true, force: true }); } catch (renameError: unknown) { if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`persistent_session_busy:${pathname}`); }
    }
  }
  try { const ownerFile = path.join(pathname, "owner.json"); fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx", mode: 0o600 }); } catch (error) { fs.rmSync(pathname, { recursive: true, force: true }); throw error; }
  let released = false;
  return { lockPath: pathname, release() { if (released) return; released = true; try { const owner = JSON.parse(fs.readFileSync(path.join(pathname, "owner.json"), "utf8")); if (owner.pid === process.pid && owner.token === token) fs.rmSync(pathname, { recursive: true, force: true }); } catch {} } };
}

/** Acquire before resolving or creating a keyed session; release only after the complete run has persisted. */
export function acquireSessionKeyLease(agentDir: string, cwd: string, canonicalAgentType: string, sessionKey: string): PersistentSessionLease {
  return acquireLease(leasePath(agentDir, `key:${getSessionKeyIndexKey(cwd, canonicalAgentType, sessionKey)}`));
}

/** Protect direct resume paths that bypass session_key mapping. */
export function acquireSessionFileLease(agentDir: string, sessionFile: string): PersistentSessionLease {
  const lease = acquireLease(leasePath(agentDir, `file:${path.resolve(sessionFile)}`)); lease.sessionFile = path.resolve(sessionFile); return lease;
}

/**
 * Fail-closed read for maintenance tooling. A missing index is an empty index
 * (ENOENT -> {}), but a present-but-corrupt index THROWS instead of silently
 * degrading to {}. Cleanup must never interpret an unreadable index as "nothing
 * is referenced" and then delete live persistent-session transcripts.
 */
export function readSessionKeyIndexStrict(agentDir: string): SessionKeyIndex {
  const indexFile = getSessionKeyIndexFile(agentDir);
  let raw: string;
  try {
    raw = fs.readFileSync(indexFile, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`invalid session key index (not an object): ${indexFile}`);
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string") throw new Error(`invalid session key index (non-string value): ${indexFile}`);
  }
  return parsed as SessionKeyIndex;
}

function parseIndex(indexFile: string): SessionKeyIndex {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("invalid session key index");
    for (const value of Object.values(parsed)) if (typeof value !== "string") throw new Error("invalid session key index");
    return parsed as SessionKeyIndex;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {};
  }
}

/** Run `fn` while holding the index file lock. Does not read or write the index
 *  itself; callers decide. Shared by the mutate and read-only-under-lock paths. */
function withIndexFileLock<T>(indexFile: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const lockFile = `${indexFile}.lock`;
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockFile); } catch { /* best effort */ }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

export function mutateSessionKeyIndex(agentDir: string, mutate: (index: SessionKeyIndex) => void): SessionKeyIndex {
  const indexFile = getSessionKeyIndexFile(agentDir);
  return withIndexFileLock(indexFile, () => {
    const index = parseIndex(indexFile);
    mutate(index);
    const tempFile = `${indexFile}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(index) + "\n", "utf8");
    fs.renameSync(tempFile, indexFile);
    return index;
  });
}

/**
 * Hold the index lock, strict-read the index (fail-closed on corruption), and
 * run `fn` against it WITHOUT writing. Cleanup uses this to check-and-move a
 * transcript atomically: because the lock is held across the caller's move, a
 * concurrent recordSessionKey cannot register the same path mid-move. A corrupt
 * index throws here so the caller can fail closed rather than treating an
 * unreadable index as "nothing referenced".
 */
export function withSessionKeyIndexLock<T>(agentDir: string, fn: (index: SessionKeyIndex) => T): T {
  const indexFile = getSessionKeyIndexFile(agentDir);
  return withIndexFileLock(indexFile, () => fn(readSessionKeyIndexStrict(agentDir)));
}

export function readSessionKeyIndex(agentDir: string): SessionKeyIndex {
  return parseIndex(getSessionKeyIndexFile(agentDir));
}

/**
 * Returns a persisted keyed session when its JSONL exists. A valid scoped entry
 * wins. If it is stale, executor may atomically migrate the valid legacy entry;
 * non-executor types never consume ambiguous legacy state.
 */
export function resolveSessionKey(agentDir: string, cwd: string, canonicalAgentType: string, sessionKey: string): string | undefined {
  const scopedKey = getSessionKeyIndexKey(cwd, canonicalAgentType, sessionKey);
  const scoped = readSessionKeyIndex(agentDir)[scopedKey];
  if (scoped && fs.existsSync(scoped)) return scoped;
  if (canonicalAgentType.toLowerCase() !== "executor") return undefined;

  const legacyKey = getLegacySessionKeyIndexKey(cwd, sessionKey);
  let resolved: string | undefined;
  mutateSessionKeyIndex(agentDir, (index) => {
    const currentScoped = index[scopedKey];
    if (currentScoped && fs.existsSync(currentScoped)) { resolved = currentScoped; return; }
    const legacy = index[legacyKey];
    if (!legacy || !fs.existsSync(legacy)) return;
    index[scopedKey] = legacy;
    delete index[legacyKey];
    resolved = legacy;
  });
  return resolved;
}

export function recordSessionKey(agentDir: string, cwd: string, canonicalAgentType: string, sessionKey: string, sessionFile: string): void {
  const scopedKey = getSessionKeyIndexKey(cwd, canonicalAgentType, sessionKey);
  mutateSessionKeyIndex(agentDir, (index) => { index[scopedKey] = path.resolve(sessionFile); });
}

export function sanitizeDanglingToolCalls(sessionManager: Pick<SessionManager, "getBranch" | "appendMessage">): number {
  const pending = new Map<string, string>();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") pending.set(block.id, block.name);
      }
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  for (const [toolCallId, toolName] of pending) {
    sessionManager.appendMessage({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "Operation aborted before completion" }], details: {}, isError: true, timestamp: Date.now() });
  }
  return pending.size;
}
