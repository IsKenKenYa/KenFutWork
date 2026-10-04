import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelSelection } from "@zcode/provider";
import { modelSelectionSchema } from "@zcode/shared";
import { expect } from "vitest";
import { z } from "zod";
import {
  type CodeUiTestClient,
  openCodeStream,
  request,
} from "./host-client.fixture.js";

async function bindSession(
  stream: Awaited<ReturnType<typeof openCodeStream>>,
  workspacePath: string,
  modelSelection: ModelSelection,
  projectId: string,
  clientId: string,
  client: Pick<CodeUiTestClient, "request">,
) {
  const created = await stream.rpc("sendConversationCommandV4", [
    {
      workspacePath,
      projectId,
      envelope: {
        commandId: randomUUID(),
        clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: projectId,
          config: {
            modelSelection,
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
        projectId,
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
    const result = await client.request(`/api/code-ui/sessions/${sessionId}`);
    expect(result.status).toBe(200);
    return result.body.snapshot;
  };
  return { command, snapshot, sessionId };
}

export async function createCodeSessionFixture(
  baseUrl: string,
  options?: { client: Pick<CodeUiTestClient, "request" | "openCodeStream"> },
) {
  const transport = options?.client ?? { request, openCodeStream };
  const viewer = await transport.request("/api/viewer");
  expect(viewer.status, JSON.stringify(viewer.body)).toBe(200);
  const dir = await mkdtemp(join(tmpdir(), "code-ui-stop-"));
  const streams: AbortController[] = [];
  let projectId = "";
  let providerId = "";
  const stream = await transport.openCodeStream(streams);
  const clientId = randomUUID();
  const connectedRequest: CodeUiTestClient["request"] = (path, body, method) =>
    transport.request(
      path,
      path === "/api/code-ui/rpc" && body !== null && typeof body === "object"
        ? { ...body, connectionId: stream.ready.hello.connectionId }
        : body,
      method,
    );
  const client = {
    ...transport,
    request: connectedRequest,
  };
  const dispose = async () => {
    try {
      if (providerId)
        await client.request("/api/code-ui/rpc", {
          service: "providerSettingsService",
          method: "deletePersonalProvider",
          args: [providerId],
        });
      if (projectId)
        await client.request(`/api/projects/${projectId}`, undefined, "DELETE");
    } finally {
      for (const controller of streams) controller.abort();
      await rm(dir, { recursive: true, force: true });
    }
  };
  try {
    const hello = await stream.rpc("initializeConversationV4", [
      {
        kind: "clientHello",
        protocolVersion: 3,
        clientId,
        appVersion: "isolated-stop-integration",
        clientKind: "web",
      },
    ]);
    expect(hello.status, JSON.stringify(hello.body)).toBe(200);
    const opened = await client.request("/api/code-ui/rpc", {
      service: "workspace",
      method: "open",
      args: [{ path: dir }],
    });
    expect(opened.status).toBe(200);
    projectId = z.uuid().parse(opened.body.result.projectId);
    const workspacePath = opened.body.result.path;
    const provider = (method: string, args: unknown[]) =>
      client.request("/api/code-ui/rpc", {
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
    const view = await client.request("/api/code-ui/rpc", {
      service: "modelSelectionService",
      method: "getView",
      args: [],
    });
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    const selection = modelSelectionSchema.parse(
      view.body.result.preferredSelection,
    );
    expect(selection).toMatchObject({ providerId, modelId: "stop-model" });
    z.string().min(1).parse(selection.options?.reasoningLevel);
    const bound = await bindSession(
      stream,
      workspacePath,
      selection,
      projectId,
      clientId,
      client,
    );
    return { ...bound, stream, workspacePath, projectId, client, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
