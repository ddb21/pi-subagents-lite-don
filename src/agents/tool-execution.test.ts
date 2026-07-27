import { describe, expect, it, vi } from "vitest";

vi.mock("../status-note.js", () => ({ getStatusNote: () => "" }));
const agentConfigs: Record<string, { sessionLifecycle?: "persistent" | "stateless"; persistentSession?: boolean }> = {
  qa: {},
  "reviewer-adversarial": {},
  "reviewer-conformance": {},
  "reviewer-tests": {},
  "qa-56": {},
  "qa-gemini": {},
  "qa-opus": {},
  executor: { sessionLifecycle: "persistent", persistentSession: true },
  "data-deck": { sessionLifecycle: "persistent" },
};

vi.mock("./agent-types.js", () => ({
  resolveType: (name: string) => name === "deck-alias" ? "data-deck" : name,
  getAgentConfig: (name: string) => agentConfigs[name],
  discoverNewAgents: vi.fn(),
}));
vi.mock("./usage.js", () => ({
  getLifetimeTotal: () =>0,
  getSessionContextPercent: () => 0,
}));
vi.mock("../spawn/worktree-validator.js", () => ({ validateWorktreePath: vi.fn() }));
vi.mock("../utils.js", () => ({
  parseModelKey: vi.fn(),
  findModelInRegistry: () => undefined,
  parseThinkingLevel: () => undefined,
  splitModelThinkingSuffix: vi.fn(),
}));

const spawn = vi.fn(async (_pi, _ctx, options) => ({
  agentId: "agent-1",
  record: {
    id: "agent-1",
    display: { type: "qa", description: options.description, outputFile: "" },
    lifecycle: { status: "completed", startedAt: 0, completedAt: 1 },
    stats: { turnCount: 1, maxTurns: 1, toolUses: 0, lifetimeUsage: { input: 0, output: 0, cost: 0 }, compactionCount: 0 },
    execution: { session: {} },
    result: "ok",
  },
}));

vi.mock("../shell.js", () => ({
  getPiInstance: () => ({}),
  getSessionCtx: () => ({ cwd: "/repo" }),
  getStore: () => ({ agent: { forceBackground: false, graceTurns: 0 } }),
  getCoordinator: () => ({ spawn }),
  getManager: () => ({ listAgents: () => [] }),
}));

import { executeAgentTool } from "./tool-execution.js";

const ctx = {
  cwd: "/repo",
  hasUI: true,
  modelRegistry: {},
  sessionManager: { getSessionFile: () => "/parent.jsonl" },
} as any;

function execute(params: Record<string, unknown>, agent = "qa") {
  return executeAgentTool("call", {
    agent,
    prompt: "review",
    description: "review",
    run_in_background: false,
    ...params,
  }, undefined, undefined, ctx);
}

describe("Agent session_key/worktree_path normalization", () => {
  it("allows a persistent-session-capable executor and trims placeholders", async () => {
    const result = await execute({ session_key: " exec-repo ", worktree_path: "  " }, "executor");

    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      sessionKey: "exec-repo",
      sessionKeyCwd: "/repo",
      worktreePath: undefined,
    }));
  });

  it("allows an unkeyed persistent agent to run one-shot", async () => {
    const result = await execute({}, "data-deck");

    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.not.objectContaining({ sessionKey: expect.anything() }));
  });

  it("allows a keyed persistent artifact agent and forwards resolved type scope", async () => {
    const result = await execute({ session_key: "deck-study" }, "data-deck");

    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      sessionKey: "deck-study",
      sessionKeyAgentType: "data-deck",
    }));
  });

  it("uses the canonical resolved type, not an alias, to scope a keyed session", async () => {
    const result = await execute({ session_key: "deck-study" }, "deck-alias");

    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      sessionKeyAgentType: "data-deck",
    }));
  });

  it.each([
    "qa",
    "qa-56",
    "qa-gemini",
    "qa-opus",
    "reviewer-adversarial",
    "reviewer-conformance",
    "reviewer-tests",
  ])("rejects session_key for stateless route %s", async (agent) => {
    const result = await execute({ session_key: "not-allowed" }, agent);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`session_key is not supported by stateless agent '${agent}'; omit session_key`);
  });

  it("rejects a session_key with a non-empty worktree_path", async () => {
    const result = await execute({ session_key: "qa-review", worktree_path: "/other" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-empty worktree_path");
  });

  it("rejects an empty session_key", async () => {
    const result = await execute({ session_key: "", worktree_path: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("session_key must be a non-empty string");
  });
});
