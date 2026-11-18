import { expect, it } from "vitest";
import { createCodeUiHttpFixture } from "../code-ui/code-ui-http.fixture.js";
import { CU_BUNDLE_ID } from "./tools.js";

const enabled =
  process.platform === "darwin" && process.env.KENFUTWORK_TEST_DESKTOP === "1";

it.skipIf(!enabled)(
  "原权限service通过真实宿主RPC读取macOS状态并遵守安装/连接/认证门",
  async () => {
    const fixture = await createCodeUiHttpFixture();
    const stream = await fixture.client.openCodeStream();
    const rpc = (
      args: unknown[] = [
        "/unused-read-only-target",
        null,
        { includeFunctionalProbes: false },
      ],
      connectionId = stream.ready.hello.connectionId,
    ) =>
      fixture.client.request("/api/code-ui/rpc", {
        connectionId,
        service: "cua-permission",
        method: "getStatus",
        args,
      });
    try {
      expect((await rpc()).body.result).toMatchObject({ available: false });
      const installed = await fixture.client.request("/api/plugins/install", {
        builtin: CU_BUNDLE_ID,
        allowLifecycleScripts: false,
      });
      expect(installed.status, JSON.stringify(installed.body)).toBe(201);
      expect(installed.body.installed).toMatchObject({
        id: "local__kenfutwork-computer-use",
        enabled: true,
      });
      const status = await rpc();
      expect(status.status, JSON.stringify(status.body)).toBe(200);
      expect(status.body.result).toMatchObject({
        available: true,
        platform: "darwin",
        grantOwner: null,
      });
      for (const key of ["accessibility", "screenRecording"]) {
        expect(["granted", "denied", "unknown"]).toContain(
          status.body.result[key],
        );
      }
      expect(status.body.result).not.toHaveProperty("media");
      expect((await rpc(["/unused-read-only-target"])).status).toBe(200);
      expect((await rpc([])).status).toBe(400);
      expect((await rpc(undefined, "unowned-connection")).status).toBe(404);
      const anonymous = await fetch(`${fixture.baseUrl}/api/code-ui/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixture.origin },
        body: JSON.stringify({
          connectionId: stream.ready.hello.connectionId,
          service: "cua-permission",
          method: "getStatus",
          args: ["/unused-read-only-target"],
        }),
      });
      expect(anonymous.status).toBe(401);
      stream.controller.abort();
      await stream.closed;
      await expect.poll(async () => (await rpc()).status).toBe(404);
    } finally {
      stream.controller.abort();
      await fixture.close();
    }
  },
  120_000,
);
