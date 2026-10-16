import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

// 两个真实SSE客户端共享Task；宿主companion传本次点击意图，原V4 envelope不加字段。
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "执行方式双客户端输入意图 integration",
  () => {
    it.each([
      {
        selected: "agent",
        stored: "solo",
        type: "sendText",
        directive: undefined,
        retired: false,
      },
      {
        selected: "solo",
        stored: "agent",
        type: "sendText",
        directive: "solo",
        retired: false,
      },
      {
        selected: "goal",
        stored: "solo",
        type: "sendGoalCommand",
        directive: "goal",
        retired: false,
      },
      {
        selected: "plan",
        stored: "agent",
        type: "sendText",
        directive: "plan",
        retired: false,
      },
      {
        selected: "loop",
        stored: "agent",
        type: "sendText",
        directive: undefined,
        retired: true,
      },
    ] as const)(
      "本窗口已选$selected，另一窗口偏好为$stored，实际输入与重试仍使用本次选择",
      async ({ selected, stored, type, directive, retired }) => {
        const fixture = await createCodeUiHttpFixture();
        const model = await heldModel();
        let host: Host | undefined;
        try {
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          const second = await host.client.openCodeStream();
          const secondClientId = randomUUID();
          expect(
            (
              await second.rpc("initializeConversationV4", [
                {
                  kind: "clientHello",
                  protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
                  clientId: secondClientId,
                  appVersion: "execution-strategy-tab",
                  clientKind: "web",
                },
              ])
            ).status,
          ).toBe(200);
          expect(
            (
              await second.rpc("subscribeConversationV4", [
                {
                  workspacePath: host.workspacePath,
                  sessionId: host.sessionId,
                },
              ])
            ).status,
          ).toBe(200);
          expect(
            (
              await host.client.request(
                `/api/execution-modes/${host.sessionId}`,
                { mode: stored },
                "PUT",
              )
            ).status,
          ).toBe(200);
          const sender = selected === "solo" ? second : host.stream;
          const envelope = {
            clientId: selected === "solo" ? secondClientId : host.clientId,
            commandId: randomUUID(),
            sessionId: host.sessionId,
            type,
            payload: {
              text: "按当前窗口已选择的工作方式处理",
              planEnabled: false,
            },
            issuedAt: Date.now(),
          };
          const send = (executionMode: string) =>
            sender.rpc("sendConversationCommandV4", [
              {
                workspacePath: host!.workspacePath,
                projectId: host!.projectId,
                executionMode,
                ...(type === "sendGoalCommand"
                  ? { goalControl: { expectedGoal: null } }
                  : {}),
                envelope,
              },
            ]);
          const initial = await send(selected);
          if (retired) {
            expect(initial.status).toBe(409);
            expect(initial.body.error.message).toContain("已停用");
            expect(model.requests).toHaveLength(0);
            return;
          }
          expect(initial.body.result.status).toBe("accepted");
          await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
            timeout: 30_000,
          });
          const user = (
            model.requests[0]!.body.messages as Array<{
              role: string;
              content: string;
            }>
          )
            .filter((message) => message.role === "user")
            .at(-1);
          expect(user?.content).toContain("按当前窗口已选择的工作方式处理");
          if (directive)
            expect(user?.content).toContain(
              `<execution_mode name="${directive}">`,
            );
          else
            expect(user?.content).not.toContain('<execution_mode name="solo">');
          if (selected === "plan")
            expect(
              protocol.conversationSnapshotSchema.parse(await host.snapshot())
                .config,
            ).toMatchObject({ mode: "build", planEnabled: true });
          expect((await send(selected)).body.result.status).toBe("duplicate");
          expect(
            (await send(selected === "solo" ? "agent" : "solo")).status,
          ).toBe(409);
          expect(model.requests).toHaveLength(1);
        } finally {
          if (host) {
            const snapshot = protocol.conversationSnapshotSchema.parse(
              await host.snapshot(),
            );
            if (snapshot.control.canStop) await host.command("stop", {});
            await host.dispose();
          }
          await model.close();
          await fixture.close();
        }
      },
      90_000,
    );
  },
);
