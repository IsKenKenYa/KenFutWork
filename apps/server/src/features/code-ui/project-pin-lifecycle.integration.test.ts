import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  type CodeProjectEditorPin,
  type CodeProjectEditorProject,
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  projectListResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type Response = Awaited<ReturnType<Host["client"]["request"]>>;

function projectRpc(host: Host, method: string, args: unknown[]) {
  return host.client.request("/api/code-ui/rpc", {
    service: "project",
    method,
    args,
  });
}

function expectNotFound(response: Response) {
  expect(response.status, JSON.stringify(response.body)).toBe(404);
  applicationErrorResponseSchema.parse(response.body);
}

async function readTree(host: Host) {
  const response = await projectRpc(host, "readTree", [
    { hostId: "local", includeDeleted: true, includeDeletedTasks: true },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function taskScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function seedTaskHistory(host: Host, model: Model) {
  const sent = await host.command("sendText", {
    text: "项目置顶生命周期期间保留的原任务历史",
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await model.firstRequest;
  model.finish(0);
  await vi.waitFor(
    async () => {
      const snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(snapshot.control.phase).toBe("completedSuccess");
      expect(
        snapshot.rows.window
          .filter((row) => row.kind === "userInput")
          .map((row) => row.text),
      ).toEqual(["项目置顶生命周期期间保留的原任务历史"]);
    },
    { timeout: 30_000 },
  ); // 仅等待原Task通过真实受控模型HTTP完成已有历史。
}

async function createProject(host: Host) {
  const root = join(host.workspacePath, "置顶生命周期主目录");
  await mkdir(root);
  const response = await projectRpc(host, "saveProject", [
    {
      creationId: randomUUID(),
      kind: "code",
      hostId: "local",
      name: "置顶生命周期项目 B",
      roots: [root],
      primaryRoot: root,
      rootPermissions: {},
      directoryChoice: "independent",
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const project = codeProjectEditorProjectSchema.parse(response.body.result);
  expect(project.id).not.toBe(host.projectId);
  expect(project.roots).toEqual([
    { rootPath: root, position: 0, isPrimary: true },
  ]);
  return { project, root };
}

async function pinWithUnavailableDirectory(
  host: Host,
  project: CodeProjectEditorProject,
  root: string,
) {
  const before = await readTree(host);
  const input: CodeProjectEditorPin = {
    id: project.id,
    hostId: "local",
    expectedRevision: project.revision,
    pinned: true,
  };
  const movedRoot = `${root} 暂存`;
  await rename(root, movedRoot);
  try {
    const response = await projectRpc(host, "saveProject", [input]);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const pinned = codeProjectEditorProjectSchema.parse(response.body.result);
    expect(pinned).toMatchObject({
      id: project.id,
      name: project.name,
      roots: project.roots,
      createdAt: project.createdAt,
      revision: project.revision + 1,
      pinned: true,
    });
    const after = await readTree(host);
    expect(after.projects.find((entry) => entry.id === project.id)).toEqual(
      pinned,
    );
    expect(after.projects.filter((entry) => entry.id !== project.id)).toEqual(
      before.projects.filter((entry) => entry.id !== project.id),
    );
    expect(after.tasks).toEqual(before.tasks);
    return { input, pinned, tree: after };
  } finally {
    await rename(movedRoot, root);
  }
}

async function rejectClosedConnectionPin(
  host: Host,
  input: CodeProjectEditorPin,
) {
  const before = await readTree(host);
  const stream = await isolatedHttp.openCodeStream();
  const rpc = (method: string, args: unknown[]) =>
    isolatedHttp.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "project",
      method,
      args,
    });
  try {
    const initialized = await stream.rpc("initializeConversationV4", [
      {
        kind: "clientHello",
        protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
        clientId: randomUUID(),
        appVersion: "project-pin-lifecycle-integration",
        clientKind: "web",
      },
    ]);
    expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
    const ready = await rpc("readTree", [
      { hostId: "local", includeDeleted: true, includeDeletedTasks: true },
    ]);
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(codeProjectTreeSchema.parse(ready.body.result)).toEqual(before);
    stream.controller.abort();
    await stream.closed;
    await vi.waitFor(
      async () => expectNotFound(await rpc("readTree", [{ hostId: "local" }])),
      { timeout: 15_000 },
    ); // 只读请求确认服务端已释放该可信连接。
    // 连接关闭后只发一次原置顶材料；此时项目仍可用，不能借归档状态掩盖连接校验。
    expectNotFound(await rpc("saveProject", [input]));
    expect(await readTree(host)).toEqual(before);
  } finally {
    stream.controller.abort();
    await stream.closed;
  }
}

async function archiveAndRejectLatePins(
  host: Host,
  project: CodeProjectEditorProject,
  inputs: readonly CodeProjectEditorPin[],
) {
  const response = await projectRpc(host, "deleteProject", [
    project.id,
    "local",
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const archived = await readTree(host);
  expect(
    archived.projects.filter((entry) => entry.id === project.id),
  ).toHaveLength(1);
  const archivedProject = archived.projects.find(
    (entry) => entry.id === project.id,
  );
  expect(archivedProject).toMatchObject({
    id: project.id,
    name: project.name,
    roots: project.roots,
    pinned: project.pinned,
    deleted: true,
  });
  expect(archivedProject?.revision).toBeGreaterThan(project.revision);
  for (const input of inputs) {
    expectNotFound(await projectRpc(host, "saveProject", [input]));
    expect(await readTree(host)).toEqual(archived);
  }
  // REST DELETE 同样执行归档；已归档项目继续返回404，维护删除另行构造。
  expectNotFound(
    await host.client.request(
      `/api/projects/${project.id}`,
      undefined,
      "DELETE",
    ),
  );
  expect(await readTree(host)).toEqual(archived);
  const listed = await host.client.request("/api/projects?kind=code");
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(
    projectListResponseSchema
      .parse(listed.body)
      .projects.map((entry) => entry.id),
  ).not.toContain(project.id);
  return archived;
}

async function maintainDeleteProject(instanceId: string, projectId: string) {
  const persistence = createPostgresPersistence({
    databaseUrl: isolatedHttp.databaseUrl(),
  });
  try {
    // 仅为本例独占临时实例构造维护删除条件；业务结果由后续公开RPC与目录验证。
    expect(
      await persistence
        .forInstance(instanceId)
        .execute(
          "delete from public.projects where instance_id=:instance and id=$1",
          [projectId],
        ),
    ).toBe(1);
  } finally {
    await persistence.close();
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目置顶生命周期的HTTP、SSE与PostgreSQL integration",
  () => {
    it("目录失效仍可稀疏置顶，关闭连接、归档和维护删除均拒绝迟到请求并保留原任务", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        await seedTaskHistory(host, model);
        const beforeScope = await taskScope(host);
        const beforeSnapshot = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        const modelRequestCountBefore = model.requests.length;
        const { project, root } = await createProject(host);
        const { input, pinned, tree } = await pinWithUnavailableDirectory(
          host,
          project,
          root,
        );
        expect(await readTree(host)).toEqual(tree);
        await rejectClosedConnectionPin(host, input);
        const nextInput: CodeProjectEditorPin = {
          id: pinned.id,
          hostId: "local",
          expectedRevision: pinned.revision,
          pinned: false,
        };
        const inputs = [input, nextInput];
        const archived = await archiveAndRejectLatePins(host, pinned, inputs);
        await maintainDeleteProject(beforeScope.instanceId, project.id);
        const deleted = await readTree(host);
        expect(deleted.projects.some((entry) => entry.id === project.id)).toBe(
          false,
        );
        expect(deleted.projects).toEqual(
          archived.projects.filter((entry) => entry.id !== project.id),
        );
        expect(deleted.tasks).toEqual(archived.tasks);
        for (const late of inputs) {
          expectNotFound(await projectRpc(host, "saveProject", [late]));
          expect(await readTree(host)).toEqual(deleted);
        }
        expect(await taskScope(host)).toEqual(beforeScope);
        expect(
          protocol.conversationSnapshotSchema.parse(await host.snapshot()),
        ).toEqual(beforeSnapshot);
        expect(model.requests).toHaveLength(modelRequestCountBefore);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [() => host?.dispose(), () => model.close()]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "项目置顶生命周期验证或资源关闭失败",
          {
            cause: failures[0],
          },
        );
    }, 90_000); // 独占HTTP、SSE关闭、临时PG、目录恢复及受控模型HTTP的验证期限。
  },
);
