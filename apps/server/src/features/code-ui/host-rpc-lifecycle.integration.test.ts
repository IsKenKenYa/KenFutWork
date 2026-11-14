import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
} from "./host-rpc-handler.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";

describe.skipIf(!enabled)("Code RPC 连接生命周期 integration", () => {
  it("宿主关闭时拒绝RPC及新连接并等待贡献资源清理", async () => {
    const fixture = await createCodeUiHttpFixture();
    let releaseCleanup = () => {};
    const cleanupReady = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let beginCleanup = () => {};
    const cleanupStarted = new Promise<void>((resolve) => {
      beginCleanup = resolve;
    });
    let cleanupFinished = false;
    const unregister = fixture.app.kernel
      .get("capabilities")
      .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
        id: "lifecycleIntegrationService.openPage",
        value: {
          async call(_actor, _args, context) {
            context.requireInitialized();
            context.onClose(async () => {
              beginCleanup();
              await cleanupReady;
              cleanupFinished = true;
            });
            return {
              connectionId: context.connectionId,
              actor: context.actor,
            };
          },
        },
      });
    let closing: Promise<void> | undefined;
    let closingFinished = false;
    try {
      const stream = await fixture.client.openCodeStream();
      const initialized = await stream.rpc("initializeConversationV4", [
        {
          kind: "clientHello",
          protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
          clientId: randomUUID(),
          appVersion: "rpc-lifecycle-integration",
          clientKind: "web",
        },
      ]);
      expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
      const registered = await fixture.client.request("/api/code-ui/rpc", {
        connectionId: stream.ready.hello.connectionId,
        service: "lifecycleIntegrationService",
        method: "openPage",
        args: [],
      });
      expect(registered.status, JSON.stringify(registered.body)).toBe(200);
      expect(registered.body.result).toEqual({
        connectionId: stream.ready.hello.connectionId,
        actor: fixture.actor,
      });
      const service = fixture.app.kernel.get("codeUi");
      closing = service.closeConnections().then(() => {
        closingFinished = true;
      });
      await cleanupStarted;
      const response = await fixture.client.request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method: "getView",
        args: [],
      });
      expect(
        response.status,
        JSON.stringify({ status: response.status, error: response.body.error }),
      ).toBe(404);
      await expect(
        service.openConnection(
          fixture.actor,
          async () => {},
          () => {},
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(cleanupFinished).toBe(false);
      expect(closingFinished).toBe(false);
      releaseCleanup();
      await closing;
      expect(cleanupFinished).toBe(true);
      expect(closingFinished).toBe(true);
    } finally {
      releaseCleanup();
      unregister();
      try {
        await closing;
      } finally {
        await fixture.close();
      }
    }
  });
});
