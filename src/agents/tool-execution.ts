import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination, nudge scheduling, and live-view tracking have moved
 * to spawn-coordinator.ts. buildAgentDetails stays here as a pure helper.
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord, ThinkingLevel } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import type { AgentConfig, SessionLifecycle } from "./types.js";
import { resolveType, getAgentConfig, discoverNewAgents } from "./agent-types.js";
import { getLifetimeTotal, getSessionContextPercent } from "./usage.js";
import { validateWorktreePath } from "../spawn/worktree-validator.js";

import { parseModelKey, findModelInRegistry, parseThinkingLevel, splitModelThinkingSuffix } from "../utils.js";
import { resolveModelSpec } from "../models/model-spec.js";
import {
  getPiInstance,
  getSessionCtx,
  getStore,
  getCoordinator,
  getManager,
} from "../shell.js";

// ============================================================================
// Tool result helpers
// ============================================================================

/** Shortcut for a successful tool result. */
function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/** Shortcut for an error tool result. */
function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], isError: true as const, details };
}

const NON_RETRYABLE_VALIDATION_NOTE = "This validation error is non-retryable; do not repeat the same Agent call unchanged.";

type ToolTextResult = {
  content: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: true;
};

function withNormalizationWarnings<T extends ToolTextResult>(result: T, warnings: string[]): T {
  if (warnings.length === 0) return result;

  const warningText = warnings.map((warning) => `[note: ${warning}]`).join("\n");
  const firstContent = result.content[0];
  return {
    ...result,
    content: firstContent?.type === "text"
      ? [
        { ...firstContent, text: `${warningText}\n\n${firstContent.text ?? ""}` },
        ...result.content.slice(1),
      ]
      : result.content,
    details: {
      ...result.details,
      normalizationWarnings: warnings,
    },
  };
}

/** Non-retryable preflight validation error. The text carries the instruction because details are not consumed by pi. */
function nonRetryableValidationErrorResult(text: string, details?: Record<string, unknown>) {
  return errorResult(`${text} ${NON_RETRYABLE_VALIDATION_NOTE}`, {
    errorType: "validation",
    retryable: false,
    ...details,
  });
}

function resolveSessionLifecycleForDispatch(
  agentName: string,
  agentConfig: AgentConfig | undefined,
): { ok: true; sessionLifecycle: SessionLifecycle } | { ok: false; error: string } {
  const metadataLifecycle = agentConfig?.sessionLifecycle;
  const aliasLifecycle = agentConfig?.persistentSession === undefined
    ? undefined
    : agentConfig.persistentSession ? "persistent" : "stateless";

  if (metadataLifecycle && aliasLifecycle && metadataLifecycle !== aliasLifecycle) {
    return { ok: false, error: `Agent '${agentName}' has conflicting session_lifecycle and persistent_session metadata` };
  }

  return { ok: true, sessionLifecycle: metadataLifecycle ?? aliasLifecycle ?? "stateless" };
}

// ============================================================================
// Activity tracking
// ============================================================================

/**
 * Build a details Record from an AgentRecord, controlled by options.
 *
 * Always includes `type` and `description`. Optional groups:
 * - `includeStatus`: adds `status`, `outputFile`
 * - `includeStats`: adds turn/token/cost/context/compaction/model fields
 *
 * Consolidates the identical field-selection logic previously duplicated
 * across emitIndividualNudge, executeSpawnForeground, and executeSpawnBackground.
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
    details.modelName = record.display.invocation?.modelName;
    details.cost = record.stats.lifetimeUsage.cost;
  }

  return details;
}

/**
 * Result text plus status note, for display.
 *
 * Shared by the foreground tool result and the subagent-result nudge so both
 * callers stay in sync on the nullish default and separator handling — they
 * have diverged before. getStatusNote owns the leading separator.
 */
export function formatResultContent(record: AgentRecord): string {
  return (record.result ?? "") + getStatusNote(record.lifecycle);
}

