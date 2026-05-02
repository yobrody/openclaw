import { describe, expect, it } from "vitest";
import { resolveAgentModelFromRouting } from "./model-input.js";

describe("resolveAgentModelFromRouting", () => {
  it("returns undefined when no routing config is present", () => {
    expect(resolveAgentModelFromRouting(undefined, "hello")).toBeUndefined();
    expect(resolveAgentModelFromRouting("openrouter/auto", "hello")).toBeUndefined();
    expect(resolveAgentModelFromRouting({ primary: "openrouter/auto" }, "hello")).toBeUndefined();
  });

  it("returns undefined when routing array is empty", () => {
    expect(resolveAgentModelFromRouting({ routing: [] }, "write me a function")).toBeUndefined();
  });

  it("matches by contains (all keywords must be present)", () => {
    const cfg = {
      routing: [
        { contains: ["code", "function"], model: "openrouter/deepseek/deepseek-r1:free" },
        { contains: ["image"], model: "openrouter/google/gemini-flash-1.5:free" },
      ],
    };
    expect(resolveAgentModelFromRouting(cfg, "write a code function for me")).toBe(
      "openrouter/deepseek/deepseek-r1:free",
    );
    expect(resolveAgentModelFromRouting(cfg, "analyze this image")).toBe(
      "openrouter/google/gemini-flash-1.5:free",
    );
    // Only one keyword present — should not match
    expect(resolveAgentModelFromRouting(cfg, "write some code")).toBeUndefined();
  });

  it("matches by containsAny (at least one keyword)", () => {
    const cfg = {
      routing: [
        {
          containsAny: ["debug", "error", "exception", "traceback"],
          model: "openrouter/anthropic/claude-sonnet-4-5",
        },
      ],
    };
    expect(resolveAgentModelFromRouting(cfg, "there's an error in my code")).toBe(
      "openrouter/anthropic/claude-sonnet-4-5",
    );
    expect(resolveAgentModelFromRouting(cfg, "I see a traceback")).toBe(
      "openrouter/anthropic/claude-sonnet-4-5",
    );
    expect(resolveAgentModelFromRouting(cfg, "hello world")).toBeUndefined();
  });

  it("matches by maxLength (short messages → light model)", () => {
    const cfg = {
      routing: [{ maxLength: 50, model: "openrouter/meta-llama/llama-3.3-70b:free" }],
    };
    expect(resolveAgentModelFromRouting(cfg, "hi")).toBe(
      "openrouter/meta-llama/llama-3.3-70b:free",
    );
    expect(resolveAgentModelFromRouting(cfg, "a".repeat(51))).toBeUndefined();
  });

  it("matches by minLength (long messages → capable model)", () => {
    const cfg = {
      routing: [{ minLength: 200, model: "openrouter/anthropic/claude-opus-4-6" }],
    };
    expect(resolveAgentModelFromRouting(cfg, "x".repeat(200))).toBe(
      "openrouter/anthropic/claude-opus-4-6",
    );
    expect(resolveAgentModelFromRouting(cfg, "short")).toBeUndefined();
  });

  it("matches by regex", () => {
    const cfg = {
      routing: [
        { regex: "\\b(sql|query|database|db)\\b", model: "openrouter/deepseek/deepseek-r1:free" },
      ],
    };
    expect(resolveAgentModelFromRouting(cfg, "write a SQL query")).toBe(
      "openrouter/deepseek/deepseek-r1:free",
    );
    expect(resolveAgentModelFromRouting(cfg, "optimize my DB schema")).toBe(
      "openrouter/deepseek/deepseek-r1:free",
    );
    expect(resolveAgentModelFromRouting(cfg, "tell me a joke")).toBeUndefined();
  });

  it("skips rules with invalid regex without crashing", () => {
    const cfg = {
      routing: [
        { regex: "[invalid(", model: "openrouter/bad" },
        { contains: ["hello"], model: "openrouter/good" },
      ],
    };
    expect(resolveAgentModelFromRouting(cfg, "hello world")).toBe("openrouter/good");
  });

  it("returns first matching rule (top-down priority)", () => {
    const cfg = {
      routing: [
        { contains: ["code"], model: "openrouter/model-a" },
        { contains: ["code"], model: "openrouter/model-b" },
      ],
    };
    expect(resolveAgentModelFromRouting(cfg, "write code")).toBe("openrouter/model-a");
  });

  it("conditions within a rule are ANDed", () => {
    const cfg = {
      routing: [
        {
          contains: ["urgent"],
          containsAny: ["bug", "crash"],
          minLength: 10,
          model: "openrouter/fast-model",
        },
      ],
    };
    // All conditions met
    expect(resolveAgentModelFromRouting(cfg, "urgent bug fix needed")).toBe(
      "openrouter/fast-model",
    );
    // Missing containsAny match
    expect(resolveAgentModelFromRouting(cfg, "urgent request needed")).toBeUndefined();
    // Missing contains
    expect(resolveAgentModelFromRouting(cfg, "there is a bug in the code")).toBeUndefined();
  });

  it("is case-insensitive for keyword matching", () => {
    const cfg = {
      routing: [{ contains: ["CODE"], model: "openrouter/code-model" }],
    };
    expect(resolveAgentModelFromRouting(cfg, "Write some code for me")).toBe(
      "openrouter/code-model",
    );
  });

  it("skips rules with empty model string", () => {
    const cfg = {
      routing: [
        { contains: ["test"], model: "  " },
        { contains: ["test"], model: "openrouter/real-model" },
      ],
    };
    expect(resolveAgentModelFromRouting(cfg, "run the test")).toBe("openrouter/real-model");
  });
});
