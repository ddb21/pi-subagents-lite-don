/**
 * log-link.ts — clickable `tail -f` hint for agent output logs.
 *
 * Inside a cmux workspace the hint is an OSC 8 hyperlink to
 * `piagents://tail?file=<log>&workspace=<origin workspace UUID>`. The local
 * handler app validates that URL and opens a cmux split in the *origin*
 * workspace, so a click follows the log where the session lives. Outside cmux,
 * or for any path that is not a canonical agent log, the hint stays plain text.
 *
 * The URL carries data only. No command, no model call, and no network call.
 */

/** Directories that hold agent output logs. Both spellings of /tmp are valid. */
const AGENT_LOG_DIRS = ["/tmp/pi-agent-outputs/", "/private/tmp/pi-agent-outputs/"];

/** Log file names accepted in a link: one flat, plain `.log` name. */
const LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.log$/;

/** cmux workspace UUID, as published in CMUX_WORKSPACE_ID. */
const WORKSPACE_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const OSC8_OPEN = "\x1b]8;;";
const OSC8_CLOSE = "\x1b]8;;\x1b\\";
const ST = "\x1b\\";

/** Minimal environment shape, so tests do not mutate process.env. */
export interface LinkEnv {
  CMUX_WORKSPACE_ID?: string;
}

/** Return the piagents URL for one log, or undefined when it is not linkable. */
export function agentLogUrl(outputFile: string, workspaceId: string): string | undefined {
  const workspace = workspaceId.trim();
  if (!WORKSPACE_UUID.test(workspace)) return undefined;
  // eslint-disable-next-line no-control-regex
  if (outputFile !== outputFile.trim() || /[\x00-\x1f\x7f\\]/.test(outputFile)) return undefined;
  const dir = AGENT_LOG_DIRS.find((candidate) => outputFile.startsWith(candidate));
  if (!dir) return undefined;
  const name = outputFile.slice(dir.length);
  if (!LOG_NAME.test(name)) return undefined;
  return `piagents://tail?file=${encodeURIComponent(outputFile)}&workspace=${encodeURIComponent(workspace)}`;
}

/** Wrap one label in an OSC 8 hyperlink. The link is closed on the same line. */
export function osc8(url: string, label: string): string {
  return `${OSC8_OPEN}${url}${ST}${label}${OSC8_CLOSE}`;
}

/**
 * Return the `tail -f` hint for an agent log: a hyperlink inside cmux, plain
 * text elsewhere, and undefined when the agent has no output file.
 */
export function agentLogHint(
  outputFile: string | undefined,
  env: LinkEnv = process.env as LinkEnv,
): string | undefined {
  if (!outputFile) return undefined;
  const label = `tail -f ${outputFile}`;
  const workspace = env.CMUX_WORKSPACE_ID?.trim();
  if (!workspace) return label;
  const url = agentLogUrl(outputFile, workspace);
  return url ? osc8(url, label) : label;
}