// ============================================================================
// Tool execute handlers
// ============================================================================

export async function executeAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  // Don fork: capture lineage before a queued spawn can outlive this session.
  const parentSessionFile = ctx.sessionManager.getSessionFile();

  // Don fork: normalize optional-string placeholders and decide after agent
  // lifecycle resolution whether a non-empty key should persist or be ignored.
  if (params.session_key !== undefined && typeof params.session_key !== "string") {
    return nonRetryableValidationErrorResult("session_key must be a string when provided.");
  }
  const rawSessionKey = typeof params.session_key === "string" ? params.session_key.trim() : undefined;
  let sessionKey = rawSessionKey || undefined;
  const rawWorktreePath = typeof params.worktree_path === "string" ? params.worktree_path.trim() : undefined;
  const normalizationWarnings: string[] = [];
  if (params.session_key !== undefined && !sessionKey) {
    normalizationWarnings.push("empty session_key ignored; spawned without a session key");
  }
  if (params.session_key !== undefined) {
    const hasMeaningfulValue = (value: unknown): boolean => {
      if (value === undefined || value === null || value === false) return false;
      if (typeof value === "string") return value.trim().length > 0;
      return true;
    };
    const forkStyleParam = ["context", "fork", "fork_from", "parent_session", "parentSession"]
      .find((name) => hasMeaningfulValue(params[name]));
    if (forkStyleParam) {
      return nonRetryableValidationErrorResult(`session_key cannot be used with ${forkStyleParam}.`);
    }
  }

  // Validate worktree_path lazily. It is needed before on-demand discovery for
  // unknown types, but known persistent+key+worktree calls should fail without
  // mutating or normalizing either piece of persistent intent.
  let validatedWorktreePath: string | undefined;
  let worktreeLabel: string | undefined;
  let worktreeValidated = false;
  const validateWorktreeForDispatch = async (): Promise<ReturnType<typeof errorResult> | undefined> => {
    if (!rawWorktreePath || worktreeValidated) return undefined;
    worktreeValidated = true;
    try {
      const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
      const warnings: string[] = [];
      const onWarning = (msg: string) => { warnings.push(msg); };
      const validation = await validateWorktreePath(getPiInstance(), rawWorktreePath, parentCwd, onWarning);
      if (!validation.ok) {
        for (const msg of warnings) {
          if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
        }
        return errorResult(validation.error);
      }
      validatedWorktreePath = validation.resolvedPath;
      worktreeLabel = validation.label;
      return undefined;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`worktree_path validation failed: ${msg}`);
    }
  };

  const type = (params.agent as string) || "general-purpose";
  let resolvedType = resolveType(type);
  if (!resolvedType) {
    // Not found in registry — try scanning filesystem for agents added during the session.
    // When worktree_path is set, also scan the worktree's .pi/agents/ directory.
    const worktreeError = await validateWorktreeForDispatch();
    if (worktreeError) return withNormalizationWarnings(worktreeError, normalizationWarnings);
    const worktreeDir = validatedWorktreePath ? `${validatedWorktreePath}/.pi/agents` : undefined;
    await discoverNewAgents(worktreeDir);
    resolvedType = resolveType(type);
  }
  if (!resolvedType) {
    return withNormalizationWarnings(nonRetryableValidationErrorResult(`Unknown agent type: ${type}.`), normalizationWarnings);
  }
  const agentConfig = getAgentConfig(resolvedType);
  const lifecycleResolution = resolveSessionLifecycleForDispatch(resolvedType, agentConfig);
  if (!lifecycleResolution.ok) {
    return withNormalizationWarnings(nonRetryableValidationErrorResult(`${lifecycleResolution.error}. Fix the agent metadata before retrying.`, {
      agent: resolvedType,
    }), normalizationWarnings);
  }
  const { sessionLifecycle } = lifecycleResolution;
  if (sessionKey && sessionLifecycle !== "persistent") {
    normalizationWarnings.push(`session_key ignored for stateless agent '${resolvedType}'; spawned as one-shot`);
    sessionKey = undefined;
  }
  if (sessionKey && rawWorktreePath) {
    return nonRetryableValidationErrorResult("session_key cannot be used with a non-empty worktree_path for persistent agents; omit one of these fields.");
  }

  const worktreeError = await validateWorktreeForDispatch();
  if (worktreeError) return withNormalizationWarnings(worktreeError, normalizationWarnings);

  const prompt = params.prompt as string;
  const description = (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  let isBackground = runInBackground || getStore().agent.forceBackground;
  // Don fork: in one-shot mode (no UI: pi -p / --mode json) the parent process
  // exits when the turn ends, killing any background child mid-work. There is
  // no later turn to collect the result, so background delegation can never
  // succeed — force foreground instead of losing the work.
  const forcedForeground = isBackground && !ctx.hasUI;
  if (forcedForeground) isBackground = false;
  const maxTurns = params.max_turns as number | undefined ?? agentConfig?.maxTurns;

  const modelStr = params.model as string | undefined;
  // Don fork: a requested model that isn't in the registry is an error, not a
  // silent fallback to the parent model — a typo in a modelAgents/providerAgents entry or
  // per-call override would otherwise run the wrong model (and any thinking
  // that traveled with the configured entry would disagree with it).
  // The spec is resolved tolerantly first (aliases, bare ids, "terra high",
  // "default" = inherit) so a near-miss spelling costs zero extra turns, and
  // any failure message carries the format plus the candidate list.
  let specThinking: ThinkingLevel | undefined;
  let resolvedModelStr = modelStr;
  if (modelStr) {
    const resolution = resolveModelSpec(modelStr, ctx.modelRegistry, {
      aliases: getStore().modelAliases,
      providerPreference: getStore().providerPreference,
      parentProvider: ctx.model?.provider,
    });
    if (resolution.kind === "error") {
      return withNormalizationWarnings(nonRetryableValidationErrorResult(resolution.message), normalizationWarnings);
    }
    specThinking = resolution.thinking;
    resolvedModelStr = resolution.kind === "resolved" ? resolution.key : undefined;
    if (resolution.note) normalizationWarnings.push(resolution.note);
  }
  const model = findModelInRegistry(resolvedModelStr, ctx.modelRegistry, resolvedModelStr ? undefined : ctx.model);
  if (resolvedModelStr && !model) {
    return withNormalizationWarnings(
      nonRetryableValidationErrorResult(`Model not found in registry: ${resolvedModelStr}.`),
      normalizationWarnings,
    );
  }
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;

  // Determine modelName for invocation (always capture for display)
  const modelName = model?.id;

  // Resolve thinking: explicit param > agent config (frontmatter) > undefined (inherit)
  const thinkingLevel = parseThinkingLevel(params.thinking as string | undefined)
    ?? specThinking
    ?? agentConfig?.thinkingLevel;

  // Use SpawnCoordinator for unified spawn path
  const coordinator = getCoordinator()!;
  let result: Awaited<ReturnType<typeof coordinator.spawn>>;
  try {
    result = await coordinator.spawn(getPiInstance(), ctx, {
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
      invocation: { modelName },
      ...(isBackground ? {} : { signal }),
      parentSessionFile,
      // Scope keyed sessions by normalized parent cwd, resolved type, and caller key.
      ...(sessionKey ? { sessionKey, sessionKeyCwd: getSessionCtx()?.cwd ?? ctx.cwd, sessionKeyAgentType: resolvedType } : {}),
      runInBackground: isBackground,
    });
  } catch (err: unknown) {
    // Don fork: surface manager-level executor contention as a normal tool error.
    return withNormalizationWarnings(
      errorResult(err instanceof Error ? err.message : String(err)),
      normalizationWarnings,
    );
  }

  const { agentId, record } = result;

  if (isBackground) {
    // Background: return immediately
    const suffix = `A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.\n\nAgent ID: ${agentId}`;
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    return withNormalizationWarnings(successResult(`[${label}] ${suffix}`, buildAgentDetails(record)), normalizationWarnings);
  }

  // Foreground: record.execution.promise is already awaited by coordinator.spawn()
  const details = buildAgentDetails(record, { includeStats: true });

  if (record.lifecycle.status === "error") {
    return withNormalizationWarnings(errorResult(`Agent failed: ${record.error || "unknown error"}`, details), normalizationWarnings);
  }

  const resultText = forcedForeground
    ? `[note: run_in_background was ignored — one-shot mode has no later turn to collect background results, so the agent ran in the foreground]\n\n${formatResultContent(record)}`
    : formatResultContent(record);
  return withNormalizationWarnings(successResult(resultText, details), normalizationWarnings);
}

