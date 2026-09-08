/**
 * model-precedence.ts — Model resolution with explicit precedence.
 *
 * Pure function — no side effects, no file I/O, no pi SDK imports.
 *
 * Precedence chain (highest to lowest):
 *   1. sessionOverrides[subagentType]   (session per-type override, /agents menu)
 *   2. sessionOverrides["default"]      (session global default)
 *   3. config.agent[subagentType]       (config per-type override)
 *   4. config.agent["default"]          (config global default)
 *   5. explicitModel                    (per-call `model` param from the parent)
 *   6. ambientOverrides[subagentType]   (session ambient route, /pool)
 *   7. ambientOverrides["default"]      (session ambient default)
 *   8. modelAgents[parent model ID]     (exact-parent map, per-type then default)
 *   9. providerAgents[parent provider]  (provider-follow map, per-type then default)
 *  10. agentConfig?.model               (agent config / frontmatter)
 *  11. parentModelId                    (inherit from parent)
 *
 * Tiers 5-9 are the Don-fork additions: an explicit per-call model wins over
 * both maps and frontmatter (so targeted overrides like a Luna trial work),
 * while exact parent-model routes take precedence over provider routes. All
 * maps still lose to user-set session/config pins.
 *
 * Why two session tiers: an /agents menu pick is a hard instruction and sits at
 * the top. A /pool switch is only "this session prefers that pool", so it sits
 * BELOW explicitModel. Otherwise a session-scoped pool switch would silently
 * cancel a deliberate escalation, for example lmd-science asking for Opus on
 * heavy quantitative work, which is the exact failure this fork set out to fix.
 *
 * Thinking travels with the model: a map entry's thinking applies only when
 * that entry is the one that supplied the resolved model. A model chosen by a
 * higher tier never picks up thinking from a map entry it didn't use.
 */

import type { ThinkingLevel } from "../types.js";
import type { SystemPromptMode } from "../agents/types.js";
import type { ModelThinkingPlacement } from "../config/types.js";
import { parseThinkingLevel } from "../utils.js";

/**
 * One entry in the providerAgents follow map: either a bare model key
 * ("provider/model") or an object carrying per-provider settings alongside it.
 */
export type ProviderAgentEntry = string | { model?: string; thinking?: ThinkingLevel };
/** Exact-parent model entries use the same shape as provider-follow entries. */
export type ModelAgentEntry = ProviderAgentEntry;

/** Shape of the subagents-lite.json config file. */
export interface SubagentsConfig {
  agent: {
    default: string | null;
    forceBackground: boolean;
    graceTurns?: number;
    showCost?: boolean;
    /** Stop an agent when a single tool call runs longer than this (minutes). 0 disables. Default: 45. */
    toolTimeoutMinutes?: number;
    /** Stop an agent showing no activity (tool events, streamed text) for this long (minutes). 0 disables. Default: 45. */
    idleTimeoutMinutes?: number;
    widgetMaxLines?: number;
    widgetMaxLinesCompact?: number;
    widgetCompact?: boolean;
    /** Show background completion cards in the TUI. Default: true. */
    showCompletionCards?: boolean;
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
    /** When true, use strict-mode schema for the Agent tool. Costs more tokens due to nullable field encoding. */
    agentToolStrictMode?: boolean;
    /** Whether to show toolUses count in widget stats line. Default: false. */
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
    /** Whether to stream the agent transcript to the output file. Default: false. */
    outputTranscript?: boolean;
    /** When true, agent colors (spinner, status icons, picker bullets) are enabled. Default: true. */
    showAgentColors?: boolean;

    /** When > 0, thinking deltas stream to output file during message_update events. Default: 0 (disabled). */
    outputThinkingBufferSize?: number;
    /** Minutes to retain finished agents in the widget. Default: 1. */
    finishedRetentionMinutes?: number;
    /** Max settled agents the AgentStatus tool lists. 0 or absent = auto: 2 × default concurrency. */
    agentStatusLimit?: number;
    /** How to display the model label: short ID or full name. Default: 'name'. */
    modelDisplayStyle?: "id" | "name";
    /** Where model/thinking appears in full mode: 'header' (1st line) or 'metadata' (2nd line). Default: 'header'. */
    modelThinkingPlacement?: ModelThinkingPlacement;
    /** Status bar format: 'full' (default) or 'compact'. */
    statusBarFormat?: "full" | "compact";
    [agentType: string]: string | null | undefined | boolean | number;
  };
  concurrency: {
    default: number;
    providers?: Record<string, number>;
    models?: Record<string, number>;
  };
  /**
   * Don fork: provider-follow map. Orchestrator (parent) provider -> per-agent-type
   * entries, with "default" as the within-provider fallback. Lets the whole
   * cast follow when the orchestrator switches provider, without editing
   * frontmatter. Thinking in an entry applies only when that entry supplied
   * the resolved model.
   */
  providerAgents?: Record<string, Record<string, ProviderAgentEntry>>;
  /**
   * Don fork: exact-parent model map. Full parent `provider/model` key -> per-agent-type
   * entries, with "default" as the within-model fallback. Checked before
   * providerAgents so a deliberate parent-model route can specialize a cast
   * without changing the broader provider default.
   */
  modelAgents?: Record<string, Record<string, ModelAgentEntry>>;
  /**
   * Don fork: user model aliases. Key = any spelling (case and separators are
   * ignored), value = canonical `provider/model[:thinking]`. Consumed by
   * resolveModelSpec so a per-call `model` param may use short names.
   */
  modelAliases?: Record<string, string>;
  /**
   * Don fork: provider order used to break a model-id tie when several
   * providers serve the same id (for example claude-opus-5 under `awb` and
   * `github-copilot`). First listed provider wins.
   */
  providerPreference?: string[];
}

