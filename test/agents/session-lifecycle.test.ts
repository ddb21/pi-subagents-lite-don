import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, DefaultResourceLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { SESSION_SHUTDOWN_TIMEOUT_MS, shutdownAgentSession } from "../../src/agents/session-lifecycle.js";
import { fakeCtx, fakePi } from "../fixtures.js";

const state = vi.hoisted(() => ({
  dir: "",
  starts: 0,
  reasons: [] as string[],
  shutdowns: 0,
  resources: 0,
  behavior: "normal" as "normal" | "throw" | "hang",
  firstBehavior: "normal" as "normal" | "throw" | "hang",
  firstCalls: 0,
  releaseFirst: undefined as (() => void) | undefined,
}));

// Use real SDK sessions and real extension factories, without user resources or a provider request.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    getAgentDir: () => state.dir,
    DefaultResourceLoader: class extends actual.DefaultResourceLoader {
      constructor(options: ConstructorParameters<typeof actual.DefaultResourceLoader>[0]) {
        super({
          ...options,
          noExtensions: true,
          noSkills: true,
          extensionFactories: [
            (pi: ExtensionAPI) => {
              pi.on("session_shutdown", () => {
                state.firstCalls++;
                if (state.firstBehavior === "throw") throw new Error("first extension failed");
                if (state.firstBehavior === "hang")
                  return new Promise<void>((resolve) => {
                    state.releaseFirst = resolve;
                  });
              });
            },
            (pi: ExtensionAPI) => {
              let resource: ReturnType<typeof setInterval> | undefined;
              pi.on("session_start", (event) => {
                state.starts++;
                state.reasons.push(event.reason);
                state.resources++;
                resource = setInterval(() => {}, 60_000);
                resource.unref();
              });
              pi.on("session_shutdown", async (event) => {
                expect(event).toEqual({ type: "session_shutdown", reason: "quit" });
                state.shutdowns++;
                state.resources--;
                clearInterval(resource);
                if (state.behavior === "throw") throw new Error("extension teardown failed");
                if (state.behavior === "hang") await new Promise<void>(() => {});
              });
            },
          ],
        });
      }
    },
  };
});

vi.mock("../../src/agents/agent-types.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/agents/agent-types.js")>()),
  getAgentConfig: () => undefined,
  getConfig: () => ({ extensions: true, skills: false }),
  getToolNamesForType: () => [],
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({ agent: { includeContextFiles: false, systemPromptMode: "replace", outputTranscript: false } }),
  enterSubagentSpawn: () => {},
  exitSubagentSpawn: () => {},
}));

let manager: AgentManager;
let prompt: ReturnType<typeof mockPrompt>;
function mockPrompt() {
  return vi.spyOn(AgentSession.prototype, "prompt");
}
let dispose: ReturnType<typeof mockDispose>;
function mockDispose() {
  return vi.spyOn(AgentSession.prototype, "dispose");
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), "subagent-lifecycle-"));
  state.starts = state.shutdowns = state.resources = 0;
  state.reasons = [];
  state.behavior = "normal";
  state.firstBehavior = "normal";
  state.firstCalls = 0;
  state.releaseFirst = undefined;
  manager = new AgentManager();
  dispose = vi.spyOn(AgentSession.prototype, "dispose");
  prompt = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, text) {
    const message = { role: "user" as const, content: text, timestamp: Date.now() };
    this.sessionManager.appendMessage(message);
    this.messages.push(message);
  });
});

afterEach(async () => {
  await manager.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(state.dir, { recursive: true, force: true });
});

function spawn() {
  return manager.spawn(fakePi(), fakeCtx({ cwd: state.dir }), "general-purpose", "first turn", {
    description: "lifecycle test",
    model: fakeCtx().model,
  });
}

function gate(id: string) {
  return manager.getRecord(id)!.execution.promise!;
}

