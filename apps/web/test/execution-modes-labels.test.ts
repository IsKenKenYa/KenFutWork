import { describe, expect, it } from "vitest";

import {
  EXECUTION_MODES_ORDER,
  executionModeLabel,
  executionModeOptions,
} from "../src/lib/execution-modes";

/**
 * 回归：**词表没到之前不能把原始 id 露给用户**。
 *
 * 实测（2026-09-19，打包版）：模式 chip 的标签来自服务端词表，而词表要等会话就绪才拉得动；
 * 首屏那一小段时间 `executionModes` 是空数组，Radix 的 Select 只能渲染 value 本身——
 * 用户看到的是英文 `agent`、点开还是个空列表。
 */
describe("执行模式标签的本地兜底", () => {
  it("六档都有中文兜底标签，顺序固定", () => {
    expect(EXECUTION_MODES_ORDER).toHaveLength(6);
    for (const id of EXECUTION_MODES_ORDER) {
      const label = executionModeLabel(id);
      expect(label).not.toBe(id); // 兜底也不该等于 id（否则等于没兜）
      expect(label).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it("词表为空时下拉仍有六项（而不是空的）", () => {
    const options = executionModeOptions([]);
    expect(options.map((option) => option.id)).toEqual([
      ...EXECUTION_MODES_ORDER,
    ]);
    expect(options.map((option) => option.label)).toContain("自主");
  });

  it("服务端词表到了以它为准（含后端新增的档位）", () => {
    const options = executionModeOptions([
      { id: "agent", label: "服务端叫法" },
      { id: "extra" as never, label: "新档位" },
    ]);
    expect(options.find((option) => option.id === "agent")?.label).toBe(
      "服务端叫法",
    );
    expect(options.some((option) => option.id === ("extra" as never))).toBe(
      true,
    );
    // 词表没覆盖到的档位仍由本地兜底补齐
    expect(options.find((option) => option.id === "plan")?.label).toBe("计划");
  });
});
