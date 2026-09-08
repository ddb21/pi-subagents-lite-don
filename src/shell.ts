/**
 * shell.ts — Composition root shell.
 *
 * Per ADR 0004, the single mutable container for all per-session state,
 * created at session_start, disposed at session_shutdown. Handler modules
 * read via getter functions — no module-level mutable globals.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agents/agent-manager.js";
import type { AgentWidget } from "./ui/agent-widget.js";
import type { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { ConfigStore } from "./config/config-store.js";

// --- Shell type ---

interface Shell {
  pi: ExtensionAPI;
  sessionCtx: ExtensionContext;
  manager: AgentManager | null;
  widget: AgentWidget | null;
  store: ConfigStore;
  coordinator: SpawnCoordinator | null;
}

// --- Mutable module-level shell (populated by index.ts at session_start) ---

const shell: Shell = {
  pi: null!,
  sessionCtx: null!,
  manager: null,
  widget: null,
  store: new ConfigStore(),
  coordinator: null,
};

// --- Getter functions (read current state at call time) ---

/** Set at init time. */
export function getPiInstance(): ExtensionAPI {
  return shell.pi;
}

/** Set at session_start. */
export function getSessionCtx(): ExtensionContext {
  return shell.sessionCtx;
}

/** Null until created at session_start. */
export function getManager(): AgentManager | null {
  return shell.manager;
}

/** Null until created at session_start. */
export function getWidget(): AgentWidget | null {
  return shell.widget;
}

/** Lives for the lifetime of the extension. */
export function getStore(): ConfigStore {
  return shell.store;
}

/** Don fork: the narrow session-routing surface published on globalThis. */
export interface SessionBridge {
  setAmbient(type: string, spec: string): void;
  setOverride(type: string, spec: string): void;
  clearOverride(type: string): void;
  /** Drop the ambient route only, keeping hard /agents pins intact. */
  clearAmbient(): void;
  clearAll(): void;
  list(): Record<string, string>;
}

/** The globalThis key the bridge is published under. */
export const SESSION_BRIDGE_KEY = "__piSubagentsLiteSession";

/**
 * Don fork: publish a narrow session-override bridge on globalThis.
 *
 * The store is module-private, so a sibling extension (the /pool command, for
 * example) has no way to scope subagent routing to one session. Without this
 * every pool switch is global: it rewrites config for all runtimes and every
 * future session, which is wrong when only this session should move pools.
 *
 * Only session-scoped setters are exposed, never persisted config, so a caller
 * cannot use the bridge to write to disk.
 */
export function publishSessionBridge(): void {
  const bridge: SessionBridge = {
    // `spec` may carry ":thinking". Sits below an explicit per-call model, so a
    // deliberate escalation still wins.
    setAmbient: (type, spec) => shell.store.mutate.session.setAmbient(type, spec),
    // Hard per-session pin, as set by the /agents menu. Outranks everything.
    setOverride: (type, spec) => shell.store.mutate.session.setOverride(type, spec),
    clearOverride: (type) => shell.store.mutate.session.clearOverride(type),
    // `/pool reset` drops session scope. Without this it would have to call
    // clearAll(), which also destroys deliberate per-agent pins from /agents.
    clearAmbient: () => shell.store.mutate.session.clearAmbient(),
    clearAll: () => shell.store.mutate.session.clearAll(),
    // Read back what is active, so /pool status can show session scope. A hard
    // pin is listed after the ambient route, so it wins on the same key.
    list: () => {
      const out: Record<string, string> = {};
      for (const snapshot of [shell.store.ambientOverrideSnapshot(), shell.store.sessionOverrideSnapshot()]) {
        for (const [type, model] of Object.entries(snapshot)) if (model) out[type] = model;
      }
      return out;
    },
  };
  (globalThis as Record<string, unknown>)[SESSION_BRIDGE_KEY] = bridge;
}

/** Null until created at session_start. */
export function getCoordinator(): SpawnCoordinator | null {
  return shell.coordinator;
}

// --- Setter functions (called by index.ts to populate the shell) ---

export function setPiInstance(pi: ExtensionAPI): void {
  shell.pi = pi;
}

export function setSessionCtx(ctx: ExtensionContext): void {
  shell.sessionCtx = ctx;
}

export function setManager(m: AgentManager | null): void {
  shell.manager = m;
}

export function setWidget(w: AgentWidget | null): void {
  shell.widget = w;
}

export function setCoordinator(c: SpawnCoordinator | null): void {
  shell.coordinator = c;
}

// --- Subagent spawn context ---

/**
 * Nesting depth of in-flight subagent spawns. Subagent re-loads of this
 * extension would clobber parent-owned shell singletons; the factory checks
 * this flag and stays inert while a subagent is spawning.
 */
let subagentSpawnDepth = 0;

export function enterSubagentSpawn(): void {
  subagentSpawnDepth++;
}

export function exitSubagentSpawn(): void {
  if (subagentSpawnDepth > 0) subagentSpawnDepth--;
}

/** True while a subagent is being spawned (factory/session_start run in subagent context). */
export function isInsideSubagentSpawn(): boolean {
  return subagentSpawnDepth > 0;
}
