/**
 * Don fork: the session-key index and the cross-process ownership lease.
 *
 * Relocated from the live fork's src/agents/persistent-executor.test.ts.
 * Upstream's vitest config collects only test/**, so a colocated file here
 * would never run.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireSessionFileLease,
  acquireSessionKeyLease,
  getSessionKeyIndexFile,
  getSessionKeyIndexKey,
  getSubagentSessionDir,
  readSessionKeyIndex,
  readSessionKeyIndexStrict,
  recordSessionKey,
  resolveSessionKey,
  sanitizeDanglingToolCalls,
  withSessionKeyIndexLock,
} from "../../src/agents/persistent-executor.js";

let agentDir: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-persistent-"));
});
afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

/** Create an empty transcript so existsSync checks in the resolver pass. */
function touchSession(name: string): string {
  const file = path.join(getSubagentSessionDir(agentDir), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  return file;
}

describe("session key scoping", () => {
  it("scopes a key by resolved cwd, lowercased type, and caller key", () => {
    const key = getSessionKeyIndexKey("/repo/./sub/..", "Executor", "exec-1");
    expect(key).toBe(`${path.resolve("/repo")}|executor|exec-1`);
  });

  it("keeps the same caller key separate across projects and agent types", () => {
    const a = getSessionKeyIndexKey("/repo-a", "executor", "exec-1");
    const b = getSessionKeyIndexKey("/repo-b", "executor", "exec-1");
    const c = getSessionKeyIndexKey("/repo-a", "reviewer", "exec-1");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("recordSessionKey / resolveSessionKey", () => {
  it("round-trips a recorded session file", () => {
    const file = touchSession("s1.jsonl");
    recordSessionKey(agentDir, "/repo", "executor", "exec-1", file);
    expect(resolveSessionKey(agentDir, "/repo", "executor", "exec-1")).toBe(path.resolve(file));
  });

  it("returns undefined when the transcript no longer exists on disk", () => {
    const file = touchSession("gone.jsonl");
    recordSessionKey(agentDir, "/repo", "executor", "exec-1", file);
    fs.rmSync(file);
    expect(resolveSessionKey(agentDir, "/repo", "executor", "exec-1")).toBeUndefined();
  });

  it("does not leak a session across agent types", () => {
    const file = touchSession("s2.jsonl");
    recordSessionKey(agentDir, "/repo", "executor", "exec-1", file);
    expect(resolveSessionKey(agentDir, "/repo", "reviewer", "exec-1")).toBeUndefined();
  });

  it("migrates a legacy unscoped entry for executor only, once", () => {
    const file = touchSession("legacy.jsonl");
    const legacyKey = `${path.resolve("/repo")}|exec-1`;
    fs.mkdirSync(getSubagentSessionDir(agentDir), { recursive: true });
    fs.writeFileSync(getSessionKeyIndexFile(agentDir), JSON.stringify({ [legacyKey]: path.resolve(file) }));

    // A non-executor type never consumes ambiguous legacy state.
    expect(resolveSessionKey(agentDir, "/repo", "reviewer", "exec-1")).toBeUndefined();

    expect(resolveSessionKey(agentDir, "/repo", "executor", "exec-1")).toBe(path.resolve(file));
    const index = readSessionKeyIndex(agentDir);
    expect(index[legacyKey]).toBeUndefined();
    expect(index[getSessionKeyIndexKey("/repo", "executor", "exec-1")]).toBe(path.resolve(file));
  });
});

describe("readSessionKeyIndexStrict", () => {
  it("reads a missing index as empty", () => {
    expect(readSessionKeyIndexStrict(agentDir)).toEqual({});
  });

  it("throws on a corrupt index instead of degrading to empty", () => {
    // Fail-closed matters: cleanup must never read an unreadable index as
    // "nothing is referenced" and then delete live transcripts.
    fs.mkdirSync(getSubagentSessionDir(agentDir), { recursive: true });
    fs.writeFileSync(getSessionKeyIndexFile(agentDir), "{ not json");
    expect(() => readSessionKeyIndexStrict(agentDir)).toThrow();

    fs.writeFileSync(getSessionKeyIndexFile(agentDir), JSON.stringify(["array"]));
    expect(() => readSessionKeyIndexStrict(agentDir)).toThrow(/not an object/);

    fs.writeFileSync(getSessionKeyIndexFile(agentDir), JSON.stringify({ k: 3 }));
    expect(() => readSessionKeyIndexStrict(agentDir)).toThrow(/non-string value/);
  });

  it("tolerates a corrupt index on the lenient read path", () => {
    fs.mkdirSync(getSubagentSessionDir(agentDir), { recursive: true });
    fs.writeFileSync(getSessionKeyIndexFile(agentDir), "{ not json");
    expect(readSessionKeyIndex(agentDir)).toEqual({});
  });

  it("holds the index lock across a caller's check-and-move", () => {
    const file = touchSession("locked.jsonl");
    recordSessionKey(agentDir, "/repo", "executor", "exec-1", file);
    const seen = withSessionKeyIndexLock(agentDir, (index) => Object.values(index));
    expect(seen).toEqual([path.resolve(file)]);
  });
});

describe("ownership leases", () => {
  it("grants a key lease and releases it for the next owner", () => {
    const first = acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-1");
    expect(fs.existsSync(first.lockPath)).toBe(true);
    first.release();
    expect(fs.existsSync(first.lockPath)).toBe(false);

    const second = acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-1");
    expect(fs.existsSync(second.lockPath)).toBe(true);
    second.release();
  });

  it("refuses a second live owner of the same key", () => {
    const held = acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-1");
    try {
      expect(() => acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-1")).toThrow(
        /persistent_session_busy/,
      );
    } finally {
      held.release();
    }
  });

  it("keeps leases for different keys, types, and projects independent", () => {
    const a = acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-1");
    const b = acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-2");
    const c = acquireSessionKeyLease(agentDir, "/repo", "reviewer", "exec-1");
    const d = acquireSessionKeyLease(agentDir, "/other", "executor", "exec-1");
    expect(new Set([a.lockPath, b.lockPath, c.lockPath, d.lockPath]).size).toBe(4);
    for (const lease of [a, b, c, d]) lease.release();
  });

  it("reclaims a lease whose owner process is gone", () => {
    const held = acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-1");
    // Rewrite the owner as a dead pid; pid 2^31-1 is not a live process here.
    fs.writeFileSync(
      path.join(held.lockPath, "owner.json"),
      JSON.stringify({ pid: 2147483646, token: "stale", createdAt: new Date().toISOString() }),
    );
    const reclaimed = acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-1");
    expect(fs.existsSync(reclaimed.lockPath)).toBe(true);
    reclaimed.release();
  });

  it("release is idempotent and never removes a lease it no longer owns", () => {
    const first = acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-1");
    first.release();
    const second = acquireSessionKeyLease(agentDir, "/repo", "executor", "exec-1");
    // A stale double-release from the first owner must not free the second.
    first.release();
    expect(fs.existsSync(second.lockPath)).toBe(true);
    second.release();
  });

  it("locks a direct resume by session file", () => {
    const file = touchSession("direct.jsonl");
    const held = acquireSessionFileLease(agentDir, file);
    expect(held.sessionFile).toBe(path.resolve(file));
    expect(() => acquireSessionFileLease(agentDir, file)).toThrow(/persistent_session_busy/);
    held.release();
  });
});

describe("sanitizeDanglingToolCalls", () => {
  const assistantWithCall = (id: string, name: string) => ({
    type: "message" as const,
    message: { role: "assistant" as const, content: [{ type: "toolCall", id, name }] },
  });
  const toolResult = (toolCallId: string) => ({
    type: "message" as const,
    message: { role: "toolResult" as const, toolCallId },
  });

  it("closes an unanswered tool call so the resumed turn is not rejected", () => {
    const appended: Array<Record<string, unknown>> = [];
    const count = sanitizeDanglingToolCalls({
      getBranch: () => [assistantWithCall("c1", "bash")] as never,
      appendMessage: ((m: Record<string, unknown>) => appended.push(m)) as never,
    });
    expect(count).toBe(1);
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      isError: true,
    });
  });

  it("leaves an answered tool call alone", () => {
    const appended: unknown[] = [];
    const count = sanitizeDanglingToolCalls({
      getBranch: () => [assistantWithCall("c1", "bash"), toolResult("c1")] as never,
      appendMessage: ((m: unknown) => appended.push(m)) as never,
    });
    expect(count).toBe(0);
    expect(appended).toEqual([]);
  });
});
