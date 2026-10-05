import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
describe.skipIf(!enabled)("原插件命令本机授权 integration", () => {
  it("免账户浏览器通过真实接入cookie读取插件，缺失与伪造凭据HTTP/SSE拒绝", async () => {
    const f = await createCodeUiHttpFixture();
    try {
      const headers = {
        origin: f.origin,
        "content-type": "application/json",
        connection: "close",
      };
      const unauthenticated = await fetch(`${f.baseUrl}/api/code-ui/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          service: "plugin-management",
          method: "getPluginsOverview",
          args: [{}],
        }),
      });
      expect(unauthenticated.status).toBe(401);
      const forged = await fetch(`${f.baseUrl}/api/code-ui/events`, {
        headers: { ...headers, authorization: "Bearer invalid" },
      });
      expect(forged.status).toBe(401);
      const stream = await f.client.openCodeStream();
      const result = await f.client.request("/api/code-ui/rpc", {
        connectionId: stream.ready.hello.connectionId,
        service: "plugin-management",
        method: "getPluginsOverview",
        args: [{ configScope: "user" }],
      });
      expect(result.status).toBe(200);
      expect(stream.ready.hello.auth.userId).toBe(f.actor.instanceId);
    } finally {
      await f.close();
    }
  });
});
