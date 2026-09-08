/**
 * Don fork: the four routing sections (providerAgents, modelAgents,
 * modelAliases, providerPreference) are top-level config keys. validateRawLayer
 * previously kept only "agent" and "concurrency", so without an explicit
 * pass-through every routing map was silently dropped at load and the whole
 * provider-follow contract became a no-op.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { validateRawLayer } from "../../src/config/config-validation.js";
import { mergeDefaults, mergeLayers, type RawConfig } from "../../src/config/config-io.js";

const PROVIDER_AGENTS: NonNullable<RawConfig["providerAgents"]> = {
  "github-copilot": { default: "github-copilot/gpt-5.2", executor: { model: "github-copilot/gpt-5.5" } },
};
const MODEL_AGENTS: NonNullable<RawConfig["modelAgents"]> = {
  "walmart-puppy/gpt-5.6-sol": { executor: { model: "walmart-puppy/gpt-5.6-terra", thinking: "medium" } },
};

describe("validateRawLayer — Don fork routing sections", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("keeps every routing section instead of dropping it", () => {
    const cleaned = validateRawLayer(
      {
        agent: { default: "a/b" },
        providerAgents: PROVIDER_AGENTS,
        modelAgents: MODEL_AGENTS,
        modelAliases: { terra: "walmart-puppy/gpt-5.6-terra" },
        providerPreference: ["awb", "github-copilot"],
      },
      "/tmp/subagents-lite.json",
    );

    expect(cleaned.providerAgents).toEqual(PROVIDER_AGENTS);
    expect(cleaned.modelAgents).toEqual(MODEL_AGENTS);
    expect(cleaned.modelAliases).toEqual({ terra: "walmart-puppy/gpt-5.6-terra" });
    expect(cleaned.providerPreference).toEqual(["awb", "github-copilot"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops a routing section that is not a JSON object, with one warning", () => {
    const cleaned = validateRawLayer({ providerAgents: ["nope"] }, "/tmp/subagents-lite.json");
    expect(cleaned.providerAgents).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"providerAgents" is array');
  });

  it("drops providerPreference unless it is an array of strings", () => {
    expect(validateRawLayer({ providerPreference: "awb" }, "/f").providerPreference).toBeUndefined();
    expect(validateRawLayer({ providerPreference: ["awb", 3] }, "/f").providerPreference).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("mergeDefaults — Don fork routing sections", () => {
  it("passes routing sections through with no baked default", () => {
    const merged = mergeDefaults({ providerAgents: PROVIDER_AGENTS, modelAgents: MODEL_AGENTS } as RawConfig);
    expect(merged.providerAgents).toEqual(PROVIDER_AGENTS);
    expect(merged.modelAgents).toEqual(MODEL_AGENTS);
    // Absent means "no map" — never an empty object that could shadow nothing.
    expect(mergeDefaults({}).providerAgents).toBeUndefined();
    expect(mergeDefaults({}).modelAliases).toBeUndefined();
  });

  it("normalizes alias keys once at load so lookup ignores case and separators", () => {
    const merged = mergeDefaults({
      modelAliases: {
        "Terra High": "walmart-puppy/gpt-5.6-terra:high",
        "opus_5": "awb/claude-opus-5",
        "copilot/gpt-5.5": "github-copilot/gpt-5.5",
      },
    } as RawConfig);
    expect(merged.modelAliases).toEqual({
      terrahigh: "walmart-puppy/gpt-5.6-terra:high",
      opus5: "awb/claude-opus-5",
      // Dots are separators too, matching model-spec's normalize().
      copilotgpt55: "github-copilot/gpt-5.5",
    });
  });

  it("drops an alias whose target is not a non-empty string", () => {
    const merged = mergeDefaults({
      modelAliases: { good: "awb/claude-opus-5", empty: "", bad: 3 as unknown as string },
    } as RawConfig);
    expect(merged.modelAliases).toEqual({ good: "awb/claude-opus-5" });
  });
});

describe("mergeLayers — Don fork routing sections", () => {
  it("inherits a global routing section the project layer does not name", () => {
    const merged = mergeLayers({ providerAgents: PROVIDER_AGENTS, modelAgents: MODEL_AGENTS }, { agent: {} });
    expect(merged.providerAgents).toEqual(PROVIDER_AGENTS);
    expect(merged.modelAgents).toEqual(MODEL_AGENTS);
  });

  it("lets a project layer replace the section it names, leaving the others alone", () => {
    const projectProviders = { awb: { default: "awb/claude-opus-5" } };
    const merged = mergeLayers(
      { providerAgents: PROVIDER_AGENTS, modelAgents: MODEL_AGENTS },
      { providerAgents: projectProviders },
    );
    expect(merged.providerAgents).toEqual(projectProviders);
    expect(merged.modelAgents).toEqual(MODEL_AGENTS);
  });
});
