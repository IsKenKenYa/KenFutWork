import { expect, test } from "vitest";
import { parseV4VisibleSlashCommand } from "../src/components/workbench/zcode/v4/slashCommands.js";

test.each(["完成项目说明\n核对实际文件", "补充原目标要求", "新的目标", ""])(
  "普通输入%s保持消息语义",
  (text) => {
    expect(parseV4VisibleSlashCommand(text)).toBeNull();
    expect(parseV4VisibleSlashCommand(text, [{}])).toBeNull();
    expect(
      parseV4VisibleSlashCommand(text, [], { contextAttachmentCount: 1 }),
    ).toBeNull();
  },
);

test.each(["/goal", "/target"])(
  "明确%s命令创建Goal并保留目标文本",
  (command) => {
    expect(
      parseV4VisibleSlashCommand(`${command} 完成项目说明\n核对实际文件`),
    ).toEqual({
      kind: "sendGoalCommand",
      objective: "完成项目说明\n核对实际文件",
      displayText: `${command} 完成项目说明\n核对实际文件`,
    });
  },
);

test("Goal恢复和压缩保留各自命令，附件与输入上下文继续按原边界处理", () => {
  expect(parseV4VisibleSlashCommand("/goal resume")).toMatchObject({
    kind: "resumeGoal",
  });
  expect(parseV4VisibleSlashCommand("/compact")).toMatchObject({
    kind: "compact",
  });
  expect(parseV4VisibleSlashCommand("/goal 新的目标", [{}])).toBeNull();
  expect(
    parseV4VisibleSlashCommand("/goal 新的目标", [], {
      contextAttachmentCount: 1,
    }),
  ).toBeNull();
});
