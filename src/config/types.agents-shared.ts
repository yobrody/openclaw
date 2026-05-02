import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";

/**
 * A single rule in per-message model routing.
 * Conditions are ANDed: all specified conditions must match for the rule to fire.
 * Rules are evaluated top-down; the first match sets the model for that message.
 */
export type AgentModelRoutingRule = {
  /** All of these keywords must appear in the prompt (case-insensitive). */
  contains?: string[];
  /** At least one of these keywords must appear in the prompt (case-insensitive). */
  containsAny?: string[];
  /** Case-insensitive regex that must match the prompt. */
  regex?: string;
  /** Prompt character length must be at most this value (useful for routing short/simple requests to lighter models). */
  maxLength?: number;
  /** Prompt character length must be at least this value (useful for routing long/complex requests to more capable models). */
  minLength?: number;
  /** Model to use when this rule matches (provider/model, e.g. "openrouter/deepseek/deepseek-r1:free"). */
  model: string;
};

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
      /**
       * Per-message model routing rules evaluated against each prompt before sending.
       * Rules are checked top-down; the first match overrides the primary model for that message.
       * Useful for routing simple requests to cheaper models and complex ones to capable models.
       */
      routing?: AgentModelRoutingRule[];
    };

export type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all";
  /** Agent workspace access inside the sandbox. */
  workspaceAccess?: "none" | "ro" | "rw";
  /**
   * Session tools visibility for sandboxed sessions.
   * - "spawned": only allow session tools to target sessions spawned from this session (default)
   * - "all": allow session tools to target any session
   */
  sessionToolsVisibility?: "spawned" | "all";
  /** Container/workspace scope for sandbox isolation. */
  scope?: "session" | "agent" | "shared";
  /** Legacy alias for scope ("session" when true, "shared" when false). */
  perSession?: boolean;
  workspaceRoot?: string;
  /** Docker-specific sandbox settings. */
  docker?: SandboxDockerSettings;
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
