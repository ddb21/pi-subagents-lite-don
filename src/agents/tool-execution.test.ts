import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../status-note.js", () => ({ getStatusNote: () => "" }));
const agentConfigs: Record<string, { sessionLifecycle?: "persistent" | "stateless"; persistentSession?: boolean; model?: string }> = {
  qa: {},
  "pinned-science": { sessionLifecycle: "persistent", model: "awb/claude-opus-5:high" },
  "stale-pin": { model: "awb/claude-opus-9" },
  scout: { sessionLifecycle: "stateless" },
  "reviewer-adversarial": {},
  "reviewer-conformance": {},
  "reviewer-tests": {},
  "qa-56": {},
  "qa-gemini": {},
  "qa-opus": {},
  executor: { sessionLifecycle: "persistent", persistentSession: true },
  "data-deck": { sessionLifecycle: "persistent" },
  "legacy-executor": { persistentSession: true },
  "conflicting-executor": { sessionLifecycle: "persistent", persistentSession: false },
  "warning-agent": {},
};

vi.mock("./agent-types.js", () => ({
  resolveType: (name: string) => {
    if (name === "missing-agent") return undefined;
    return name === "deck-alias" ? "data-deck" : name;
  },
  getAgentConfig: (name: string) => agentConfigs[name],
  discoverNewAgents: vi.fn(),
}));
vi.mock("./usage.js", () => ({
  getLifetimeTotal: () =>0,
  getSessionContextPercent: () => 0,
}));
vi.mock("../spawn/worktree-validator.js", () => ({
  validateWorktreePath: vi.fn(),
  isParentCwdPath: vi.fn((worktreePath: string, parentCwd: string) =>
    worktreePath.replace(/\/+$/, "") === parentCwd.replace(/\/+$/, "")),
}));
vi.mock("../utils.js", () => ({
  // Inlined (not a top-level const): vi.mock factories are hoisted.
  parseModelKey: vi.fn(),
  findModelInRegistry: (spec?: string) => {
    if (!spec) return undefined;
    const entries = [
      { provider: "awb", id: "claude-opus-5" },
      { provider: "walmart-puppy", id: "gpt-5.6-terra" },
    ];
    const slash = spec.indexOf("/");
    if (slash <= 0) return undefined;
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    return entries.find((e) => e.provider === provider && e.id === id);
  },
  parseThinkingLevel: () => undefined,
  // model-spec.ts consumes these two; keep real behavior so spec resolution
  // (and its error text) is exercised instead of mocked away.
  VALID_THINKING_LEVELS: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  splitModelThinkingSuffix: (spec: string) => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const idx = spec.lastIndexOf(":");
    if (idx <= 0 || idx === spec.length - 1) return { model: spec };
    const suffix = spec.slice(idx + 1);
    return levels.includes(suffix)
      ? { model: spec.slice(0, idx), thinking: suffix }
      : { model: spec };
  },
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
    warnings: options.type === "warning-agent"
      ? ["agent \"warning-agent\" declares extension \"pi-lens\", but no loaded extension has that exact package name"]
      : [] as string[],
  },
}));

vi.mock("../shell.js", () => ({
  getPiInstance: () => ({}),
  getSessionCtx: () => ({ cwd: "/repo" }),
  getStore: () => ({
    agent: { forceBackground: false, graceTurns: 0 },
    modelAliases: {},
    providerPreference: [],
    // Mirrors config-store.spawnFor: frontmatter pin, else parent model.
    spawnFor: (_type: string, parentModelId: string, agentConfig?: { model?: string }) => ({
      model: agentConfig?.model ?? parentModelId,
    }),
  }),
  getCoordinator: () => ({ spawn }),
  getManager: () => ({ listAgents: () => [] }),
}));

import { validateWorktreePath } from "../spawn/worktree-validator.js";
import { executeAgentTool } from "./tool-execution.js";

const validateWorktreePathMock = validateWorktreePath as unknown as {
  mockReset: () => void;
  mockRejectedValue: (error: unknown) => void;
  mockResolvedValue: (value: unknown) => void;
};

