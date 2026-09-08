/**
 * model-spec.ts — Tolerant model-spec resolution for Agent spawns.
 *
 * Problem this solves (Don fork): the `model` param of the Agent tool accepted
 * only a canonical `provider/model-id` key. Any other spelling produced a
 * non-retryable "Model not found in registry" error with no format hint and no
 * candidate list, so an orchestrator burned turn after turn guessing ("terra",
 * "gpt-5.4", "claude-opus-5", "default"). Worse, when the guessing stopped the
 * heavy agent often ran on the parent's cheap model.
 *
 * This module resolves a human spelling to a registry entry, or returns an
 * error message that always contains enough information to fix the call on the
 * next attempt (format, close matches, full available list).
 *
 * Pure functions — no file I/O, no pi SDK imports beyond the registry shape.
 */

import type { ThinkingLevel } from "../types.js";
import { VALID_THINKING_LEVELS, splitModelThinkingSuffix } from "../utils.js";

/** Minimal registry shape needed here (satisfied by pi's ModelRegistry). */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): { provider: string; id: string } | undefined;
  getAvailable(): Array<{ provider: string; id: string }>;
  getAll?(): Array<{ provider: string; id: string }>;
  /** Optional in pi's ModelRegistry; used to break fragment ties. */
  hasConfiguredAuth?(model: { provider: string; id: string }): boolean;
}

/** Optional hints that break fragment ties without an extra turn. */
export interface ModelSpecHints {
  /** Provider of the calling (parent) model. Preferred on a tie. */
  parentProvider?: string;
  /**
   * Provider preference order from config (`providerPreference`). Used to break
   * a fragment tie when one model id is served by several providers, for
   * example claude-opus-5 under both `awb` and `github-copilot`.
   */
  providerPreference?: string[];
  /** User aliases: normalized spelling -> canonical "provider/model[:thinking]". */
  aliases?: Record<string, string>;
}

/** Outcome of resolving one model spec. */
export type ModelSpecResolution =
  | { kind: "inherit"; thinking?: ThinkingLevel; note?: string }
  | { kind: "resolved"; provider: string; id: string; key: string; thinking?: ThinkingLevel; note?: string }
  | { kind: "error"; message: string };

/** Spellings that mean "use the parent/orchestrator model". */
const INHERIT_KEYWORDS = new Set([
  "default", "inherit", "inherited", "parent", "host", "same", "auto", "any",
]);

/** Provider spellings a human or an orchestrator is likely to type. */
const PROVIDER_ALIASES: Record<string, string> = {
  wm: "walmart-puppy",
  wmcodepuppy: "walmart-puppy",
  codepuppy: "walmart-puppy",
  puppy: "walmart-puppy",
  walmartpuppy: "walmart-puppy",
  copilot: "github-copilot",
  githubcopilot: "github-copilot",
  gh: "github-copilot",
  gemini: "walmart-puppy-gemini",
  anthropic: "awb",
  claude: "awb",
  bedrock: "awb",
  awb: "awb",
  mlx: "local-mlx",
  local: "local-mlx",
};

const MAX_LISTED_MODELS = 24;

/** Lowercase and drop separators so "Opus 5", "opus-5" and "opus_5" match. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s._\-/:]+/g, "");
}

/** Strip a trailing effort word ("terra high", "opus 5 medium"). */
function splitTrailingThinkingWord(spec: string): { spec: string; thinking?: ThinkingLevel } {
  const match = spec.match(/^(.*?)[\s,_]+([A-Za-z]+)$/);
  if (!match) return { spec };
  const candidate = match[2].toLowerCase() as ThinkingLevel;
  if (!VALID_THINKING_LEVELS.includes(candidate)) return { spec };
  const head = match[1].trim();
  if (!head) return { spec };
  return { spec: head, thinking: candidate };
}

function registryEntries(registry: ModelRegistryLike): Array<{ provider: string; id: string }> {
  const available = registry.getAvailable();
  if (available.length > 0) return available;
  return registry.getAll?.() ?? [];
}

function keyOf(entry: { provider: string; id: string }): string {
  return `${entry.provider}/${entry.id}`;
}

