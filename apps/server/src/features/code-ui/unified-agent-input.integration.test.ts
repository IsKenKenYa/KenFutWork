import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeUiRepository } from "./repository.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "统一 Agent 输入 integration",
  () => {
    it("执行选择列表和会话选择端点均已关闭", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const sessionId = randomUUID();
        expect(
          (await fixture.client.request("/api/execution-modes")).status,
        ).toBe(404);
        expect(
          (await fixture.client.request(`/api/execution-modes/${sessionId}`))
            .status,
        ).toBe(404);
        expect(
          (
            await fixture.client.request(
              `/api/execution-modes/${sessionId}`,
              { mode: "agent" },
              "PUT",
            )
          ).status,
        ).toBe(404);
      } finally {
        await fixture.close();
      }
    }, 90_000);

    it("宿主命令拒绝未知字段且不创建任务", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const stream = await fixture.client.openCodeStream();
        const clientId = randomUUID();
        expect(
          (
            await stream.rpc("initializeConversationV4", [
              {
                kind: "clientHello",
                protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
                clientId,
                appVersion: "unified-agent-input",
                clientKind: "web",
              },
            ])
          ).status,
        ).toBe(200);
        const repository = createCodeUiRepository(fixture.database.persistence);
        const beforeWorkspaces = await fixture.client.request(
          "/api/code-ui/workspaces",
        );
        expect(beforeWorkspaces.status).toBe(200);
        const beforeTasks = (
          await repository.listRoots(fixture.actor.instanceId)
        )
          .map((task) => task.id)
          .sort();
        for (const removed of [
          { executionMode: "agent" },
          { goalId: randomUUID() },
          { unexpected: true },
        ]) {
          const rejected = await stream.rpc("sendConversationCommandV4", [
            {
              workspacePath: fixture.directory,
              ...removed,
              envelope: {
                clientId,
                commandId: randomUUID(),
                sessionId: null,
                type: "createSession",
                payload: { workspaceId: randomUUID() },
                issuedAt: Date.now(),
              },
            },
          ]);
          expect(rejected.status).toBe(400);
        }
        const workspaces = await fixture.client.request(
          "/api/code-ui/workspaces",
        );
        expect(workspaces.status).toBe(200);
        expect(workspaces.body.workspaces).toEqual(
          beforeWorkspaces.body.workspaces,
        );
        expect(
          (await repository.listRoots(fixture.actor.instanceId))
            .map((task) => task.id)
            .sort(),
        ).toEqual(beforeTasks);
      } finally {
        await fixture.close();
      }
    }, 90_000);
  },
);
