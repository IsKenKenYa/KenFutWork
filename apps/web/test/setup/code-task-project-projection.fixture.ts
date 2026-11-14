import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeTaskProjectMoveInput,
  type IWindowControllerService,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { expect, vi } from "vitest";
import type { createCodeSessionFixture } from "../../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../../server/src/features/code-ui/model-stream.fixture.js";
import type { CodeHttpChannelClient } from "../../src/components/workbench/zcode/host/httpChannelClient";
import {
  type CodeConnectionGate,
  createCodeConnectionGate,
} from "./code-connection-gate.js";
import type { PublicFixture } from "./code-public-session";

type Fixture = PublicFixture & { directory: string; origin: string };
export type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
export type Model = Awaited<ReturnType<typeof heldModel>>;
export type ProjectionResources = {
  fixture: Fixture;
  model?: Model;
  host?: Host;
  client?: CodeHttpChannelClient;
  targetProjectId?: string;
  controller?: IWindowControllerService;
  controllerListener?: { dispose(): void };
  controllerSubscriptionId?: string;
  taskMetaListener?: { dispose(): void };
  connectionGate?: CodeConnectionGate;
  unmount?: () => void;
  releaseDom?: () => void;
};
export type ProjectionContext = Awaited<
  ReturnType<typeof prepareProjectionResources>
>;
const fixturePath = join(
  import.meta.dirname,
  "../../../server/src/features/code-ui/code-ui-http.fixture.ts",
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

export async function createTarget(fixture: Fixture, host: Host) {
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

export async function submitTaskMove(
  host: Host,
  input: CodeTaskProjectMoveInput,
) {
  const moved = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body).toEqual({ result: null });
}

async function loadProjectionFixture() {
  const httpLoading: Promise<{
    createCodeUiHttpFixture(): Promise<Fixture>;
  }> = import(fixturePath);
  const [http, sessions, models, channel] = await Promise.all([
    httpLoading,
    import("../../../server/src/features/code-ui/host-session.fixture.js"),
    import("../../../server/src/features/code-ui/model-stream.fixture.js"),
    import("../../src/components/workbench/zcode/host/httpChannelClient"),
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
    apiBase: resources.connectionGate?.baseUrl ?? fixture.baseUrl,
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

export async function moveUsingCurrentControl(
  host: Host,
  workspacePath: string,
  projectId: string,
) {
  const current = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const control = protocol.conversationTaskControlSchema.parse(
    current.taskControl,
  );
  await submitTaskMove(host, {
    task: {
      taskId: host.sessionId,
      workspacePath,
      workspaceIdentity: JSON.stringify([control.projectId, workspacePath]),
    },
    sourceProjectId: control.projectId,
    projectId,
    observedRevision: current.revision,
    hostId: "local",
    addMissingRoot: true,
  });
}

async function closeProjectionResources(
  resources: ProjectionResources,
  failures: unknown[],
) {
  const { client, targetProjectId, host, model, fixture } = resources;
  for (const close of [
    () => resources.unmount?.(),
    async () => {
      if (resources.controller && resources.controllerSubscriptionId)
        await resources.controller.unsubscribeControllerV4({
          subscriptionId: resources.controllerSubscriptionId,
        });
    },
    () => resources.controllerListener?.dispose(),
    () => resources.taskMetaListener?.dispose(),
    () => client?.dispose(),
    () => resources.connectionGate?.close(),
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
    () => resources.releaseDom?.(),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
}

export async function withProjectionResources(
  assertion: (
    context: ProjectionContext,
    resources: ProjectionResources,
  ) => Promise<void>,
  throughConnectionGate = false,
) {
  const loaded = await loadProjectionFixture();
  const resources: ProjectionResources = { fixture: loaded.fixture };
  const failures: unknown[] = [];
  try {
    if (throughConnectionGate)
      resources.connectionGate = await createCodeConnectionGate(
        loaded.fixture.baseUrl,
      );
    const context = await prepareProjectionResources(loaded, resources);
    await assertion(context, resources);
  } catch (error) {
    failures.push(error);
  } finally {
    await closeProjectionResources(resources, failures);
  }
  if (failures.length)
    throw new AggregateError(failures, "Task项目投影验证或资源关闭失败", {
      cause: failures[0],
    });
}
