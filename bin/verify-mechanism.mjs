// verify-mechanism.mjs - deterministic, no-LLM proof of Don fork persistence.
//
// Drives pi's ACTUAL bundled SessionManager exactly as the patched
// initSession() does, in a throwaway temp dir. No LLM, no pi process, no
// ~/.pi writes. Requires the pi runtime packages to be resolvable (the
// bin/verify-mechanism.sh wrapper sets NODE_PATH for you), then:
//
//   bun bin/verify-mechanism.mjs
//   node bin/verify-mechanism.mjs   # also works if peer deps resolve
//
// Exits 0 on all-pass, non-zero otherwise.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

const subagentSessionDir = (base) => path.join(base, "sessions-subagents");
const sessionKeyIndexFile = (base) => path.join(subagentSessionDir(base), "session-keys.json");
const sessionKeyIndexKey = (baseCwd, key) => `${path.resolve(baseCwd)}|${key}`;
const writeSessionKeyIndex = (base, index) => {
  const indexFile = sessionKeyIndexFile(base);
  const tempFile = `${indexFile}.${process.pid}.verify.tmp`;
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(tempFile, JSON.stringify(index) + "\n", "utf8");
  fs.renameSync(tempFile, indexFile);
};
const readSessionKeyIndex = (base) => {
  try { return JSON.parse(fs.readFileSync(sessionKeyIndexFile(base), "utf8")); }
  catch { return {}; }
};
const recordSessionKey = (base, baseCwd, key, file) => {
  const index = readSessionKeyIndex(base);
  index[sessionKeyIndexKey(baseCwd, key)] = path.resolve(file);
  writeSessionKeyIndex(base, index);
};
const resolveSessionKey = (base, baseCwd, key) => {
  const file = readSessionKeyIndex(base)[sessionKeyIndexKey(baseCwd, key)];
  return file && fs.existsSync(file) ? file : undefined;
};
const sanitizeDanglingToolCalls = (sessionManager) => {
  const pending = new Map();
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
};

// Throwaway agent dir + subagent cwd (mirror getAgentDir() + subagent cwd).
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "psl-don-agentdir-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "psl-don-cwd-"));
const fakeParent = path.join(agentDir, "sessions", "--fake--", "PARENT.jsonl");
fs.mkdirSync(path.dirname(fakeParent), { recursive: true });
fs.writeFileSync(
  fakeParent,
  '{"type":"session","version":3,"id":"parent","timestamp":"2026-07-12T00:00:00.000Z","cwd":"/x"}\n',
);

