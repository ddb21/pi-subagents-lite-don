import { describe, expect, it } from "vitest";
import { ConfigStore, type ConfigIO } from "./config-store.js";
import type { SubagentsConfig } from "../models/model-precedence.js";

/**
 * Don fork: a pool-profile switch rewrites subagents-lite.json while sessions
 * are open. These cover refreshIfChanged, which picks that up mid-session.
 */
function configWith(defaultModel: string | null): SubagentsConfig {
  return {
    agent: { default: defaultModel, forceBackground: false },
    concurrency: { default: 4 },
  } as SubagentsConfig;
}

function makeIO(initial: SubagentsConfig) {
  let current = initial;
  let mtime = 1000;
  const io: ConfigIO = {
    load: () => current,
    save: () => {},
    mtimeMs: () => mtime,
  };
  return {
    io,
    externalEdit(next: SubagentsConfig) {
      current = next;
      mtime += 1;
    },
    touchOnly() {
      mtime += 1;
    },
  };
}

describe("ConfigStore.refreshIfChanged", () => {
  it("returns false while the file is unchanged", () => {
    const harness = makeIO(configWith(null));
    const store = new ConfigStore(harness.io);

    expect(store.refreshIfChanged()).toBe(false);
    expect(store.agent.defaultModel).toBeNull();
  });

  it("re-reads the config after an external edit", () => {
    const harness = makeIO(configWith(null));
    const store = new ConfigStore(harness.io);

    harness.externalEdit(configWith("walmart-puppy/gpt-5.6-terra"));

    expect(store.refreshIfChanged()).toBe(true);
    expect(store.agent.defaultModel).toBe("walmart-puppy/gpt-5.6-terra");
    // Second call is a no-op: the mtime is now current.
    expect(store.refreshIfChanged()).toBe(false);
  });

  it("keeps session overrides, which must outrank an external file edit", () => {
    const harness = makeIO(configWith(null));
    const store = new ConfigStore(harness.io);
    store.mutate.session.setOverride("qa", "awb/claude-opus-5");

    harness.externalEdit(configWith("github-copilot/gpt-5.6-sol"));
    store.refreshIfChanged();

    expect(store.agent.defaultModel).toBe("github-copilot/gpt-5.6-sol");
    expect(store.sessionModelOverride("qa")).toBe("awb/claude-opus-5");
  });

  it("treats a missing config file (mtime 0) as no change", () => {
    const harness = makeIO(configWith(null));
    const store = new ConfigStore({ ...harness.io, mtimeMs: () => 0 });

    expect(store.refreshIfChanged()).toBe(false);
  });
});

describe("sessionOverrideSnapshot", () => {
  it("returns a copy, so a caller cannot mutate live overrides", () => {
    const store = new ConfigStore();
    store.mutate.session.setOverride("executor", "github-copilot/gpt-5.6-terra:medium");
    const snap = store.sessionOverrideSnapshot() as Record<string, string | null>;
    expect(snap.executor).toBe("github-copilot/gpt-5.6-terra:medium");
    snap.executor = "tampered";
    expect(store.sessionModelOverride("executor")).toBe("github-copilot/gpt-5.6-terra:medium");
  });

  it("clearAll drops per-type overrides", () => {
    const store = new ConfigStore();
    store.mutate.session.setOverride("qa", "awb/claude-opus-5:high");
    store.mutate.session.clearAll();
    expect(store.sessionModelOverride("qa")).toBeNull();
  });
});

describe("session override precedence (what /pool session scope relies on)", () => {
  it("beats a providerAgents route but loses to an explicit per-call model", () => {
    const store = new ConfigStore();
    // Stand in for a global pool profile: providerAgents routes awb parents to Sol.
    (store as any).config.providerAgents = {
      awb: { executor: { model: "walmart-puppy/gpt-5.6-sol", thinking: "xhigh" } },
    };
    const globalRoute = store.spawnFor("executor", "awb/claude-opus-5");
    expect(globalRoute.model).toBe("walmart-puppy/gpt-5.6-sol");

    store.mutate.session.setAmbient("executor", "github-copilot/gpt-5.6-terra:medium");
    const scoped = store.spawnFor("executor", "awb/claude-opus-5");
    expect(scoped.model).toBe("github-copilot/gpt-5.6-terra:medium");

    // An explicit escalation in the Agent call still wins over session scope.
    const explicit = store.spawnFor("executor", "awb/claude-opus-5", undefined, "awb/claude-opus-5:high");
    expect(explicit.model).toBe("awb/claude-opus-5:high");
  });

  it("a hard /agents pin still outranks an explicit per-call model", () => {
    const store = new ConfigStore();
    store.mutate.session.setOverride("executor", "awb/claude-opus-5:high");
    const explicit = store.spawnFor("executor", "awb/claude-opus-5", undefined, "walmart-puppy/gpt-5.6-luna");
    expect(explicit.model).toBe("awb/claude-opus-5:high");
  });

  it("clearing session scope restores the global route", () => {
    const store = new ConfigStore();
    (store as any).config.providerAgents = {
      awb: { qa: { model: "github-copilot/gpt-5.6-sol", thinking: "xhigh" } },
    };
    store.mutate.session.setAmbient("qa", "awb/claude-opus-5:high");
    expect(store.spawnFor("qa", "awb/claude-opus-5").model).toBe("awb/claude-opus-5:high");
    store.mutate.session.clearAll();
    expect(store.spawnFor("qa", "awb/claude-opus-5").model).toBe("github-copilot/gpt-5.6-sol");
  });
});
