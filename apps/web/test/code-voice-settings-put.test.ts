import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";

let client: CodeHttpChannelClient | undefined;
afterEach(() => {
  client?.dispose();
  client = undefined;
  vi.unstubAllGlobals();
});

// 回归：语音设置保存曾用 POST 命中 /api/voice/settings，服务端只注册了 GET/PUT，
// 结果每次改模式/选模型/应用推荐都得到「Code 宿主请求失败：404」。
it("保存语音设置以 PUT 发出，不再 POST 到只读路由", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/events")) return new Response("", { status: 404 });
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json({
      settings: {
        mode: "loop",
        listen: null,
        think: null,
        speak: null,
        speakReplies: false,
      },
    });
  });
  client = new CodeHttpChannelClient({ apiBase: "http://localhost:3001" });

  const result = await client.putRequest<{ settings: { mode: string } }>(
    "/api/voice/settings",
    { mode: "loop" },
  );

  expect(result.settings.mode).toBe("loop");
  expect(calls).toEqual([
    {
      url: "http://localhost:3001/api/voice/settings",
      method: "PUT",
      body: { mode: "loop" },
    },
  ]);
});
