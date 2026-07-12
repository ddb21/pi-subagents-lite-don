// verify-mechanism.mjs - deterministic, no-LLM proof of the fork's one change.
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

// Throwaway agent dir + subagent cwd (mirror getAgentDir() + subagent cwd).
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "psl-don-agentdir-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "psl-don-cwd-"));
const fakeParent = path.join(agentDir, "sessions", "--fake--", "PARENT.jsonl");
fs.mkdirSync(path.dirname(fakeParent), { recursive: true });
fs.writeFileSync(
  fakeParent,
  '{"type":"session","version":3,"id":"parent","timestamp":"2026-07-12T00:00:00.000Z","cwd":"/x"}\n',
);

// ---- Branch 1: parent present -> persisted under sessions-subagents ----
// These two lines mirror the patch verbatim.
const subagentDir = path.join(agentDir, "sessions-subagents");
const sm = SessionManager.create(cwd, subagentDir, { parentSession: fakeParent });
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

const file = sm.getSessionFile();
assert(typeof file === "string" && file.length > 0, "getSessionFile() returns a path");
assert(sm.isPersisted() === true, "isPersisted() is true for the parent-present branch");
assert(!!file && file.startsWith(subagentDir + path.sep), `session file is under sessions-subagents (${file})`);
assert(!!file && fs.existsSync(file), ".jsonl exists on disk");

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

// ---- Branch 2: no parent (pi -p / ephemeral) -> in-memory fallback ----
const smMem = SessionManager.inMemory(cwd);
assert(smMem.isPersisted() === false, "inMemory fallback: isPersisted() is false");
assert(smMem.getSessionFile() === undefined, "inMemory fallback: getSessionFile() is undefined (no .jsonl)");

// cleanup throwaway dirs
fs.rmSync(agentDir, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
