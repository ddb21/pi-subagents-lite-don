import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAvailableTypes } from "./agents/agent-types.js";
import { executeAgentTool, executeStopAgentTool } from "./agents/tool-execution.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "./ui/renderer.js";
import { showAgentsMainMenu } from "./ui/menu/menus.js";
import { getPiInstance, getStore } from "./shell.js";
import { emitLifecycle, lifecycleEnabled } from "./benchmark-lifecycle.js";

// ============================================================================
// Agent tool registration helper — dynamic enum for agent types
// ============================================================================

/**
 * Register (or re-register) the Agent tool with current agent types.
 * At init time only defaults exist; call again from session_start after
 * user/project agents are loaded to update the enum.
 */
type RegistryForDescription = {
  getAvailable(): Array<{ provider: string; id: string }>;
  hasConfiguredAuth?(model: { provider: string; id: string }): boolean;
};

export function registerAgentTool(pi: ExtensionAPI, ctx?: { modelRegistry?: RegistryForDescription }): void {
  const types = getAvailableTypes();
  // Don fork: the model param used to be an undocumented bare string, so a
  // constrained orchestrator guessed keys ("terra", "gpt-5.4", "default") and
  // burned a turn per guess on a non-retryable error. Publish the format and
  // the live registry keys in the schema instead.
  const modelParam = Type.Optional(Type.String({ description: buildModelParamDescription(ctx) }));
  // Use plain string to avoid verbose anyOf in prompt.
  // Available types are listed in description for discoverability.
  const agentParam = types.length > 0
    ? Type.Optional(Type.String({ description: types.join(",") }))
    : Type.Optional(Type.String());
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.Optional(Type.String()),
      agent: agentParam,
      run_in_background: Type.Optional(Type.Boolean()),
      worktree_path: Type.Optional(Type.String({ description: "Optional working directory. Do not supply with session_key; omit this field rather than passing an empty string." })),
      // Don fork: optional named, resumable child-session executor. The schema
      // rejects empty/whitespace placeholders before execution; one-shot
      // reviewer calls should omit session_key entirely.
      session_key: Type.Optional(Type.String({ minLength: 1, pattern: ".*\\S.*", description: "Optional persistent-session key. If unused, omit this field. Must contain a non-whitespace character and is mutually exclusive with a non-empty worktree_path." })),
      // Don fork: per-call overrides. These were always read by the executor
      // but absent from the schema, so constrained providers could never emit
      // them. model: "provider/model-id"; thinking: off..max.
      model: modelParam,
      thinking: Type.Optional(Type.String({ description: "off|minimal|low|medium|high|xhigh|max" })),
      max_turns: Type.Optional(Type.Number()),
    }),
    execute: executeAgentTool,

    renderCall: (args, theme) => renderAgentToolCall(args as Record<string, unknown>, theme),

    renderResult: (result, options, theme) => {
      const showCost = getStore().agent.showCost;
      return renderAgentToolResult(
        result as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
        options as { expanded?: boolean },
        theme,
        showCost,
      );
    },
  });
}

/** Format hint plus the live registry keys, capped to stay prompt-cheap. */
function buildModelParamDescription(ctx?: { modelRegistry?: RegistryForDescription }): string {
  const base = 'Model as "provider/model-id" or "provider/model-id:thinking". "default" inherits the parent model.';
  let keys: string[] = [];
  try {
    const registry = ctx?.modelRegistry;
    const entries = registry?.getAvailable() ?? [];
    // The list is a menu, not an inventory: show the providers Don actually
    // uses first (providerPreference), then any authenticated provider.
    const preference = getStore().providerPreference;
    const rank = (m: { provider: string; id: string }): number => {
      const idx = preference.indexOf(m.provider);
      if (idx >= 0) return idx;
      return registry?.hasConfiguredAuth?.(m) ? preference.length : preference.length + 1;
    };
    keys = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
      .map(({ entry }) => `${entry.provider}/${entry.id}`);
  } catch {
    keys = [];
  }
  if (keys.length === 0) return base;
  const listed = keys.slice(0, MODEL_DESCRIPTION_LIMIT);
  const suffix = keys.length > listed.length ? `, ... (${keys.length} total)` : "";
  return `${base} Available: ${listed.join(", ")}${suffix}`;
}

const MODEL_DESCRIPTION_LIMIT = 24;

// ============================================================================
// Tool/Command/Message registration
// ============================================================================

/** Register all tools, commands, and message renderers. */
export function registerTools(pi: ExtensionAPI): void {
  if (lifecycleEnabled()) emitLifecycle("extension_loaded", { extension: "pi-subagents-lite" });
  // Agent tool — stealth schema with dynamic agent type enum
  registerAgentTool(pi);

  // StopAgent tool — stealth schema, stop a running agent by ID
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "StopAgent",
    label: "StopAgent",
    parameters: Type.Object({
      agent_id: Type.String(),
    }),
    execute: executeStopAgentTool,
  });

  // AgentStatus tool — stealth schema, list all agents and their statuses
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "AgentStatus",
    label: "AgentStatus",
    parameters: Type.Object({}),
    execute: executeAgentStatusTool,
  });

  // Message renderer — subagent-result (background agent completion)
  pi.registerMessageRenderer("subagent-result", (message, options, theme) => {
    const showCost = getStore().agent.showCost;
    return renderSubagentResult(
      message as { content?: string; details?: Record<string, unknown> },
      options as { expanded?: boolean },
      theme,
      showCost,
    );
  });

  // Command registration
  pi.registerCommand("agents", {
    description: "Manage subagents: agent briefing, model settings, concurrency, running agents, agent types",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const modelOptions = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
      await showAgentsMainMenu(ctx, modelOptions);
    },
  });
}
