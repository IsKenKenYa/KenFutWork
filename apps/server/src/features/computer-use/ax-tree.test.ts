import { describe, expect, it } from "vitest";

import {
  flattenAxTree,
  formatAxTree,
  type AxNode,
} from "./ax-tree.js";

const calcTree: AxNode = {
  role: "group",
  title: "CalculatorKeypadView",
  states: ["focused"],
  children: [
    {
      role: "text",
      title: "编辑字段",
      value: "四点二",
    },
    {
      role: "button",
      title: "7",
      states: ["pressable"],
      actions: ["AXPress"],
    },
    {
      role: "splitter",
      value: "-1",
      states: ["editable", "disabled"],
    },
    {
      role: "scrollarea",
      title: "StandardInputView",
      value: "4.2",
      actions: ["拷贝"],
    },
  ],
};

describe("flattenAxTree（AX 树展平 + 索引）", () => {
  it("深度优先展平并分配连续索引", () => {
    const rows = flattenAxTree(calcTree);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[0]?.node.role).toBe("group");
    expect(rows[0]?.depth).toBe(0);
    expect(rows[1]?.depth).toBe(1);
  });

  it("空树（无 children）仍产出根行", () => {
    const rows = flattenAxTree({ role: "window", title: "计算器" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.node.role).toBe("window");
  });
});

describe("formatAxTree（观察树文本化）", () => {
  const base = {
    app: { pid: 24231, bundleId: "com.apple.calculator", name: "计算器" },
    window: {
      windowId: 6363,
      title: "计算器",
      bounds: [990, 382, 230, 408] as [number, number, number, number],
    },
    stateId: "s-1",
  };

  it("行格式：状态括号 / 动作清单 / text 的 title = value / 其他 title;value:v", () => {
    const out = formatAxTree({ ...base, root: calcTree, maxBytes: 8192 });
    const lines = out.text.split("\n");
    // 头两行是 app/window 摘要，其后是元素行
    expect(lines[0]).toContain("app: com.apple.calculator");
    expect(lines[1]).toContain('window: "计算器"');
    expect(out.text).toContain("[1] text 编辑字段 = 四点二");
    expect(out.text).toContain("[2] button 7 (pressable) actions=[AXPress]");
    expect(out.text).toContain("[3] splitter = -1 (editable disabled)");
    expect(out.text).toContain(
      "[4] scrollarea StandardInputView;value:4.2 actions=[拷贝]",
    );
  });

  it("structuredContent 带 state_id/app/window/has_image/element_count", () => {
    const out = formatAxTree({ ...base, root: calcTree, maxBytes: 8192 });
    expect(out.structuredContent.state_id).toBe("s-1");
    expect(out.structuredContent.app.bundle_id).toBe("com.apple.calculator");
    expect(out.structuredContent.window.title).toBe("计算器");
    expect(out.structuredContent.has_image).toBe(false);
    expect(out.structuredContent.element_count).toBe(5);
    expect(out.structuredContent.snapshot_mode).toBe("full");
  });

  it("超预算裁剪：保留祖先、丢弃最深行、索引保留跳号、头部声明", () => {
    const deep: AxNode = {
      role: "group",
      title: "L0",
      children: [
        {
          role: "group",
          title: "L1",
          children: Array.from({ length: 40 }, (_, i) => ({
            role: "button",
            title: `deep-${i}-${"x".repeat(20)}`,
            states: ["pressable"],
          })),
        },
      ],
    };
    const out = formatAxTree({ ...base, root: deep, maxBytes: 1024 });
    expect(out.truncated).toBe(true);
    expect(out.structuredContent.trimmed).toBeGreaterThan(0);
    // 头部声明裁剪
    expect(out.text).toContain("trimmed");
    // 祖先保留
    expect(out.text).toContain("L0");
    expect(out.text).toContain("L1");
    // 被裁行不出现
    expect(out.text).not.toContain("deep-0-");
    // 未超预算时 trimmed 不出现
    const full = formatAxTree({ ...base, root: calcTree, maxBytes: 8192 });
    expect(full.truncated).toBe(false);
    expect(full.structuredContent.trimmed).toBeUndefined();
  });
});
