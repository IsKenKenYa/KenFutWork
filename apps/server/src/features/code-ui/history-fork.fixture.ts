import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { expect, vi } from "vitest";
import type { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import type { createCodeSessionFixture } from "./host-session.fixture.js";

export type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
export type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;

export async function snapshot(fixture: Fixture, taskId: string) {
  const response = await fixture.client.request(
    `/api/code-ui/sessions/${taskId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return protocol.conversationSnapshotSchema.parse(response.body.snapshot);
}

export async function waitPhase(
  fixture: Fixture,
  taskId: string,
  phase: string,
) {
  let result: protocol.ConversationSnapshot | undefined;
  await vi.waitFor(
    async () => {
      result = await snapshot(fixture, taskId);
      expect(
        result.control.phase,
        JSON.stringify(result.control.lastError),
      ).toBe(phase);
    },
    { timeout: 30_000 },
  ); // 仅真实模型/持久投影同步期限，非产品治理值。
  if (!result) throw new Error("未读取实际Task快照");
  return result;
}

export function sendToTask(host: Host, taskId: string, text: string) {
  return host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        type: "sendText",
        sessionId: taskId,
        commandId: randomUUID(),
        clientId: host.clientId,
        payload: { text },
        issuedAt: Date.now(),
      },
    },
  ]);
}
