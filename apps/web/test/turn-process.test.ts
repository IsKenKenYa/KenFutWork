import { describe, expect, it } from "vitest";
import {
  deriveTurnProcesses,
  specCoveringIndex,
} from "../src/lib/turn-process";
import type { TaskMessage } from "../src/lib/workbench-tools";

/**
 * 轮级过程折叠（deepseek-harness Turn Process Folding 同款）的纯逻辑测试。
 *
 * 锁住的用户口径与规则：
 * - 跑完且**有结论**的轮才折叠：结论（尾部正文）永远可见，过程收进控制行；
 * - **运行中不折叠**（过程正在展开才是常态）；旧轮次在任务还运行时也已关闭；
 * - 展开后逐行原位可见——折叠不是有损聚合（2026-09-20 用户三次反馈的底线）。
 */

function user(text: string, startedAt?: number): TaskMessage {
  return { role: "user", text, ...(startedAt ? { startedAt } : {}) };
}

function assistant(
  blocks: NonNullable<TaskMessage["blocks"]>,
  extra: Partial<TaskMessage> = {},
): TaskMessage {
  const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { role: "assistant", text, blocks, ...extra };
}

describe("deriveTurnProcesses 折叠判定", () => {
  it("单轮跑完：工具/思考/中途输出进折叠区，尾部正文是答案", () => {
    const messages = [
      user("改一下首页", 1000),
      assistant([{ type: "reasoning", text: "先看看结构" }], {
        startedAt: 1100,
      }),
      assistant([
        {
          type: "tool",
          tool: {
            toolCallId: "t1",
            toolName: "read_file",
            status: "completed",
          },
        },
        {
          type: "tool",
          tool: {
            toolCallId: "t2",
            toolName: "edit_file",
            status: "completed",
          },
        },
        { type: "text", text: "改好了：", at: 2000 },
      ]),
    ];
    const specs = deriveTurnProcesses(messages, true);
    expect(specs).toHaveLength(1);
    const spec = specs[0];
    expect(spec?.turnIndex).toBe(1);
    expect(spec?.startIndex).toBe(1);
    expect(spec?.answerIndex).toBe(2);
    expect(spec?.answerTailText).toBe("改好了：");
    expect(spec?.toolCount).toBe(2);
    expect(spec?.reasoningCount).toBe(1);
    expect(spec?.foldedTextCount).toBe(0);
  });

  it("任务运行中：最后一轮不折叠", () => {
    const messages = [
      user("跑个任务", 1000),
      assistant([
        {
          type: "tool",
          tool: { toolCallId: "t1", toolName: "execute", status: "completed" },
        },
        { type: "text", text: "做完了" },
      ]),
    ];
    expect(deriveTurnProcesses(messages, false)).toHaveLength(0);
  });

  it("多轮：旧轮次在任务仍运行时也已关闭（下一条用户消息即轮界）", () => {
    const messages = [
      user("第一轮", 1000),
      assistant([
        {
          type: "tool",
          tool: {
            toolCallId: "t1",
            toolName: "read_file",
            status: "completed",
          },
        },
        { type: "text", text: "第一轮结论" },
      ]),
      user("第二轮", 5000),
      assistant([{ type: "text", text: "还在做" }]),
    ];
    const specs = deriveTurnProcesses(messages, false);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.turnIndex).toBe(1);
    expect(specs[0]?.answerIndex).toBe(1);
  });

  it("没有答案（轮尾是工具/思考）不折叠——折了就没有可看的结论", () => {
    const messages = [
      user("看一眼", 1000),
      assistant([
        {
          type: "tool",
          tool: { toolCallId: "t1", toolName: "read_file", status: "running" },
        },
      ]),
    ];
    expect(deriveTurnProcesses(messages, true)).toHaveLength(0);
  });

  it("失败收尾且只有过程没有正文：不折叠", () => {
    const messages = [
      user("跑", 1000),
      assistant([
        {
          type: "tool",
          tool: { toolCallId: "t1", toolName: "execute", status: "completed" },
        },
      ]),
    ];
    expect(deriveTurnProcesses(messages, true)).toHaveLength(0);
  });

  it("纯文本轮（没有任何过程）：不折叠", () => {
    const messages = [
      user("你好", 1000),
      assistant([{ type: "text", text: "你好！有什么可以帮你？" }]),
    ];
    expect(deriveTurnProcesses(messages, true)).toHaveLength(0);
  });

  it("答案消息内的 [思考, 正文]：思考折叠、正文保留", () => {
    const messages = [
      user("总结一下", 1000),
      assistant([
        { type: "reasoning", text: "组织语言…" },
        { type: "text", text: "结论如下" },
      ]),
    ];
    const specs = deriveTurnProcesses(messages, true);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.reasoningCount).toBe(1);
    expect(specs[0]?.toolCount).toBe(0);
    expect(specs[0]?.answerTailText).toBe("结论如下");
  });

  it("多条中途助手消息：正文段计数折叠，最后一条的尾部是答案", () => {
    const messages = [
      user("做", 1000),
      assistant([{ type: "text", text: "先说说思路" }], { startedAt: 1100 }),
      assistant([
        {
          type: "tool",
          tool: {
            toolCallId: "t1",
            toolName: "write_file",
            status: "completed",
          },
        },
        { type: "text", text: "写完了" },
      ]),
    ];
    const specs = deriveTurnProcesses(messages, true);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.foldedTextCount).toBe(1);
    expect(specs[0]?.startIndex).toBe(1);
    expect(specs[0]?.answerIndex).toBe(2);
  });

  it("旧数据（无 blocks 的助手消息）：中途消息整条折叠、答案消息整体即答案", () => {
    const messages = [
      user("旧对话", 1000),
      { role: "assistant", text: "先答一半" },
      { role: "assistant", text: "直接回答" },
      user("再来", 2000),
      { role: "assistant", text: "第二轮回答" },
    ] as TaskMessage[];
    const specs = deriveTurnProcesses(messages, true);
    // 第 1 轮有过程（中途消息）可折；第 2 轮只有孤零零一条答案，没有过程可收
    expect(specs).toHaveLength(1);
    expect(specs[0]?.turnIndex).toBe(1);
    expect(specs[0]?.startIndex).toBe(1);
    expect(specs[0]?.answerIndex).toBe(2);
    expect(specs[0]?.answerTailText).toBe("直接回答");
    expect(specs[0]?.foldedTextCount).toBe(1);
  });

  it("开头没有用户消息的助手消息：防御性归入第 1 轮", () => {
    const messages = [
      assistant([
        {
          type: "tool",
          tool: {
            toolCallId: "t1",
            toolName: "read_file",
            status: "completed",
          },
        },
        { type: "text", text: "结果" },
      ]),
    ];
    const specs = deriveTurnProcesses(messages, true);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.turnIndex).toBe(1);
    expect(specs[0]?.startIndex).toBe(0);
  });
});

describe("specCoveringIndex 折叠区命中", () => {
  const messages = [
    user("问", 1000),
    assistant([
      {
        type: "tool",
        tool: { toolCallId: "t1", toolName: "read_file", status: "completed" },
      },
      { type: "text", text: "答" },
    ]),
    user("再问", 3000),
    assistant([{ type: "text", text: "再答" }]),
  ];
  const specs = deriveTurnProcesses(messages, false);

  it("用户消息不落在折叠区（控制行不该挡住用户气泡）", () => {
    expect(specCoveringIndex(specs, 0)).toBeNull();
  });

  it("过程与答案消息都命中第 1 轮折叠区；第 2 轮消息不命中", () => {
    expect(specCoveringIndex(specs, 1)?.answerIndex).toBe(1);
    expect(specCoveringIndex(specs, 2)).toBeNull();
    expect(specCoveringIndex(specs, 3)).toBeNull();
  });
});
