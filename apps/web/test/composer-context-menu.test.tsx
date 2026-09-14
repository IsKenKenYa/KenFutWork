import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useComposerContextMenu } from "../src/components/chat/composer-context-menu.js";
import { COMPOSER_MENU_ITEMS } from "../src/lib/composer-edit.js";

/**
 * 输入框右键菜单的动作层：在真实 textarea 上验证选区与回填
 * （纯区间/历史逻辑已在 composer-edit.test.ts 覆盖，这里锁「接线」）。
 */
afterEach(() => {
  vi.unstubAllGlobals();
  document
    .querySelectorAll("textarea[data-test-harness]")
    .forEach((el) => el.remove());
});

/** 真实挂载 textarea（选区语义依赖 DOM 连接），并把受控值同步到 DOM。 */
function createHarnessTextarea(): HTMLTextAreaElement {
  const existing = document.querySelector<HTMLTextAreaElement>(
    "textarea[data-test-harness]",
  );
  if (existing) return existing;
  const el = document.createElement("textarea");
  el.setAttribute("data-test-harness", "");
  document.body.appendChild(el);
  return el;
}

function useHarness(
  initial = "",
  options: { onNotice?: (message: string) => void } = {},
) {
  const [value, setValue] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  if (!textareaRef.current) {
    textareaRef.current = createHarnessTextarea();
  }
  // 受控输入框：DOM 值跟随 state（组件里由 React 负责，这里手动同步）
  textareaRef.current.value = value;
  const menu = useComposerContextMenu({
    value,
    setValue,
    textareaRef,
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
  });
  return { value, setValue, textareaRef, menu };
}

const item = (id: string) =>
  COMPOSER_MENU_ITEMS.find((entry) => entry.id === id)!;

describe("输入框右键菜单动作", () => {
  it("全选：把选区设为整段文本", async () => {
    const { result } = renderHook(() => useHarness("hello"));
    act(() =>
      result.current.menu.open({
        preventDefault: () => {},
      } as React.MouseEvent),
    );
    await act(async () => {
      await result.current.menu.run(item("select-all"));
    });
    const el = result.current.textareaRef.current as HTMLTextAreaElement;
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe(5);
  });

  it("粘贴：把剪贴板文本插入光标处并更新值", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn().mockResolvedValue("X") },
    });
    const { result } = renderHook(() => useHarness("ab"));
    const el = result.current.textareaRef.current as HTMLTextAreaElement;
    el.setSelectionRange(1, 1);

    await act(async () => {
      await result.current.menu.run(item("paste"));
    });
    expect(result.current.value).toBe("aXb");
  });

  it("删除/剪切：无选区时给提示且不改值", async () => {
    const notices: string[] = [];
    const { result } = renderHook(() =>
      useHarness("abc", { onNotice: (message) => notices.push(message) }),
    );
    const el = result.current.textareaRef.current as HTMLTextAreaElement;
    el.setSelectionRange(1, 1); // 无选区

    await act(async () => {
      await result.current.menu.run(item("delete"));
    });
    expect(result.current.value).toBe("abc");
    expect(notices.at(-1)).toContain("先选中");
  });

  it("剪贴板被拒时粘贴给出改用快捷键的提示", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const notices: string[] = [];
    const { result } = renderHook(() =>
      useHarness("ab", { onNotice: (message) => notices.push(message) }),
    );

    await act(async () => {
      await result.current.menu.run(item("paste"));
    });
    expect(notices.at(-1)).toContain("Ctrl+V");
  });

  it("无历史时撤销给提示（不误报成功）", async () => {
    const notices: string[] = [];
    const { result } = renderHook(() =>
      useHarness("x", { onNotice: (message) => notices.push(message) }),
    );

    await act(async () => {
      await result.current.menu.run(item("undo"));
    });
    expect(notices.at(-1)).toContain("没有可撤销");
  });
});
