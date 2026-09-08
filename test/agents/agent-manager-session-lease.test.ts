/**
 * Don fork: AgentManager reserves a keyed session before anything is queued.
 *
 * The persistent-executor module owns the on-disk lease and index; those are
 * tested against a real temp dir in persistent-executor.test.ts. Here the
 * module is stubbed so the assertions are about the manager's own decisions:
 * when it acquires, when it rejects, and when it releases.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
import { mockModules, mockRunResult, type OnAgentComplete } from "./manager-mocks.js";

const leaseMocks = vi.hoisted(() => ({
  acquireSessionKeyLease: vi.fn(),
  acquireSessionFileLease: vi.fn(),
  resolveSessionKey: vi.fn(() => undefined as string | undefined),
  getSessionKeyIndexKey: vi.fn(
    (cwd: string, type: string, key: string) => `${cwd}|${type.toLowerCase()}|${key}`,
  ),
}));

vi.mock("../../src/agents/persistent-executor.js", () => leaseMocks);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/fake/agent-dir",
}));

const { AgentManager } = await import("../../src/agents/agent-manager.js");

/** A lease double that records whether it was released. */
function fakeLease(lockPath = "/fake/agent-dir/leases/abc.lock") {
  const lease = { lockPath, released: false, release: vi.fn(() => void (lease.released = true)) };
  return lease;
}

