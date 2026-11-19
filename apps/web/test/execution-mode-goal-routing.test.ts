import { expect, test } from "vitest";
import { parseV4VisibleSlashCommand } from "../src/components/workbench/zcode/v4/slashCommands.js";

test("目标工作方式的普通输入产生原生Goal命令，保留目标文本", () => {
  expect(
    parseV4VisibleSlashCommand("完成项目说明\n核对实际文件", [], {
      executionMode: "goal",
    }),
  ).toEqual({
    kind: "sendGoalCommand",
    objective: "完成项目说明\n核对实际文件",
    displayText: "完成项目说明\n核对实际文件",
  });
  expect(
    parseV4VisibleSlashCommand("普通输入", [], { executionMode: "agent" }),
  ).toBeNull();
  expect(
    parseV4VisibleSlashCommand("/compact", [], { executionMode: "goal" }),
  ).toMatchObject({ kind: "compact" });
  expect(
    parseV4VisibleSlashCommand("使用附件完成目标", [{}], {
      executionMode: "goal",
    }),
  ).toMatchObject({ kind: "unsupportedGoal", action: "attachments" });
});

test.each(["active", "paused", "verifying", "notSatisfied", "failed"] as const)(
  "目标处于%s时，已选目标方式的新文本仍引导原Goal，不再新建",
  (goalStatus) => {
    expect(
      parseV4VisibleSlashCommand("补充原目标要求", [], {
        executionMode: "goal",
        goalStatus,
      }),
    ).toBeNull();
  },
);

test("已验收的目标允许下次文本创建新Goal", () => {
  expect(
    parseV4VisibleSlashCommand("新的目标", [], {
      executionMode: "goal",
      goalStatus: "verified",
    }),
  ).toMatchObject({ kind: "sendGoalCommand", objective: "新的目标" });
});
