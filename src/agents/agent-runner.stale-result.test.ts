import { describe, expect, it } from "vitest";
import { __test__ } from "./agent-runner.js";

const { lastAssistantTextFrom, collectResponseText, resolveRunResult } = __test__;

/** Minimal session double: only `subscribe` is used by the collector. */
function fakeSession() {
  const listeners: ((event: unknown) => void)[] = [];
  return {
    session: {
      subscribe(fn: (event: unknown) => void) {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
    emit(event: unknown) {
      for (const fn of [...listeners]) fn(event);
    },
    listenerCount: () => listeners.length,
  };
}

const delta = (text: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: text },
});
const end = (text: string) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

/**
 * Regression cover for the persistent-session stale-result defect.
 *
 * A resumed `session_key` run that produced no new text used to return the
 * PREVIOUS run's assistant message as its result. A StopAgent call then
 * reported stale work as if it were current. The boundary index fixes it.
 */
describe("stale-result boundary", () => {
  const previous = { role: "assistant", content: [{ type: "text", text: "previous run result" }] };
  const resumePrompt = { role: "user", content: [{ type: "text", text: "resume task" }] };

  it("returns nothing when a resumed run produced no assistant text", () => {
    const messages = [previous, resumePrompt] as never[];
    // Boundary sits at the end: this run added no assistant message.
    expect(lastAssistantTextFrom(messages, messages.length)).toBe("");
  });

  it("ignores an earlier run's text even when this run added only a user message", () => {
    const messages = [previous] as never[];
    const boundary = messages.length;
    (messages as unknown[]).push(resumePrompt);
    expect(lastAssistantTextFrom(messages, boundary)).toBe("");
  });

  it("returns text this run produced", () => {
    const messages = [
      previous,
      resumePrompt,
      { role: "assistant", content: [{ type: "text", text: "current run result" }] },
    ] as never[];
    expect(lastAssistantTextFrom(messages, 1)).toBe("current run result");
  });

  it("returns the latest assistant text when this run produced several", () => {
    const messages = [
      previous,
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ] as never[];
    expect(lastAssistantTextFrom(messages, 1)).toBe("second");
  });

  it("skips empty assistant text and keeps scanning within this run", () => {
    const messages = [
      previous,
      { role: "assistant", content: [{ type: "text", text: "kept" }] },
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ] as never[];
    expect(lastAssistantTextFrom(messages, 1)).toBe("kept");
  });

  it("scans the whole history when the boundary is zero", () => {
    const messages = [previous] as never[];
    expect(lastAssistantTextFrom(messages, 0)).toBe("previous run result");
  });

  it("returns nothing for an empty history", () => {
    expect(lastAssistantTextFrom([] as never[], 0)).toBe("");
  });
});

/**
 * The collector must record finalized assistant text from this run, because a
 * compaction can replace `session.messages` with a shorter array while the run
 * is still in flight. The boundary index then points past the end.
 */
describe("collectResponseText final text", () => {
  it("records finalized assistant text when the provider sends no deltas", () => {
    const fake = fakeSession();
    const collector = collectResponseText(fake.session as never);
    fake.emit(end("finalized answer"));
    expect(collector.getText()).toBe("");
    expect(collector.getFinalText()).toBe("finalized answer");
  });

  it("keeps the latest finalized text across several assistant messages", () => {
    const fake = fakeSession();
    const collector = collectResponseText(fake.session as never);
    fake.emit(end("first"));
    fake.emit(end("second"));
    expect(collector.getFinalText()).toBe("second");
  });

  it("ignores a finalized message that carries no text", () => {
    const fake = fakeSession();
    const collector = collectResponseText(fake.session as never);
    fake.emit(end("kept"));
    fake.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    fake.emit(end("   "));
    expect(collector.getFinalText()).toBe("kept");
  });

  it("ignores a finalized user message", () => {
    const fake = fakeSession();
    const collector = collectResponseText(fake.session as never);
    fake.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "prompt" }] },
    });
    expect(collector.getFinalText()).toBe("");
  });

  it("resets streamed text at message_start but keeps finalized text", () => {
    const fake = fakeSession();
    const collector = collectResponseText(fake.session as never);
    fake.emit(delta("partial"));
    fake.emit(end("partial"));
    fake.emit({ type: "message_start" });
    expect(collector.getText()).toBe("");
    expect(collector.getFinalText()).toBe("partial");
  });

  it("stops recording after unsubscribe", () => {
    const fake = fakeSession();
    const collector = collectResponseText(fake.session as never);
    collector.unsubscribe();
    expect(fake.listenerCount()).toBe(0);
    fake.emit(end("after unsubscribe"));
    expect(collector.getFinalText()).toBe("");
  });
});

/** Pins the priority order the turn loop uses, so a call-site change fails. */
describe("resolveRunResult priority", () => {
  const history = [
    { role: "assistant", content: [{ type: "text", text: "previous run result" }] },
  ] as never[];

  it("prefers streamed text", () => {
    expect(resolveRunResult(" streamed ", "finalized", history, 1)).toBe("streamed");
  });

  it("uses finalized text when no deltas arrived", () => {
    expect(resolveRunResult("", " finalized ", history, 1)).toBe("finalized");
  });

  it("returns this run's text after a compaction shortened the history", () => {
    // Boundary was recorded at 40 messages; compaction cut history to 1.
    expect(resolveRunResult("", "current run result", history, 40)).toBe("current run result");
  });

  it("never returns an earlier run's text when this run produced nothing", () => {
    expect(resolveRunResult("", "", history, 1)).toBe("");
    expect(resolveRunResult("", "", history, 40)).toBe("");
  });

  it("falls back to the message array when no events fired", () => {
    const messages = [
      ...history,
      { role: "assistant", content: [{ type: "text", text: "array only" }] },
    ] as never[];
    expect(resolveRunResult("", "", messages, 1)).toBe("array only");
  });
});
