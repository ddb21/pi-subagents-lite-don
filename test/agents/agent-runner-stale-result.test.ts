/**
 * Don fork ahead of upstream: a run's result comes from run-scoped events, not
 * only from a message-array index.
 *
 * Upstream v1.13.1 records a pre-prompt boundary index and scans the message
 * array down to it, which keeps an earlier run's text from surfacing as this
 * run's result. That part is correct and is kept. The hole is compaction:
 * threshold auto-compaction inside session.prompt() replaces the message array
 * with a SHORTER one (see node_modules/@earendil-works/pi-coding-agent/
 * dist/core/agent-session.js lines 1585 and 1439), so the boundary index can
 * point past the end of the array, the scan loop never runs, and a legitimate
 * current-run result is dropped as "". It only fires when the provider sends no
 * text_delta events, which is the only case where the fallback runs at all.
 *
 * The fix records the last finalized assistant text from THIS run's message_end
 * events. Event-scoped text cannot carry an earlier run's result and cannot be
 * invalidated by compaction.
 *
 * Relocated from the live fork's src/agents/agent-runner.stale-result.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockModules } from "./agent-runner-mocks.js";
import { __test__ } from "../../src/agents/agent-runner.js";

// The shared runner mocks stub extractText as a bare spy. These tests are about
// text resolution, so give it the real concatenating behavior.
beforeEach(() => {
  mockModules.mockExtractText.mockImplementation((content: unknown) =>
    Array.isArray(content)
      ? content
          .filter((part): part is { type: string; text: string } => (part as { type?: string })?.type === "text")
          .map((part) => part.text)
          .join("")
      : "",
  );
});

const { lastAssistantTextFrom, collectResponseText, resolveRunResult } = __test__;

type Listener = (event: Record<string, unknown>) => void;

/** A session double that only needs to publish events to one subscriber. */
function fakeSession() {
  const listeners: Listener[] = [];
  return {
    subscribe: (listener: Listener) => {
      listeners.push(listener);
      return () => void listeners.splice(listeners.indexOf(listener), 1);
    },
    emit: (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

const messageEnd = (text: string) => ({ type: "message_end", message: assistant(text) });
const textDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});

describe("lastAssistantTextFrom", () => {
  it("returns the last assistant text at or above the boundary", () => {
    const messages = [assistant("old run"), user("go"), assistant("this run")];
    expect(lastAssistantTextFrom(messages as never, 1)).toBe("this run");
  });

  it("never reaches below the boundary", () => {
    // The whole point of the index: an earlier run's answer must not be
    // reported as this run's result.
    const messages = [assistant("old run"), user("go")];
    expect(lastAssistantTextFrom(messages as never, 1)).toBe("");
  });

  it("returns empty when the boundary is past the end of the array", () => {
    // This is exactly what a compaction leaves behind.
    expect(lastAssistantTextFrom([assistant("kept")] as never, 5)).toBe("");
  });

  it("skips assistant messages whose text is blank", () => {
    const messages = [assistant("real"), assistant("   ")];
    expect(lastAssistantTextFrom(messages as never, 0)).toBe("real");
  });
});

describe("collectResponseText", () => {
  it("accumulates text deltas and resets on message_start", () => {
    const session = fakeSession();
    const collector = collectResponseText(session as never);

    session.emit(textDelta("part one "));
    session.emit(textDelta("part two"));
    expect(collector.getText()).toBe("part one part two");

    session.emit({ type: "message_start" });
    expect(collector.getText()).toBe("");
  });

  it("records finalized assistant text from message_end", () => {
    const session = fakeSession();
    const collector = collectResponseText(session as never);

    session.emit(messageEnd("finalized answer"));
    expect(collector.getFinalText()).toBe("finalized answer");
  });

  it("keeps only the latest non-blank finalized text", () => {
    const session = fakeSession();
    const collector = collectResponseText(session as never);

    session.emit(messageEnd("first"));
    session.emit(messageEnd("second"));
    session.emit(messageEnd("   "));
    expect(collector.getFinalText()).toBe("second");
  });

  it("ignores message_end for a non-assistant role", () => {
    const session = fakeSession();
    const collector = collectResponseText(session as never);

    session.emit({ type: "message_end", message: user("prompt text") });
    session.emit({ type: "message_end", message: { role: "toolResult", content: [] } });
    expect(collector.getFinalText()).toBe("");
  });

  it("does not reset finalized text on message_start", () => {
    // A later turn that streams nothing must not lose the previous turn's
    // finalized text from the same run.
    const session = fakeSession();
    const collector = collectResponseText(session as never);

    session.emit(messageEnd("turn one answer"));
    session.emit({ type: "message_start" });
    expect(collector.getFinalText()).toBe("turn one answer");
    expect(collector.getText()).toBe("");
  });

  it("forwards deltas to the onTextDelta callback with the running text", () => {
    const session = fakeSession();
    const onTextDelta = vi.fn();
    collectResponseText(session as never, onTextDelta);

    session.emit(textDelta("a"));
    session.emit(textDelta("b"));

    expect(onTextDelta).toHaveBeenNthCalledWith(1, "a", "a");
    expect(onTextDelta).toHaveBeenNthCalledWith(2, "b", "ab");
  });

  it("stops recording after unsubscribe", () => {
    const session = fakeSession();
    const collector = collectResponseText(session as never);
    collector.unsubscribe();

    session.emit(messageEnd("late"));
    session.emit(textDelta("late"));
    expect(collector.getFinalText()).toBe("");
    expect(collector.getText()).toBe("");
  });
});

describe("resolveRunResult", () => {
  const messages = [assistant("old run"), user("go"), assistant("array text")] as never;

  it("prefers streamed text over everything else", () => {
    expect(resolveRunResult("streamed", "finalized", messages, 1)).toBe("streamed");
  });

  it("falls back to finalized event text when nothing streamed", () => {
    // The provider sent no text_delta events. This is the only case where the
    // fallback runs at all.
    expect(resolveRunResult("", "finalized", messages, 1)).toBe("finalized");
  });

  it("falls back to the message array when there is no finalized text", () => {
    expect(resolveRunResult("", "", messages, 1)).toBe("array text");
  });

  it("returns finalized text when compaction shortened the array past the boundary", () => {
    // THE DEFECT upstream still has. The boundary index was taken before
    // prompt(); a threshold compaction inside prompt() replaced the array with
    // a shorter one, so the scan runs zero times. Without the event-scoped
    // text this run reports "" despite having produced a real answer.
    const compacted = [assistant("summary of earlier turns")] as never;
    expect(resolveRunResult("", "finalized", compacted, 9)).toBe("finalized");
    expect(lastAssistantTextFrom(compacted, 9)).toBe("");
  });

  it("still refuses an earlier run's text when this run produced nothing", () => {
    // The boundary guarantee is preserved: no streamed text, no finalized text,
    // and nothing at or above the boundary means an empty result, not the
    // previous run's answer.
    const priorOnly = [assistant("previous run answer"), user("go")] as never;
    expect(resolveRunResult("", "", priorOnly, 1)).toBe("");
  });

  it("treats whitespace-only sources as absent", () => {
    expect(resolveRunResult("   ", "  ", messages, 1)).toBe("array text");
    expect(resolveRunResult("   ", "finalized", messages, 1)).toBe("finalized");
  });

  it("returns empty when every source is empty", () => {
    expect(resolveRunResult("", "", [] as never, 0)).toBe("");
  });
});
