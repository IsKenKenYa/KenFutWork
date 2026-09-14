import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatContextMenu } from "../src/components/chat/chat-context-menu.js";

/**
 * 渲染层：对话区右键菜单（应用内浏览器不弹原生菜单 → 必须自绘）。
 * 交互（复制/粘贴/全选/复制对话）在 jsdom 里逐项走通，补足浏览器点击通道不可用时的验证。
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderMenu(overrides?: {
  messages?: Array<{ role: string; text: string }>;
  onPasteText?: (text: string) => void;
  onNotice?: (message: string) => void;
}) {
  const containerRef = createRef<HTMLDivElement>();
  const onClose = vi.fn();
  const onPasteText = overrides?.onPasteText ?? vi.fn();
  const onNotice = overrides?.onNotice ?? vi.fn();
  render(
    <div>
      <div ref={containerRef}>对话内容</div>
      <ChatContextMenu
        state={{ x: 40, y: 60 }}
        messages={overrides?.messages ?? [{ role: "user", text: "你好" }]}
        containerRef={containerRef}
        onPasteText={onPasteText}
        onNotice={onNotice}
        onClose={onClose}
      />
    </div>,
  );
  return { onClose, onPasteText, onNotice };
}

describe("对话区右键菜单（渲染与交互）", () => {
  it("渲染四项：复制 / 粘贴 / 全选对话 / 复制当前对话", () => {
    renderMenu();
    const menu = screen.getByRole("menu", { name: "对话菜单" });
    expect(menu).toBeDefined();
    // 逐项断言标签（按钮的可访问名会拼上右侧快捷键，故直接读标签节点）
    const labels = [
      ...menu.querySelectorAll('button[role="menuitem"] span:first-child'),
    ].map((node) => node.textContent);
    expect(labels).toEqual(["复制", "粘贴", "全选对话", "复制当前对话"]);
  });

  it("粘贴：读剪贴板并回填输入框，随后关闭菜单", async () => {
    const write = { readText: vi.fn().mockResolvedValue("粘贴内容") };
    vi.stubGlobal("navigator", { clipboard: write });
    const { onPasteText, onClose } = renderMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /粘贴/ }));

    await waitFor(() => expect(onPasteText).toHaveBeenCalledWith("粘贴内容"));
    expect(onClose).toHaveBeenCalled();
  });

  it("粘贴失败（权限被拒）：给出改用快捷键的提示，不回填", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const { onPasteText, onNotice } = renderMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /粘贴/ }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Ctrl+V")),
    );
    expect(onPasteText).not.toHaveBeenCalled();
  });

  it("复制对话：把整段对话按角色导出到剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { onNotice } = renderMenu({
      messages: [
        { role: "user", text: "问题" },
        { role: "assistant", text: "回答" },
      ],
    });

    fireEvent.click(screen.getByRole("menuitem", { name: /复制当前对话/ }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("我：问题\n\n助手：回答"),
    );
    expect(onNotice).toHaveBeenCalledWith("已复制本轮对话。");
  });

  it("无可复制内容时不写剪贴板并提示", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { onNotice } = renderMenu({ messages: [] });

    fireEvent.click(screen.getByRole("menuitem", { name: /复制当前对话/ }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("还没有")),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it("state 为空时不渲染菜单", () => {
    render(
      <ChatContextMenu
        state={null}
        messages={[]}
        containerRef={createRef<HTMLElement>()}
        onPasteText={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