/** Build the "here is what you may use" part of an error message. */
function availabilityHint(registry: ModelRegistryLike, spec: string, hints?: ModelSpecHints): string {
  const entries = registryEntries(registry);
  // Show usable keys first: parent provider, then providers with auth.
  const preference = hints?.providerPreference ?? [];
  const rank = (entry: { provider: string; id: string }): number => {
    if (hints?.parentProvider && entry.provider === hints.parentProvider) return 0;
    const preferredIdx = preference.indexOf(entry.provider);
    if (preferredIdx >= 0) return 1 + preferredIdx;
    if (registry.hasConfiguredAuth?.(entry)) return 1 + preference.length;
    return 2 + preference.length;
  };
  const keys = [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => keyOf(entry));
  const needle = normalize(spec);
  const close = needle.length < 3 ? [] : keys.filter((key) => {
    const id = normalize(key.slice(key.indexOf("/") + 1));
    if (normalize(key).includes(needle)) return true;
    // Only treat the id as a near match when it is substantial: an empty or
    // 2-character id would otherwise match every spec.
    return id.length >= 3 && needle.includes(id);
  });
  const listed = keys.slice(0, MAX_LISTED_MODELS);
  const parts = [
    'Use "provider/model-id" or "provider/model-id:thinking" (thinking: off|minimal|low|medium|high|xhigh|max).',
  ];
  if (close.length > 0) parts.push(`Close matches: ${close.slice(0, 8).join(", ")}.`);
  parts.push(`Available: ${listed.join(", ")}${keys.length > listed.length ? `, ... (${keys.length} total)` : ""}.`);
  parts.push('Pass "default" to inherit the parent model.');
  return parts.join(" ");
}

/**
 * Resolve one model spec against the registry.
 *
 * Accepted spellings, in order of attempt:
 *   1. canonical `provider/model-id`, optional `:thinking` suffix
 *   2. inherit keywords ("default", "parent", ...)
 *   3. aliased provider ("copilot/gpt-5.5", "wm/gpt-5.6-terra")
 *   4. `provider model-id` with a space ("awb claude-opus-5")
 *   5. bare model id, exact after normalization ("gpt-5.6-terra", "Opus 5")
 *   6. bare fragment, unique substring match ("terra", "luna")
 * A trailing effort word ("terra high") sets thinking.
 * Ambiguous fragments return an error that lists every candidate, so the next
 * call can be exact instead of another guess.
 *
 * `aliases` maps a normalized spelling to a canonical key and is meant for
 * user config (subagents-lite.json `modelAliases`).
 */
export function resolveModelSpec(
  rawSpec: string | undefined,
  registry: ModelRegistryLike,
  hints: ModelSpecHints = {},
): ModelSpecResolution {
  const aliases = hints.aliases ?? {};
  const trimmed = (rawSpec ?? "").trim();
  if (!trimmed) return { kind: "inherit" };

  // 1. Peel thinking off both spellings (":high" and " high").
  const colonSplit = splitModelThinkingSuffix(trimmed);
  const wordSplit = splitTrailingThinkingWord(colonSplit.model);
  let spec = wordSplit.spec.trim();
  const thinking = colonSplit.thinking ?? wordSplit.thinking;

  const finish = (resolution: ModelSpecResolution): ModelSpecResolution => {
    if (resolution.kind === "error") return resolution;
    return { ...resolution, thinking: thinking ?? resolution.thinking };
  };

  // 2. Inherit keywords.
  if (INHERIT_KEYWORDS.has(normalize(spec))) {
    return finish({ kind: "inherit", note: `model '${trimmed}' means inherit the parent model` });
  }

  // 3. User/built-in alias for the whole spec.
  const aliasTarget = aliases[normalize(spec)];
  if (aliasTarget) {
    const aliasSplit = splitModelThinkingSuffix(aliasTarget);
    const aliased = resolveModelSpec(aliasSplit.model, registry, {
      parentProvider: hints.parentProvider,
      providerPreference: hints.providerPreference,
    });
    if (aliased.kind === "resolved") {
      return finish({
        ...aliased,
        thinking: thinking ?? aliasSplit.thinking ?? aliased.thinking,
        note: `model alias '${trimmed}' resolved to ${aliased.key}`,
      });
    }
    spec = aliasSplit.model;
  }

  const entries = registryEntries(registry);
  const exactMatch = (provider: string, id: string) => {
    const found = registry.find(provider, id);
    if (found) return { provider: found.provider ?? provider, id: found.id ?? id };
    const entry = entries.find((e) => e.provider === provider && e.id === id);
    return entry ? { provider: entry.provider, id: entry.id } : undefined;
  };

  // 4. Canonical or aliased provider-qualified key.
  const slashIdx = spec.indexOf("/");
  if (slashIdx > 0) {
    const rawProvider = spec.slice(0, slashIdx);
    const rawId = spec.slice(slashIdx + 1);
    const direct = exactMatch(rawProvider, rawId);
    if (direct) return finish({ kind: "resolved", ...direct, key: keyOf(direct) });

    const providerKey = normalize(rawProvider);
    const knownProvider = PROVIDER_ALIASES[providerKey]
      ?? entries.map((e) => e.provider).find((p) => normalize(p) === providerKey);
    if (knownProvider) {
      const aliasedDirect = exactMatch(knownProvider, rawId);
      if (aliasedDirect) {
        return finish({
          kind: "resolved",
          ...aliasedDirect,
          key: keyOf(aliasedDirect),
          note: `model '${trimmed}' resolved to ${keyOf(aliasedDirect)}`,
        });
      }
      const scoped = matchWithinProvider(entries, knownProvider, rawId, registry, hints);
      if (scoped.kind !== "none") return finish(decorate(scoped, trimmed, registry, spec, hints));
    }
    // Unknown provider: fall through and try the model id on its own.
    spec = rawId;
  }

  // 5. "provider model-id" with a space.
  const spaceIdx = spec.search(/\s/);
  if (spaceIdx > 0) {
    const head = normalize(spec.slice(0, spaceIdx));
    const provider = PROVIDER_ALIASES[head] ?? entries.map((e) => e.provider).find((p) => normalize(p) === head);
    if (provider) {
      const scoped = matchWithinProvider(entries, provider, spec.slice(spaceIdx + 1).trim(), registry, hints);
      if (scoped.kind !== "none") return finish(decorate(scoped, trimmed, registry, spec, hints));
    }
  }

  // 6. Bare model id or fragment across every provider.
  const anyProvider = matchWithinProvider(entries, undefined, spec, registry, hints);
  return finish(decorate(anyProvider, trimmed, registry, spec, hints));
}

