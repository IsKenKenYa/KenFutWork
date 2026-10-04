import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { openCodeStream, request } from "./host-client.fixture.js";

async function bindSession(
  stream: Awaited<ReturnType<typeof openCodeStream>>,
  workspacePath: string,
  providerId: string,
) {
  const clientId = randomUUID();
  await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: 3,
      clientId,
      appVersion: "integration",
      clientKind: "web",
    },
  ]);
  const created = await stream.rpc("sendConversationCommandV4", [
    {
      workspacePath,
      envelope: {
        commandId: randomUUID(),
        clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: workspacePath,
          config: {
            modelSelection: {
              providerId,
              modelId: "stop-model",
              options: {},
            },
          },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const sessionId = created.body.result.result.sessionId as string;
  const command = (
    type: string,
    payload: unknown,
    commandId: string = randomUUID(),
  ) =>
    stream.rpc("sendConversationCommandV4", [
      {
        workspacePath,
        envelope: {
          commandId,
          clientId,
          sessionId,
          type,
          payload,
          issuedAt: Date.now(),
        },
      },
    ]);
  const snapshot = async () => {
    const result = await request(`/api/code-ui/sessions/${sessionId}`);
    expect(result.status).toBe(200);
    return result.body.snapshot;
  };
  return { command, snapshot, sessionId };
}

export async function createCodeSessionFixture(baseUrl: string) {
  const dir = await mkdtemp(join(tmpdir(), "code-ui-stop-"));
  const streams: AbortController[] = [];
  let projectId = "";
  let providerId = "";
  const dispose = async () => {
    for (const stream of streams) stream.abort();
    if (providerId)
      await request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method: "deletePersonalProvider",
        args: [providerId],
      });
    if (projectId)
      await request(`/api/projects/${projectId}`, undefined, "DELETE");
    await rm(dir, { recursive: true, force: true });
  };
  try {
    expect((await request("/api/viewer")).status).toBe(200);
    const opened = await request("/api/code-ui/rpc", {
      service: "workspace",
      method: "open",
      args: [{ path: dir }],
    });
    expect(opened.status).toBe(200);
    projectId = opened.body.result.projectId;
    const workspacePath = opened.body.result.path;
    const provider = (method: string, args: unknown[]) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    const added = await provider("createPersonalProvider", [
      { providerName: "停止公开接口验收" },
    ]);
    providerId = added.body.result.providerId;
    await provider("savePersonalProviderOverlay", [
      providerId,
      {
        api: { type: "openai-chat-completions", baseUrl },
        access: { type: "api-key", apiKey: "integration-only-not-a-key" },
      },
    ]);
    await provider("addPersonalModel", [providerId, "stop-model", {}]);
    const stream = await openCodeStream(streams);
    const bound = await bindSession(stream, workspacePath, providerId);
    return { ...bound, stream, workspacePath, projectId, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
