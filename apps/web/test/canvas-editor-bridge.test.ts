import { afterEach, expect, test, vi } from "vitest";
import {
  canvasWorkbenchUrl,
  createCanvasRefreshCoordinator,
  installCanvasEditorBridge,
} from "../src/lib/canvas-editor-bridge";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function parentWindow() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  if (!frame.contentWindow) throw new Error("Missing iframe window");
  return frame.contentWindow;
}

test("画布深链打开共享工作台，只保留真实项目与文档目标", () => {
  expect(canvasWorkbenchUrl()).toBe("/workbench?mode=design");
  const url = new URL(
    canvasWorkbenchUrl({
      canvasId: "canvas /one",
      projectId: "project &one",
    }),
    window.location.origin,
  );
  expect(url.pathname).toBe("/workbench");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    mode: "design",
    projectId: "project &one",
    canvasId: "canvas /one",
  });
});

test("选区、品牌及共享会话动作通过直接宿主发送，不包含目录授权", () => {
  const parent = parentWindow();
  const post = vi.spyOn(parent, "postMessage").mockImplementation(() => {});
  const bridge = installCanvasEditorBridge({
    target: { canvasId: "canvas-a", projectId: "project-a" },
    parent,
    origin: window.location.origin,
    events: window,
    onRefresh: vi.fn(),
    onSessionChange: vi.fn(),
  });
  const selected = [
    {
      id: "text-a",
      type: "text",
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      text: "海报",
    },
  ];
  bridge.publishContext(selected, "brand-a");
  bridge.publishContext([], null);
  bridge.focusSession();
  bridge.requestProject();
  expect(post.mock.calls.map(([message]) => message)).toEqual([
    {
      type: "kenfutwork:canvas-context",
      canvasId: "canvas-a",
      projectId: "project-a",
      selectedCanvasElements: selected,
      brandKitId: "brand-a",
    },
    {
      type: "kenfutwork:canvas-context",
      canvasId: "canvas-a",
      projectId: "project-a",
      selectedCanvasElements: [],
      brandKitId: null,
    },
    {
      type: "kenfutwork:canvas-focus-session",
      canvasId: "canvas-a",
      projectId: "project-a",
    },
    {
      type: "kenfutwork:canvas-new-project",
      canvasId: "canvas-a",
      projectId: "project-a",
    },
  ]);
  expect(
    post.mock.calls.every(
      ([, targetOrigin]) => targetOrigin === window.location.origin,
    ),
  ).toBe(true);
  bridge.dispose();
});

test("真实文档通知仅向匹配宿主发布，不携带Run身份，dispose后不发布", () => {
  const parent = parentWindow();
  const post = vi.spyOn(parent, "postMessage").mockImplementation(() => {});
  const bridge = installCanvasEditorBridge({
    target: { canvasId: "canvas-a", projectId: "project-a" },
    parent,
    origin: window.location.origin,
    events: window,
    onRefresh: vi.fn(),
    onSessionChange: vi.fn(),
  });
  const message = {
    type: "canvas.document.updated" as const,
    canvasId: "canvas-a",
    projectId: "project-a",
    revision: "a".repeat(64),
    deleted: false,
  };
  bridge.publishDocumentUpdated({ ...message, canvasId: "canvas-b" });
  bridge.publishDocumentUpdated({ ...message, projectId: "project-b" });
  expect(post).not.toHaveBeenCalled();
  bridge.publishDocumentUpdated(message);
  expect(post).toHaveBeenCalledWith(
    {
      type: "kenfutwork:canvas-document-updated",
      canvasId: "canvas-a",
      projectId: "project-a",
      revision: message.revision,
      deleted: false,
    },
    window.location.origin,
  );
  bridge.dispose();
  bridge.publishDocumentUpdated({ ...message, deleted: true });
  expect(post).toHaveBeenCalledOnce();
});

