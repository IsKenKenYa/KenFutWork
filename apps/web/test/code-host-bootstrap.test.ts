import { afterEach, expect, it, vi } from "vitest";
import { requestParentBootstrap } from "../src/components/workbench/zcode/host/parentBridge";

afterEach(() => document.body.replaceChildren());

it("Code 宿主只接收同源父窗口的有效本地宿主配置", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const parent = frame.contentWindow;
  if (!parent) throw new Error("测试父文档未创建");
  const post = vi.spyOn(parent, "postMessage");
  const accepted = vi.fn();
  const pending = requestParentBootstrap(parent).then(accepted);
  expect(post).toHaveBeenCalledWith(
    { type: "kenfutwork:code-ready" },
    window.location.origin,
  );
  const config = {
    type: "kenfutwork:code-bootstrap",
    apiBase: "http://localhost:3001",
    user: null,
  };
  for (const event of [
    { source: parent, origin: "https://untrusted.example", data: config },
    { source: window, origin: window.location.origin, data: config },
    {
      source: parent,
      origin: window.location.origin,
      data: { ...config, apiBase: "not-a-url" },
    },
  ])
    window.dispatchEvent(new MessageEvent("message", event));
  await Promise.resolve();
  expect(accepted).not.toHaveBeenCalled();
  window.dispatchEvent(
    new MessageEvent("message", {
      source: parent,
      origin: window.location.origin,
      data: config,
    }),
  );
  await pending;
  expect(accepted).toHaveBeenCalledWith(config);
});

it("隐藏工作区只阻断用户焦点和快捷键，运行事件继续，且拒绝伪造活动消息", async () => {
  const { installHostWorkspaceActivity } = await import(
    "../src/components/workbench/zcode/host/workspaceActivity"
  );
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const parent = frame.contentWindow;
  if (!parent) throw new Error("父窗口不存在");
  const release = installHostWorkspaceActivity(parent);
  const keys = vi.fn(),
    updates = vi.fn();
  window.addEventListener("keydown", keys);
  window.addEventListener("task-update", updates);
  const message = (
    active: boolean,
    source: MessageEventSource | null,
    origin = window.location.origin,
  ) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        origin,
        data: { type: "kenfutwork:workspace-activity", active },
      }),
    );
  try {
    message(false, window);
    expect(document.documentElement.inert).toBe(false);
    message(false, parent, "https://untrusted.example");
    expect(document.documentElement.inert).toBe(false);
    message(false, parent);
    expect(document.documentElement.inert).toBe(true);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", ctrlKey: true }),
    );
    window.dispatchEvent(new Event("task-update"));
    expect(keys).not.toHaveBeenCalled();
    expect(updates).toHaveBeenCalledOnce();
    message(true, parent);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", ctrlKey: true }),
    );
    expect(keys).toHaveBeenCalledOnce();
  } finally {
    release();
    window.removeEventListener("keydown", keys);
    window.removeEventListener("task-update", updates);
  }
});

it("隐藏父iframe的活动消息早于子页监听时，跨Realm初始输入仍被阻断", async () => {
  const { installHostWorkspaceActivity } = await import(
    "../src/components/workbench/zcode/host/workspaceActivity"
  );
  const frame = document.createElement("iframe");
  frame.setAttribute("inert", "");
  document.body.append(frame);
  const child = frame.contentWindow;
  if (!child) throw new Error("子窗口不存在");
  const parent = window;
  vi.stubGlobal("window", child);
  vi.stubGlobal("document", child.document);
  vi.stubGlobal("HTMLIFrameElement", Reflect.get(child, "HTMLIFrameElement"));
  const release = installHostWorkspaceActivity(parent);
  const keys = vi.fn();
  child.addEventListener("keydown", keys);
  try {
    expect(child.document.documentElement.inert).toBe(true);
    child.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    expect(keys).not.toHaveBeenCalled();
    child.dispatchEvent(
      new MessageEvent("message", {
        source: parent,
        origin: child.location.origin,
        data: { type: "kenfutwork:workspace-activity", active: true },
      }),
    );
    child.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    expect(keys).toHaveBeenCalledOnce();
  } finally {
    release();
    child.removeEventListener("keydown", keys);
    vi.unstubAllGlobals();
  }
});
