import type { AgentModelConfig, AgentModelRoutingRule } from "./types.agents-shared.js";

type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
};

export function resolveAgentModelPrimaryValue(model?: AgentModelConfig): string | undefined {
  if (typeof model === "string") {
    const trimmed = model.trim();
    return trimmed || undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  const primary = model.primary?.trim();
  return primary || undefined;
}

export function resolveAgentModelFallbackValues(model?: AgentModelConfig): string[] {
  if (!model || typeof model !== "object") {
    return [];
  }
  return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}

export function toAgentModelListLike(model?: AgentModelConfig): AgentModelListLike | undefined {
  if (typeof model === "string") {
    const primary = model.trim();
    return primary ? { primary } : undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return model;
}

function matchesRoutingRule(rule: AgentModelRoutingRule, prompt: string, lower: string): boolean {
  if (rule.contains?.length) {
    if (!rule.contains.every((kw) => lower.includes(kw.toLowerCase()))) {
      return false;
    }
  }
  if (rule.containsAny?.length) {
    if (!rule.containsAny.some((kw) => lower.includes(kw.toLowerCase()))) {
      return false;
    }
  }
  if (rule.regex) {
    try {
      if (!new RegExp(rule.regex, "i").test(prompt)) {
        return false;
      }
    } catch {
      // Skip malformed regex rules rather than crashing.
      return false;
    }
  }
  if (rule.maxLength !== undefined && prompt.length > rule.maxLength) {
    return false;
  }
  if (rule.minLength !== undefined && prompt.length < rule.minLength) {
    return false;
  }
  return true;
}

/**
 * Evaluate per-message model routing rules against a prompt.
 * Rules are checked top-down; the first matching rule's model is returned.
 * Returns undefined if no rule matches or no routing config is present.
 */
export function resolveAgentModelFromRouting(
  model: AgentModelConfig | undefined,
  prompt: string,
): string | undefined {
  if (!model || typeof model !== "object" || !Array.isArray(model.routing)) {
    return undefined;
  }
  const lower = prompt.toLowerCase();
  for (const rule of model.routing) {
    const target = rule.model?.trim();
    if (!target) {
      continue;
    }
    if (matchesRoutingRule(rule, prompt, lower)) {
      return target;
    }
  }
  return undefined;
}