describe("AgentManager — keyed session reservation", () => {
  let manager: InstanceType<typeof AgentManager>;
  let onComplete: Mock<OnAgentComplete>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    mockModules.mockAgentOutputLog.mockClear();
    mockModules.mockGetAgentConfig.mockClear();
    leaseMocks.acquireSessionKeyLease.mockReset();
    leaseMocks.acquireSessionFileLease.mockReset();
    leaseMocks.resolveSessionKey.mockReset().mockReturnValue(undefined);
    onComplete = vi.fn<OnAgentComplete>();
  });

  afterEach(() => {
    manager?.dispose();
  });

  const spawnKeyed = (key: string, extra: Record<string, unknown> = {}) =>
    manager.spawn(fakePi(), fakeCtx(), "executor", "task", {
      description: "task",
      isBackground: true,
      sessionKey: key,
      sessionKeyCwd: "/repo",
      sessionKeyAgentType: "executor",
      ...extra,
    });

  it("acquires a key lease before the record exists", () => {
    manager = new AgentManager(onComplete, { default: 4, models: {} });
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const lease = fakeLease();
    leaseMocks.acquireSessionKeyLease.mockReturnValue(lease);

    const id = spawnKeyed("exec-1");

    expect(leaseMocks.acquireSessionKeyLease).toHaveBeenCalledWith("/fake/agent-dir", "/repo", "executor", "exec-1");
    expect(manager.getRecord(id)!.execution.sessionKey).toBe("/repo|executor|exec-1");
  });

  it("reserves the key on a queued record too, before any session file exists", () => {
    // The whole point of reserving at spawn: a second call on the same key must
    // lose even while the first is still waiting for a concurrency slot.
    manager = new AgentManager(onComplete, { default: 1, models: {} });
    mockModules.mockRunAgent.mockReturnValue(makeResolvablePromise().promise);
    leaseMocks.acquireSessionKeyLease.mockImplementation(() => fakeLease());

    manager.spawn(fakePi(), fakeCtx(), "executor", "first", {
      description: "first",
      isBackground: true,
      modelKey: "p/m",
      sessionKey: "exec-1",
      sessionKeyCwd: "/repo",
      sessionKeyAgentType: "executor",
    });
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "executor", "second", {
      description: "second",
      isBackground: true,
      modelKey: "p/m",
      sessionKey: "exec-2",
      sessionKeyCwd: "/repo",
      sessionKeyAgentType: "executor",
    });

    expect(manager.getRecord(queuedId)!.lifecycle.status).toBe("queued");
    expect(manager.getRecord(queuedId)!.execution.sessionKey).toBe("/repo|executor|exec-2");
  });

  it("rejects a second spawn on a key a live record already holds, and frees the lease", () => {
    manager = new AgentManager(onComplete, { default: 4, models: {} });
    mockModules.mockRunAgent.mockReturnValue(makeResolvablePromise().promise);
    const first = fakeLease();
    const second = fakeLease();
    leaseMocks.acquireSessionKeyLease.mockReturnValueOnce(first).mockReturnValueOnce(second);

    spawnKeyed("exec-1");

    expect(() => spawnKeyed("exec-1")).toThrow(/Session 'exec-1' is busy/);
    // The rejected attempt must not keep the lease it just took.
    expect(second.release).toHaveBeenCalled();
    expect(first.release).not.toHaveBeenCalled();
  });

  it("rejects a second spawn that resolves to the same session file under a different key", () => {
    manager = new AgentManager(onComplete, { default: 4, models: {} });
    mockModules.mockRunAgent.mockReturnValue(makeResolvablePromise().promise);
    leaseMocks.acquireSessionKeyLease.mockImplementation(() => fakeLease());
    leaseMocks.resolveSessionKey.mockReturnValue("/sessions/shared.jsonl");

    spawnKeyed("exec-1");
    expect(() => spawnKeyed("exec-2")).toThrow(/is busy/);
  });

  it("requires a canonical agent type whenever a key is set", () => {
    manager = new AgentManager(onComplete, { default: 4, models: {} });
    expect(() =>
      manager.spawn(fakePi(), fakeCtx(), "executor", "task", {
        description: "task",
        isBackground: true,
        sessionKey: "exec-1",
        sessionKeyCwd: "/repo",
      }),
    ).toThrow(/session_key requires a canonical resolved agent type/);
    // No lease is taken when the precondition fails.
    expect(leaseMocks.acquireSessionKeyLease).not.toHaveBeenCalled();
  });

  it("releases the lease once the run settles", async () => {
    manager = new AgentManager(onComplete, { default: 4, models: {} });
    const gate = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(gate.promise);
    const lease = fakeLease();
    leaseMocks.acquireSessionKeyLease.mockReturnValue(lease);

    spawnKeyed("exec-1");
    expect(lease.released).toBe(false);

    gate.resolve(mockRunResult());
    await vi.waitFor(() => expect(lease.released).toBe(true));

    // Released, so the next spawn on the same key may take it.
    expect(lease.release).toHaveBeenCalled();
  });

  it("releases the lease when the run rejects", async () => {
    manager = new AgentManager(onComplete, { default: 4, models: {} });
    mockModules.mockRunAgent.mockRejectedValue(new Error("provider boom"));
    const lease = fakeLease();
    leaseMocks.acquireSessionKeyLease.mockReturnValue(lease);

    spawnKeyed("exec-1");
    await vi.waitFor(() => expect(lease.released).toBe(true));
  });

  it("takes a file lease for a direct resume with no key", () => {
    manager = new AgentManager(onComplete, { default: 4, models: {} });
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    leaseMocks.acquireSessionFileLease.mockReturnValue(fakeLease());

    manager.spawn(fakePi(), fakeCtx(), "executor", "task", {
      description: "task",
      isBackground: true,
      resumeSessionFile: "/sessions/direct.jsonl",
    });

    expect(leaseMocks.acquireSessionFileLease).toHaveBeenCalledWith("/fake/agent-dir", "/sessions/direct.jsonl");
    expect(leaseMocks.acquireSessionKeyLease).not.toHaveBeenCalled();
  });

  it("takes no lease at all for an ordinary unkeyed spawn", () => {
    manager = new AgentManager(onComplete, { default: 4, models: {} });
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

    manager.spawn(fakePi(), fakeCtx(), "executor", "task", { description: "task", isBackground: true });

    expect(leaseMocks.acquireSessionKeyLease).not.toHaveBeenCalled();
    expect(leaseMocks.acquireSessionFileLease).not.toHaveBeenCalled();
  });

  it("forwards the persistent-session fields to the runner", () => {
    manager = new AgentManager(onComplete, { default: 4, models: {} });
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    leaseMocks.acquireSessionKeyLease.mockReturnValue(fakeLease());
    leaseMocks.resolveSessionKey.mockReturnValue("/sessions/exec-1.jsonl");

    spawnKeyed("exec-1", { parentSessionFile: "/sessions/parent.jsonl" });

    expect(mockModules.mockRunAgent).toHaveBeenCalledWith(
      expect.anything(),
      "executor",
      "task",
      expect.objectContaining({
        sessionKey: "exec-1",
        sessionKeyCwd: "/repo",
        sessionKeyAgentType: "executor",
        resumeSessionFile: "/sessions/exec-1.jsonl",
        parentSessionFile: "/sessions/parent.jsonl",
      }),
    );
  });
});
