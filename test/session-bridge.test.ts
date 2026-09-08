/**
 * Don fork: the globalThis session-routing bridge used by /pool.
 *
 * The store is module-private, so a sibling extension has no way to scope
 * subagent routing to one session. Without the bridge every pool switch is
 * global: it rewrites config for all runtimes and every future session, which
 * is wrong when only this session should move pools.
 *
 * These tests drive the real shell store, because shell.store has no setter.
 * Only session-scoped state is touched, and afterEach clears it, so nothing
 * reaches disk.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStore, publishSessionBridge, SESSION_BRIDGE_KEY, type SessionBridge } from "../src/shell.js";
import { shellMock } from "./fixtures.js";

const bridge = () => (globalThis as Record<string, unknown>)[SESSION_BRIDGE_KEY] as SessionBridge;

beforeEach(() => {
  publishSessionBridge();
  getStore().mutate.session.clearAll();
});

afterEach(() => {
  getStore().mutate.session.clearAll();
  delete (globalThis as Record<string, unknown>)[SESSION_BRIDGE_KEY];
});

describe("publishSessionBridge", () => {
  it("publishes exactly the session-scoped surface, and nothing that writes to disk", () => {
    // A caller must not be able to reach persisted config through the bridge.
    expect(Object.keys(bridge()).sort()).toEqual([
      "clearAll",
      "clearAmbient",
      "clearOverride",
      "list",
      "setAmbient",
      "setOverride",
    ]);
  });

  it("keeps the shell mock's copy of the bridge key in step with the real one", () => {
    // fixtures.ts cannot import this constant: it is pulled into hoisted
    // vi.mock factories and the import deadlocks the hoist. So it holds a
    // literal, and this assertion is what stops the two from drifting.
    expect(shellMock().SESSION_BRIDGE_KEY).toBe(SESSION_BRIDGE_KEY);
  });

  it("clearAmbient drops session scope without destroying hard pins", () => {
    // `/pool reset` needs this. With only clearAll() available it would also
    // wipe a deliberate per-agent pin set through /agents, with no warning.
    bridge().setAmbient("default", "p/pool");
    bridge().setOverride("reviewer-adversarial", "p/opus");

    bridge().clearAmbient();

    expect(getStore().ambientOverrideSnapshot().default).toBeNull();
    expect(getStore().sessionOverrideSnapshot()["reviewer-adversarial"]).toBe("p/opus");
  });

  it("setAmbient records an ambient route on the live store", () => {
    bridge().setAmbient("default", "p/pool");
    expect(getStore().ambientOverrideSnapshot().default).toBe("p/pool");
    // Ambient state is separate from a hard pin.
    expect(getStore().sessionOverrideSnapshot().default).toBeNull();
  });

  it("setOverride records a hard pin, kept separate from the ambient route", () => {
    bridge().setAmbient("default", "p/pool");
    bridge().setOverride("default", "p/pinned");

    expect(getStore().ambientOverrideSnapshot().default).toBe("p/pool");
    expect(getStore().sessionOverrideSnapshot().default).toBe("p/pinned");
  });

  it("clearOverride drops one hard pin and leaves the ambient route", () => {
    bridge().setAmbient("executor", "p/pool");
    bridge().setOverride("executor", "p/pinned");
    bridge().clearOverride("executor");

    expect(getStore().sessionOverrideSnapshot().executor).toBeUndefined();
    expect(getStore().ambientOverrideSnapshot().executor).toBe("p/pool");
  });

  it("clearAll drops both tiers", () => {
    bridge().setAmbient("default", "p/pool");
    bridge().setOverride("executor", "p/pinned");
    bridge().clearAll();

    expect(bridge().list()).toEqual({});
  });

  it("list reports both tiers, with a hard pin winning on the same key", () => {
    bridge().setAmbient("default", "p/pool");
    bridge().setAmbient("reviewer", "p/pool-rev");
    bridge().setOverride("default", "p/pinned");

    expect(bridge().list()).toEqual({ default: "p/pinned", reviewer: "p/pool-rev" });
  });

  it("list omits empty entries rather than reporting them as null", () => {
    expect(bridge().list()).toEqual({});
  });

  it("accepts a model spec carrying a thinking suffix", () => {
    bridge().setAmbient("default", "p/model:high");
    expect(bridge().list()).toEqual({ default: "p/model:high" });
  });

  it("republishing replaces the bridge without losing session state", () => {
    bridge().setAmbient("default", "p/pool");
    publishSessionBridge();
    expect(bridge().list()).toEqual({ default: "p/pool" });
  });
});
