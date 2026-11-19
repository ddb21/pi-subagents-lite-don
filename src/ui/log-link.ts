/** Safe Pi Agents links for the local Herdr URL handler. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_LOG_DIRS = ["/tmp/pi-agent-outputs/", "/private/tmp/pi-agent-outputs/"];
const LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.log$/;
const SPACE_ID = /^sp[0-9a-f]+$/;
// Strict allowlist that matches the opener and the hc pi.agent label values.
const RESUME_AGENTS = new Set(["pi", "pilite", "pi-bolt"]);
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH = /[\x00-\x1f\x7f\\%]/;
const OSC8_OPEN = "\x1b]8;;";
const OSC8_CLOSE = "\x1b]8;;\x1b\\";
const ST = "\x1b\\";

export interface LinkEnv {
  HC_TERMINAL_ID?: string;
}

interface CallerLabels {
  space?: string;
  agent?: string;
}

let cachedTerminal: string | undefined;
let cachedLabels: CallerLabels = {};

/** Read the caller's hc labels once, not on every widget render. */
function callerLabels(env: LinkEnv): CallerLabels {
  const terminal = env.HC_TERMINAL_ID?.trim();
  if (!terminal) return {};
  if (terminal === cachedTerminal) return cachedLabels;
  cachedTerminal = terminal;
  cachedLabels = {};
  try {
    const result: unknown = JSON.parse(
      execFileSync(join(homedir(), ".local/bin/hc"), ["get", terminal], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (!result || typeof result !== "object" || !("labels" in result)) return cachedLabels;
    const labels = result.labels;
    if (!labels || typeof labels !== "object") return cachedLabels;
    const space = "herdr.space" in labels ? labels["herdr.space"] : undefined;
    const agent = "pi.agent" in labels ? labels["pi.agent"] : undefined;
    if (typeof space === "string" && SPACE_ID.test(space)) cachedLabels.space = space;
    if (typeof agent === "string" && RESUME_AGENTS.has(agent)) cachedLabels.agent = agent;
  } catch {
    // Missing core, missing terminal, and malformed replies leave plain log text.
  }
  return cachedLabels;
}

/** Resolve the caller's space once, not on every widget render. */
export function herdrSpace(env: LinkEnv = process.env as LinkEnv): string | undefined {
  return callerLabels(env).space;
}

/** Resolve the caller's Pi variant (pi, pilite, or pi-bolt) from its pi.agent label. */
export function herdrAgent(env: LinkEnv = process.env as LinkEnv): string | undefined {
  return callerLabels(env).agent;
}

/** Require the app installed by install-piagents-handler.sh, not synced sources alone. */
function localHandlerInstalled(): boolean {
  return (
    existsSync(join(homedir(), "Applications/PiAgentsOpen.app/Contents/Info.plist")) &&
    existsSync(join(homedir(), "puppy_workspace/scripts/pi-agents-open.py"))
  );
}

/** Logs need an explicit local space; never guess the active space. */
export function agentLogUrl(outputFile: string, workspaceId: string): string | undefined {
  if (!localHandlerInstalled()) return undefined;
  if (!SPACE_ID.test(workspaceId)) return undefined;
  if (outputFile !== outputFile.trim() || UNSAFE_PATH.test(outputFile)) return undefined;
  const dir = AGENT_LOG_DIRS.find((candidate) => outputFile.startsWith(candidate));
  if (!dir || !LOG_NAME.test(outputFile.slice(dir.length))) return undefined;
  return `piagents://tail?file=${encodeURIComponent(outputFile)}&workspace=${encodeURIComponent(workspaceId)}`;
}

/** Session links can omit the space: the handler focuses or creates a space.
 * The optional agent selects the resume binary; the handler defaults to pi. */
export function agentSessionUrl(sessionFile: string, workspaceId?: string, agent?: string): string | undefined {
  if (!localHandlerInstalled()) return undefined;
  if (!sessionFile.startsWith("/") || !sessionFile.endsWith(".jsonl")) return undefined;
  if (UNSAFE_PATH.test(sessionFile) || sessionFile !== sessionFile.trim()) return undefined;
  if (sessionFile.includes("//") || sessionFile.split("/").some((part) => part === "." || part === ".."))
    return undefined;
  if (workspaceId !== undefined && !SPACE_ID.test(workspaceId)) return undefined;
  if (agent !== undefined && !RESUME_AGENTS.has(agent)) return undefined;
  const target = workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : "";
  const variant = agent ? `&agent=${encodeURIComponent(agent)}` : "";
  return `piagents://session?file=${encodeURIComponent(sessionFile)}${target}${variant}`;
}

/** Close every OSC 8 link on the same line. */
export function osc8(url: string, label: string): string {
  return `${OSC8_OPEN}${url}${ST}${label}${OSC8_CLOSE}`;
}

/** Keep log hints plain when no explicit Herdr space exists. */
export function agentLogHint(
  outputFile: string | undefined,
  env: LinkEnv = process.env as LinkEnv,
): string | undefined {
  if (!outputFile) return undefined;
  if (!localHandlerInstalled()) return outputFile;
  const label = `tail -f ${outputFile}`;
  const workspace = herdrSpace(env);
  const url = workspace ? agentLogUrl(outputFile, workspace) : undefined;
  return url ? osc8(url, label) : label;
}

/** Use the agent's session file, not the parent terminal's session label. */
export function agentSessionHint(
  sessionFile: string | undefined,
  env: LinkEnv = process.env as LinkEnv,
): string | undefined {
  if (!sessionFile) return undefined;
  if (!localHandlerInstalled()) return sessionFile;
  const label = `pi --session ${sessionFile}`;
  const url = agentSessionUrl(sessionFile, herdrSpace(env), herdrAgent(env));
  return url ? osc8(url, label) : label;
}
