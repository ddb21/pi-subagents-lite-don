import { getStatusNote, formatStopReason } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination, nudge scheduling, and live-view tracking have moved
 * to spawn-coordinator.ts. buildAgentDetails stays here as a pure helper.
 */

import { getAgentDir, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { resolveType, getAgentConfig, resolveTypeOrDiscover, type TypeResolution } from "./agent-types.js";
import type { SessionLifecycle } from "./types.js";
import { getSessionContextPercent } from "./usage.js";
import { validateWorktreePath, isParentCwdPath } from "../spawn/worktree-validator.js";
import { resolveSubagentTrust, createSubagentTrustDeps, untrustedProjectWarning } from "../spawn/project-trust.js";

import { parseModelKey, findModelInRegistry, parseThinkingLevel, splitModelThinkingSuffix } from "../utils.js";
import { resolveModelSpec } from "../models/model-spec.js";
import type { ThinkingLevel } from "../types.js";
import { getPiInstance, getSessionCtx, getStore, getCoordinator, getManager } from "../shell.js";

// --- Tool result helpers ---

function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/**
 * Build a details record from an AgentRecord. Always includes type and
 * description; includeStatus adds status/outputFile/stopReason, includeStats
 * adds turn/token/cost/context/compaction/model fields.
 */
export function buildAgentDetails(
  record: AgentRecord,
  opts?: { includeStats?: boolean; includeStatus?: boolean },
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    type: record.display.type,
    description: record.display.description,
  };

  if (record.display.worktreePath) {
    details.worktreePath = record.display.worktreePath;
  }

  if (opts?.includeStatus) {
    details.status = record.lifecycle.status;
    details.outputFile = record.display.outputFile;
    const stopReason = formatStopReason(record.lifecycle);
    if (stopReason) details.stopReason = stopReason;
  }

  if (opts?.includeStats) {
    const elapsedMs = record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0;

    details.turnCount = record.stats.turnCount;
    details.maxTurns = record.stats.maxTurns;
    details.toolUses = record.stats.toolUses;
    details.input = record.stats.lifetimeUsage.input;
    details.output = record.stats.lifetimeUsage.output;
    details.contextPercent = getSessionContextPercent(record.execution.session);
    details.durationMs = elapsedMs;
    details.compactions = record.stats.compactionCount;
    details.modelName = record.execution.session?.model?.name ?? record.display.invocation?.modelName;
    details.modelId = record.execution.session?.model?.id ?? record.display.invocation?.modelName;
    details.thinkingLevel = record.execution.session?.thinkingLevel ?? record.display.invocation?.thinkingLevel;
    details.cost = record.stats.lifetimeUsage.cost;
  }

  return details;
}

/**
 * Result text plus status note, for display. For error status, appends the
 * recorded error message so the nudge explains the failure.
 *
 * Shared by the foreground tool result and the subagent-result nudge so both
 * callers stay in sync on the nullish default and separator handling — they
 * have diverged before. getStatusNote owns the leading separator.
 */
export function formatResultContent(record: AgentRecord): string {
  // Only the nudge path formats error-status records as text: the foreground
  // handler intercepts error status earlier and throws instead.
  const errorNote = record.lifecycle.status === "error" && record.error ? `\n\nError: ${record.error}` : "";
  return (record.result ?? "") + errorNote + getStatusNote(record.lifecycle);
}

// --- Tool execute handlers ---

/**
 * Validate worktree_path and gate cross-repo trust, surfacing warnings via
 * ctx.ui. Errors are LLM-facing and self-correctable.
 */
async function resolveWorktree(
  ctx: ExtensionContext,
  rawWorktreePath: string | undefined,
): Promise<
  { ok: true; resolvedPath?: string; worktreeLabel?: string; projectTrusted: boolean } | { ok: false; error: string }