// ============================================================================
// Running agents list helper (used by executeStopAgentTool)
// ============================================================================

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(): string {
  const agents = getManager()!.listAgents().filter(
    (a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued",
  );

  if (agents.length === 0) return "none";

  return agents
    .map((a) => `${a.id.slice(0, SHORT_ID_LENGTH)} (${a.display.type})`)
    .join(", ");
}

// ============================================================================
// StopAgent execute handler
// ============================================================================

export async function executeStopAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const agentId = params.agent_id as string | undefined;

  if (!agentId) {
    return errorResult("agent_id is required");
  }

  let record: AgentRecord | undefined;
  try {
    record = getManager()!.getRecord(agentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message);
  }

  if (!record) {
    // Agent not found → return error + list of running agents
    return errorResult(
      `Agent ${agentId} not found. Running agents: ${formatRunningAgents()}`,
    );
  }

  // Check if already in a terminal state (not running or queued)
  if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
    return successResult(
      `Agent ${agentId} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents()}`,
    );
  }

  // Attempt to stop the running/queued agent
  if (getManager()!.abort(record.id, "agent")) {
    return successResult(`Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`);
  }

  return errorResult(`Failed to stop agent ${agentId}`);
}

// ============================================================================
// Tool_call listener — inject model into Agent tool calls
// =============================================================================

