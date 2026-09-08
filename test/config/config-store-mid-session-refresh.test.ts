/**
 * Don fork: mid-session external config edits, and the ambient (/pool) tier.
 *
 * A pool-profile switch rewrites subagents-lite.json while sessions are open.
 * reload() only runs at session_start, so without refreshIfChanged a running
 * orchestrator keeps routing to the old pool, which is exactly wrong when the
 * switch was made because that pool ran out of quota.
 */
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/config-store.js";
import type { ConfigIO, RawConfig, ProjectLayerStatus } from "../../src/config/config-io.js";
import { widgetStub } from "./config-store-helpers.js";

/** In-memory ConfigIO with a caller-driven change stamp. */
function stampedIO(initial: RawConfig = {}): {
  io: ConfigIO;
  setGlobal(raw: RawConfig): void;
  bump(): void;
  loadCount(): number;
} {
  const state = { global: initial, stamp: 1, loads: 0 };
  return {
    io: {
      load: () => {
        state.loads++;
        return {
          global: structuredClone(state.global),
          project: null,
          projectStatus: "untrusted" as ProjectLayerStatus,
        };
      },
      saveGlobal: () => {},
      saveProject: () => {},
      changeStamp: () => state.stamp,
    },
    setGlobal: (raw) => void (state.global = raw),
    bump: () => void (state.stamp++),
    loadCount: () => state.loads,
  };
}

describe("ConfigStore.refreshIfChanged", () => {
  it("does nothing when the change stamp has not moved", () => {
    const { io, loadCount } = stampedIO({ agent: { default: "p/old" } });
    const store = new ConfigStore(io);
    const loadsAfterConstruct = loadCount();

    expect(store.refreshIfChanged()).toBe(false);
    expect(loadCount()).toBe(loadsAfterConstruct);
    expect(store.modelFor("executor", "p/parent")).toBe("p/old");
  });

  it("re-reads config when the stamp moves", () => {
    const { io, setGlobal, bump } = stampedIO({ agent: { default: "p/old" } });
    const store = new ConfigStore(io);

    setGlobal({ agent: { default: "p/new" } });
    bump();

    expect(store.refreshIfChanged()).toBe(true);
    expect(store.modelFor("executor", "p/parent")).toBe("p/new");
  });

  it("re-reads only once per change", () => {
    const { io, setGlobal, bump, loadCount } = stampedIO({ agent: { default: "p/old" } });
    const store = new ConfigStore(io);

    setGlobal({ agent: { default: "p/new" } });
    bump();
    expect(store.refreshIfChanged()).toBe(true);
    const loads = loadCount();

    expect(store.refreshIfChanged()).toBe(false);
    expect(loadCount()).toBe(loads);
  });

  it("treats a zero stamp as absent and never refreshes", () => {
    // Neither config file exists. There is nothing to pick up, and refreshing
    // would throw away the in-memory defaults for no reason.
    const io: ConfigIO = {
      load: () => ({ global: { agent: { default: "p/x" } }, project: null, projectStatus: "untrusted" }),
      saveGlobal: () => {},
      saveProject: () => {},
      changeStamp: () => 0,
    };
    expect(new ConfigStore(io).refreshIfChanged()).toBe(false);
  });

  it("is a no-op for an adapter that publishes no change stamp", () => {
    // The in-memory test adapters omit changeStamp entirely.
    const io: ConfigIO = {
      load: () => ({ global: {}, project: null, projectStatus: "untrusted" }),
      saveGlobal: () => {},
      saveProject: () => {},
    };
    expect(new ConfigStore(io).refreshIfChanged()).toBe(false);
  });

  it("keeps a session pin across an external edit", () => {
    // The one behavioral difference from reload(): a user pin must outrank an
    // external file edit, or a pool switch would cancel a deliberate choice.
    const { io, setGlobal, bump } = stampedIO({ agent: { default: "p/old" } });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("default", "p/pinned");

    setGlobal({ agent: { default: "p/new" } });
    bump();
    expect(store.refreshIfChanged()).toBe(true);

    expect(store.modelFor("executor", "p/parent")).toBe("p/pinned");
  });

  it("keeps an ambient route across an external edit", () => {
    const { io, setGlobal, bump } = stampedIO({});
    const store = new ConfigStore(io);
    store.mutate.session.setAmbient("default", "p/ambient");

    setGlobal({ agent: { defaultMaxTurns: 7 } });
    bump();
    store.refreshIfChanged();

    expect(store.ambientOverrideSnapshot().default).toBe("p/ambient");
  });

  it("re-syncs dependents so a widget sees the new config", () => {
    const { io, setGlobal, bump } = stampedIO({ agent: { showCost: false } });
    const store = new ConfigStore(io);
    const { w, calls } = widgetStub();
    store.setDeps({ widget: w });
    calls.length = 0;

    setGlobal({ agent: { showCost: true } });
    bump();
    store.refreshIfChanged();

    expect(calls).toContain("setShowCost:true");
  });
});

describe("ConfigStore ambient overrides", () => {
  const store = () => new ConfigStore(stampedIO({}).io);

  it("routes through the ambient tier when nothing stronger is set", () => {
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    expect(s.modelFor("executor", "p/parent")).toBe("p/pool");
  });

  it("prefers a per-type ambient route over the ambient default", () => {
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    s.mutate.session.setAmbient("executor", "p/pool-exec");
    expect(s.modelFor("executor", "p/parent")).toBe("p/pool-exec");
  });

  it("loses to an explicit per-call model", () => {
    // The point of a separate tier. A session-scoped pool switch must not
    // silently cancel a deliberate escalation.
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    expect(s.spawnFor("executor", "p/parent", undefined, "p/escalated").model).toBe("p/escalated");
  });

  it("loses to a hard session pin", () => {
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    s.mutate.session.setOverride("default", "p/pinned");
    expect(s.modelFor("executor", "p/parent")).toBe("p/pinned");
  });

  it("still beats agent frontmatter and the parent model", () => {
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    expect(s.modelFor("executor", "p/parent", { model: "p/frontmatter" } as never)).toBe("p/pool");
  });

  it("clearAmbient drops ambient routes but keeps hard pins", () => {
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    s.mutate.session.setOverride("executor", "p/pinned");
    s.mutate.session.clearAmbient();

    expect(s.ambientOverrideSnapshot().default).toBeNull();
    expect(s.sessionOverrideSnapshot().executor).toBe("p/pinned");
  });

  it("clearAll drops both tiers", () => {
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    s.mutate.session.setOverride("executor", "p/pinned");
    s.mutate.session.clearAll();

    expect(s.ambientOverrideSnapshot().default).toBeNull();
    expect(s.sessionOverrideSnapshot().executor).toBeUndefined();
  });

  it("reload clears ambient routes, unlike refreshIfChanged", () => {
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    s.reload();
    expect(s.ambientOverrideSnapshot().default).toBeNull();
  });

  it("snapshots are copies, not live handles", () => {
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    const snapshot = s.ambientOverrideSnapshot() as Record<string, string | null>;
    snapshot.default = "p/tampered";
    expect(s.modelFor("executor", "p/parent")).toBe("p/pool");
  });
});
