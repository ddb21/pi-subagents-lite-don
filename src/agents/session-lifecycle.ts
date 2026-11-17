import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Bound extension teardown so a broken handler cannot hold the completion gate. */
export const SESSION_SHUTDOWN_TIMEOUT_MS = 1_000;

const shutdowns = new WeakMap<AgentSession, Promise<void>>();

/** Emit before dispose, once per session, including concurrent teardown paths. */
export function shutdownAgentSession(session: AgentSession): Promise<void> {
  const existing = shutdowns.get(session);
  if (existing) return existing;
  // Defer emission until after the map entry exists, including reentrant handlers.
  const shutdown = Promise.resolve().then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SESSION_SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Extension failures must not prevent disposal or completion.
    } finally {
      clearTimeout(timer);
      try {
        session.dispose();
      } catch {
        // Keep manager teardown safe even if the host's dispose hook fails.
      }
    }
  });
  shutdowns.set(session, shutdown);
  return shutdown;
}

export function isAgentSessionShutdown(session: AgentSession): boolean {
  return shutdowns.has(session);
}
