import { expect, it } from "vitest";
import { executionModeOptions } from "../src/lib/execution-modes";

it("retired Loop is never restored by the first-party selector fallback", () => {
  expect(executionModeOptions().map((mode) => mode.id)).toEqual([
    "agent",
    "plan",
    "solo",
    "goal",
    "creative",
  ]);
  expect(
    executionModeOptions([{ id: "loop", label: "循环" }]).some(
      (mode) => mode.id === "loop",
    ),
  ).toBe(false);
});