test("刷新与Task绑定严格校验origin、source、画布和项目，解绑后不消费迟到消息", () => {
  const parent = parentWindow();
  const onRefresh = vi.fn();
  const onSessionChange = vi.fn();
  const bridge = installCanvasEditorBridge({
    target: { canvasId: "canvas-a", projectId: "project-a" },
    parent,
    origin: window.location.origin,
    events: window,
    onRefresh,
    onSessionChange,
  });
  const dispatch = (
    data: unknown,
    origin = window.location.origin,
    source: Window = parent,
  ) => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
  };
  dispatch(
    { type: "kenfutwork:canvas-refresh", canvasId: "canvas-a" },
    "https://elsewhere.test",
  );
  dispatch(
    { type: "kenfutwork:canvas-refresh", canvasId: "canvas-a" },
    window.location.origin,
    window,
  );
  dispatch({ type: "kenfutwork:canvas-refresh", canvasId: "canvas-b" });
  const session = {
    type: "kenfutwork:canvas-session-context",
    canvasId: "canvas-a",
    projectId: "project-a",
    taskId: "task-a",
  };
  dispatch({ ...session, projectId: "project-b" });
  dispatch({ ...session, taskId: undefined, sessionId: "legacy" });
  dispatch({ ...session, taskId: "" });
  expect(onRefresh).not.toHaveBeenCalled();
  expect(onSessionChange).not.toHaveBeenCalled();
  dispatch({ type: "kenfutwork:canvas-refresh", canvasId: "canvas-a" });
  dispatch(session);
  dispatch({ ...session, taskId: null });
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(onSessionChange.mock.calls).toEqual([["task-a"], [null]]);
  bridge.dispose();
  dispatch({ type: "kenfutwork:canvas-refresh", canvasId: "canvas-a" });
  dispatch(session);
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(onSessionChange).toHaveBeenCalledTimes(2);
});

test("重复刷新串行合并，应用后重新对账在飞期间的通知", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let calls = 0;
  let maxActive = 0;
  const refresh = vi.fn(async () => {
    active++;
    calls++;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await blocked;
    active--;
  });
  const coordinator = createCanvasRefreshCoordinator(refresh);
  const first = coordinator.refresh();
  const second = coordinator.refresh();
  const third = coordinator.refresh();
  expect(refresh).toHaveBeenCalledOnce();
  release();
  await Promise.all([first, second, third]);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(maxActive).toBe(1);
  coordinator.dispose();
});

test("同一prepare请求仅保存一次，返回匹配请求的真实revision且dispose后不发布", async () => {
  const parent = parentWindow();
  const post = vi.spyOn(parent, "postMessage").mockImplementation(() => {});
  let resolvePrepare: ((revision: string) => void) | undefined;
  const prepare = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolvePrepare = resolve;
      }),
  );
  const bridge = installCanvasEditorBridge({
    target: { canvasId: "canvas-a", projectId: "project-a" },
    parent,
    origin: window.location.origin,
    events: window,
    onRefresh: vi.fn(),
    onSessionChange: vi.fn(),
    onPrepare: prepare,
  });
  const data = {
    type: "kenfutwork:canvas-prepare",
    canvasId: "canvas-a",
    projectId: "project-a",
    requestId: "prepare-a",
  };
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      source: parent,
      origin: window.location.origin,
    }),
  );
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      source: parent,
      origin: window.location.origin,
    }),
  );
  await Promise.resolve();
  expect(prepare).toHaveBeenCalledOnce();
  resolvePrepare?.("real-revision");
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      {
        type: "kenfutwork:canvas-prepared",
        canvasId: "canvas-a",
        projectId: "project-a",
        requestId: "prepare-a",
        revision: "real-revision",
      },
      window.location.origin,
    ),
  );
  post.mockClear();
  bridge.dispose();
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      source: parent,
      origin: window.location.origin,
    }),
  );
  await Promise.resolve();
  expect(post).not.toHaveBeenCalled();
});

test("刷新失败保留明确失败，下一次显式刷新可继续；dispose取消待刷新", async () => {
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const coordinator = createCanvasRefreshCoordinator(refresh);
  await expect(coordinator.refresh()).rejects.toThrow("offline");
  await coordinator.refresh();
  expect(refresh).toHaveBeenCalledTimes(2);
  coordinator.dispose();
  await coordinator.refresh();
  expect(refresh).toHaveBeenCalledTimes(2);

  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const apply = vi.fn(() => blocked);
  const cancelled = createCanvasRefreshCoordinator(apply);
  const first = cancelled.refresh();
  void cancelled.refresh();
  cancelled.dispose();
  release();
  await first;
  expect(apply).toHaveBeenCalledOnce();
});
