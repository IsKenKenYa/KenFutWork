import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { ModelSelection } from "@zcode/provider";
import { modelSelectionSchema } from "@zcode/shared";
import { expect } from "vitest";
import { z } from "zod";
import { createLocalInstanceService } from "../local-instance/service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { CodeUiTestClient } from "./host-client.fixture.js";

const runFile = promisify(execFile);

async function initializeTaskRepository(directory: string) {
  const options = { cwd: directory };
  await runFile("git", ["init", "--quiet", "--initial-branch=main"], options);
  for (const [name, value] of Object.entries({
    "user.name": "KFW Test",
    "user.email": "tests@kenfutwork.invalid",
    "commit.gpgsign": "false",
  }))
    await runFile("git", ["config", "--local", name, value], options);
  const { stdout } = await runFile(
    "git",
    ["rev-parse", "--show-toplevel"],
    options,
  );
  if ((await realpath(stdout.trim())) !== (await realpath(directory)))
    throw new Error("临时 Task 的 Git 仓库必须属于自己的工作目录。");
}

type InitialConfig = Pick<
  NonNullable<protocol.CommandPayloadMap["createSession"]["config"]>,
  "mode" | "planEnabled"
>;

async function bindSession(
  stream: Awaited<ReturnType<CodeUiTestClient["openCodeStream"]>>,
  workspacePath: string,
  modelSelection: ModelSelection,
  projectId: string,
  clientId: string,
  client: Pick<CodeUiTestClient, "request">,
  initialConfig?: InitialConfig,
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
            ...initialConfig,
            modelSelection,
          },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(created.body.result).status).toBe(
    "accepted",
  );
  const sessionId = created.body.result.result.sessionId as string;
  const commandObservations = new Map<
    string,
    Promise<protocol.ConversationTaskControl | undefined>
  >();
  const command = async (
    type: string,
    payload: unknown,
    commandId: string = randomUUID(),
    guard?: Partial<
      Pick<
        protocol.CommandEnvelope,
        "baseRevision" | "baseLogEpoch" | "taskControl"
      >
    >,
  ) => {
    const suppliedGuard = structuredClone(guard);
    let observation = commandObservations.get(commandId);
    if (!observation) {
      observation = Object.hasOwn(suppliedGuard ?? {}, "taskControl")
        ? Promise.resolve(
            suppliedGuard?.taskControl
              ? Object.freeze(structuredClone(suppliedGuard.taskControl))
              : undefined,
          )
        : client
            .request(`/api/code-ui/sessions/${sessionId}`)
            .then((result) => {
              if (result.status === 404) return undefined;
              expect(result.status, JSON.stringify(result.body)).toBe(200);
              const current = protocol.conversationSnapshotSchema.parse(
                result.body.snapshot,
              );
              if (!current.taskControl)
                throw new Error("命令测试没有公开 Task 观察值");
              return Object.freeze(structuredClone(current.taskControl));
            });
      commandObservations.set(commandId, observation);
    }
    const taskControl = await observation;
    return stream.rpc("sendConversationCommandV4", [
      {
        workspacePath,
        projectId,
        envelope: {
          commandId,
          clientId,
          sessionId,
          type,
          payload,
          taskControl: structuredClone(taskControl),
          issuedAt: Date.now(),
          ...suppliedGuard,
        },
      },
    ]);
  };
  const snapshot = async () => {
    const result = await client.request(`/api/code-ui/sessions/${sessionId}`);
    expect(result.status).toBe(200);
    return result.body.snapshot;
  };
  return { command, snapshot, sessionId, clientId };
}

export async function createCodeSessionFixture(
  baseUrl: string,
  options: {
    client: Pick<CodeUiTestClient, "request" | "openCodeStream">;
    initialConfig?: InitialConfig;
  },
) {
  const transport = options.client;
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
    await initializeTaskRepository(dir);
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
      options.initialConfig,
    );
    return { ...bound, stream, workspacePath, projectId, client, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** 单元夹具复用真实实例服务，Actor 不包含账户/邮箱/令牌别名。 */
export function createCodeUiTestInstance(
  instanceId: string,
  accessClientId: string | null = null,
  dataDir = tmpdir(),
) {
  const actor: LocalActor = Object.freeze({ instanceId, accessClientId });
  const localInstance = createLocalInstanceService({
    repository: { ensure: async () => instanceId },
    dataDir,
  });
  return { actor, localInstance };
}