> {
  // Empty/whitespace → omitted: nothing to validate, nothing to gate.
  if (!rawWorktreePath || rawWorktreePath.trim() === "") {
    return { ok: true, projectTrusted: true };
  }
  try {
    const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
    const warnings: string[] = [];
    const onWarning = (msg: string) => {
      warnings.push(msg);
    };
    const validation = await validateWorktreePath(getPiInstance(), rawWorktreePath, parentCwd, onWarning);
    if (!validation.ok) {
      for (const msg of warnings) {
        if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
      }
      return { ok: false, error: validation.error };
    }

    const resolvedPath = validation.resolvedPath!; // non-empty paths always resolve

    // Cross-repo targets are gated by pi's trust framework. Same-repo paths
    // are never gated; an untrusted target still spawns but with its project
    // resources ignored and a warning surfaced.
    const projectTrusted = resolveSubagentTrust({
      targetPath: resolvedPath,
      sameRepo: validation.sameRepo === true,
      deps: createSubagentTrustDeps(getAgentDir(), parentCwd),
    });
    if (!projectTrusted && ctx.ui?.notify) {
      ctx.ui.notify(`[pi-subagents-lite] ${untrustedProjectWarning(resolvedPath)}`, "warning");
    }
    return {
      ok: true,
      resolvedPath,
      worktreeLabel: validation.label,
      projectTrusted,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `worktree_path validation failed: ${msg}` };
  }
}

/**
 * Don fork: resolve the model for a spawn through the full precedence chain,
 * then through tolerant spec resolution (aliases, bare ids, "terra high",
 * "default" = inherit).
 *
 * A caller-typed spec that does not resolve is a hard error, not a silent
 * fallback to the parent model: a typo in a modelAgents/providerAgents entry or
 * a per-call override would otherwise run the wrong model. A stale config or
 * frontmatter pin must not block the spawn, but it must not be silent either,
 * so it degrades to the parent model with a note.
 */
function resolveSpawnModel(
  ctx: ExtensionContext,
  resolvedType: string,
  callerModelStr: string | undefined,
): {
  model: ReturnType<typeof findModelInRegistry>;
  modelKey: string | undefined;
  specThinking: ThinkingLevel | undefined;
  modelWarnings: string[];
  modelError?: string;
} {
  const warnings: string[] = [];
  const agentConfig = getAgentConfig(resolvedType);
  let specThinking: ThinkingLevel | undefined;

  let modelSpec = callerModelStr;
  if (!modelSpec) {
    const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const configured = getStore().spawnFor(resolvedType, parentModelId, agentConfig, undefined);
    if (configured.model && configured.model !== parentModelId) {
      modelSpec = configured.model;
      specThinking = configured.thinking;
    }
  }

  let resolvedModelStr = modelSpec;
  if (modelSpec) {
    const resolution = resolveModelSpec(modelSpec, ctx.modelRegistry, {
      aliases: getStore().modelAliases,
      providerPreference: getStore().providerPreference,
      parentProvider: ctx.model?.provider,
    });
    if (resolution.kind === "error") {
      if (callerModelStr) return { model: undefined, modelKey: undefined, specThinking, modelWarnings: warnings, modelError: resolution.message };
      warnings.push(
        `agent '${resolvedType}' pins model '${modelSpec}', which did not resolve; using the parent model. ${resolution.message}`,
      );
      specThinking = undefined;
      resolvedModelStr = undefined;
    } else {
      specThinking = resolution.thinking ?? specThinking;
      resolvedModelStr = resolution.kind === "resolved" ? resolution.key : undefined;
      // Only surface a note for a spelling the caller actually typed; a
      // frontmatter or config pin resolving is not news for the caller.
      if (resolution.note && callerModelStr) warnings.push(resolution.note);
    }
  }

  const model = findModelInRegistry(resolvedModelStr, ctx.modelRegistry, resolvedModelStr ? undefined : ctx.model);
  if (resolvedModelStr && !model) {
    return {
      model: undefined,
      modelKey: undefined,
      specThinking,
      modelWarnings: warnings,
      modelError: `Model not found in registry: ${resolvedModelStr}.`,
    };
  }
  return {
    model,
    modelKey: model ? `${model.provider}/${model.id}` : undefined,
    specThinking,
    modelWarnings: warnings,
  };
}

/**
 * Appended to every preflight validation error. pi does not surface tool
 * details to the model, so the instruction has to ride in the text or an
 * orchestrator repeats the identical failing call.
 */
const NON_RETRYABLE_VALIDATION_NOTE =
  "This validation error is non-retryable; do not repeat the same Agent call unchanged.";

