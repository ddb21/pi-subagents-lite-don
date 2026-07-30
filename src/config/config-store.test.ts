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
