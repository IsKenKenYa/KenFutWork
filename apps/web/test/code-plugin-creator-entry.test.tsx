import { renderHook } from "@testing-library/react";
import { usePluginCreator } from "@zui/hooks/usePluginCreator.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { TabStoreProvider } from "@zui/store/TabStoreProvider.js";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TabStoreProvider>{children}</TabStoreProvider>
    </ZCodeIntlProvider>
  );
}

it("设置页无活动 tabStore 时用 Scope workspace 兜底，创建插件入口可用", () => {
  const onCreateTask = vi.fn();
  const { result } = renderHook(
    () => usePluginCreator(onCreateTask, { workspacePath: "/ws" }),
    { wrapper },
  );
  expect(result.current.available).toBe(true);
});

it("创建插件以创造方式启动新任务，agent 才会调用 install_plugin", () => {
  const onCreateTask = vi.fn();
  const { result } = renderHook(
    () => usePluginCreator(onCreateTask, { workspacePath: "/ws" }),
    { wrapper },
  );
  result.current.create();
  expect(onCreateTask).toHaveBeenCalledTimes(1);
  expect(onCreateTask).toHaveBeenCalledWith(
    expect.objectContaining({
      executionMode: "creative",
      initialPrompt: "创建一个插件：\n",
    }),
  );
});

it("管理文档没有自己的活动工作区时入口仍可用，任务落点交给 Code 壳", () => {
  const onCreateTask = vi.fn();
  const { result } = renderHook(() => usePluginCreator(onCreateTask), {
    wrapper,
  });
  expect(result.current.available).toBe(true);
  result.current.create();
  expect(onCreateTask).toHaveBeenCalledTimes(1);
  // 设置页不知道壳的活动目录：不得把空目录当成保护键传下去。
  expect(onCreateTask.mock.calls[0]?.[0]).not.toHaveProperty(
    "expectedWorkspaceKey",
  );
  expect(onCreateTask.mock.calls[0]?.[0]).toMatchObject({
    executionMode: "creative",
    initialPrompt: "创建一个插件：\n",
  });
});