/**
 * Session-only model overrides: "default" plus per-agent-type entries.
 * Not persisted — cleared on session_start.
 */
export interface SessionModelOverrides {
  default: string | null;
  [agentType: string]: string | null | undefined;
}

export interface ResolveModelOptions {
  /** The type of subagent being spawned. */
  subagentType: string;
  /** The agent's config (from .md frontmatter or defaults). */
  agentConfig?: { model?: string };
  /** The subagents-lite.json config (model overrides); the agent section plus the Don-fork routing maps. */
  config: Pick<SubagentsConfig, "agent"> & Partial<Pick<SubagentsConfig, "modelAgents" | "providerAgents">>;
  /** The parent agent's model ID (final fallback). */
  parentModelId: string;
  /** Session-only overrides (checked first). */
  sessionOverrides?: SessionModelOverrides;
  /** Don fork: ambient session routes from /pool. Below explicitModel on purpose. */
  ambientOverrides?: SessionModelOverrides;
  /** Don fork: explicit per-call `model` param from the parent's Agent tool call. */
  explicitModel?: string;
}

/** Which chain position won resolution (see resolveModelSource). */
export type ModelSource =
  | "session-per-type"
  | "session-default"
  | "config-per-type"
  | "config-default"
  | "explicit"
  | "ambient-per-type"
  | "ambient-default"
  | "model-map-per-type"
  | "model-map-default"
  | "provider-map-per-type"
  | "provider-map-default"
  | "frontmatter"
  | "parent";

/** Extract the provider segment from a "provider/model" key, if present. */
export function providerOf(modelKey: string | null | undefined): string | undefined {
  if (!modelKey) return undefined;
  const slash = modelKey.indexOf("/");
  return slash > 0 ? modelKey.slice(0, slash) : undefined;
}

/** A resolved spawn: the model plus any settings that traveled with it. */
export interface ResolvedSpawn {
  model: string;
  source: ModelSource;
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
 * Resolve the model for a subagent invocation and report which chain
 * position won. resolveModel() is the model-only projection; callers that
 * need the winning layer (the Model settings menu's provenance tags) use
 * this instead of re-deriving precedence from the inputs.
 *
 * Returns the first non-null, non-undefined, non-empty-string value
 * from the precedence chain; parentModelId (always valid) is the final
 * fallback.
 */
export function resolveModelSource(options: ResolveModelOptions): { model: string; source: ModelSource } {
  const { model, source } = resolveSpawn(options);
  return { model, source };
}

/**
 * Resolve the model AND the settings that travel with it. Same precedence as
 * resolveModelSource; thinking is populated only when a follow-map entry won.
 */
export function resolveSpawn(options: ResolveModelOptions): ResolvedSpawn {
  const { subagentType, agentConfig, config, parentModelId, sessionOverrides, ambientOverrides, explicitModel } =
    options;

  const parentProvider = providerOf(parentModelId);
  const modelMap = parentModelId ? config.modelAgents?.[parentModelId] : undefined;
  const providerMap = parentProvider ? config.providerAgents?.[parentProvider] : undefined;
  const exactTypedEntry = normalizeEntry(modelMap?.[subagentType]);
  const exactDefaultEntry = normalizeEntry(modelMap?.["default"]);
  const providerTypedEntry = normalizeEntry(providerMap?.[subagentType]);
  const providerDefaultEntry = normalizeEntry(providerMap?.["default"]);

  // Cast agent values: index signature includes number (graceTurns), but models are always strings
  const candidates: Array<{ source: ModelSource; model: string | null | undefined; thinking?: ThinkingLevel }> = [
    { source: "session-per-type", model: sessionOverrides?.[subagentType] },
    { source: "session-default", model: sessionOverrides?.["default"] },
    { source: "config-per-type", model: config.agent[subagentType] as string | null | undefined },
    { source: "config-default", model: config.agent["default"] },
    { source: "explicit", model: explicitModel },
    { source: "ambient-per-type", model: ambientOverrides?.[subagentType] },
    { source: "ambient-default", model: ambientOverrides?.["default"] },
    { source: "model-map-per-type", model: exactTypedEntry?.model, thinking: exactTypedEntry?.thinking },
    { source: "model-map-default", model: exactDefaultEntry?.model, thinking: exactDefaultEntry?.thinking },
    { source: "provider-map-per-type", model: providerTypedEntry?.model, thinking: providerTypedEntry?.thinking },
    { source: "provider-map-default", model: providerDefaultEntry?.model, thinking: providerDefaultEntry?.thinking },
    { source: "frontmatter", model: agentConfig?.model },
  ];
  for (const candidate of candidates) {
    if (isValidModelValue(candidate.model)) {
      return { model: candidate.model, source: candidate.source, thinking: candidate.thinking };
    }
  }
  // Parent model id is the final fallback (always a valid string).
  return { model: parentModelId, source: "parent" };
}

/**
 * Resolve the model for a subagent invocation — model-only projection of
 * resolveModelSource() for callers that do not need the winning source.
 */
export function resolveModel(options: ResolveModelOptions): string {
  return resolveSpawn(options).model;
}

/** True when the value is a usable model string (null/undefined/empty are unset). */
export function isValidModelValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
