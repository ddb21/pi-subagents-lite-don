/**
 * model-precedence.ts — Model resolution with explicit precedence.
 *
 * Pure function — no side effects, no file I/O, no pi SDK imports.
 *
 * Precedence chain (highest to lowest):
 *   1. sessionOverrides[subagentType]  (session per-type override)
 *   2. sessionOverrides["default"]     (session global default)
 *   3. config.agent[subagentType]      (config per-type override)
 *   4. config.agent["default"]         (config global default)
 *   5. explicitModel                   (per-call `model` param from the parent)
 *   6. providerAgents[parent provider] (provider-follow map, per-type then default)
 *   7. agentConfig?.model              (agent config / frontmatter)
 *   8. parentModelId                   (inherit from parent)
 *
 * Tiers 5–6 are the Don-fork additions: an explicit per-call model wins over
 * the follow map and frontmatter (so targeted overrides like a Luna trial
 * work) but still loses to user-set session/config pins; the providerAgents
 * map keys off the parent's provider so switching the orchestrator provider
 * moves the whole cast without touching frontmatter.
 *
 * Thinking travels with the model: a follow-map entry's thinking applies only
 * when that entry is the one that supplied the resolved model. A model chosen
 * by a higher tier never picks up thinking from a map entry it didn't use.
 */

import type { ThinkingLevel } from "../types.js";
import type { SystemPromptMode } from "../agents/types.js";
import { parseThinkingLevel } from "../utils.js";

/**
 * One entry in the providerAgents follow map: either a bare model key
 * ("provider/model") or an object carrying per-provider settings alongside it.
 */
export type ProviderAgentEntry = string | { model?: string; thinking?: ThinkingLevel };

/** Shape of the subagents-lite.json config file. */
export interface SubagentsConfig {
  agent: {
    default: string | null;
    forceBackground: boolean;
    graceTurns?: number;
    showCost?: boolean;
    widgetMaxLines?: number;
    widgetMaxLinesCompact?: number;
    widgetCompact?: boolean;
    widgetShortcut?: boolean;
    /** System prompt mode: replace (default), inherit parent, or custom file. */
    systemPromptMode?: SystemPromptMode;
    /** Whether to include AGENTS.md context files in the subagent system prompt. Default: true. */
    includeContextFiles?: boolean;
    /** Default thinking level for spawned agents. Undefined = inherit from agent config. */
    defaultThinking?: ThinkingLevel;
    /** Default max turns for spawned agents. Undefined = unlimited. */
    defaultMaxTurns?: number;
    /** Global default for skills loading when agent doesn't explicitly set skills. true (default) or false. */
    loadSkillsImplicitly?: boolean;
    /** Global default for extensions loading when agent doesn't explicitly set extensions. true (default) or false. */
    loadExtensionsImplicitly?: boolean;
    /** When true, skip built-in default agents (general-purpose, Explore) at registration. */
    disableDefaultAgents?: boolean;
    /** Whether to show toolUses count in widget stats line. Default: true. */
    showTools?: boolean;
    /** Whether to show turn count in widget stats line. Default: true. */
    showTurns?: boolean;
    /** Whether to show input tokens in widget stats line. Default: true. */
    showInput?: boolean;
    /** Whether to show output tokens in widget stats line. Default: true. */
    showOutput?: boolean;
    /** Whether to show context percent and compactions in widget stats line. Default: true. */
    showContext?: boolean;
    /** Whether to show elapsed time in widget stats line. Default: true. */
    showTime?: boolean;
    /** Max description length in widget full mode. Default: 50. */
    widgetDescLengthFull?: number;
    /** Max description length in widget compact mode. Default: 30. */
    widgetDescLengthCompact?: number;
    /** When > 0, thinking deltas stream to output file during message_update events. Default: 0 (disabled). */
    outputThinkingBufferSize?: number;
    [agentType: string]: string | null | undefined | boolean | number;
  };
  concurrency: {
    default: number;
    providers?: Record<string, number>;
    models?: Record<string, number>;
  };
  /**
   * Provider-follow map: orchestrator (parent) provider → per-agent-type
   * entries, with "default" as the within-provider fallback. Lets the whole
   * cast follow when the orchestrator switches provider, without editing
   * frontmatter. Thinking in an entry applies only when that entry supplied
   * the resolved model.
   */
  providerAgents?: Record<string, Record<string, ProviderAgentEntry>>;
}

