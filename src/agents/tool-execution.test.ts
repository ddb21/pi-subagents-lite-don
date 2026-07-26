import { describe, expect, it, vi } from "vitest";

vi.mock("../status-note.js", () => ({ getStatusNote: () => "" }));
vi.mock("./agent-types.js", () => ({
  resolveType: () => "qa",
  getAgentConfig: () => undefined,
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

function execute(params: Record<string, unknown>) {
  return executeAgentTool("call", {
    agent: "qa",
    prompt: "review",
    description: "review",
    run_in_background: false,
    ...params,
  }, undefined, undefined, ctx);
}

describe("Agent session_key/worktree_path normalization", () => {
  it("treats an empty worktree_path placeholder as absent", async () => {
    const result = await execute({ session_key: " qa-review ", worktree_path: "  " });

    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      sessionKey: "qa-review",
      sessionKeyCwd: "/repo",
      worktreePath: undefined,
    }));
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