export async function toolCallListener(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (event.toolName !== "Agent") return;

  const input = event.input;
  // Resolve the caller's spelling to the canonical type before any keyed
  // lookup: session/config/modelAgents/providerAgents keys are canonical, so "Executor"
  // or a display name would silently miss its per-type entries otherwise.
  const requestedType = typeof input.agent === "string" && input.agent ? input.agent : "general-purpose";
  const subagentType = resolveType(requestedType) ?? requestedType;
  const agentConfig = getAgentConfig(subagentType);

  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

  // Don fork: feed the per-call model param into resolution instead of
  // clobbering it — it now wins over the follow map and frontmatter (targeted
  // overrides like a Luna trial) while still losing to session/config pins.
  const explicitModel = typeof input.model === "string" && input.model ? input.model : undefined;
  const spawn = getStore().spawnFor(subagentType, parentModelId, agentConfig, explicitModel);

  const modelWithSuffix = spawn.model ? splitModelThinkingSuffix(spawn.model) : undefined;
  // Don fork: canonicalize the resolved spelling before execute() validates it.
  // A tolerated spelling (alias, bare id, "terra high") becomes the registry
  // key here; "default" clears the override so the parent model is inherited;
  // an unresolvable spelling is left untouched so execute() can report the
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
  // resolved model (follow-map entry), a pi CLI-style model suffix, else agent
  // config (frontmatter).
  if (input.thinking === undefined) {
    const thinking = spawn.thinking
      ?? modelWithSuffix?.thinking
      ?? (specResolution?.kind !== "error" ? specResolution?.thinking : undefined)
      ?? agentConfig?.thinkingLevel;
    if (thinking !== undefined) {
      input.thinking = thinking;
    }
  }
}
