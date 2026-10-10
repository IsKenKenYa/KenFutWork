import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DesignHome } from "../src/components/workbench/canvas-workbench/design-home";
import type { useDesignComposer } from "../src/components/workbench/canvas-workbench/use-design-composer";
import {
  installCodeRootBrowser,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";
import { createCodeRootHostFetch } from "./setup/code-root-host-http";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  restoreCodeRootBrowser();
});

it("Design空态原编辑器发送命令原文，客户端不展开模板或替换用户转录", async () => {
  installCodeRootBrowser();
  vi.stubGlobal("fetch", createCodeRootHostFetch([], { rejectOpen: false }));
  const submitted = vi.fn();
  const composer: ReturnType<typeof useDesignComposer> = {
    tier: "default",
    thinking: "default",
    executionMode: "agent",
    setExecutionMode: vi.fn(),
    executionModes: [],
    models: [{ id: "configured-model", name: "已配置模型" }],
    model: "configured-model",
    modelMeta: { contextWindow: null, maxOutputTokens: null },
    commands: [
      { name: "quotecheck", description: "参数", prompt: "原模板 $ARGUMENTS" },
    ],
    hasWorkDir: false,
    pendingFullAccess: false,
    setPendingFullAccess: vi.fn(),
    applyTier: vi.fn(async () => {}),
    handleTierChange: vi.fn(async () => {}),
    handleModelChange: vi.fn(),
    handleThinkingChange: vi.fn(),
  };
  render(
    <DesignHome
      composer={composer}
      notice={null}
      selectedProject={null}
      setSettingsTab={vi.fn()}
      onSubmit={submitted}
    />,
  );
  const editor = await screen.findByTestId("design-home-prompt");
  const text = '/quotecheck "中文 空格" 雪😀';
  // 原件自带的浏览器输入驱动仅负责键入；断言只读取可见文本及父宿主提交。
  await waitFor(() =>
    expect(editor.getAttribute("data-e2e-lexical-bridge")).toBe("ready"),
  );
  const inputDriver = Reflect.get(editor, "__zcodeLexicalInputE2E");
  await act(async () => {
    inputDriver.setText(text);
  });
  await waitFor(() => expect(editor.textContent).toBe(text));
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(submitted).toHaveBeenCalledWith(text));
  expect(submitted).toHaveBeenCalledTimes(1);
});