/**
 * Don fork: resolve an agent's session lifecycle. `sessionLifecycle` is
 * authoritative; `persistentSession` is the legacy boolean. Anything unset
 * defaults to stateless, so persistence is always opt-in.
 */
function resolveSessionLifecycle(resolvedType: string): SessionLifecycle {
  const config = getAgentConfig(resolvedType);
  return config?.sessionLifecycle ?? (config?.persistentSession === true ? "persistent" : "stateless");
}

/** True when a param carries a value a caller actually meant to set. */
function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/** Prefix a tool result text with any spawn-time normalization notes. */
function withNotes(text: string, warnings: string[]): string {
  if (warnings.length === 0) return text;
  return `${warnings.map((warning) => `[note: ${warning}]`).join("\n")}\n\n${text}`;
}

export async function executeAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  /** Don fork: spawn-time notes surfaced to the caller alongside the result. */
  const normalizationWarnings: string[] = [];
  // Don fork: capture lineage before a queued spawn can outlive this session.
  const parentSessionFile = ctx.sessionManager?.getSessionFile?.();

  // Don fork: normalize the session_key placeholder before anything reads it.
  // Models that fill every optional field send "" here; that is not a key.
  if (params.session_key !== undefined && typeof params.session_key !== "string") {
    throw new Error(`session_key must be a string when provided. ${NON_RETRYABLE_VALIDATION_NOTE}`);
  }
  const sessionKey = (params.session_key as string | undefined)?.trim() || undefined;
  if (params.session_key !== undefined && !sessionKey) {
    normalizationWarnings.push("empty session_key ignored; spawned without a session key");
  }
  if (sessionKey) {
    // A key resumes one named session. A fork-style param asks for a copy of a
    // different session, so the two cannot both be honoured.
    const forkStyleParam = ["context", "fork", "fork_from", "parent_session", "parentSession"].find((name) =>
      hasMeaningfulValue(params[name]),
    );
    if (forkStyleParam) {
      throw new Error(`session_key cannot be used with ${forkStyleParam}. ${NON_RETRYABLE_VALIDATION_NOTE}`);
    }
  }

  // Validate worktree_path early — needed for on-demand agent discovery
  const rawWorktreePath = params.worktree_path as string | undefined;
  // Don fork: an empty or whitespace-only placeholder selects no worktree.
  let effectiveWorktreePath = rawWorktreePath?.trim() || undefined;

  if (sessionKey && effectiveWorktreePath) {
    // Don fork: a worktree_path equal to the parent working directory selects no
    // OTHER worktree. Models that fill every optional field send exactly that,
    // and a hard error here made one live session repeat the identical call 11
    // times. Ignore the no-op value and keep the session instead.
    const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
    if (isParentCwdPath(effectiveWorktreePath, parentCwd)) {
      normalizationWarnings.push(
        `worktree_path '${effectiveWorktreePath}' is the parent working directory, not a separate git worktree; ` +
          `ignored so session_key '${sessionKey}' applies. Omit worktree_path unless you target a different worktree.`,
      );
      effectiveWorktreePath = undefined;
    } else {
      // A genuinely different worktree cannot host a session keyed to this one.
      // Name the failed value, the parent cwd, and the exact retry, so the
      // caller can tell which of the two arguments to drop.
      throw new Error(
        `session_key cannot be used with a non-empty worktree_path for persistent agents; ` +
          `omit one of these fields. worktree_path was '${effectiveWorktreePath}', which is not the parent ` +
          `working directory '${parentCwd}'. To reuse session_key '${sessionKey}', resend the same call with ` +
          `worktree_path omitted. ${NON_RETRYABLE_VALIDATION_NOTE}`,
      );
    }
  }

  const resolved = await resolveWorktree(ctx, effectiveWorktreePath);
  if (!resolved.ok) throw new Error(resolved.error);
  const validatedWorktreePath = resolved.resolvedPath;
  const worktreeLabel = resolved.worktreeLabel;
  const projectTrusted = resolved.projectTrusted;

  const type = (params.agent as string) || "general-purpose";
  // When worktree_path is set, also scan the target's .pi/agents/ directory, unless
  // the target is an untrusted cross-repo project (its agent types stay hidden).
  const targetAgentsDir = projectTrusted && validatedWorktreePath ? `${validatedWorktreePath}/.pi/agents` : undefined;
  const resolution = await resolveTypeOrDiscover(type, targetAgentsDir);
  if (resolution.kind === "ambiguous") {
    // Two or more registered types differ only by case — never a silent pick.
    throw new Error(
      `Ambiguous agent type: ${type}. Candidates: ${resolution.candidates.join(", ")}. Use the exact registered name.`,
    );
  }
  if (resolution.kind === "not-found") {
    throw new Error(`Unknown agent type: ${type}`);
  }
  const resolvedType = resolution.key;

  // Don fork: only a "persistent" agent may be addressed by a named key. A key
  // sent to a stateless agent is dropped with a note rather than thrown,
  // because the caller cannot see agent frontmatter and an error here just
  // loses the work: an orchestrator whose routing config names a key would
  // resend the identical call. The note tells it the key had no effect.
  const lifecycle = resolveSessionLifecycle(resolvedType);
  const effectiveSessionKey = sessionKey && lifecycle === "persistent" ? sessionKey : undefined;
  if (sessionKey && !effectiveSessionKey) {
    normalizationWarnings.push(
      `session_key '${sessionKey}' ignored: agent '${resolvedType}' is stateless, so this call is one-shot. ` +
        `Omit session_key, or set session_lifecycle: persistent in that agent's frontmatter.`,
    );
  }

  const prompt = params.prompt as string;
  const description =
    (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  const maxTurns =
    (params.max_turns as number | undefined) ??
    getAgentConfig(resolvedType)?.maxTurns ??
    getStore().agent.defaultMaxTurns;

  const modelStr = params.model as string | undefined;
  // Don fork: resolve the full precedence chain here rather than trusting the
  // tool_call listener. The listener does not fire in one-shot (`pi -p`) runs,
  // which is exactly how two-context delegations spawn children, so a pinned
  // heavy agent (lmd-science, analyst) silently inherited the orchestrator's
  // cheap model. execute() is the authoritative resolver; the listener only
  // canonicalizes what the caller typed for display.
  const { model, modelKey, specThinking, modelWarnings, modelError } = resolveSpawnModel(
    ctx,
    resolvedType,
    modelStr,
  );
  if (modelError) throw new Error(modelError);
  normalizationWarnings.push(...modelWarnings);

  // Determine modelName for invocation (always capture for display)
  const modelName = model?.id;

  // Resolve thinking: explicit param > settings that traveled with the resolved
  // model > agent config (frontmatter) > spawn options default > inherit
  const thinkingLevel =
    parseThinkingLevel(params.thinking as string | undefined) ??
    specThinking ??
    getAgentConfig(resolvedType)?.thinkingLevel ??
    getStore().agent.defaultThinking;

  const coordinator = getCoordinator()!;
  // Background spawns (explicit or forceBackground) never bind to the parent
  // run's interrupt signal — only foreground spawns can be interrupted.
  const isBackground = runInBackground || getStore().agent.forceBackground;

  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    prompt,
    description,
    model,
    modelKey,
    maxTurns,
    thinkingLevel,
    graceTurns: getStore().agent.graceTurns,
    worktreePath: validatedWorktreePath,
    worktreeLabel,
    projectTrusted,
    parentSessionFile,
    // Don fork: scope a keyed session by normalized parent cwd, canonical type,
    // and caller key, so the same key under two projects stays two sessions.
    ...(effectiveSessionKey
      ? {
          sessionKey: effectiveSessionKey,
          sessionKeyCwd: getSessionCtx()?.cwd ?? ctx.cwd,
          sessionKeyAgentType: resolvedType,
        }
      : {}),
    invocation: { modelName, thinkingLevel, maxTurns },
    runInBackground: isBackground,
    signal: isBackground ? undefined : signal,
  });

  const { agentId, record } = result;

  // Store toolCallId in record for call renderer to find agent
  if (_toolCallId) {
    record.display.toolCallId = _toolCallId;
  }

  if (isBackground) {
    const suffix = `Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!\n\nAgent ID: ${agentId}`;
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    const details = buildAgentDetails(record);
    details.agentId = agentId;
    details.status = record.lifecycle.status;
    return successResult(withNotes(`[${label}] ${suffix}`, normalizationWarnings), details);
  }

  // Foreground: record.execution.promise is already awaited by coordinator.spawn()
  const details = buildAgentDetails(record, { includeStats: true });

  if (record.lifecycle.status === "error") {
    throw new Error(`Agent failed: ${record.error || "unknown error"}`);
  }

  return successResult(withNotes(formatResultContent(record), normalizationWarnings), details);
}