/**
 * Shape of session-only model overrides.
 * Same as config.agent but without the forceBackground flag.
 * Not persisted — cleared on session_start.
 */
export interface SessionModelOverrides {
  default: string | null;
  [agentType: string]: string | null | undefined;
}

/** Options for resolveModel. */
export interface ResolveModelOptions {
  /** The type of subagent being spawned. */
  subagentType: string;
  /** The agent's config (from .md frontmatter or defaults). */
  agentConfig?: { model?: string };
  /** The global subagents-lite.json config (model overrides). */
  config: SubagentsConfig;
  /** The parent agent's model ID (final fallback). */
  parentModelId: string;
  /** Session-only overrides (checked first). */
  sessionOverrides?: SessionModelOverrides;
  /** Explicit per-call `model` param from the parent's Agent tool call. */
  explicitModel?: string;
}

/** Extract the provider segment from a "provider/model" key, if present. */
export function providerOf(modelKey: string | null | undefined): string | undefined {
  if (!modelKey) return undefined;
  const slash = modelKey.indexOf("/");
  return slash > 0 ? modelKey.slice(0, slash) : undefined;
}

/** A resolved spawn: the model plus any settings that traveled with it. */
export interface ResolvedSpawn {
  model: string;
  /** Set only when the winning tier was a follow-map entry carrying thinking. */
  thinking?: ThinkingLevel;
}

/**
 * Normalize a hand-edited JSON entry into a safe shape. Tolerates null,
 * arrays, wrong-typed fields, and invalid thinking values (typeof null is
 * "object" — a naive object check would throw on `"reviewer": null`).
 */
function normalizeEntry(
  entry: ProviderAgentEntry | null | undefined,
): { model?: string; thinking?: ThinkingLevel } | undefined {
  if (typeof entry === "string") return entry ? { model: entry } : undefined;
  if (entry === null || entry === undefined || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  return {
    model: typeof entry.model === "string" && entry.model ? entry.model : undefined,
    thinking: parseThinkingLevel(typeof entry.thinking === "string" ? entry.thinking : undefined),
  };
}

/**
 * Resolve the model for a subagent invocation.
 *
 * Returns the first non-null, non-undefined, non-empty-string value
 * from the precedence chain. If all are empty/null, returns parentModelId.
 */
export function resolveModel(options: ResolveModelOptions): string {
  return resolveSpawn(options).model;
}

/**
 * Resolve the model AND the settings that travel with it. Same precedence as
 * resolveModel; thinking is populated only when a follow-map entry won.
 */
export function resolveSpawn(options: ResolveModelOptions): ResolvedSpawn {
  const { subagentType, agentConfig, config, parentModelId, sessionOverrides, explicitModel } = options;

  const parentProvider = providerOf(parentModelId);
  const providerMap = parentProvider ? config.providerAgents?.[parentProvider] : undefined;
  const typedEntry = normalizeEntry(providerMap?.[subagentType]);
  const defaultEntry = normalizeEntry(providerMap?.["default"]);

  // Precedence chain: session > config > per-call param > provider map > frontmatter > parent
  // Cast agent values: index signature includes number (graceTurns), but models are always strings
  const candidates: Array<{ model: string | boolean | null | undefined; thinking?: ThinkingLevel }> = [
    { model: sessionOverrides?.[subagentType] },
    { model: sessionOverrides?.["default"] },
    { model: config.agent[subagentType] as string | null | undefined },
    { model: config.agent["default"] },
    { model: explicitModel },
    { model: typedEntry?.model, thinking: typedEntry?.thinking },
    { model: defaultEntry?.model, thinking: defaultEntry?.thinking },
    { model: agentConfig?.model },
    { model: parentModelId }, // final fallback (always a valid string)
  ];
  const winner = candidates.find((c) => isValidValue(c.model));
  return winner
    ? { model: winner.model as string, thinking: winner.thinking }
    : { model: parentModelId };
}

/**
 * Check if a value is a valid non-empty model string.
 * Returns true for non-null, non-undefined, non-empty strings.
 */
function isValidValue(value: string | boolean | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
