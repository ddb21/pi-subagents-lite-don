import { describe, expect, it } from "vitest";
import { agentLogHint, agentLogUrl, osc8, type LinkEnv } from "../../src/ui/log-link.js";

const WORKSPACE = "FA7BE949-0171-42B5-BD89-04E07946F722";
const LOG = "/tmp/pi-agent-outputs/f4d9bca1-f924-448.log";
const inCmux: LinkEnv = { CMUX_WORKSPACE_ID: WORKSPACE };

describe("agentLogUrl", () => {
  it("builds a strict tail URL with the origin workspace", () => {
    expect(agentLogUrl(LOG, WORKSPACE)).toBe(
      `piagents://tail?file=%2Ftmp%2Fpi-agent-outputs%2Ff4d9bca1-f924-448.log&workspace=${WORKSPACE}`,
    );
  });

  it("accepts the /private/tmp spelling of the log directory", () => {
    expect(agentLogUrl(`/private${LOG}`, WORKSPACE)).toContain("%2Fprivate%2Ftmp%2Fpi-agent-outputs%2F");
  });

  it("carries exactly the file and workspace parameters once", () => {
    const url = agentLogUrl(LOG, WORKSPACE) as string;
    expect(url.match(/file=/g)).toHaveLength(1);
    expect(url.match(/workspace=/g)).toHaveLength(1);
    expect(url.split("?")[1].split("&")).toHaveLength(2);
  });

  it("refuses logs outside the agent log directory", () => {
    expect(agentLogUrl("/etc/passwd", WORKSPACE)).toBeUndefined();
    expect(agentLogUrl("/tmp/pi-agent-outputs/../evil.log", WORKSPACE)).toBeUndefined();
    expect(agentLogUrl("/tmp/pi-agent-outputs/nested/dir.log", WORKSPACE)).toBeUndefined();
    expect(agentLogUrl("/tmp/pi-agent-outputsevil/x.log", WORKSPACE)).toBeUndefined();
  });

  it("refuses non-log names, control bytes, and backslashes", () => {
    expect(agentLogUrl("/tmp/pi-agent-outputs/notes.txt", WORKSPACE)).toBeUndefined();
    expect(agentLogUrl("/tmp/pi-agent-outputs/a b.log", WORKSPACE)).toBeUndefined();
    expect(agentLogUrl("/tmp/pi-agent-outputs/a\nwhoami.log", WORKSPACE)).toBeUndefined();
    expect(agentLogUrl("/tmp/pi-agent-outputs/a\\b.log", WORKSPACE)).toBeUndefined();
  });

  it("refuses a workspace value that is not a UUID", () => {
    expect(agentLogUrl(LOG, "workspace:3")).toBeUndefined();
    expect(agentLogUrl(LOG, "")).toBeUndefined();
    expect(agentLogUrl(LOG, `${WORKSPACE} extra`)).toBeUndefined();
  });
});

describe("osc8", () => {
  it("opens and closes the hyperlink on one line", () => {
    const link = osc8("piagents://tail?file=x&workspace=y", "tail -f x");
    expect(link).toBe("\x1b]8;;piagents://tail?file=x&workspace=y\x1b\\tail -f x\x1b]8;;\x1b\\");
    expect(link.split("\n")).toHaveLength(1);
    expect(link.endsWith("\x1b]8;;\x1b\\")).toBe(true);
  });
});

describe("agentLogHint", () => {
  it("returns a hyperlink whose visible text is still the tail command", () => {
    const hint = agentLogHint(LOG, inCmux) as string;
    expect(hint).toContain(`piagents://tail?file=%2Ftmp%2Fpi-agent-outputs%2F`);
    expect(hint).toContain(`&workspace=${WORKSPACE}`);
    // eslint-disable-next-line no-control-regex
    expect(hint.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")).toBe(`tail -f ${LOG}`);
  });

  it("falls back to plain text outside a cmux workspace", () => {
    expect(agentLogHint(LOG, {})).toBe(`tail -f ${LOG}`);
    expect(agentLogHint(LOG, { CMUX_WORKSPACE_ID: "   " })).toBe(`tail -f ${LOG}`);
  });

  it("falls back to plain text for a path that must not be linked", () => {
    expect(agentLogHint("/etc/passwd", inCmux)).toBe("tail -f /etc/passwd");
    expect(agentLogHint("/tmp/pi-agent-outputs/a b.log", inCmux)).toBe(
      "tail -f /tmp/pi-agent-outputs/a b.log",
    );
  });

  it("returns undefined when the agent has no output file", () => {
    expect(agentLogHint(undefined, inCmux)).toBeUndefined();
    expect(agentLogHint("", inCmux)).toBeUndefined();
  });
});
