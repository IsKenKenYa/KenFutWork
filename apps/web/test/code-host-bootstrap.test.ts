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
