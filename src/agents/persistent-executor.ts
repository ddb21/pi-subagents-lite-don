// Don fork: disk index and resume repair for named persistent subagent sessions.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

const SUBAGENT_SESSION_DIR = "sessions-subagents";
const SESSION_KEY_INDEX_FILE = "session-keys.json";

type SessionKeyIndex = Record<string, string>;

/** Don fork: get the dedicated persisted-subagent session directory. */
export function getSubagentSessionDir(agentDir: string): string {
  return path.join(agentDir, SUBAGENT_SESSION_DIR);
}

/** Don fork: key persistent executors by their normalized parent cwd and caller key. */
export function getSessionKeyIndexKey(cwd: string, sessionKey: string): string {
  return `${path.resolve(cwd)}|${sessionKey}`;
}

function getSessionKeyIndexFile(agentDir: string): string {
  return path.join(getSubagentSessionDir(agentDir), SESSION_KEY_INDEX_FILE);
}

function writeSessionKeyIndex(agentDir: string, index: SessionKeyIndex): void {
  const indexFile = getSessionKeyIndexFile(agentDir);
  const tempFile = `${indexFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(index) + "\n", "utf8");
    fs.renameSync(tempFile, indexFile);
  } catch (err) {
    try { fs.unlinkSync(tempFile); } catch { /* best effort */ }
    throw err;
  }
}

function readSessionKeyIndex(agentDir: string): SessionKeyIndex {
  const indexFile = getSessionKeyIndexFile(agentDir);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("invalid session key index");
    for (const value of Object.values(parsed)) {
      if (typeof value !== "string") throw new Error("invalid session key index");
    }
    return parsed as SessionKeyIndex;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Don fork: discard corrupt indexes rather than making executor sessions unusable.
    try { writeSessionKeyIndex(agentDir, {}); } catch { /* best effort */ }
    return {};
  }
}

/** Don fork: return an existing keyed session only while its JSONL still exists. */
export function resolveSessionKey(agentDir: string, cwd: string, sessionKey: string): string | undefined {
  const sessionFile = readSessionKeyIndex(agentDir)[getSessionKeyIndexKey(cwd, sessionKey)];
  return sessionFile && fs.existsSync(sessionFile) ? sessionFile : undefined;
}

/** Don fork: atomically point a keyed executor at its freshly created session file. */
export function recordSessionKey(agentDir: string, cwd: string, sessionKey: string, sessionFile: string): void {
  const index = readSessionKeyIndex(agentDir);
  index[getSessionKeyIndexKey(cwd, sessionKey)] = path.resolve(sessionFile);
  writeSessionKeyIndex(agentDir, index);
}

/** Don fork: append failures for tool calls left unanswered when a run was aborted. */
export function sanitizeDanglingToolCalls(sessionManager: Pick<SessionManager, "getBranch" | "appendMessage">): number {
  const pending = new Map<string, string>();

  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          pending.set(block.id, block.name);
        }
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }

  for (const [toolCallId, toolName] of pending) {
    // SessionManager.appendMessage supplies the correct append-only parentId chain.
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: "Operation aborted before completion" }],
      details: {},
      isError: true,
      timestamp: Date.now(),
    });
  }

  return pending.size;
}
