import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { goalEvidence, goalEvidenceCandidates } from "./goals.js";

function row(command: string, result: unknown, status = "success") {
  return protocol.toolCallRowSchema.parse({
    rowId: 1,
    turnId: "r",
    createdAt: 0,
    createdAtSeq: 0,
    kind: "toolCall",
    toolCallId: "r/test",
    toolName: "Bash",
    inputText: JSON.stringify({ command }),
    input: { command },
    status,
    ...(status === "error"
      ? { error: { code: "failed", message: "failed" } }
      : {}),
    output: { text: JSON.stringify(result) },
  });
}
it("验收根据canonical退出事实，不猜命令或输出文本", () => {
  for (const command of [
    "pnpm test --grep true",
    "node scripts/verify.mjs",
    "tsc --noEmit",
    "echo answer",
    "printf answer",
  ]) {
    expect(
      goalEvidence([row(command, { state: "exited", exitCode: 0 })], "r", [
        "row:1",
      ])[0]?.tool,
    ).toEqual({
      name: "Bash",
      inputText: JSON.stringify({ command }),
    });
    expect(
      goalEvidence(
        [row(command, { state: "exited", exitCode: 0, output: "" })],
        "r",
        ["row:1"],
      )[0]?.passed,
    ).toBe(true);
  }
  expect(() =>
    goalEvidence(
      [
        row("pnpm test", {
          state: "exited",
          exitCode: 1,
          output: "tests passed",
        }),
      ],
      "r",
      ["row:1"],
    ),
  ).toThrow();
  for (const command of ["true", ":", "exit 0"])
    expect(() =>
      goalEvidence([row(command, { state: "exited", exitCode: 0 })], "r", [
        "row:1",
      ]),
    ).toThrow();
  expect(() =>
    goalEvidence([row("test", { state: "running", exitCode: null })], "r", [
      "row:1",
    ]),
  ).toThrow();
});
it("候选只显示当前Run真实row身份，主观答复可引用已完整正文", () => {
  const answer = protocol.assistantTextRowSchema.parse({
    rowId: 2,
    turnId: "r",
    createdAt: 0,
    createdAtSeq: 0,
    kind: "assistantText",
    text: "Research conclusion",
    state: "complete",
  });
  expect(goalEvidenceCandidates([answer], "r", 7)).toEqual([
    { id: "row:2", kind: "assistantText", revision: 7 },
  ]);
  expect(goalEvidence([answer], "r", ["row:2"])[0]?.detail).toBe(
    "Research conclusion",
  );
  expect(() => goalEvidence([answer], "old", ["row:2"])).toThrow();
  expect(() => goalEvidence([answer], "r", ["row:999"])).toThrow();
  expect(() => goalEvidence([], "r", [])).toThrow();
});

it("后台结果验收消费真实completed与命令退出码，不接受失败正文", () => {
  const output = (status: string, exitCode: number) => ({
    ...row("ignored", {
      status,
      summary: JSON.stringify({
        state: "exited",
        exitCode,
        output: "tests passed",
      }),
    }),
    toolName: "TaskOutput",
  });
  expect(
    goalEvidence([output("completed", 0)], "r", ["row:1"])[0]?.passed,
  ).toBe(true);
  expect(() =>
    goalEvidence([output("completed", 1)], "r", ["row:1"]),
  ).toThrow();
  expect(() => goalEvidence([output("failed", 0)], "r", ["row:1"])).toThrow();
  expect(() =>
    goalEvidence([{ ...output("completed", 0), toolName: "GetGoal" }], "r", [
      "row:1",
    ]),
  ).toThrow();
});

it.each(["TaskOutput", "task_output"])(
  "%s excludes failed summaries without accepting assistant claims as tool receipts",
  (toolName) => {
    const answer = protocol.assistantTextRowSchema.parse({
      rowId: 2,
      turnId: "r",
      createdAt: 0,
      createdAtSeq: 0,
      kind: "assistantText",
      text: "The command passed",
      state: "complete",
    });
    for (const summary of [
      { state: "exited", exitCode: 1 },
      JSON.stringify({ state: "exited", exitCode: 1 }),
      { state: "running", exitCode: null },
    ]) {
      const result = {
        ...row("ignored", { status: "completed", summary }),
        toolName,
      };
      expect(goalEvidenceCandidates([answer, result], "r", 3)).toEqual([
        { id: "row:2", kind: "assistantText", revision: 3 },
      ]);
      expect(() =>
        goalEvidence([answer, result], "r", ["row:2", "row:1"]),
      ).toThrow();
    }
    expect(() => goalEvidence([answer], "r", ["row:1"])).toThrow();
  },
);

it("Goal control tools remain excluded from real tool evidence", () => {
  for (const toolName of ["GetGoal", "VerifyGoal"])
    expect(
      goalEvidenceCandidates(
        [{ ...row("ignored", { status: "completed" }), toolName }],
        "r",
        1,
      ),
    ).toEqual([]);
});

it("缺少原始命令的成功退出结果不能作为Goal验收证据", () => {
  for (const command of ["", " ", ";"]) {
    const receipt = row(command, { state: "exited", exitCode: 0 });
    expect(goalEvidenceCandidates([receipt], "r", 7)).toEqual([]);
    expect(() => goalEvidence([receipt], "r", ["row:1"])).toThrow();
  }
  for (const input of [{}, { command: null }, { command: 123 }]) {
    const receipt = {
      ...row("ignored", { state: "exited", exitCode: 0 }),
      input,
      inputText: JSON.stringify(input),
    };
    expect(goalEvidenceCandidates([receipt], "r", 7)).toEqual([]);
    expect(() => goalEvidence([receipt], "r", ["row:1"])).toThrow();
  }
});

it("画布工具的失败和零应用结果不能验收，部分成功保留真实结果", () => {
  for (const result of [
    { error: "write_failed", message: "画布保存失败。" },
    { success: false },
    { ok: false },
    { success: true, applied: 0, errors: ["[skip] element not found"] },
  ]) {
    const receipt = {
      ...row("ignored", result),
      toolName: "manipulate_canvas",
    };
    expect(goalEvidenceCandidates([receipt], "r", 7)).toEqual([]);
    expect(() => goalEvidence([receipt], "r", ["row:1"])).toThrow();
  }

  const result = {
    success: true,
    applied: 1,
    summary: "added text",
    errors: ["[skip] element not found"],
  };
  const receipt = { ...row("ignored", result), toolName: "manipulate_canvas" };
  expect(goalEvidenceCandidates([receipt], "r", 7)).toEqual([
    { id: "row:1", kind: "toolCall", revision: 7 },
  ]);
  expect(goalEvidence([receipt], "r", ["row:1"])[0]).toMatchObject({
    passed: true,
    detail: JSON.stringify(result),
  });
});
