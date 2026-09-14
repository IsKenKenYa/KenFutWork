import { describe, expect, it, vi } from "vitest";

import {
  buildConversationText,
  CHAT_MENU_ITEMS,
  clampMenuPosition,
  copyTextToClipboard,
  extractMessageText,
  readClipboardText,
  selectAllTextIn,
  toChatMenuMessages,
} from "../src/lib/chat-menu.js";

/**
 * 回归背景：对话区此前右键没有菜单（应用内浏览器不弹原生菜单），用户无法复制/粘贴。
 * 纯逻辑（导出文本、落点收敛、剪贴板读写）在此锁死；渲染层由组件承担。
 */
describe("对话区右键菜单逻辑", () => {
  it("整段对话导出为文本：按角色标注、跳过无文本消息、保留顺序", () => {
    const text = buildConversationText([
      { role: "user", text: "帮我写个脚本" },
      { role: "assistant", text: "" }, // 只有工具调用，无文本
      { role: "assistant", text: "好的，已完成" },
    ]);
    expect(text).toBe("我：帮我写个脚本\n\n助手：好的，已完成");
  });

  it("空对话导出为空串（不产出空行）", () => {
    expect(buildConversationText([])).toBe("");
    expect(buildConversationText([{ role: "assistant", text: "   " }])).toBe(
      "",
    );
  });

  it("菜单落点：正常在光标处，右侧/下方越界时向内收", () => {
    const size = { width: 160, height: 140 };
    const viewport = { width: 1000, height: 800 };
    expect(clampMenuPosition({ x: 300, y: 200 }, size, viewport)).toEqual({
      x: 300,
      y: 200,
    });
    // 右下角点击 → 收进视口内
    expect(clampMenuPosition({ x: 990, y: 790 }, size, viewport)).toEqual({
      x: 832,
      y: 652,
    });
    // 左上角负值/零 → 收到安全边距
    expect(clampMenuPosition({ x: 0, y: -20 }, size, viewport)).toEqual({
      x: 8,
      y: 8,
    });
  });

  it("复制：走 Clipboard API；API 失败回落 execCommand", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyTextToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");

    // 失败回落
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    vi.stubGlobal("document", {
      createElement: () => ({
        style: {},
        setAttribute: () => {},
        select: () => {},
      }),
      body: { appendChild: () => {}, removeChild: () => {} },
      execCommand,
    });
    await expect(copyTextToClipboard("fallback")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");

    // 空文本不写剪贴板
    await expect(copyTextToClipboard("")).resolves.toBe(false);
    vi.unstubAllGlobals();
  });

  it("读取剪贴板：被拒/不支持时返回 null（调用方据此提示用快捷键）", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn().mockResolvedValue("pasted") },
    });
    await expect(readClipboardText()).resolves.toBe("pasted");

    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await expect(readClipboardText()).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it("全选：容器为空时返回 false，不抛错", () => {
    expect(selectAllTextIn(null)).toBe(false);
  });

  it("菜单项齐备且含用户点名的四项", () => {
    expect(CHAT_MENU_ITEMS.map((item) => item.label)).toEqual([
      "复制",
      "粘贴",
      "全选对话",
      "复制当前对话",
    ]);
  });
});

describe("消息文本提取（供「复制当前对话」）", () => {
  it("只取 text 块，忽略思考/工具块", () => {
    expect(
      extractMessageText([
        { type: "thinking", content: "内部思考" },
        { type: "text", content: "正文一" },
        { type: "tool", content: "工具输出" },
        { type: "text", content: "正文二" },
      ]),
    ).toBe("正文一\n正文二");
  });

  it("无块/空块返回空串；toChatMenuMessages 兜底 content 字段", () => {
    expect(extractMessageText(null)).toBe("");
    expect(extractMessageText([])).toBe("");
    expect(
      toChatMenuMessages([
        { role: "user", contentBlocks: [{ type: "text", content: "hi" }] },
        { role: "assistant", content: "旧格式正文" },
      ]),
    ).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "旧格式正文" },
    ]);
  });
});