// --- Running agents list helper (used by executeStopAgentTool) ---

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(): string {
  const agents = getManager()!
    .listAgents()
    .filter((a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued");

  if (agents.length === 0) return "none";

  return agents.map((a) => `${a.id.slice(0, SHORT_ID_LENGTH)} (${a.display.type})`).join(", ");
}

// --- StopAgent execute handler ---

export async function executeStopAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const agentId = params.agent_id as string | undefined;

  if (!agentId) {
    throw new Error("agent_id is required");
  }

  const record = getManager()!.getRecord(agentId);

  if (!record) {
    throw new Error(`Agent ${agentId} not found. Running agents: ${formatRunningAgents()}`);
  }

  if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
    return successResult(
      `Agent ${agentId} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents()}`,
    );
  }

  if (getManager()!.abort(agentId, "agent")) {
    return successResult(`Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`);
  }

  throw new Error(`Failed to stop agent ${agentId}`);
}

// --- Tool_call listener — inject model into Agent tool calls ---

export async function toolCallListener(event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
  if (event.toolName !== "Agent") return;

  const input = event.input;
  // Don fork: resolve the caller's spelling to the canonical type before any
  // keyed lookup. Session, config, modelAgents, and providerAgents keys are
  // canonical, so "Executor" or a display name would silently miss its
  // per-type entries otherwise.
  const requestedType = typeof input.agent === "string" && input.agent ? input.agent : "general-purpose";
  const typeResolution = resolveType(requestedType);
  const subagentType = typeResolution.kind === "resolved" ? typeResolution.key : requestedType;
  const agentConfig = getAgentConfig(subagentType);

  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

  // Don fork: feed the per-call model param into resolution instead of
  // clobbering it — it wins over the routing maps and frontmatter (targeted
  // overrides like a Luna trial) while still losing to session/config pins.
  const explicitModel = typeof input.model === "string" && input.model ? input.model : undefined;
  const spawn = getStore().spawnFor(subagentType, parentModelId, agentConfig, explicitModel);

  const modelWithSuffix = spawn.model ? splitModelThinkingSuffix(spawn.model) : undefined;
  // Don fork: canonicalize the resolved spelling before execute() validates it.
  // A tolerated spelling (alias, bare id, "terra high") becomes the registry
  // key here; "default" clears the override so the parent model is inherited;
  // an unresolvable spelling is left untouched so execute() reports the
  // actionable error exactly once.
  const specResolution = modelWithSuffix?.model
    ? resolveModelSpec(modelWithSuffix.model, ctx.modelRegistry, {
        aliases: getStore().modelAliases,
        providerPreference: getStore().providerPreference,
        parentProvider: ctx.model?.provider,
      })
    : undefined;
  if (specResolution?.kind === "resolved") {
    input.model = specResolution.key;
    input._modelOverride = specResolution.id;
  } else if (specResolution?.kind === "inherit") {
    delete input.model;
    delete input._modelOverride;
  } else if (modelWithSuffix?.model) {
    input.model = modelWithSuffix.model;
    // Always inject _modelOverride for renderCall
    const parsed = parseModelKey(modelWithSuffix.model);
    if (parsed) {
      input._modelOverride = parsed.modelId;
    }
  }

  // Inject thinking if not explicitly passed: settings that traveled with the
  // resolved model (routing-map entry), a pi CLI-style model suffix, the
  // resolved spec's own suffix, then agent frontmatter, then the spawn default.
  if (input.thinking === undefined) {
    input.thinking =
      spawn.thinking ??
      modelWithSuffix?.thinking ??
      (specResolution?.kind !== "error" ? specResolution?.thinking : undefined) ??
      agentConfig?.thinkingLevel ??
      getStore().agent.defaultThinking;
  }
}
