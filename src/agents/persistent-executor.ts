// Don fork: disk index and resume repair for named persistent subagent sessions.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

const SUBAGENT_SESSION_DIR = "sessions-subagents";
const SESSION_KEY_INDEX_FILE = "session-keys.json";
type SessionKeyIndex = Record<string, string>;

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

function getSessionKeyIndexFile(agentDir: string): string {
  return path.join(getSubagentSessionDir(agentDir), SESSION_KEY_INDEX_FILE);
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

function mutateSessionKeyIndex(agentDir: string, mutate: (index: SessionKeyIndex) => void): SessionKeyIndex {
  const indexFile = getSessionKeyIndexFile(agentDir);
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const lockFile = `${indexFile}.lock`;
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        const index = parseIndex(indexFile);
        mutate(index);
        const tempFile = `${indexFile}.${process.pid}.${randomUUID()}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(index) + "\n", "utf8");
        fs.renameSync(tempFile, indexFile);
        return index;
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

function readSessionKeyIndex(agentDir: string): SessionKeyIndex {
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
