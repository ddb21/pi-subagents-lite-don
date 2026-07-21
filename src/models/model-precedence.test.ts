import { describe, expect, it } from "vitest";
import {
  providerOf,
  resolveModel,
  resolveSpawn,
  type ProviderAgentEntry,
  type SubagentsConfig,
} from "./model-precedence.js";

const baseConfig = (extra: Partial<SubagentsConfig> = {}): SubagentsConfig => ({
  agent: { default: null, forceBackground: false },
  concurrency: { default: 4 },
  ...extra,
});

const PROVIDER_MAP: SubagentsConfig["providerAgents"] = {
  "github-copilot": {
    default: "github-copilot/gpt-5.2",
    "reviewer-adversarial": { model: "github-copilot/claude-opus-4.8", thinking: "medium" },
  },
  "openai-codex": {
    default: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
  },
};

describe("resolveModel", () => {
  it("keeps the original precedence: session > config > frontmatter > parent", () => {
    const config = baseConfig();
    config.agent["executor"] = "openai-codex/from-config";
    expect(
      resolveModel({
        subagentType: "executor",
        config,
        parentModelId: "openai-codex/parent",
        agentConfig: { model: "openai-codex/from-frontmatter" },
        sessionOverrides: { default: null, executor: "openai-codex/from-session" },
      }),
    ).toBe("openai-codex/from-session");

    expect(
      resolveModel({
        subagentType: "executor",
        config,
        parentModelId: "openai-codex/parent",
        agentConfig: { model: "openai-codex/from-frontmatter" },
      }),
    ).toBe("openai-codex/from-config");

    expect(
      resolveModel({
        subagentType: "executor",
        config: baseConfig(),
        parentModelId: "openai-codex/parent",
        agentConfig: { model: "openai-codex/from-frontmatter" },
      }),
    ).toBe("openai-codex/from-frontmatter");

    expect(
      resolveModel({
        subagentType: "executor",
        config: baseConfig(),
        parentModelId: "openai-codex/parent",
      }),
    ).toBe("openai-codex/parent");
  });

  it("follows the parent provider's map over frontmatter", () => {
    const result = resolveModel({
      subagentType: "executor",
      config: baseConfig({ providerAgents: PROVIDER_MAP }),
      parentModelId: "github-copilot/gpt-5.2",
      agentConfig: { model: "openai-codex/gpt-5.6-terra" },
    });
    expect(result).toBe("github-copilot/gpt-5.2");
  });

  it("prefers the per-type map entry over the map's default", () => {
    const result = resolveModel({
      subagentType: "reviewer-adversarial",
      config: baseConfig({ providerAgents: PROVIDER_MAP }),
      parentModelId: "github-copilot/gpt-5.2",
      agentConfig: { model: "openai-codex/gpt-5.6-sol" },
    });
    expect(result).toBe("github-copilot/claude-opus-4.8");
  });

  it("falls back to frontmatter for an unmapped parent provider", () => {
    const result = resolveModel({
      subagentType: "executor",
      config: baseConfig({ providerAgents: PROVIDER_MAP }),
      parentModelId: "my-custom-vllm/qwen3-max",
      agentConfig: { model: "openai-codex/gpt-5.6-terra" },
    });
    expect(result).toBe("openai-codex/gpt-5.6-terra");
  });

  it("lets an explicit per-call model beat the map and frontmatter", () => {
    const result = resolveModel({
      subagentType: "executor",
      config: baseConfig({ providerAgents: PROVIDER_MAP }),
      parentModelId: "github-copilot/gpt-5.2",
      agentConfig: { model: "openai-codex/gpt-5.6-terra" },
      explicitModel: "openai-codex/gpt-5.6-luna",
    });
    expect(result).toBe("openai-codex/gpt-5.6-luna");
  });

  it("lets session and config pins beat an explicit per-call model", () => {
    const config = baseConfig({ providerAgents: PROVIDER_MAP });
    config.agent["executor"] = "openai-codex/from-config";
    expect(
      resolveModel({
        subagentType: "executor",
        config,
        parentModelId: "github-copilot/gpt-5.2",
        explicitModel: "openai-codex/gpt-5.6-luna",
      }),
    ).toBe("openai-codex/from-config");

    expect(
      resolveModel({
        subagentType: "executor",
        config: baseConfig({ providerAgents: PROVIDER_MAP }),
        parentModelId: "github-copilot/gpt-5.2",
        explicitModel: "openai-codex/gpt-5.6-luna",
        sessionOverrides: { default: "openai-codex/from-session" },
      }),
    ).toBe("openai-codex/from-session");
  });

  it("does not consult a literal empty-string provider key", () => {
    const config = baseConfig({
      providerAgents: { "": { default: "sneaky/model" } },
    });
    expect(
      resolveModel({ subagentType: "executor", config, parentModelId: "" }),
    ).toBe("");
    expect(
      resolveModel({ subagentType: "executor", config, parentModelId: "bare-model" }),
    ).toBe("bare-model");
  });
});