describe("subagent extension lifecycle (real createAgentSession)", () => {
  it("shuts down once on completion, preserves history, and restarts extensions on continuation", async () => {
    const id = spawn();
    await gate(id);
    const first = manager.getRecord(id)!.execution.session!;
    expect([state.starts, state.shutdowns, state.resources]).toEqual([1, 1, 0]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(first.messages).toHaveLength(1);
    expect(await manager.steer(id, "second turn")).toBe(true);
    await vi.waitFor(() => expect(manager.getRecord(id)!.execution.settlementCount).toBe(2));
    const next = manager.getRecord(id)!.execution.session!;
    expect(next).not.toBe(first);
    expect(next.messages).toHaveLength(2);
    expect(next.sessionManager).toBe(first.sessionManager);
    expect(state.reasons).toEqual(["startup", "resume"]);
    expect([state.starts, state.shutdowns, state.resources]).toEqual([2, 2, 0]);
    manager.clear(id);
    await manager.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
    console.log(
      `real SDK continuation: starts=${state.starts} shutdowns=${state.shutdowns} resources=${state.resources} messages=${next.messages.length}`,
    );
  });

  it("queues steers while a continuation replaces the disposed session", async () => {
    const id = spawn();
    await gate(id);
    const first = manager.getRecord(id)!.execution.session!;
    const steer = vi.spyOn(AgentSession.prototype, "steer").mockResolvedValue();
    const reload = DefaultResourceLoader.prototype.reload;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(async function (
      this: DefaultResourceLoader,
    ) {
      await ready;
      await reload.call(this);
    });
    expect(await manager.steer(id, "second turn")).toBe(true);
    expect(await manager.steer(id, "during restart")).toBe(true);
    expect(steer).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(manager.getRecord(id)!.execution.settlementCount).toBe(2));
    expect(steer).toHaveBeenCalledExactlyOnceWith("during restart");
    expect(steer.mock.instances[0]).not.toBe(first);
  });

  it("shuts down once after stop", async () => {
    prompt.mockImplementation(function (this: AgentSession) {
      return new Promise<void>((resolve) => {
        vi.spyOn(this, "abort").mockImplementation(async () => resolve());
      });
    });
    const id = spawn();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    manager.abort(id);
    await gate(id);
    expect(manager.getRecord(id)!.lifecycle.status).toBe("stopped");
    expect([state.starts, state.shutdowns, state.resources]).toEqual([1, 1, 0]);
    await manager.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("shuts down a live session on manager dispose, once across repeated dispose and settlement", async () => {
    prompt.mockImplementation(function (this: AgentSession) {
      return new Promise<void>((resolve) => {
        vi.spyOn(this, "abort").mockImplementation(async () => resolve());
      });
    });
    const id = spawn();
    const completion = gate(id);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    await Promise.all([manager.dispose(), manager.dispose(), completion]);
    expect([state.starts, state.shutdowns, state.resources]).toEqual([1, 1, 0]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("closes a session that finishes setup after manager disposal", async () => {
    const bind = AgentSession.prototype.bindExtensions;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (
      this: AgentSession,
      bindings,
    ) {
      await bind.call(this, bindings);
      await ready;
    });
    const id = spawn();
    const completion = gate(id);
    await vi.waitFor(() => expect(state.starts).toBe(1));
    await manager.dispose();
    release();
    await completion;
    expect(prompt).not.toHaveBeenCalled();
    expect([state.starts, state.shutdowns, state.resources]).toEqual([1, 1, 0]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("closes extensions and opens the gate after a prompt failure", async () => {
    prompt.mockRejectedValue(new Error("provider failed"));
    const id = spawn();
    await gate(id);
    expect(manager.getRecord(id)!.lifecycle.status).toBe("error");
    expect([state.starts, state.shutdowns, state.resources]).toEqual([1, 1, 0]);
  });

  it("does not let a throwing extension break completion", async () => {
    state.behavior = "throw";
    const id = spawn();
    await gate(id);
    expect(manager.getRecord(id)!.lifecycle.status).toBe("completed");
    expect([state.starts, state.shutdowns, state.resources]).toEqual([1, 1, 0]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["hang", "throw"] as const)(
    "releases the second extension when the first handler will %s",
    async (behavior) => {
      state.firstBehavior = behavior;
      const id = spawn();
      await vi.waitFor(() => expect(state.shutdowns).toBe(1));
      expect(state.resources).toBe(0);
      if (behavior === "hang") expect(dispose).not.toHaveBeenCalled();
      await gate(id);
      expect(state.firstCalls).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      await manager.dispose();
      expect(state.shutdowns).toBe(1);
    },
  );

  it("does not invoke another handler after a timed-out handler resolves late", async () => {
    state.firstBehavior = "hang";
    const id = spawn();
    await gate(id);
    expect([state.firstCalls, state.shutdowns, state.resources]).toEqual([1, 1, 0]);
    expect(dispose).toHaveBeenCalledTimes(1);
    state.releaseFirst!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect([state.firstCalls, state.shutdowns, state.resources]).toEqual([1, 1, 0]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("bounds a handler that never resolves", async () => {
    state.behavior = "hang";
    const id = spawn();
    await vi.waitFor(() => expect(state.shutdowns).toBe(1));
    expect(await manager.steer(id, "during teardown")).toBe(false);
    await gate(id);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)!.execution.settled).toBe(true);
  });

  it("bounds a rejecting runner and a hung runner with an exact timeout", async () => {
    vi.useFakeTimers();
    const session = {
      extensionRunner: { emit: vi.fn(() => new Promise<void>(() => {})) },
      dispose: vi.fn(),
    };
    const shutdown = shutdownAgentSession(session as unknown as AgentSession);
    expect(shutdownAgentSession(session as unknown as AgentSession)).toBe(shutdown);
    await vi.advanceTimersByTimeAsync(SESSION_SHUTDOWN_TIMEOUT_MS - 1);
    expect(session.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(session.dispose).toHaveBeenCalledTimes(1);
    const rejecting = {
      extensionRunner: {
        emit: vi.fn(() => {
          throw new Error("runner failed");
        }),
      },
      dispose: vi.fn(),
    };
    await shutdownAgentSession(rejecting as unknown as AgentSession);
    expect(rejecting.dispose).toHaveBeenCalledTimes(1);
  });
});
