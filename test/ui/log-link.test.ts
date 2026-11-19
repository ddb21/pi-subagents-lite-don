import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  agentLogHint,
  agentLogUrl,
  agentSessionHint,
  agentSessionUrl,
  herdrAgent,
  herdrSpace,
  osc8,
} from "../../src/ui/log-link.js";

const SPACE = "sp123abc";
const LOG = "/tmp/pi-agent-outputs/f4d9bca1-f924-448.log";
const SESSION = "/Users/don/.pi-shared/sessions/agent.jsonl";
const get = vi.mocked(execFileSync);
const exists = vi.mocked(existsSync);
let terminalNumber = 0;
const env = () => ({ HC_TERMINAL_ID: `t-test-${++terminalNumber}` });

beforeEach(() => {
  exists.mockReset();
  exists.mockReturnValue(true);
  get.mockReset();
  get.mockReturnValue(JSON.stringify({ labels: { "herdr.space": SPACE } }));
});

describe("local handler availability", () => {
  it("emits log and session links when the installed app and opener exist", () => {
    expect(agentLogHint(LOG, env())).toContain("piagents://tail?");
    expect(agentSessionHint(SESSION, env())).toContain("piagents://session?");
    expect(exists).toHaveBeenCalledWith(expect.stringContaining("/Applications/PiAgentsOpen.app/Contents/Info.plist"));
    expect(exists).toHaveBeenCalledWith(expect.stringContaining("/puppy_workspace/scripts/pi-agents-open.py"));
  });

  it.each(["/Applications/PiAgentsOpen.app/Contents/Info.plist", "/puppy_workspace/scripts/pi-agents-open.py"])(
    "keeps paths plain when %s is absent, without querying the core",
    (missing) => {
      exists.mockImplementation((path) => !String(path).endsWith(missing));
      expect(agentLogHint(LOG, env())).toBe(LOG);
      expect(agentSessionHint(SESSION, env())).toBe(SESSION);
      expect(agentLogUrl(LOG, SPACE)).toBeUndefined();
      expect(agentSessionUrl(SESSION, SPACE)).toBeUndefined();
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("does not emit links when only the repository sources are present", () => {
    exists.mockImplementation((path) => String(path).includes("/puppy_workspace/"));
    expect(agentLogHint(LOG, env())).toBe(LOG);
    expect(agentSessionHint(SESSION, env())).toBe(SESSION);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("herdrSpace", () => {
  it("reads the caller's label with explicit hc arguments and caches it", () => {
    const caller = env();
    expect(herdrSpace(caller)).toBe(SPACE);
    expect(herdrSpace(caller)).toBe(SPACE);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining("/.local/bin/hc"),
      ["get", caller.HC_TERMINAL_ID],
      expect.objectContaining({ timeout: 1000 }),
    );
  });

  it("does not call the core outside Herdr", () => {
    expect(herdrSpace({})).toBeUndefined();
    expect(herdrSpace({ HC_TERMINAL_ID: "  " })).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("handles missing, malformed, or invalid labels", () => {
    for (const reply of [
      "not json",
      "null",
      "{}",
      '{"labels":null}',
      '{"labels":{"herdr.space":12}}',
      '{"labels":{"herdr.space":"not-a-space"}}',
    ]) {
      get.mockReturnValue(reply);
      expect(herdrSpace(env())).toBeUndefined();
    }
  });

  it("handles a missing core without breaking the widget", () => {
    get.mockImplementation(() => {
      throw new Error("missing hc");
    });
    expect(agentLogHint(LOG, env())).toBe(`tail -f ${LOG}`);
    expect(agentSessionHint(SESSION, env())).toContain("piagents://session?file=");
  });
});

describe("agentLogUrl", () => {
  it("builds the exact tail URL for a Herdr space", () => {
    expect(agentLogUrl(LOG, SPACE)).toBe(
      `piagents://tail?file=%2Ftmp%2Fpi-agent-outputs%2Ff4d9bca1-f924-448.log&workspace=${SPACE}`,
    );
    expect(agentLogUrl(`/private${LOG}`, SPACE)).toContain("%2Fprivate%2Ftmp%2Fpi-agent-outputs%2F");
  });

  it("refuses paths outside the log root and unsafe names", () => {
    for (const file of [
      "/etc/passwd",
      "/tmp/pi-agent-outputs/../evil.log",
      "/tmp/pi-agent-outputs/nested/dir.log",
      "/tmp/pi-agent-outputsevil/x.log",
      "/tmp/pi-agent-outputs/notes.txt",
      "/tmp/pi-agent-outputs/a b.log",
      "/tmp/pi-agent-outputs/a\nwhoami.log",
      "/tmp/pi-agent-outputs/a\\b.log",
    ]) {
      expect(agentLogUrl(file, SPACE)).toBeUndefined();
    }
  });

  it("requires a Herdr space rather than an old workspace id", () => {
    for (const space of ["", "workspace:3", "FA7BE949-0171-42B5-BD89-04E07946F722", `${SPACE} extra`]) {
      expect(agentLogUrl(LOG, space)).toBeUndefined();
    }
  });
});

describe("session links", () => {
  it("emits a session URL without a space", () => {
    expect(agentSessionUrl(SESSION)).toBe(`piagents://session?file=${encodeURIComponent(SESSION)}`);
    expect(agentSessionHint(SESSION, {})).toContain(`piagents://session?file=${encodeURIComponent(SESSION)}`);
    expect(get).not.toHaveBeenCalled();
  });

  it("adds only the explicit Herdr space when available", () => {
    expect(agentSessionUrl(SESSION, SPACE)).toBe(
      `piagents://session?file=${encodeURIComponent(SESSION)}&workspace=${SPACE}`,
    );
    expect(agentSessionHint(SESSION, env())).toContain(`&workspace=${SPACE}`);
  });

  it("refuses unsafe session paths and invalid spaces", () => {
    for (const file of [
      "relative.jsonl",
      "/tmp/a.log",
      "/tmp/../a.jsonl",
      "/tmp/./a.jsonl",
      "/tmp//a.jsonl",
      "/tmp/a%20.jsonl",
      "/tmp/a\n.jsonl",
      "/tmp/a\\b.jsonl",
    ]) {
      expect(agentSessionUrl(file)).toBeUndefined();
    }
    expect(agentSessionUrl(SESSION, "bad-space")).toBeUndefined();
  });

  it("adds an allowlisted agent and refuses other agent values", () => {
    for (const agent of ["pi", "pilite", "pi-bolt"]) {
      expect(agentSessionUrl(SESSION, SPACE, agent)).toBe(
        `piagents://session?file=${encodeURIComponent(SESSION)}&workspace=${SPACE}&agent=${agent}`,
      );
      expect(agentSessionUrl(SESSION, undefined, agent)).toBe(
        `piagents://session?file=${encodeURIComponent(SESSION)}&agent=${agent}`,
      );
    }
    for (const agent of ["", "bash", "PI", "pi-lite", "pi&cmd=x"]) {
      expect(agentSessionUrl(SESSION, SPACE, agent)).toBeUndefined();
    }
  });

  it("takes the agent from the caller's pi.agent label", () => {
    get.mockReturnValue(JSON.stringify({ labels: { "herdr.space": SPACE, "pi.agent": "pilite" } }));
    const caller = env();
    expect(herdrAgent(caller)).toBe("pilite");
    const hint = agentSessionHint(SESSION, caller) as string;
    expect(hint).toContain(`&workspace=${SPACE}&agent=pilite`);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("omits the agent when the label is absent or not allowlisted", () => {
    for (const labels of [
      { "herdr.space": SPACE },
      { "herdr.space": SPACE, "pi.agent": "" },
      { "herdr.space": SPACE, "pi.agent": "bash" },
      { "herdr.space": SPACE, "pi.agent": 7 },
    ]) {
      get.mockReturnValue(JSON.stringify({ labels }));
      const caller = env();
      expect(herdrAgent(caller)).toBeUndefined();
      expect(agentSessionHint(SESSION, caller)).not.toContain("&agent=");
      expect(agentSessionHint(SESSION, caller)).toContain(`&workspace=${SPACE}`);
    }
  });

  it("keeps the agent when the space label is missing", () => {
    get.mockReturnValue(JSON.stringify({ labels: { "pi.agent": "pi-bolt" } }));
    const caller = env();
    expect(herdrSpace(caller)).toBeUndefined();
    expect(agentSessionHint(SESSION, caller)).toContain(
      `piagents://session?file=${encodeURIComponent(SESSION)}&agent=pi-bolt`,
    );
  });

  it("omits absent session hints", () => {
    expect(agentSessionHint(undefined, {})).toBeUndefined();
    expect(agentSessionHint("", {})).toBeUndefined();
  });
});

describe("agentLogHint and osc8", () => {
  it("keeps the tail command as its visible label", () => {
    const hint = agentLogHint(LOG, env()) as string;
    expect(hint).toContain(`&workspace=${SPACE}`);
    // eslint-disable-next-line no-control-regex
    expect(hint.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")).toBe(`tail -f ${LOG}`);
  });

  it("keeps plain text without a space or with an invalid path", () => {
    expect(agentLogHint(LOG, {})).toBe(`tail -f ${LOG}`);
    expect(agentLogHint("/etc/passwd", env())).toBe("tail -f /etc/passwd");
  });

  it("omits absent log hints", () => {
    expect(agentLogHint(undefined, {})).toBeUndefined();
    expect(agentLogHint("", {})).toBeUndefined();
  });

  it("opens and closes the hyperlink on one line", () => {
    expect(osc8("piagents://session?file=x", "resume x")).toBe(
      "\x1b]8;;piagents://session?file=x\x1b\\resume x\x1b]8;;\x1b\\",
    );
  });
});