const REGISTRY_ENTRIES = [
  { provider: "awb", id: "claude-opus-5" },
  { provider: "awb", id: "claude-opus-4-8" },
  { provider: "walmart-puppy", id: "gpt-5.6-terra" },
];

const ctx = {
  cwd: "/repo",
  hasUI: true,
  modelRegistry: {
    getAvailable: () => REGISTRY_ENTRIES,
    find: (provider: string, id: string) => REGISTRY_ENTRIES.find((e) => e.provider === provider && e.id === id),
  },
  sessionManager: { getSessionFile: () => "/parent.jsonl" },
} as any;

beforeEach(() => {
  spawn.mockClear();
  validateWorktreePathMock.mockReset();
});

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
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      sessionKey: "exec-repo",
      sessionKeyCwd: "/repo",
      worktreePath: undefined,
    }));
  });

  it("includes spawn-time dependency warnings in the agent result", async () => {
    const result = await execute({}, "warning-agent");

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("declares extension \"pi-lens\"");
    expect(result.details).toMatchObject({
      normalizationWarnings: [expect.stringContaining("no loaded extension has that exact package name")],
    });
  });

  it("allows an unkeyed persistent agent to run one-shot", async () => {
    const result = await execute({}, "data-deck");

    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.not.objectContaining({ sessionKey: expect.anything() }));
  });

  it("allows a keyed persistent artifact agent and forwards resolved type scope", async () => {
    const result = await execute({ session_key: "deck-study" }, "data-deck");

    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      sessionKey: "deck-study",
      sessionKeyAgentType: "data-deck",
    }));
  });

  it("allows a keyed agent using the persistent_session compatibility alias", async () => {
    const result = await execute({ session_key: "exec-legacy" }, "legacy-executor");

    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      sessionKey: "exec-legacy",
      sessionKeyAgentType: "legacy-executor",
    }));
  });

  it("normalizes a whitespace session_key for a persistent agent and runs one-shot", async () => {
    const result = await execute({ session_key: "  " }, "executor");

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("empty session_key ignored; spawned without a session key");
    expect(result.details).toMatchObject({
      normalizationWarnings: ["empty session_key ignored; spawned without a session key"],
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.not.objectContaining({ sessionKey: expect.anything() }));
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
    "scout",
    "qa-56",
    "qa-gemini",
    "qa-opus",
    "reviewer-adversarial",
    "reviewer-conformance",
    "reviewer-tests",
  ])("normalizes session_key for stateless route %s and spawns exactly once", async (agent) => {
    const result = await execute({ session_key: "not-allowed" }, agent);

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain(`session_key ignored for stateless agent '${agent}'; spawned as one-shot`);
    expect(result.details).toMatchObject({
      normalizationWarnings: [`session_key ignored for stateless agent '${agent}'; spawned as one-shot`],
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.not.objectContaining({ sessionKey: expect.anything() }));
  });

  it("normalizes stateless session_key with a valid worktree_path and spawns exactly once", async () => {
    validateWorktreePathMock.mockResolvedValue({ ok: true, resolvedPath: "/repo-wt", label: "repo-wt" });

    const result = await execute({ session_key: "not-allowed", worktree_path: "/repo-wt" }, "scout");

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("session_key ignored for stateless agent 'scout'; spawned as one-shot");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      worktreePath: "/repo-wt",
      worktreeLabel: "repo-wt",
    }));
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.not.objectContaining({ sessionKey: expect.anything() }));
  });

  it("drops a parent-cwd worktree_path, warns, and keeps the persistent session", async () => {
    const result = await execute({ session_key: "exec-review", worktree_path: "/repo/" }, "executor");

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("worktree_path '/repo/' is the parent working directory");
    expect(result.details).toMatchObject({
      normalizationWarnings: [expect.stringContaining("ignored so session_key 'exec-review' applies")],
    });
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      sessionKey: "exec-review",
      sessionKeyCwd: "/repo",
      worktreePath: undefined,
    }));
    expect(validateWorktreePath).not.toHaveBeenCalled();
  });

  it("rejects persistent session_key with a different worktree_path before spawn", async () => {
    const result = await execute({ session_key: "exec-review", worktree_path: "/other" }, "executor");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("worktree_path was '/other'");
    expect(result.content[0].text).toContain("parent working directory '/repo'");
    expect(result.content[0].text).toContain("resend the same call with worktree_path omitted");
    expect(result.content[0].text).toContain("non-retryable; do not repeat the same Agent call unchanged");
    expect(result.details).toMatchObject({ errorType: "validation", retryable: false });
    expect(spawn).not.toHaveBeenCalled();
    expect(validateWorktreePath).not.toHaveBeenCalled();
  });

  it("validates worktree_path without session_key and forwards it normally", async () => {
    validateWorktreePathMock.mockResolvedValue({ ok: true, resolvedPath: "/repo-wt", label: "repo-wt" });

    const result = await execute({ worktree_path: "/repo-wt" }, "executor");

    expect(result.isError).not.toBe(true);
    expect(validateWorktreePath).toHaveBeenCalledWith(expect.anything(), "/repo-wt", "/repo", expect.any(Function));
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.objectContaining({
      worktreePath: "/repo-wt",
      worktreeLabel: "repo-wt",
    }));
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.not.objectContaining({ sessionKey: expect.anything() }));
  });

  it("rejects a non-string session_key before spawn", async () => {
    const result = await execute({ session_key: 123 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("session_key must be a string when provided");
    expect(result.content[0].text).toContain("non-retryable; do not repeat the same Agent call unchanged");
    expect(result.details).toMatchObject({ errorType: "validation", retryable: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["context", "fork", "fork_from", "parent_session", "parentSession"])(
    "rejects session_key mixed with %s before stateless normalization",
    async (paramName) => {
      const result = await execute({ session_key: "not-allowed", [paramName]: "parent" }, "scout");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`session_key cannot be used with ${paramName}`);
      expect(result.content[0].text).toContain("non-retryable; do not repeat the same Agent call unchanged");
      expect(result.details).toMatchObject({ errorType: "validation", retryable: false });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects whitespace session_key mixed with fork-style intent before normalization", async () => {
    const result = await execute({ session_key: "  ", parent_session: "parent" }, "scout");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("session_key cannot be used with parent_session");
    expect(result.content[0].text).toContain("non-retryable; do not repeat the same Agent call unchanged");
    expect(result.content[0].text).not.toContain("empty session_key ignored");
    expect(result.details).toMatchObject({ errorType: "validation", retryable: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects conflicting lifecycle metadata before spawn", async () => {
    const result = await execute({ session_key: "exec-conflict" }, "conflicting-executor");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("conflicting session_lifecycle and persistent_session metadata");
    expect(result.content[0].text).toContain("non-retryable; do not repeat the same Agent call unchanged");
    expect(result.details).toMatchObject({ errorType: "validation", retryable: false, agent: "conflicting-executor" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves empty-key normalization on conflicting lifecycle metadata", async () => {
    const result = await execute({ session_key: "  " }, "conflicting-executor");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("empty session_key ignored; spawned without a session key");
    expect(result.content[0].text).toContain("conflicting session_lifecycle and persistent_session metadata");
    expect(result.details).toMatchObject({
      errorType: "validation",
      retryable: false,
      agent: "conflicting-executor",
      normalizationWarnings: ["empty session_key ignored; spawned without a session key"],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("normalizes an empty session_key and spawns exactly once", async () => {
    const result = await execute({ session_key: "  ", worktree_path: "" });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("empty session_key ignored; spawned without a session key");
    expect(result.details).toMatchObject({
      normalizationWarnings: ["empty session_key ignored; spawned without a session key"],
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.anything(), ctx, expect.not.objectContaining({ sessionKey: expect.anything() }));
  });

  it("preserves empty-key normalization on unknown agent validation", async () => {
    const result = await execute({ session_key: "  " }, "missing-agent");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("empty session_key ignored; spawned without a session key");
    expect(result.content[0].text).toContain("Unknown agent type: missing-agent");
    expect(result.details).toMatchObject({
      errorType: "validation",
      retryable: false,
      normalizationWarnings: ["empty session_key ignored; spawned without a session key"],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves stateless-key normalization on worktree validation failure", async () => {
    validateWorktreePathMock.mockResolvedValue({ ok: false, error: "worktree rejected" });

    const result = await execute({ session_key: "not-allowed", worktree_path: "/bad" }, "scout");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("session_key ignored for stateless agent 'scout'; spawned as one-shot");
    expect(result.content[0].text).toContain("worktree rejected");
    expect(result.details).toMatchObject({
      normalizationWarnings: ["session_key ignored for stateless agent 'scout'; spawned as one-shot"],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves stateless-key normalization on bad model validation", async () => {
    const result = await execute({ session_key: "not-allowed", model: "missing/model" }, "scout");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("session_key ignored for stateless agent 'scout'; spawned as one-shot");
    expect(result.content[0].text).toContain("Model not found in registry: missing/model");
    expect(result.details).toMatchObject({
      errorType: "validation",
      retryable: false,
      normalizationWarnings: ["session_key ignored for stateless agent 'scout'; spawned as one-shot"],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts a short model spelling and spawns the resolved registry model", async () => {
    const result = await execute({ model: "terra" });

    expect(result.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ modelKey: "walmart-puppy/gpt-5.6-terra" }),
    );
    expect(result.content[0].text).toContain("model 'terra' resolved to walmart-puppy/gpt-5.6-terra");
  });

  it("reads a trailing effort word as the thinking level", async () => {
    await execute({ model: "terra high" });

    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ modelKey: "walmart-puppy/gpt-5.6-terra", thinkingLevel: "high" }),
    );
  });

  it("treats model 'default' as inherit instead of a validation error", async () => {
    const result = await execute({ model: "default" });

    expect(result.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ modelKey: undefined }),
    );
  });

  it("lists candidates when a model fragment is ambiguous", async () => {
    const result = await execute({ model: "opus" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Ambiguous model: 'opus'");
    expect(result.content[0].text).toContain("awb/claude-opus-4-8");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("puts the format and the available keys in the model error", async () => {
    const result = await execute({ model: "gpt-5.2" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"provider/model-id:thinking"');
    expect(result.content[0].text).toContain("Available: awb/claude-opus-5");
    expect(result.content[0].text).toContain("non-retryable");
  });

  it("applies a frontmatter model pin when the caller passes no model", async () => {
    const result = await execute({}, "pinned-science");

    expect(result.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ modelKey: "awb/claude-opus-5", thinkingLevel: "high" }),
    );
  });

  it("warns and inherits the parent model when a frontmatter pin is stale", async () => {
    const result = await execute({}, "stale-pin");

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("pins model 'awb/claude-opus-9', which did not resolve");
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ modelKey: undefined }),
    );
  });

  it("keeps normalization warnings visible when the child spawn ends in error", async () => {
    spawn.mockImplementationOnce(async (_pi, _ctx, options) => ({
      agentId: "agent-err",
      record: {
        id: "agent-err",
        display: { type: "scout", description: options.description, outputFile: "" },
        lifecycle: { status: "error", startedAt: 0, completedAt: 1 },
        stats: { turnCount: 1, maxTurns: 1, toolUses: 0, lifetimeUsage: { input: 0, output: 0, cost: 0 }, compactionCount: 0 },
        execution: { session: {} },
        result: "",
        error: "child boom",
        warnings: [] as string[],
      },
    }));

    const result = await execute({ session_key: "not-allowed" }, "scout");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("session_key ignored for stateless agent 'scout'; spawned as one-shot");
    expect(result.content[0].text).toContain("Agent failed: child boom");
    expect(result.details).toMatchObject({
      normalizationWarnings: ["session_key ignored for stateless agent 'scout'; spawned as one-shot"],
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("preserves normalization warnings and does not label worktree exceptions as non-retryable", async () => {
    validateWorktreePathMock.mockRejectedValue(new Error("ephemeral IO failure"));

    const result = await execute({ session_key: "not-allowed", worktree_path: "/other" }, "scout");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("session_key ignored for stateless agent 'scout'; spawned as one-shot");
    expect(result.content[0].text).toContain("worktree_path validation failed: ephemeral IO failure");
    expect(result.content[0].text).not.toContain("non-retryable");
    expect(result.details).toMatchObject({
      normalizationWarnings: ["session_key ignored for stateless agent 'scout'; spawned as one-shot"],
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