type ScopedMatch =
  | { kind: "one"; provider: string; id: string }
  | { kind: "many"; candidates: string[] }
  | { kind: "none" };

/** Match `spec` against ids, optionally restricted to one provider. */
function matchWithinProvider(
  entries: Array<{ provider: string; id: string }>,
  provider: string | undefined,
  spec: string,
  registry?: ModelRegistryLike,
  hints?: ModelSpecHints,
): ScopedMatch {
  const pool = provider ? entries.filter((e) => e.provider === provider) : entries;
  const needle = normalize(spec);
  if (!needle) return { kind: "none" };

  const exact = pool.filter((e) => normalize(e.id) === needle);
  let partial = exact.length > 0
    ? exact
    : needle.length >= 3
      ? pool.filter((e) => normalize(e.id).includes(needle))
      : [];
  if (partial.length === 0) return { kind: "none" };

  // Tie-breakers, applied only while more than one provider serves the same
  // model id: the same registry can list one id under four providers, and an
  // "ambiguous" error there would cost a turn for no decision value.
  partial = narrow(partial, (e) => e.provider === hints?.parentProvider);
  for (const preferred of hints?.providerPreference ?? []) {
    if (partial.length <= 1) break;
    partial = narrow(partial, (e) => e.provider === preferred);
  }
  partial = narrow(partial, (e) => registry?.hasConfiguredAuth?.(e) === true);

  const uniqueKeys = [...new Set(partial.map(keyOf))];
  if (uniqueKeys.length === 1) {
    const [only] = partial;
    return { kind: "one", provider: only.provider, id: only.id };
  }
  return { kind: "many", candidates: uniqueKeys };
}

/** Keep the preferred subset when it is non-empty and the set is still ambiguous. */
function narrow<T>(items: T[], prefer: (item: T) => boolean): T[] {
  if (items.length <= 1) return items;
  const preferred = items.filter(prefer);
  return preferred.length > 0 ? preferred : items;
}

/** Turn a scoped match into a resolution with a helpful note or error. */
function decorate(
  match: ScopedMatch,
  originalSpec: string,
  registry: ModelRegistryLike,
  probedSpec: string,
  hints?: ModelSpecHints,
): ModelSpecResolution {
  if (match.kind === "one") {
    const key = `${match.provider}/${match.id}`;
    return {
      kind: "resolved",
      provider: match.provider,
      id: match.id,
      key,
      note: key === originalSpec ? undefined : `model '${originalSpec}' resolved to ${key}`,
    };
  }
  if (match.kind === "many") {
    return {
      kind: "error",
      message: `Ambiguous model: '${originalSpec}' matches ${match.candidates.join(", ")}. `
        + "Pass one provider-qualified key.",
    };
  }
  return {
    kind: "error",
    message: `Model not found in registry: ${originalSpec}. ${availabilityHint(registry, probedSpec, hints)}`,
  };
}
