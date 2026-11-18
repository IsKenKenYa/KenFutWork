import { afterEach, expect, it, vi } from "vitest";
import {
  LOCAL_ACCESS_LOST_EVENT,
  LocalAccessError,
  loadLocalInstance,
  serverFetch,
} from "../src/lib/local-access";

const instance = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  dataDir: "/data/instance",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});

it("一次性连接票据只兑换一次，Cookie请求无Bearer并清除fragment", async () => {
  window.history.replaceState(
    null,
    "",
    "/workbench?mode=design#connect=single-use-ticket",
  );
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      url.endsWith("/connect") ? { instanceId: instance.instanceId } : instance,
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const [first, second] = await Promise.all([
    loadLocalInstance(),
    loadLocalInstance(),
  ]);
  expect(first).toEqual(instance);
  expect(second).toEqual(instance);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]).toEqual([
    expect.stringContaining("/api/local-access/connect"),
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: "single-use-ticket" }),
    },
  ]);
  expect(fetch.mock.calls[1]).toEqual([
    expect.stringContaining("/api/instance"),
    { credentials: "include" },
  ]);
  expect(window.location.hash).toBe("");
  expect(window.location.search).toBe("?mode=design");
  expect(localStorage.length).toBe(0);
});

it("Cookie恢复不会读取本地token或构造账户身份", async () => {
  const fetch = vi.fn(async () => Response.json(instance));
  vi.stubGlobal("fetch", fetch);
  expect(await loadLocalInstance()).toEqual(instance);
  expect(fetch.mock.calls).toEqual([
    [expect.stringContaining("/api/instance"), { credentials: "include" }],
  ]);
});

it("已消费或过期票据透出连接原因，不伪造就绪状态", async () => {
  window.history.replaceState(null, "", "/workbench#connect=expired");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: { message: "连接入口已经失效。" } },
        { status: 401 },
      ),
    ),
  );
  await expect(loadLocalInstance()).rejects.toMatchObject({
    status: 401,
    message: "连接入口已经失效。",
  });
  expect(window.location.hash).toBe("#connect=expired");
});

it("服务故障保持与缺少接入凭据不同的错误状态", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: { message: "数据库暂不可用。" } },
        { status: 503 },
      ),
    ),
  );
  await expect(loadLocalInstance()).rejects.toEqual(
    new LocalAccessError(503, "数据库暂不可用。"),
  );
});

it("普通API统一带cookie，401通知上下文失效", async () => {
  const lost = vi.fn();
  window.addEventListener(LOCAL_ACCESS_LOST_EVENT, lost);
  const fetch = vi.fn(async () => new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  await serverFetch("/api/projects", {
    headers: { Authorization: "Bearer explicit-client" },
  });
  expect(fetch.mock.calls).toEqual([
    [
      "/api/projects",
      {
        credentials: "include",
        headers: { Authorization: "Bearer explicit-client" },
      },
    ],
  ]);
  expect(lost).toHaveBeenCalledOnce();
  window.removeEventListener(LOCAL_ACCESS_LOST_EVENT, lost);
});
