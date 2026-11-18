import { expect, it } from "vitest";
import { isGoalToolEvidence } from "./tool-evidence.js";

it.each(["Bash", "execute"])(
  "%s uses actual exit facts and excludes trivial commands",
  (name) => {
    const exited = JSON.stringify({ state: "exited", exitCode: 0 });
    expect(isGoalToolEvidence(name, exited, "pnpm test --grep true")).toBe(
      true,
    );
    for (const command of ["", " ", ";", "true", " :; ", "exit 0;"])
      expect(isGoalToolEvidence(name, exited, command)).toBe(false);
    for (const output of [
      { state: "running", exitCode: 0 },
      { state: "exited", exitCode: 1, output: "tests passed" },
      { state: "exited" },
    ])
      expect(
        isGoalToolEvidence(name, JSON.stringify(output), "pnpm test"),
      ).toBe(false);
  },
);

it.each(["TaskOutput", "task_output"])(
  "%s requires completed work and successful command summaries",
  (name) => {
    for (const summary of [
      { state: "exited", exitCode: 0 },
      JSON.stringify({ state: "exited", exitCode: 0 }),
      "Written report",
      undefined,
    ])
      expect(
        isGoalToolEvidence(
          name,
          JSON.stringify({ status: "completed", summary }),
        ),
      ).toBe(true);
    for (const summary of [
      { state: "exited", exitCode: 1 },
      JSON.stringify({ state: "exited", exitCode: 1 }),
      { state: "running", exitCode: null },
      { exitCode: 0 },
    ])
      expect(
        isGoalToolEvidence(
          name,
          JSON.stringify({ status: "completed", summary }),
        ),
      ).toBe(false);
    for (const output of [
      "not json",
      "{}",
      '{"status":"failed"}',
      '{"status":"running"}',
    ])
      expect(isGoalToolEvidence(name, output)).toBe(false);
  },
);

it("Goal control tools and empty output never qualify as tool evidence", () => {
  for (const name of ["GetGoal", "VerifyGoal"])
    expect(isGoalToolEvidence(name, "complete")).toBe(false);
  expect(isGoalToolEvidence("Read", " ")).toBe(false);
  expect(isGoalToolEvidence("Read", "actual content")).toBe(true);
});
