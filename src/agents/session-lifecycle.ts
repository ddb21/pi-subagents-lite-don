import type { AgentSession, ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

/** Bound extension teardown so a broken handler cannot hold the completion gate. */
export const SESSION_SHUTDOWN_TIMEOUT_MS = 1_000;

const shutdowns = new WeakMap<AgentSession, Promise<void>>();
type ShutdownHandler = (event: SessionShutdownEvent, context: ExtensionContext) => unknown;

function emitShutdown(session: AgentSession): Promise<unknown> {
  const runner = session.extensionRunner;
  const event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
  let handlers: { extensionPath: string; handler: ShutdownHandler }[];
  let context: ExtensionContext;
  try {
    // Public SDK surfaces: the loader owns the extensions bound to this runner.
    // Validate and snapshot every handler before invocation, including older SDKs.
    const extensions = session.resourceLoader?.getExtensions?.().extensions;
    if (!Array.isArray(extensions) || typeof runner?.createContext !== "function") throw new Error("Unsupported SDK");
    handlers = extensions.flatMap((extension) => {
      if (!(extension.handlers instanceof Map)) throw new Error("Unsupported handlers");
      const callbacks = extension.handlers.get("session_shutdown") ?? [];
      if (!Array.isArray(callbacks) || callbacks.some((handler) => typeof handler !== "function")) {
        throw new Error("Unsupported handlers");
      }
      return callbacks.map((handler) => ({ extensionPath: extension.path, handler }));
    });
    context = runner.createContext();
  } catch {
    // Compatibility fallback only before any handler has run. Never replay handlers.
    return Promise.resolve(runner?.emit(event));
  }

  // Start every handler before any await or disposal. A stalled handler cannot
  // prevent another handler from releasing its resources, even after the deadline.
  return Promise.allSettled(
    handlers.map(({ extensionPath, handler }) => {
      const reportError = (error: unknown) => {
        try {
          runner.emitError({ extensionPath, event: event.type, error: String(error) });
        } catch {
          // An error reporter must not prevent the other handlers from starting.
        }
      };
      try {
        return Promise.resolve(handler(event, context)).catch(reportError);
      } catch (error) {
        reportError(error);
        return Promise.resolve();
      }
    }),
  );
}

/** Emit before dispose, once per session, including concurrent teardown paths. */
export function shutdownAgentSession(session: AgentSession): Promise<void> {
  const existing = shutdowns.get(session);
  if (existing) return existing;
  // Defer emission until after the map entry exists, including reentrant handlers.
  const shutdown = Promise.resolve().then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => emitShutdown(session)),
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