describe("resolveSpawn thinking semantics", () => {
  it("carries thinking only when the map entry supplied the model", () => {
    const config = baseConfig({ providerAgents: PROVIDER_MAP });
    // Map entry wins → its thinking travels with it
    expect(
      resolveSpawn({
        subagentType: "reviewer-adversarial",
        config,
        parentModelId: "github-copilot/gpt-5.2",
      }),
    ).toEqual({ model: "github-copilot/claude-opus-4.8", thinking: "medium" });
    // Default entry object → same
    expect(
      resolveSpawn({
        subagentType: "executor",
        config,
        parentModelId: "openai-codex/gpt-5.6-sol",
      }),
    ).toEqual({ model: "openai-codex/gpt-5.6-terra", thinking: "high" });
  });

  it("drops map thinking when a higher tier chose the model", () => {
    const config = baseConfig({ providerAgents: PROVIDER_MAP });
    // Session override on the SAME provider/role as a thinking-carrying entry:
    // the entry didn't supply the model, so its thinking must not leak.
    const viaSession = resolveSpawn({
      subagentType: "reviewer-adversarial",
      config,
      parentModelId: "github-copilot/gpt-5.2",
      sessionOverrides: { default: null, "reviewer-adversarial": "github-copilot/gpt-4.1" },
    });
    expect(viaSession).toEqual({ model: "github-copilot/gpt-4.1", thinking: undefined });

    const viaExplicit = resolveSpawn({
      subagentType: "reviewer-adversarial",
      config,
      parentModelId: "github-copilot/gpt-5.2",
      explicitModel: "openai-codex/gpt-5.6-luna",
    });
    expect(viaExplicit.thinking).toBeUndefined();
  });

  it("has no thinking for bare-string entries or frontmatter/parent wins", () => {
    const config = baseConfig({ providerAgents: PROVIDER_MAP });
    expect(
      resolveSpawn({ subagentType: "executor", config, parentModelId: "github-copilot/gpt-5.2" }).thinking,
    ).toBeUndefined();
    expect(
      resolveSpawn({ subagentType: "executor", config: baseConfig(), parentModelId: "openai-codex/parent" }).thinking,
    ).toBeUndefined();
  });

  it("tolerates malformed hand-edited entries", () => {
    const junk = {
      "openai-codex": {
        // typeof null === "object" — must not throw
        executor: null,
        researcher: ["not", "a", "model"],
        scout: { model: 42, thinking: "high" },
        default: { model: "openai-codex/ok", thinking: "not-a-level" },
      },
    } as unknown as SubagentsConfig["providerAgents"];
    const config = baseConfig({ providerAgents: junk });

    // null / array / wrong-typed model all fall through to the default entry;
    // its invalid thinking string is dropped.
    for (const type of ["executor", "researcher", "scout"]) {
      expect(
        resolveSpawn({ subagentType: type, config, parentModelId: "openai-codex/parent" }),
      ).toEqual({ model: "openai-codex/ok", thinking: undefined });
    }
  });

  it("treats an empty-string entry as absent", () => {
    const config = baseConfig({
      providerAgents: { "openai-codex": { executor: "" as ProviderAgentEntry, default: "openai-codex/ok" } },
    });
    expect(
      resolveSpawn({ subagentType: "executor", config, parentModelId: "openai-codex/parent" }).model,
    ).toBe("openai-codex/ok");
  });
});

describe("providerOf", () => {
  it("extracts the provider segment", () => {
    expect(providerOf("openai-codex/gpt-5.6-sol")).toBe("openai-codex");
    // First segment only: "provider/org/model" keys keep working
    expect(providerOf("openrouter/qwen/qwen3-max")).toBe("openrouter");
    expect(providerOf("bare-model")).toBeUndefined();
    expect(providerOf("")).toBeUndefined();
    expect(providerOf(undefined)).toBeUndefined();
  });
});
