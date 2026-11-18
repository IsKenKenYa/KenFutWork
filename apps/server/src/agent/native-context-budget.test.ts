import { expect, it } from "vitest";
import { createInstanceChatModel as anthropic } from "../providers/anthropic/index.js";
import { createInstanceChatModel as gemini } from "../providers/gemini/index.js";
import { createInstanceChatModel as openai } from "../providers/openai-compatible/index.js";
import { resolveCompactionPlan } from "./auto-compact.js";
import { nativeEffectiveOutputTokens } from "./native-context-budget.js";

it.each([
  [
    "completions",
    () =>
      openai(
        "gateway-model",
        { apiKey: "fixture", useResponsesApi: false },
        { max_tokens: 1_024 },
      ),
  ],
  [
    "reasoning-completions",
    () =>
      openai(
        "o3-mini",
        { apiKey: "fixture", useResponsesApi: false },
        { max_completion_tokens: 1_024 },
      ),
  ],
  [
    "responses",
    () =>
      openai(
        "gateway-model",
        { apiKey: "fixture", useResponsesApi: true },
        { max_output_tokens: 1_024 },
      ),
  ],
  [
    "anthropic",
    () =>
      anthropic("claude-test", { apiKey: "fixture" }, { max_tokens: 1_024 }),
  ],
  [
    "gemini",
    () =>
      gemini(
        "gemini-test",
        { apiKey: "fixture" },
        { generationConfig: { maxOutputTokens: 1_024 } },
      ),
  ],
] as const)(
  "native %s contract uses actual wire output cap rather than catalog capacity",
  (_name, create) => {
    const effective = nativeEffectiveOutputTokens(create());
    expect(effective).toBe(1_024);
    const actual = resolveCompactionPlan({
      contextWindow: 100_000,
      maxOutputTokens: effective,
    });
    const catalog = resolveCompactionPlan({
      contextWindow: 100_000,
      maxOutputTokens: 80_000,
    });
    expect(actual.trigger.value).toBe(98_976);
    expect(catalog.trigger.value).toBe(20_000);
  },
);

it("captures real Anthropic SDK default and leaves unspecified OpenAI limit unknown", () => {
  const actual = anthropic("claude-test", { apiKey: "fixture" });
  const parameters =
    "invocationParams" in actual &&
    typeof actual.invocationParams === "function"
      ? (actual.invocationParams.call(actual) as { max_tokens?: number })
      : undefined;
  if (!parameters || typeof parameters.max_tokens !== "number")
    throw new Error("actual SDK default missing");
  expect(nativeEffectiveOutputTokens(actual)).toBe(parameters.max_tokens);
  expect(
    nativeEffectiveOutputTokens(
      openai("gateway-model", { apiKey: "fixture", useResponsesApi: false }),
    ),
  ).toBeNull();
});

it("invalid or contradictory real wire fields fail loud rather than hiding behind a catalog fallback", () => {
  expect(() =>
    nativeEffectiveOutputTokens(
      openai(
        "gateway-model",
        { apiKey: "fixture", useResponsesApi: false },
        { max_tokens: -1 },
      ),
    ),
  ).toThrow("输出上限无效");
  expect(() =>
    nativeEffectiveOutputTokens(
      openai(
        "gateway-model",
        { apiKey: "fixture", useResponsesApi: false },
        { max_tokens: 100, max_completion_tokens: 200 },
      ),
    ),
  ).toThrow("输出上限冲突");
});
