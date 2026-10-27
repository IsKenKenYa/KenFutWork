import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceMainView } from "@zui/app-shell/types";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchSurfaceMode } from "../src/components/workbench/zcode/host/useWorkbenchSurfaceMode";
import { createHostWorkbenchNavigation } from "../src/components/workbench/zcode/host/workbenchNavigation";

/**
 * Work 模式的主区语义（用户 2026-10-27 口径）：Work 与 Code 共用同一个会话主区，
 * 引擎页是显式打开的视图——切到 Work 不能再把主区换成引擎页，反过来共享页面
 * （会话/自动化/插件市场）也不能把模式回写成 Code。
 */
const host = vi.hoisted(() => ({
  navigation: null as ReturnType<typeof createHostWorkbenchNavigation> | null,
}));
vi.mock("@zui/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ workbenchNavigation: host.navigation }),
}));

function Harness() {
  const [view, setView] = useState<WorkspaceMainView>("chat");
  useWorkbenchSurfaceMode({
    workspaceMainView: view,
    setWorkspaceMainView: setView,
  });
  return (
    <>
      <output data-testid="view">{view}</output>
      <button type="button" onClick={() => setView("work")}>
        引擎
      </button>
      <button type="button" onClick={() => setView("plugin-store")}>
        市场
      </button>
    </>
  );
}

function setup() {
  host.navigation = createHostWorkbenchNavigation(window, [
    "code",
    "design",
    "work",
    "flow",
  ]);
  render(<Harness />);
  return host.navigation;
}

const view = () => screen.getByTestId("view").textContent;

afterEach(() => {
  cleanup();
  host.navigation?.dispose?.();
  host.navigation = null;
  window.sessionStorage.clear();
});

describe("Work 模式主区", () => {
  it("切到 Work 停在共享会话主区，不切引擎页", async () => {
    const navigation = setup();
    expect(view()).toBe("chat");
    await act(async () => {
      navigation.open("work");
    });
    expect(navigation.getSnapshot().mode).toBe("work");
    expect(view()).toBe("chat");
  });

  it("Work 模式下会话主区不回写 Code 模式", async () => {
    const navigation = setup();
    await act(async () => {
      navigation.open("work");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(view()).toBe("chat");
    expect(navigation.getSnapshot().mode).toBe("work");
  });

  it("引擎页与插件市场是 Work 模式的合法视图，模式保持 Work", async () => {
    const navigation = setup();
    await act(async () => {
      navigation.open("work");
    });
    fireEvent.click(screen.getByRole("button", { name: "引擎" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view()).toBe("work");
    expect(navigation.getSnapshot().mode).toBe("work");
    fireEvent.click(screen.getByRole("button", { name: "市场" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view()).toBe("plugin-store");
    expect(navigation.getSnapshot().mode).toBe("work");
  });
});
