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
  const state = { global: initial, stamp: "s1", loads: 0, tick: 1 };
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
    bump: () => void (state.stamp = `s${++state.tick}`),
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

  it("treats an empty stamp as absent and never refreshes", () => {
    // Neither config file exists. There is nothing to pick up, and refreshing
    // would throw away the in-memory defaults for no reason.
    const io: ConfigIO = {
      load: () => ({ global: { agent: { default: "p/x" } }, project: null, projectStatus: "untrusted" }),
      saveGlobal: () => {},
      saveProject: () => {},
      changeStamp: () => "",
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

  it("keeps an ambient route EFFECTIVE across an external edit", () => {
    // Asserting the snapshot alone is not enough: a stored route that no longer
    // routes still passes that check. Edit the one key that collides, the
    // config default model, and assert resolution.
    const { io, setGlobal, bump } = stampedIO({});
    const store = new ConfigStore(io);
    store.mutate.session.setAmbient("default", "p/ambient");

    setGlobal({ agent: { default: "p/new" } });
    bump();
    store.refreshIfChanged();

    expect(store.ambientOverrideSnapshot().default).toBe("p/ambient");
    expect(store.modelFor("executor", "p/parent")).toBe("p/ambient");
  });

  it("does not commit the stamp when the file is being rewritten", () => {
    // A writer that truncates before writing moves mtime at truncate time, so a
    // stat in that window reads an empty file and the loader returns {}. If the
    // stamp were committed first, that empty config would stick for the whole
    // session. Simulate it: the stamp moves again between the load and the
    // post-load re-stat.
    const state = { stamp: "s1", loads: 0, global: {} as RawConfig, tearNext: false };
    const io: ConfigIO = {
      load: () => {
        state.loads++;
        if (state.tearNext) {
          // The writer finishes mid-read: mtime moves again, and what we just
          // read was the truncated file, which the loader turns into {}.
          state.tearNext = false;
          state.stamp = "s3";
          return { global: {}, project: null, projectStatus: "untrusted" as ProjectLayerStatus };
        }
        return {
          global: structuredClone(state.global),
          project: null,
          projectStatus: "untrusted" as ProjectLayerStatus,
        };
      },
      saveGlobal: () => {},
      saveProject: () => {},
      changeStamp: () => state.stamp,
    };
    const store = new ConfigStore(io);

    // A pool switch truncates the file. mtime moves before the content lands.
    state.stamp = "s2";
    state.tearNext = true;

    // The torn read is refused and the stamp is NOT committed.
    expect(store.refreshIfChanged()).toBe(false);
    expect(state.loads).toBe(2);

    // The writer has finished. The next call retries and applies the real file,
    // which is the whole point of not committing the stamp early.
    state.global = { agent: { default: "p/new" } };
    expect(store.refreshIfChanged()).toBe(true);
    expect(state.loads).toBe(3);
    expect(store.modelFor("executor", "p/parent")).toBe("p/new");
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

  it("beats a config default model", () => {
    // The property that makes /pool session scope work at all. Once any model
    // is set through the /agents menu, agent.default is written to the global
    // config file. If config outranked ambient, every session-scoped pool
    // switch would become a silent no-op from that moment on.
    const s = new ConfigStore(stampedIO({ agent: { default: "p/config" } }).io);
    s.mutate.session.setAmbient("default", "p/pool");
    expect(s.modelFor("executor", "p/parent")).toBe("p/pool");
  });

  it("LOSES to a config per-type pin, the documented limit", () => {
    // Not the same as the default case. A per-type pin is a deliberate, visible
    // per-agent choice and it also outranks an explicit per-call model, so it
    // cannot sit below the ambient route without breaking escalation. A /pool
    // switch therefore does not move an agent that carries its own pin.
    const s = new ConfigStore(stampedIO({ agent: { executor: "p/config-exec" } }).io);
    s.mutate.session.setAmbient("default", "p/pool");
    expect(s.modelFor("executor", "p/parent")).toBe("p/config-exec");
    // An agent without a pin still moves with the pool.
    expect(s.modelFor("writer", "p/parent")).toBe("p/pool");
  });

  it("loses to an explicit model even when config also sets one", () => {
    const s = new ConfigStore(stampedIO({ agent: { default: "p/config" } }).io);
    s.mutate.session.setAmbient("default", "p/pool");
    expect(s.spawnFor("executor", "p/parent", undefined, "p/escalated").model).toBe("p/escalated");
  });

  it("reports the ambient route as session-layer state", () => {
    // The /agents menu reads these. If they ignored ambient, a user could clear
    // "all session overrides", see an empty session layer, and still be routed
    // by the pool with nothing on screen explaining it.
    const s = store();
    s.mutate.session.setAmbient("executor", "p/pool-exec");
    expect(s.hasSessionModelSettings).toBe(true);
    expect(s.sessionModelOverride("executor")).toBe("p/pool-exec");
  });

  it("clearModelOverride drops the ambient route for that type", () => {
    const s = store();
    s.mutate.session.setAmbient("executor", "p/pool-exec");
    s.mutate.agent.clearModelOverride("executor", "session");
    expect(s.modelFor("executor", "p/parent")).toBe("p/parent");
  });

  it("clearAllModelOverrides drops ambient routes too", () => {
    const s = store();
    s.mutate.session.setAmbient("default", "p/pool");
    s.mutate.agent.clearAllModelOverrides("session");
    expect(s.modelFor("executor", "p/parent")).toBe("p/parent");
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
