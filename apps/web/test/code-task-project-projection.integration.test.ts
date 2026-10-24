// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodeTaskProjectMoveInput,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../server/src/features/code-ui/model-stream.fixture.js";
import type { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import type { PublicFixture } from "./setup/code-public-session";

type Fixture = PublicFixture & { directory: string };
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type ProjectionResources = {
  fixture: Fixture;
  model?: Model;
  host?: Host;
  client?: CodeHttpChannelClient;
  targetProjectId?: string;
};
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

async function completeTask(host: Host, model: Model) {
  const sent = await host.command("sendText", {
    text: "完成持久Task后验证项目移动的客户端读取",
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await model.firstRequest;
  model.finish(0);
  await vi.waitFor(
    async () => {
      const current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(
        current.control.phase,
        JSON.stringify(current.control.lastError),
      ).toBe("completedSuccess");
      expect(current.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          state: "complete",
          text: "正在运行 1",
        }),
      );
    },
    { timeout: 30_000 },
  ); // 仅等待独占模型HTTP与持久会话投影完成。
}

async function createTarget(fixture: Fixture, host: Host) {
  const directory = join(fixture.directory, "客户端投影的目标项目目录");
  await mkdir(directory);
  const response = await host.client.request("/api/projects", {
    name: "客户端投影的目标项目",
    kind: "code",
    work_dir: directory,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return projectCreateResponseSchema.parse(response.body).project.id;
}

async function loadProjectionFixture() {
  const httpLoading: Promise<{
    createCodeUiHttpFixture(): Promise<Fixture>;
  }> = import(fixturePath);
  const [http, sessions, models, channel] = await Promise.all([
    httpLoading,
    import("../../server/src/features/code-ui/host-session.fixture.js"),
    import("../../server/src/features/code-ui/model-stream.fixture.js"),
    import("../src/components/workbench/zcode/host/httpChannelClient"),
  ]);
  const fixture = await http.createCodeUiHttpFixture();
  return { fixture, sessions, models, channel };
}

async function prepareProjectionResources(
  loaded: Awaited<ReturnType<typeof loadProjectionFixture>>,
  resources: ProjectionResources,
) {
  const { fixture, sessions, models, channel } = loaded;
  // 受控模型HTTP只用于建立真实历史，不调用用户的供应商或模型。
  const model = await models.heldModel();
  resources.model = model;
  const session = await sessions.createCodeSessionFixture(model.baseUrl, {
    client: fixture.client,
  });
  resources.host = session;
  await completeTask(session, model);
  const client = new channel.CodeHttpChannelClient({
    apiBase: fixture.baseUrl,
    accessToken: await fixture.app.kernel.get("localAccess").getDesktopToken(),
  });
  resources.client = client;
  await client.connect();
  const hello = protocol.helloMessageSchema.parse(
    await client.services.zcodeAgentService.helloConversationV4(),
  );
  await client.services.zcodeAgentService.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: hello.protocolVersion,
    clientId: randomUUID(),
    appVersion: "task-project-projection-integration",
    clientKind: "web",
  });
  await client.refreshWorkspaces();
  return { fixture, session, model, client };
}

async function assertProjectProjection(
  context: Awaited<ReturnType<typeof prepareProjectionResources>>,
  resources: ProjectionResources,
) {
  const { fixture, session, model, client } = context;
  const projectService = client.services.projectService;
  if (!projectService) throw new Error("原项目服务尚未连接。");
  expect(client.workspaces.task(session.sessionId)).toBeNull();
  const before = await projectService.readTree({
    hostId: "local",
  });
  const task = before.tasks.find((entry) => entry.taskId === session.sessionId);
  if (!task?.taskControl || task.conversationRevision === undefined)
    throw new Error("公开项目树缺少持久Task及移动观察值。");
  expect(task.projectId).toBe(session.projectId);
  expect(task.workspacePath).toBe(session.workspacePath);
  expect(client.workspaces.task(task.taskId)).toEqual({
    taskId: task.taskId,
    projectId: session.projectId,
    rootDirectory: session.workspacePath,
  });
  const targetProjectId = await createTarget(fixture, session);
  resources.targetProjectId = targetProjectId;
  const input: CodeTaskProjectMoveInput = {
    task: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
    },
    sourceProjectId: task.projectId,
    projectId: targetProjectId,
    observedRevision: task.conversationRevision,
    hostId: "local",
    addMissingRoot: true,
  };
  const moved = await session.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body).toEqual({ result: null });
  const after = await projectService.readTree({
    hostId: "local",
  });
  expect(after.tasks).toContainEqual(
    expect.objectContaining({
      taskId: task.taskId,
      projectId: targetProjectId,
      workspacePath: task.workspacePath,
    }),
  );
  expect(client.workspaces.task(task.taskId)).toEqual({
    taskId: task.taskId,
    projectId: targetProjectId,
    rootDirectory: task.workspacePath,
  });
  expect(model.requests).toHaveLength(1);
}

async function closeProjectionResources(
  resources: ProjectionResources,
  failures: unknown[],
) {
  const { client, targetProjectId, host, model, fixture } = resources;
  for (const close of [
    () => client?.dispose(),
    async () => {
      if (!targetProjectId || !host) return;
      const response = await host.client.request(
        `/api/projects/${targetProjectId}`,
        undefined,
        "DELETE",
      );
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(400);
    },
    () => host?.dispose(),
    () => model?.close(),
    () => fixture.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task项目归属的客户端真实HTTP、SSE与PostgreSQL投影 integration",
  () => {
    it("另一连接移动Task后，原客户端重读项目树更新项目身份并保留固定目录", async () => {
      const loaded = await loadProjectionFixture();
      const resources: ProjectionResources = { fixture: loaded.fixture };
      const failures: unknown[] = [];
      try {
        const context = await prepareProjectionResources(loaded, resources);
        await assertProjectProjection(context, resources);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeProjectionResources(resources, failures);
      }
      if (failures.length)
        throw new AggregateError(failures, "Task项目投影验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 120_000); // 真实HTTP/SSE、独占PostgreSQL、受控模型及资源关闭期限。
  },
);