// ---- Named executor: create -> mapping -> persisted under sessions-subagents ----
const subagentDir = subagentSessionDir(agentDir);
const sessionKey = "exec-myproject";
const sm = SessionManager.create(cwd, subagentDir, { parentSession: fakeParent });
const file = sm.getSessionFile();
recordSessionKey(agentDir, cwd, sessionKey, file);
// What session.setSessionName(...) writes once the manager persists:
sm.appendSessionInfo("qa#deadbeef");
sm.appendMessage({ role: "user", content: "hello subagent", timestamp: Date.now() });
sm.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  api: "test",
  provider: "test",
  model: "test",
  usage: {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

assert(typeof file === "string" && file.length > 0, "getSessionFile() returns a path");
assert(sm.isPersisted() === true, "isPersisted() is true for the parent-present branch");
assert(!!file && file.startsWith(subagentDir + path.sep), `session file is under sessions-subagents (${file})`);
assert(!!file && fs.existsSync(file), ".jsonl exists on disk");
const index = readSessionKeyIndex(agentDir);
assert(fs.existsSync(sessionKeyIndexFile(agentDir)), "session_key mapping file is written");
assert(index[sessionKeyIndexKey(cwd, sessionKey)] === file, "session_key mapping points to the created session");

const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
const header = JSON.parse(lines[0]);
assert(header.type === "session", "line 1 is a session header");
assert(header.parentSession === fakeParent, `header.parentSession == parent (${header.parentSession})`);
const info = lines.map((l) => JSON.parse(l)).find((e) => e.type === "session_info");
assert(!!info, "a session_info entry exists");
assert(!!info && info.name === "qa#deadbeef", `session_info.name == agent name (${info && info.name})`);
const asst = lines.map((l) => JSON.parse(l)).find((e) => e.type === "message" && e.message?.role === "assistant");
assert(!!asst && !!asst.message.usage, "assistant message persists a usage block (tokens/cost)");

console.log("\n--- header ---\n" + lines[0]);
console.log("--- session_info ---\n" + JSON.stringify(info));

// ---- Reopen through mapping: second delegation keeps the same conversation ----
const mappedFile = resolveSessionKey(agentDir, cwd, sessionKey);
assert(mappedFile === file, "mapping resolves the existing session file");
const resumed = SessionManager.open(mappedFile, subagentDir);
assert(resumed.getSessionFile() === file, "SessionManager.open returns the mapped file");
assert(resumed.getEntries().some((e) => e.type === "message" && e.message.role === "user" && e.message.content === "hello subagent"), "reopened session contains prior messages");
const beforeAppendCount = resumed.getEntries().length;
resumed.appendMessage({ role: "user", content: "second delegation", timestamp: Date.now() });
assert(resumed.getEntries().length === beforeAppendCount + 1, "new append lands in the reopened session");
assert(fs.readFileSync(file, "utf8").includes("second delegation"), "reopened append is written to the same JSONL");

// ---- Resume repair: an unanswered trailing tool call gets a synthetic error ----
const dangling = SessionManager.create(cwd, subagentDir, { parentSession: fakeParent });
dangling.appendMessage({ role: "user", content: "call a tool", timestamp: Date.now() });
dangling.appendMessage({
  role: "assistant",
  content: [{ type: "toolCall", id: "call-aborted", name: "Bash", arguments: { command: "false" } }],
  api: "test",
  provider: "test",
  model: "test",
  usage: {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: Date.now(),
});
const repaired = SessionManager.open(dangling.getSessionFile(), subagentDir);
assert(sanitizeDanglingToolCalls(repaired) === 1, "dangling tool call is detected on resume");
const repairedBranch = repaired.getBranch();
const repairedResult = repairedBranch.at(-1);
const danglingAssistant = repairedBranch.at(-2);
assert(repairedResult?.type === "message" && repairedResult.message.role === "toolResult" && repairedResult.message.isError, "synthetic error tool_result is appended");
assert(repairedResult?.type === "message" && repairedResult.message.content[0]?.text === "Operation aborted before completion", "synthetic tool_result has the abort message");
assert(repairedResult?.parentId === danglingAssistant?.id, "synthetic tool_result parentId chains from the assistant tool call");

// ---- Missing mapped JSONL: make a fresh session and replace the mapping ----
fs.unlinkSync(file);
assert(resolveSessionKey(agentDir, cwd, sessionKey) === undefined, "missing mapped file falls through instead of reopening");
const fresh = SessionManager.create(cwd, subagentDir, { parentSession: fakeParent });
const freshFile = fresh.getSessionFile();
recordSessionKey(agentDir, cwd, sessionKey, freshFile);
assert(freshFile !== file, "missing mapping fallback creates a fresh session target");
assert(readSessionKeyIndex(agentDir)[sessionKeyIndexKey(cwd, sessionKey)] === freshFile, "missing-file fallback updates the mapping");

// ---- No key / no parent (pi -p / ephemeral) -> in-memory fallback ----
const smMem = SessionManager.inMemory(cwd);
assert(smMem.isPersisted() === false, "inMemory fallback: isPersisted() is false");
assert(smMem.getSessionFile() === undefined, "inMemory fallback: getSessionFile() is undefined (no .jsonl)");

// ---- A key selects the persisted create branch even without parent lineage ----
const keyWithoutParent = SessionManager.create(cwd, subagentDir);
assert(keyWithoutParent.isPersisted() === true, "session_key branch persists even without a parent session");
assert(keyWithoutParent.getHeader()?.parentSession === undefined, "key-only session header has no parentSession");

// cleanup throwaway dirs
fs.rmSync(agentDir, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
