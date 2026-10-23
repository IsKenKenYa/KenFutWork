import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeProjectEditorProject,
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;

function projectRpc(host: Host, method: string, args: unknown[] = []) {
  return host.client.request("/api/code-ui/rpc", {
    service: "project",
    method,
    args,
  });
}

async function taskSnapshot(host: Host, taskId: string) {
  const response = await host.client.request(`/api/code-ui/sessions/${taskId}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return protocol.conversationSnapshotSchema.parse(response.body.snapshot);
}

async function taskCommand(
  host: Host,
  projectId: string,
  taskId: string,
  type: "sendText" | "stop",
  payload: { text: string } | Record<string, never>,
) {
  const snapshot = await taskSnapshot(host, taskId);
  if (!snapshot.taskControl) throw new Error("真实Task缺少公开控制观察值。");
  const result = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: taskId,
        type,
        payload,
        taskControl: snapshot.taskControl,
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(result.body.result).status).toBe(
    "accepted",
  );
}

async function publishTask(
  host: Host,
  projectId: string,
  taskId: string,
  title: string,
  model: Model,
  requestCount: number,
) {
  await taskCommand(host, projectId, taskId, "sendText", { text: title });
  await vi.waitFor(() => expect(model.requests).toHaveLength(requestCount), {
    timeout: 30_000,
  }); // 只等待本例真实HTTP模型流，不属于Agent运行时配置。
  await taskCommand(host, projectId, taskId, "stop", {});
  await vi.waitFor(
    async () => {
      const snapshot = await taskSnapshot(host, taskId);
      expect(snapshot.control.phase).toBe("completedInterrupted");
      expect(snapshot.meta.title).toBe(title);
      expect(model.requests[requestCount - 1]?.closed).toBe(true);
    },
    { timeout: 30_000 },
  );
}

async function taskScope(host: Host, taskId: string) {
  const result = await host.client.request(
    `/api/code-ui/tasks/${taskId}/scope`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(result.body).scope;
}

async function localProjectTree(host: Host) {
  const result = await projectRpc(host, "readTree", [
    { hostId: "local", includeDeleted: false, includeDeletedTasks: true },
  ]);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return codeProjectTreeSchema.parse(result.body.result);
}

async function createSameDirectoryProjects(host: Host, additional: string) {
  const listed = await projectRpc(host, "readProjects", [{ hostId: "local" }]);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const projectsBefore = codeProjectEditorProjectSchema
    .array()
    .parse(listed.body.result);
  const original = projectsBefore.find(
    (project) => project.id === host.projectId,
  );
  if (!original) throw new Error("公开项目列表缺少真实来源项目。");
  const shared = {
    hostId: "local",
    roots: [host.workspacePath, additional],
    primaryRoot: host.workspacePath,
  };
  const edited = await projectRpc(host, "saveProject", [
    {
      ...shared,
      id: original.id,
      name: "项目树同目录甲",
      rootPermissions: { [additional]: "read-only" },
      expectedRevision: original.revision,
    },
  ]);
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  const source = codeProjectEditorProjectSchema.parse(edited.body.result);
  const created = await projectRpc(host, "saveProject", [
    {
      ...shared,
      creationId: randomUUID(),
      kind: "code",
      name: "项目树同目录乙",
      rootPermissions: { [additional]: "read-write" },
      directoryChoice: "independent",
    },
  ]);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const target = codeProjectEditorProjectSchema.parse(created.body.result);
  expect(target.id).not.toBe(source.id);
  return { source, target, projectsBefore };
}

async function createTargetTask(
  host: Host,
  projectId: string,
  modelSelection: protocol.SessionConfigState["modelSelection"],
) {
  const result = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: projectId,
          config: { modelSelection, mode: "build", planEnabled: false },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(result.body.result);
  expect(ack.status).toBe("accepted");
  if (ack.result?.type !== "createSession")
    throw new Error("公开创建回执没有返回真实Task身份。");
  return ack.result.sessionId;
}

async function prepareStoppedRootAndNeighbor(host: Host, model: Model) {
  const selection = (await taskSnapshot(host, host.sessionId)).config
    .modelSelection;
  await publishTask(
    host,
    host.projectId,
    host.sessionId,
    "项目树待删除任务",
    model,
    1,
  );
  const retainedTaskId = await createTargetTask(
    host,
    host.projectId,
    selection,
  );
  await publishTask(
    host,
    host.projectId,
    retainedTaskId,
    "项目树保留任务",
    model,
    2,
  );
  return {
    retainedTaskId,
    scopeBefore: await taskScope(host, retainedTaskId),
    before: await localProjectTree(host),
  };
}

async function archiveStoppedRootWithBody(host: Host, model: Model) {
  await taskCommand(host, host.projectId, host.sessionId, "sendText", {
    text: "归档项目保留的任务正文",
  });
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  });
  await vi.waitFor(
    async () => {
      const current = await taskSnapshot(host, host.sessionId);
      expect(JSON.stringify(current.rows.window)).toContain("正在运行 1");
    },
    { timeout: 30_000 },
  ); // 仅等待本例真实HTTP正文进入公开快照，不属于Agent运行时配置。
  await taskCommand(host, host.projectId, host.sessionId, "stop", {});
  await vi.waitFor(
    async () => {
      const current = await taskSnapshot(host, host.sessionId);
      expect(current.control.phase).toBe("completedInterrupted");
      expect(model.requests[0]?.closed).toBe(true);
    },
    { timeout: 30_000 },
  );
  const stopped = await taskSnapshot(host, host.sessionId);
  expect(JSON.stringify(stopped.rows.window)).toContain("正在运行 1");
  if (!stopped.taskControl)
    throw new Error("归档项目夹具缺少已停止Task的公开观察值。");
  const archived = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "archiveTask",
    args: [
      {
        taskId: host.sessionId,
        workspacePath: host.workspacePath,
        workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
        taskControl: structuredClone(stopped.taskControl),
      },
    ],
  });
  expect(archived.status, JSON.stringify(archived.body)).toBe(200);
  expect(archived.body.result).toMatchObject({
    taskId: host.sessionId,
    projectId: host.projectId,
    workspacePath: host.workspacePath,
  });
}

function expectLocalTree(
  tree: unknown,
  input: {
    source: CodeProjectEditorProject;
    target: CodeProjectEditorProject;
    projectsBefore: CodeProjectEditorProject[];
    sourceTaskId: string;
    targetTaskId: string;
    root: string;
    additional: string;
  },
) {
  const {
    source,
    target,
    projectsBefore,
    sourceTaskId,
    targetTaskId,
    root,
    additional,
  } = input;
  expect(tree).toHaveProperty("projects.length", projectsBefore.length + 1);
  expect(tree).toHaveProperty("tasks.length", 2);
  expect(tree).not.toHaveProperty("legacySingleRoot");
  expect(tree).toMatchObject({
    projects: expect.arrayContaining([
      ...projectsBefore.filter((project) => project.id !== source.id),
      expect.objectContaining({
        id: source.id,
        hostId: "local",
        name: "项目树同目录甲",
        revision: 1,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
        roots: [
          { rootPath: root, position: 0, isPrimary: true },
          {
            rootPath: additional,
            position: 1,
            isPrimary: false,
            access: "read-only",
          },
        ],
      }),
      expect.objectContaining({
        id: target.id,
        hostId: "local",
        name: "项目树同目录乙",
        revision: 0,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
        roots: [
          { rootPath: root, position: 0, isPrimary: true },
          {
            rootPath: additional,
            position: 1,
            isPrimary: false,
            access: "read-write",
          },
        ],
      }),
    ]),
    tasks: expect.arrayContaining([
      expect.objectContaining({
        taskId: sourceTaskId,
        projectId: source.id,
        hostId: "local",
        workspacePath: root,
        workspaceIdentity: JSON.stringify([source.id, root]),
        title: "项目甲稳定任务",
        pinned: false,
        archived: false,
      }),
      expect.objectContaining({
        taskId: targetTaskId,
        projectId: target.id,
        hostId: "local",
        workspacePath: root,
        workspaceIdentity: JSON.stringify([target.id, root]),
        title: "项目乙稳定任务",
        pinned: false,
        archived: false,
      }),
    ]),
    deletedTasks: [],
  });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目树的真实RPC与PostgreSQL integration",
  () => {
    it("本机树按稳定Project与Task身份隔离同目录项目，保留目录权限且读取无副作用", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      let targetProjectId: string | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        const additional = join(host.workspacePath, "项目树附加资料");
        await mkdir(additional);
        const { source, target, projectsBefore } =
          await createSameDirectoryProjects(host, additional);
        targetProjectId = target.id;
        const selection = (await taskSnapshot(host, host.sessionId)).config
          .modelSelection;
        await publishTask(
          host,
          source.id,
          host.sessionId,
          "项目甲稳定任务",
          model,
          1,
        );
        const targetTaskId = await createTargetTask(host, target.id, selection);
        expect(targetTaskId).not.toBe(host.sessionId);
        await publishTask(
          host,
          target.id,
          targetTaskId,
          "项目乙稳定任务",
          model,
          2,
        );
        const beforeSource = await taskScope(host, host.sessionId);
        const beforeTarget = await taskScope(host, targetTaskId);
        expect(beforeSource).toMatchObject({
          projectId: source.id,
          rootDirectory: host.workspacePath,
          additionalDirectories: [],
        });
        expect(beforeTarget).toMatchObject({
          projectId: target.id,
          rootDirectory: host.workspacePath,
          additionalDirectories: [{ path: additional, access: "read-write" }],
        });
        const requestsBefore = model.requests.length;
        const result = await projectRpc(host, "readTree", [
          { hostId: "local", includeDeleted: false, includeDeletedTasks: true },
        ]);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expectLocalTree(result.body.result, {
          source,
          target,
          projectsBefore,
          sourceTaskId: host.sessionId,
          targetTaskId,
          root: host.workspacePath,
          additional,
        });
        expect(await taskScope(host, host.sessionId)).toEqual(beforeSource);
        expect(await taskScope(host, targetTaskId)).toEqual(beforeTarget);
        expect(model.requests).toHaveLength(requestsBefore);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          async () => {
            if (!host || !targetProjectId) return;
            const deleted = await host.client.request(
              `/api/projects/${targetProjectId}`,
              undefined,
              "DELETE",
            );
            expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
          },
          () => host?.dispose(),
          () => model.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "原项目树读取验证或清理失败", {
          cause: failures[0],
        });
    }, 90_000); // 两次真实HTTP模型流与PG资源关闭的独占测试期限。

    it("删除已停止根Task后只返回稳定删除身份，保留其他Task与完整项目且读取不启动模型", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        const listed = await projectRpc(host, "readProjects", [
          { hostId: "local" },
        ]);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const projectsBefore = codeProjectEditorProjectSchema
          .array()
          .parse(listed.body.result);
        const { retainedTaskId, scopeBefore, before } =
          await prepareStoppedRootAndNeighbor(host, model);
        expect(before.projects).toEqual(projectsBefore);
        expect(before.tasks).toHaveLength(2);
        expect(before.deletedTasks).toEqual([]);
        const retained = before.tasks.find(
          (task) => task.taskId === retainedTaskId,
        );
        expect(retained).toMatchObject({
          taskId: retainedTaskId,
          projectId: host.projectId,
          hostId: "local",
          workspacePath: host.workspacePath,
          workspaceIdentity: JSON.stringify([
            host.projectId,
            host.workspacePath,
          ]),
          title: "项目树保留任务",
          pinned: false,
          archived: false,
        });
        const requestsBefore = model.requests.length;
        const deleted = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "deleteTask",
          args: [
            {
              taskId: host.sessionId,
              projectId: host.projectId,
              workspacePath: host.workspacePath,
              workspaceIdentity: JSON.stringify([
                host.projectId,
                host.workspacePath,
              ]),
            },
          ],
        });
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        expect(deleted.body.result).toBeNull();
        const after = await localProjectTree(host);
        expect(after.projects).toEqual(projectsBefore);
        expect(after.tasks).toEqual([retained]);
        expect(after.deletedTasks).toEqual([
          {
            taskId: host.sessionId,
            projectId: host.projectId,
            hostId: "local",
          },
        ]);
        for (const path of [
          `/api/code-ui/sessions/${host.sessionId}`,
          `/api/code-ui/tasks/${host.sessionId}/scope`,
        ]) {
          const missing = await host.client.request(path);
          expect(missing.status, JSON.stringify(missing.body)).toBe(404);
        }
        expect(await taskScope(host, retainedTaskId)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(requestsBefore);
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
        throw new AggregateError(failures, "原项目树删除验证或清理失败", {
          cause: failures[0],
        });
    }, 90_000); // 两条真实Task发送与停止，以及独占HTTP和PG资源关闭。

    it("读取参数省略或为空使用本机项目，拒绝远端、错误类型、未知字段及多余参数且不改变Scope", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        const listed = await projectRpc(host, "readProjects", [
          { hostId: "local" },
        ]);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const projectsBefore = codeProjectEditorProjectSchema
          .array()
          .parse(listed.body.result);
        const scopeBefore = await taskScope(host, host.sessionId);
        expect(model.requests).toHaveLength(0);
        const requestsBefore = model.requests.length;
        for (const args of [[], [null], [{}]]) {
          const response = await projectRpc(host, "readTree", args);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(codeProjectTreeSchema.parse(response.body.result)).toEqual({
            projects: projectsBefore,
            tasks: [],
          });
          expect(await taskScope(host, host.sessionId)).toEqual(scopeBefore);
          expect(model.requests).toHaveLength(requestsBefore);
        }
        for (const args of [
          [{ hostId: "remote-host" }],
          [{ includeDeleted: "true" }],
          [{ unknown: true }],
          [{}, {}],
        ]) {
          const response = await projectRpc(host, "readTree", args);
          expect(response.status, JSON.stringify(response.body)).toBe(400);
          expect(await taskScope(host, host.sessionId)).toEqual(scopeBefore);
          expect(model.requests).toHaveLength(requestsBefore);
        }
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
        throw new AggregateError(failures, "原项目树参数验证或清理失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占真实HTTP、PG及已创建Task的只读参数验证期限。

    it("归档管理读取保留已归档项目及其归档Task，普通项目树排除二者且不恢复执行", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        const listed = await projectRpc(host, "readProjects", [
          { hostId: "local" },
        ]);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const original = codeProjectEditorProjectSchema
          .array()
          .parse(listed.body.result)
          .find((project) => project.id === host?.projectId);
        if (!original) throw new Error("公开项目列表缺少待归档的真实项目。");
        await archiveStoppedRootWithBody(host, model);
        expect((await localProjectTree(host)).tasks).toContainEqual(
          expect.objectContaining({
            taskId: host.sessionId,
            projectId: original.id,
            archived: true,
          }),
        );
        const archived = await host.client.request(
          `/api/projects/${original.id}`,
          undefined,
          "DELETE",
        );
        expect(archived.status, JSON.stringify(archived.body)).toBe(204);
        const requestsBefore = model.requests.length;
        const included = await projectRpc(host, "readTree", [
          { hostId: "local", includeDeleted: true, includeDeletedTasks: true },
        ]);
        expect(included.status, JSON.stringify(included.body)).toBe(200);
        const archiveTree = codeProjectTreeSchema.parse(included.body.result);
        expect(archiveTree.projects).toContainEqual(
          expect.objectContaining({
            id: original.id,
            hostId: "local",
            name: original.name,
            roots: original.roots,
            deleted: true,
          }),
        );
        expect(archiveTree.tasks).toContainEqual(
          expect.objectContaining({
            taskId: host.sessionId,
            projectId: original.id,
            hostId: "local",
            workspacePath: host.workspacePath,
            workspaceIdentity: JSON.stringify([
              original.id,
              host.workspacePath,
            ]),
            archived: true,
          }),
        );
        const activeTree = await localProjectTree(host);
        expect(activeTree.projects).not.toContainEqual(
          expect.objectContaining({ id: original.id }),
        );
        expect(activeTree.tasks).not.toContainEqual(
          expect.objectContaining({ taskId: host.sessionId }),
        );
        const unavailable = await host.client.request(
          `/api/code-ui/tasks/${host.sessionId}/scope`,
        );
        expect(
          unavailable.status,
          JSON.stringify(unavailable.body),
        ).toBeGreaterThanOrEqual(400);
        expect(unavailable.status).toBeLessThan(500);
        expect(
          codeTaskScopeResponseSchema.safeParse(unavailable.body).success,
        ).toBe(false);
        expect(model.requests).toHaveLength(requestsBefore);
        expect(model.requests).toHaveLength(1);
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
        throw new AggregateError(failures, "归档项目树读取验证或清理失败", {
          cause: failures[0],
        });
    }, 90_000);
  },
);
