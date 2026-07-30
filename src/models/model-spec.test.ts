import { describe, expect, it } from "vitest";
import { resolveModelSpec, type ModelRegistryLike } from "./model-spec.js";

const ENTRIES = [
  ["awb", "claude-opus-5"],
  ["awb", "claude-opus-4-8"],
  ["awb", "claude-opus-4-7"],
  ["awb", "claude-sonnet-4-6"],
  ["awb", "claude-haiku-4-5"],
  ["walmart-puppy", "gpt-5.6-sol"],
  ["walmart-puppy", "gpt-5.6-terra"],
  ["walmart-puppy", "gpt-5.6-luna"],
  ["walmart-puppy", "gpt-5.4"],
  ["walmart-puppy-gemini", "gemini-3.5-flash"],
  ["github-copilot", "gpt-5.5"],
].map(([provider, id]) => ({ provider, id }));

const registry: ModelRegistryLike = {
  getAvailable: () => ENTRIES,
  find: (provider, id) => ENTRIES.find((e) => e.provider === provider && e.id === id),
};

describe("resolveModelSpec", () => {
  it("resolves a canonical provider/model key unchanged", () => {
    const r = resolveModelSpec("awb/claude-opus-5", registry);
    expect(r).toMatchObject({ kind: "resolved", key: "awb/claude-opus-5", thinking: undefined });
    expect((r as { note?: string }).note).toBeUndefined();
  });

  it("keeps a :thinking suffix with the resolved model", () => {
    expect(resolveModelSpec("awb/claude-opus-5:medium", registry)).toMatchObject({
      kind: "resolved",
      key: "awb/claude-opus-5",
      thinking: "medium",
    });
  });

  it("resolves a bare model id to its only provider", () => {
    expect(resolveModelSpec("gpt-5.4", registry)).toMatchObject({
      kind: "resolved",
      key: "walmart-puppy/gpt-5.4",
      note: "model 'gpt-5.4' resolved to walmart-puppy/gpt-5.4",
    });
  });

  it("resolves a unique fragment such as terra", () => {
    expect(resolveModelSpec("terra", registry)).toMatchObject({
      kind: "resolved",
      key: "walmart-puppy/gpt-5.6-terra",
    });
  });

  it("reads a trailing effort word as thinking", () => {
    expect(resolveModelSpec("Terra High", registry)).toMatchObject({
      kind: "resolved",
      key: "walmart-puppy/gpt-5.6-terra",
      thinking: "high",
    });
    expect(resolveModelSpec("opus 5 medium", registry)).toMatchObject({
      kind: "resolved",
      key: "awb/claude-opus-5",
      thinking: "medium",
    });
  });

  it("treats default/parent/inherit as inherit the parent model", () => {
    for (const spec of ["default", "Parent", "inherit", "auto"]) {
      expect(resolveModelSpec(spec, registry).kind).toBe("inherit");
    }
  });

  it("treats an empty or missing spec as inherit", () => {
    expect(resolveModelSpec(undefined, registry).kind).toBe("inherit");
    expect(resolveModelSpec("   ", registry).kind).toBe("inherit");
  });

  it("accepts provider aliases and space-separated provider spellings", () => {
    expect(resolveModelSpec("copilot/gpt-5.5", registry)).toMatchObject({
      kind: "resolved",
      key: "github-copilot/gpt-5.5",
    });
    expect(resolveModelSpec("wm/gpt-5.6-terra", registry)).toMatchObject({
      kind: "resolved",
      key: "walmart-puppy/gpt-5.6-terra",
    });
    expect(resolveModelSpec("awb claude-opus-5", registry)).toMatchObject({
      kind: "resolved",
      key: "awb/claude-opus-5",
    });
  });

  it("applies user aliases, including a thinking suffix in the alias target", () => {
    const r = resolveModelSpec("Terra-High", registry, { aliases: { terrahigh: "walmart-puppy/gpt-5.6-terra:high" } });
    expect(r).toMatchObject({ kind: "resolved", key: "walmart-puppy/gpt-5.6-terra", thinking: "high" });
  });

  it("lets an explicit thinking suffix win over the alias target", () => {
    const r = resolveModelSpec("terrahigh:medium", registry, { aliases: { terrahigh: "walmart-puppy/gpt-5.6-terra:high" } });
    expect(r).toMatchObject({ kind: "resolved", thinking: "medium" });
  });

  it("returns every candidate when a fragment is ambiguous", () => {
    const r = resolveModelSpec("opus", registry);
    expect(r.kind).toBe("error");
    const message = (r as { message: string }).message;
    expect(message).toContain("Ambiguous model");
    expect(message).toContain("awb/claude-opus-5");
    expect(message).toContain("awb/claude-opus-4-8");
  });

  it("returns format, close matches, and the available list when nothing matches", () => {
    const r = resolveModelSpec("gpt-5.2", registry);
    expect(r.kind).toBe("error");
    const message = (r as { message: string }).message;
    expect(message).toContain("Model not found in registry: gpt-5.2.");
    expect(message).toContain('"provider/model-id:thinking"');
    expect(message).toContain("Available: awb/claude-opus-5");
    expect(message).toContain('Pass "default" to inherit the parent model.');
  });

  it("recovers when the provider is wrong but the model id is unique", () => {
    expect(resolveModelSpec("openai/gpt-5.6-luna", registry)).toMatchObject({
      kind: "resolved",
      key: "walmart-puppy/gpt-5.6-luna",
    });
  });

  it("does not fuzzy-match fragments shorter than three characters", () => {
    expect(resolveModelSpec("gp", registry).kind).toBe("error");
  });

  it("breaks a provider tie with parentProvider, then providerPreference, then auth", () => {
    const shared = [
      { provider: "awb", id: "claude-opus-5" },
      { provider: "github-copilot", id: "claude-opus-5" },
      { provider: "openai", id: "claude-opus-5" },
    ];
    const tieRegistry: ModelRegistryLike = {
      getAvailable: () => shared,
      find: (provider, id) => shared.find((e) => e.provider === provider && e.id === id),
      hasConfiguredAuth: (m) => m.provider !== "openai",
    };

    expect(resolveModelSpec("opus 5", tieRegistry).kind).toBe("error");
    expect(resolveModelSpec("opus 5", tieRegistry, { parentProvider: "github-copilot" })).toMatchObject({
      kind: "resolved",
      key: "github-copilot/claude-opus-5",
    });
    expect(resolveModelSpec("opus 5", tieRegistry, { providerPreference: ["awb", "github-copilot"] })).toMatchObject({
      kind: "resolved",
      key: "awb/claude-opus-5",
    });
  });

  it("puts the parent provider and preferred providers first in the error list", () => {
    const r = resolveModelSpec("gpt-9", registry, {
      parentProvider: "walmart-puppy",
      providerPreference: ["awb"],
    });
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("Available: walmart-puppy/gpt-5.6-sol");
  });

  it("keeps unrelated ids out of the close-match list", () => {
    const noisy = [
      { provider: "local-mlx", id: "/Users/d/mx-vlm/gemma-4-12B" },
      { provider: "walmart-puppy", id: "gpt-5.6-terra" },
    ];
    const noisyRegistry: ModelRegistryLike = {
      getAvailable: () => noisy,
      find: (provider, id) => noisy.find((e) => e.provider === provider && e.id === id),
    };
    const r = resolveModelSpec("gpt-5.9-nope", noisyRegistry);
    expect(r.kind).toBe("error");
    const message = (r as { message: string }).message;
    expect(message).not.toContain("Close matches: local-mlx");
  });

  it("falls back to getAll when no model is marked available", () => {
    const fallbackRegistry: ModelRegistryLike = {
      getAvailable: () => [],
      getAll: () => ENTRIES,
      find: () => undefined,
    };
    expect(resolveModelSpec("terra", fallbackRegistry)).toMatchObject({
      kind: "resolved",
      key: "walmart-puppy/gpt-5.6-terra",
    });
  });
});
