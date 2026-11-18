import { cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { getSidePaneTabSearchHint } from "../src/components/workbench/zcode/app-shell/sidePaneTabPresentation.js";
import { Tabs } from "../src/components/workbench/zcode/components/ui/tabs.js";
import {
  DocumentPane,
  type DocumentPaneRendererProps,
  DocumentPaneRendererProvider,
  DocumentSidePaneContent,
} from "../src/components/workbench/zcode/host/DocumentPane.js";
import {
  buildTaskSidePaneMemoryKey,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneMemoryState,
} from "../src/components/workbench/zcode/lib/taskSidePaneMemory.js";
import {
  applyBrowserUseSidePaneEvent,
  applyBrowserUseSidePaneVisibilityEvent,
  closeSidePaneTab,
  closeSidePaneTabForParent,
  closeVisibleOtherSidePaneTabs,
  closeVisibleSidePaneTabs,
  type DocumentSidePaneTab,
  getActiveSidePaneTab,
  getVisibleSidePaneTabs,
  type OpenDocumentSidePaneRequest,
  openBrowserSidePane,
  openDocumentSidePane,
  preserveDocumentSidePaneForAutomaticEvent,
  reorderSidePaneTab,
  resolveSidePaneScopeState,
  restoreSidePaneTab,
  setActiveSidePaneTab,
  shouldMountSidePaneContent,
  stampSidePaneTabsOwnership,
} from "../src/components/workbench/zcode/lib/workspaceSidePane.js";

afterEach(cleanup);

test("浏览器自动ready/visibility保留画布，用户显式选浏览器仍切换", () => {
  const current = openDocumentSidePane(null, request());
  const browser = {
    workspaceKey: "workspace-a",
    sessionId: "task-a",
    tabId: "browser-a",
    browserId: "iab-a",
    browserGeneration: 1,
  };
  const ready = applyBrowserUseSidePaneEvent(current, browser, {
    workspaceKey: "workspace-a",
    ownerTaskId: "task-a",
  });
  const background = preserveDocumentSidePaneForAutomaticEvent(
    current,
    ready.state,
    { projectId: "project-a", workspaceKey: "workspace-a" },
  );
  expect(background?.activeTabId).toBe(current.activeTabId);
  expect(
    background?.tabs.some(
      (tab) => tab.type === "browser-use" && tab.tabId === "browser-a",
    ),
  ).toBe(true);
  const show = applyBrowserUseSidePaneVisibilityEvent(background, browser, {
    workspaceKey: "workspace-a",
    ownerTaskId: "task-a",
  });
  expect(
    preserveDocumentSidePaneForAutomaticEvent(background, show.state, {
      projectId: "project-a",
      workspaceKey: "workspace-a",
    })?.activeTabId,
  ).toBe(current.activeTabId);
  expect(
    setActiveSidePaneTab(background, "browser-use:browser-a")?.activeTabId,
  ).toBe("browser-use:browser-a");
});

test("文档标签搜索使用真实文档和项目身份，无需文件source", () => {
  const tab = activeDocument(openDocumentSidePane(null, request()));
  expect(getSidePaneTabSearchHint(tab)).toBe(
    "画布 A project-a canvas-a canvas document",
  );
});

function request(
  overrides: Partial<
    OpenDocumentSidePaneRequest & { workspaceKey: string }
  > = {},
): OpenDocumentSidePaneRequest & { workspaceKey: string } {
  return {
    resourceType: "canvas",
    projectId: "project-a",
    documentId: "canvas-a",
    title: "画布 A",
    workspaceKey: "workspace-a",
    ...overrides,
  };
}

function activeDocument(
  state: ReturnType<typeof openDocumentSidePane>,
): DocumentSidePaneTab {
  const tab = getActiveSidePaneTab(state);
  if (tab?.type !== "document") throw new Error("Expected active document");
  return tab;
}

test("重复打开复用文档身份并更新标题，选择入口与文档分别建标签", () => {
  const opened = openDocumentSidePane(null, request());
  const first = activeDocument(opened);
  const renamed = openDocumentSidePane(opened, request({ title: "海报" }));
  expect(renamed.tabs).toHaveLength(1);
  expect(activeDocument(renamed)).toEqual({ ...first, title: "海报" });

  const picker = request({ title: "画布" });
  delete picker.documentId;
  const withPicker = openDocumentSidePane(renamed, picker);
  expect(withPicker.tabs).toHaveLength(2);
  expect(activeDocument(withPicker).documentId).toBeUndefined();
  expect(withPicker.activeTabId).not.toBe(first.id);
});

test("同名文档在不同项目和工作区的身份不碰撞", () => {
  const first = openDocumentSidePane(null, request());
  const otherProject = openDocumentSidePane(
    first,
    request({ projectId: "project-b" }),
  );
  const otherWorkspace = openDocumentSidePane(
    otherProject,
    request({ workspaceKey: "workspace-b" }),
  );
  expect(new Set(otherWorkspace.tabs.map((tab) => tab.id)).size).toBe(3);
  expect(
    getVisibleSidePaneTabs(otherWorkspace.tabs, {
      workspaceKey: "workspace-a",
      projectId: "project-a",
      ownerTaskId: "another-task",
    }).map((tab) => tab.id),
  ).toEqual([first.activeTabId]);
  expect(
    getVisibleSidePaneTabs(otherWorkspace.tabs, {
      workspaceKey: "workspace-a",
      ownerTaskId: "task-a",
    }),
  ).toEqual([]);
});

test("文档标签跨会话保留，切换会话的历史预览偏好不抢画布", () => {
  const browser = openBrowserSidePane(null, {
    ownerTaskId: "task-b",
    workspaceKey: "workspace-a",
  });
  const opened = openDocumentSidePane(browser, request());
  const stamped = stampSidePaneTabsOwnership(opened, {
    ownerTaskId: "task-a",
    workspaceKey: "workspace-a",
  });
  expect(stamped).toBe(opened);
  const next = resolveSidePaneScopeState(
    opened,
    {
      workspaceKey: "workspace-a",
      projectId: "project-a",
      ownerTaskId: "task-b",
    },
    browser.activeTabId,
  );
  expect(next.sidePaneState?.activeTabId).toBe(opened.activeTabId);
  expect(next.isSidePaneCollapsed).toBe(false);
  expect(
    getVisibleSidePaneTabs(opened.tabs, {
      workspaceKey: "workspace-a",
      projectId: "project-a",
      ownerTaskId: null,
    }).map((tab) => tab.id),
  ).toEqual([opened.activeTabId]);
});

test("关闭全部或其他标签只关闭当前项目文档，未绑定项目不会误关", () => {
  const first = openDocumentSidePane(null, request());
  const withSecond = openDocumentSidePane(
    first,
    request({ projectId: "project-b" }),
  );
  const withThird = openDocumentSidePane(
    withSecond,
    request({ documentId: "canvas-c" }),
  );
  const closedOthers = closeVisibleOtherSidePaneTabs(
    withThird,
    first.activeTabId,
    "task-a",
    "project-a",
  );
  expect(closedOthers?.tabs.map((tab) => tab.id)).toEqual([
    first.activeTabId,
    withSecond.activeTabId,
  ]);
  expect(
    closeVisibleSidePaneTabs(withThird, "task-a", "project-a")?.tabs.map(
      (tab) => tab.id,
    ),
  ).toEqual([withSecond.activeTabId]);
  expect(closeVisibleSidePaneTabs(withThird, "task-a")?.tabs).toEqual(
    withThird.tabs,
  );
});

test("后台标签关闭不切走当前画布，显式关闭画布后可恢复", () => {
  const browser = openBrowserSidePane(null, {
    ownerTaskId: "task-a",
    workspaceKey: "workspace-a",
  });
  const opened = openDocumentSidePane(browser, request());
  const tab = activeDocument(opened);
  expect(
    closeSidePaneTabForParent(
      opened,
      browser.activeTabId,
      "task-a",
      undefined,
      "project-a",
    )?.activeTabId,
  ).toBe(tab.id);
  const closed = closeSidePaneTab(opened, tab.id);
  const restored = restoreSidePaneTab(closed, tab);
  expect(restored.activeTabId).toBe(tab.id);
  expect(activeDocument(restored)).toEqual(tab);
});

test("原排序和工作区记忆完整保留文档，记忆不按会话拆分", () => {
  const first = openDocumentSidePane(
    null,
    request({ workspaceKey: "memory-documents" }),
  );
  const second = openDocumentSidePane(
    first,
    request({ documentId: "canvas-b", workspaceKey: "memory-documents" }),
  );
  const reordered = reorderSidePaneTab(
    second,
    second.activeTabId,
    first.activeTabId,
  );
  const memoryKey = buildTaskSidePaneMemoryKey({
    workspacePath: "/same-directory",
    workspaceIdentity: "memory-documents",
    taskId: "task-a",
  });
  saveTaskSidePaneMemoryState(memoryKey, { sidePaneState: reordered });
  const secondTaskKey = buildTaskSidePaneMemoryKey({
    workspacePath: "/same-directory",
    workspaceIdentity: "memory-documents",
    taskId: "task-b",
  });
  expect(secondTaskKey).toBe(memoryKey);
  expect(readTaskSidePaneMemoryState(secondTaskKey).sidePaneState).toEqual(
    reordered,
  );
  expect(reordered?.tabs.map((tab) => tab.id)).toEqual([
    second.activeTabId,
    first.activeTabId,
  ]);
  expect(
    readTaskSidePaneMemoryState("other-documents").sidePaneState,
  ).toBeNull();
  expect(shouldMountSidePaneContent(false, second.tabs)).toBe(true);
  expect(shouldMountSidePaneContent(false, [])).toBe(false);
});

test("宿主文档renderer按资源类型提供，隐藏与切换会话保留编辑状态", () => {
  const tab = activeDocument(openDocumentSidePane(null, request()));
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function CanvasRenderer({ tab: target }: DocumentPaneRendererProps) {
    const [count, setCount] = useState(0);
    useEffect(() => {
      mounted(target.documentId);
      return unmounted;
    }, [target.documentId]);
    return (
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        {target.title}: {count}
      </button>
    );
  }
  const renderers = [
    { resourceType: "canvas", component: CanvasRenderer },
  ] as const;
  function Harness({ visible, taskId }: { visible: boolean; taskId: string }) {
    return (
      <DocumentPaneRendererProvider renderers={renderers}>
        <Tabs value={visible ? tab.id : "other-tab"}>
          <DocumentSidePaneContent
            tab={tab}
            isVisible={visible}
            workspaceAbsPath="/workspace"
            workspaceIdentity="workspace-a"
            activeTaskId={taskId}
          />
        </Tabs>
      </DocumentPaneRendererProvider>
    );
  }
  const view = render(<Harness visible taskId="task-a" />);
  fireEvent.click(view.getByRole("button", { name: "画布 A: 0" }));
  view.rerender(<Harness visible={false} taskId="task-b" />);
  const panel = view.container.querySelector('[data-slot="tabs-content"]');
  expect(panel?.hasAttribute("hidden")).toBe(true);
  expect(panel?.hasAttribute("inert")).toBe(true);
  expect(view.queryByRole("button")).toBeNull();
  expect(unmounted).not.toHaveBeenCalled();
  view.rerender(<Harness visible taskId="task-b" />);
  expect(view.getByRole("button", { name: "画布 A: 1" })).toBeTruthy();
  expect(mounted).toHaveBeenCalledOnce();
  expect(mounted).toHaveBeenCalledWith("canvas-a");
  view.unmount();
  expect(unmounted).toHaveBeenCalledOnce();
});

test("缺少文档插件明确报错，不显示空白文档", () => {
  const tab = activeDocument(openDocumentSidePane(null, request()));
  const view = render(
    <DocumentPane
      tab={tab}
      isVisible
      workspaceAbsPath="/workspace"
      activeTaskId={null}
    />,
  );
  expect(view.getByRole("alert").textContent).toBe(
    "无法打开文档，请检查对应插件",
  );
});
