import { describe, expect, it } from "vitest";
import { __test__ } from "./agent-runner.js";

const { lastAssistantTextFrom } = __test__;

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
