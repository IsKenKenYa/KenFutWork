import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeTaskOrganizationTarget,
  codeProjectEditorProjectSchema,
  codeTaskGroupStructureSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type HttpFixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type TaskReadRef = {
  taskId: string;
  projectId: string;
  workspacePath: string;
  client: Pick<Host["client"], "request">;
};

function readGroups(
  client: TaskReadRef["client"],
  args: unknown = [],
  connectionId?: string,
) {
  return client.request("/api/code-ui/rpc", {
    service: "task-groups",
    method: "read",
    args,
    connectionId,
  });
}

function taskReadRef(host: Host): TaskReadRef {
  return {
    taskId: host.sessionId,
    projectId: host.projectId,
    workspacePath: host.workspacePath,
    client: host.client,
  };
}

async function hostState(task: TaskReadRef) {
  const scope = await task.client.request(
    `/api/code-ui/tasks/${task.taskId}/scope`,
  );
  expect(scope.status, JSON.stringify(scope.body)).toBe(200);
  const session = await task.client.request(
    `/api/code-ui/sessions/${task.taskId}`,
  );
  expect(session.status, JSON.stringify(session.body)).toBe(200);
  return {
    scope,
    snapshot: protocol.conversationSnapshotSchema.parse(session.body.snapshot),
  };
}

async function closeReadResources(
  failures: unknown[],
  resources: Array<() => unknown | Promise<unknown>>,
) {
  for (const close of resources) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "原分组读取验证或清理失败", {
      cause: failures[0],
    });
}

async function seedReadMaterial(
  fixture: HttpFixture,
  member: TaskReadRef,
  root: TaskReadRef,
) {
  const { instanceId } = await fixture.app.kernel
    .get("localInstance")
    .getContext();
  const firstGroupId = randomUUID();
  const secondGroupId = randomUUID();
  const currentProjectDirectory = join(member.workspacePath, "项目当前主目录");
  await mkdir(currentProjectDirectory);
  // 仅预置读取测试材料；创建分组与整理顺序的界面写入不由本例验证。
  await fixture.database.persistence.transaction(async (tx) => {
    const sql = tx.forInstance(instanceId);
    // 读取材料包含项目当前目录与已有 Task 固定目录不同的历史状态。
    await sql.execute(
      "update public.projects set work_dir=$1 where instance_id=:instance and id=$2",
      [currentProjectDirectory, member.projectId],
    );
    await sql.execute(
      `insert into public.code_task_groups
        (instance_id,id,title,color,sort_order,created_at,updated_at)
        values (:instance,$1,'研发资料','blue',30,'2026-10-24T00:00:00.000Z','2026-10-24T00:01:00.000Z'),
               (:instance,$2,'待整理','orange',10,'2026-10-24T01:00:00.000Z','2026-10-24T01:01:00.000Z')`,
      [firstGroupId, secondGroupId],
    );
    await sql.execute(
      `insert into public.code_task_group_members
        (instance_id,task_id,task_kind,group_id,sort_order,user_organized)
        values (:instance,$1,'code',$2,7,true),
               (:instance,$3,'code',null,20,true)`,
      [member.taskId, firstGroupId, root.taskId],
    );
    await sql.execute(
      "update public.code_task_group_state set revision=17 where instance_id=:instance",
    );
  });
  return {
    revision: 17,
    groups: [
      {
        id: firstGroupId,
        title: "研发资料",
        color: "blue",
        createdAt: Date.parse("2026-10-24T00:00:00.000Z"),
        updatedAt: Date.parse("2026-10-24T00:01:00.000Z"),
      },
      {
        id: secondGroupId,
        title: "待整理",
        color: "orange",
        createdAt: Date.parse("2026-10-24T01:00:00.000Z"),
        updatedAt: Date.parse("2026-10-24T01:01:00.000Z"),
      },
    ],
    members: [
      {
        groupId: firstGroupId,
        workspaceKey: JSON.stringify([member.projectId, member.workspacePath]),
        taskId: member.taskId,
        sortOrder: 7,
      },
    ],
    order: [
      { type: "group", key: secondGroupId, sortOrder: 10 },
      {
        type: "task",
        key: JSON.stringify([
          JSON.stringify([root.projectId, root.workspacePath]),
          root.taskId,
        ]),
        sortOrder: 20,
      },
      { type: "group", key: firstGroupId, sortOrder: 30 },
    ],
  };
}

async function createTaskProject(host: Host) {
  const directory = join(host.workspacePath, "根排序项目");
  await mkdir(directory);
  const saved = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "saveProject",
    args: [
      {
        hostId: "local",
        creationId: randomUUID(),
        kind: "code",
        name: "分组读取根排序项目",
        roots: [directory],
        primaryRoot: directory,
        rootPermissions: {},
      },
    ],
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const project = codeProjectEditorProjectSchema.parse(saved.body.result);
  expect(project.roots).toEqual([
    { rootPath: directory, position: 0, isPrimary: true },
  ]);
  return { projectId: project.id, workspacePath: directory };
}

async function createRootTask(
  host: Host,
  project: { projectId: string; workspacePath: string },
  modelSelection: protocol.SessionConfigState["modelSelection"],
): Promise<TaskReadRef> {
  const created = await host.stream.rpc("sendConversationCommandV4", [
    {
      ...project,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: project.projectId,
          config: { modelSelection },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(created.body.result);
  expect(ack.status).toBe("accepted");
  if (ack.result?.type !== "createSession")
    throw new Error("公开创建回执没有返回根 Task 身份。");
  return { ...project, taskId: ack.result.sessionId, client: host.client };
}

async function observedTaskTarget(
  host: Host,
): Promise<CodeTaskOrganizationTarget> {
  const response = await host.client.request(
    `/api/code-ui/sessions/${host.sessionId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const snapshot = protocol.conversationSnapshotSchema.parse(
    response.body.snapshot,
  );
  if (!snapshot.taskControl)
    throw new Error("分组归档验证缺少公开 Task 观察值。");
  return {
    taskId: host.sessionId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
    taskControl: snapshot.taskControl,
  };
}

function organizeTask(
  host: Host,
  method: string,
  target: CodeTaskOrganizationTarget,
) {
  return host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method,
    args: [target],
  });
}

async function prepareTaskForArchive(
  fixture: HttpFixture,
  host: Host,
  model: Awaited<ReturnType<typeof heldModel>>,
) {
  const accepted = await host.command("sendText", {
    text: "分组归档保留的原始输入",
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(accepted.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  });
  const stopped = await host.command("stop", {});
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(stopped.body.result).status).toBe(
    "accepted",
  );
  const snapshot = await waitPhase(
    fixture,
    host.sessionId,
    "completedInterrupted",
  );
  expect(JSON.stringify(snapshot.rows.window)).toContain(
    "分组归档保留的原始输入",
  );
  await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组服务的真实 HTTP 与 PostgreSQL integration",
  () => {
    it("新实例读取空分组结构且重复读取保持Task目录与运行不变", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const session = host;
        const before = await session.client.request(
          `/api/code-ui/tasks/${session.sessionId}/scope`,
        );
        expect(before.status, JSON.stringify(before.body)).toBe(200);
        for (const response of [
          await readGroups(session.client),
          await readGroups(session.client),
        ]) {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(response.body.result).toEqual({
            groups: [],
            members: [],
            order: [],
            revision: 0,
          });
        }
        expect(
          await session.client.request(
            `/api/code-ui/tasks/${session.sessionId}/scope`,
          ),
        ).toEqual(before);
        expect(model.requests).toHaveLength(0);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeReadResources(failures, [
          () => host?.dispose(),
          () => model.close(),
          () => fixture.close(),
        ]);
      }
    }, 90_000);

    it("读取真实分组成员和根排序，项目当前目录不同仍使用Task固定身份且不改变会话与Scope", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      let secondProject:
        | Awaited<ReturnType<typeof createTaskProject>>
        | undefined;
      let readConnection:
        | Awaited<ReturnType<HttpFixture["client"]["openCodeStream"]>>
        | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const member = taskReadRef(host);
        const beforeMember = await hostState(member);
        secondProject = await createTaskProject(host);
        const root = await createRootTask(
          host,
          secondProject,
          beforeMember.snapshot.config.modelSelection,
        );
        expect(root.taskId).not.toBe(member.taskId);
        const beforeRoot = await hostState(root);
        expect(beforeMember.scope.body.scope).toMatchObject({
          taskId: member.taskId,
          projectId: member.projectId,
          rootDirectory: member.workspacePath,
        });
        expect(beforeRoot.scope.body.scope).toMatchObject({
          taskId: root.taskId,
          projectId: root.projectId,
          rootDirectory: root.workspacePath,
        });
        const expected = await seedReadMaterial(fixture, member, root);
        readConnection = await fixture.client.openCodeStream();
        const initialized = await readConnection.rpc(
          "initializeConversationV4",
          [
            {
              kind: "clientHello",
              protocolVersion: 3,
              clientId: randomUUID(),
              appVersion: "task-group-read-integration",
              clientKind: "web",
            },
          ],
        );
        expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
        for (const reader of [
          { client: host.client, connectionId: undefined },
          {
            client: fixture.client,
            connectionId: readConnection.ready.hello.connectionId,
          },
          { client: host.client, connectionId: undefined },
        ]) {
          const response = await readGroups(
            reader.client,
            [],
            reader.connectionId,
          );
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(
            codeTaskGroupStructureSchema.parse(response.body.result),
          ).toEqual(expected);
          expect(await hostState(member)).toEqual(beforeMember);
          expect(await hostState(root)).toEqual(beforeRoot);
          expect(model.requests).toHaveLength(0);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        await closeReadResources(failures, [
          () => {
            readConnection?.controller.abort();
            return readConnection?.closed;
          },
          async () => {
            if (!secondProject) return;
            const deleted = await fixture.client.request(
              `/api/projects/${secondProject.projectId}`,
              undefined,
              "DELETE",
            );
            expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
          },
          () => host?.dispose(),
          () => model.close(),
          () => fixture.close(),
        ]);
      }
    }, 90_000); // 两个根 Task、两条连接与独占 HTTP、PostgreSQL 的读取和关闭期限。

    it("read只接收空参数元组，拒绝额外值与错误类型且重复读取保持结构与原会话", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const task = taskReadRef(host);
        const before = await hostState(task);
        for (const args of [
          [null],
          [{}],
          [false],
          ["unexpected"],
          [[]],
          [{}, {}],
          null,
          {},
          "[]",
        ]) {
          const rejected = await readGroups(host.client, args);
          expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
          expect(rejected.body.error.code).toBe("invalid_code_ui_request");
          const accepted = await readGroups(host.client);
          expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
          expect(accepted.body.result).toEqual({
            revision: 0,
            groups: [],
            members: [],
            order: [],
          });
          expect(await hostState(task)).toEqual(before);
          expect(model.requests).toHaveLength(0);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        await closeReadResources(failures, [
          () => host?.dispose(),
          () => model.close(),
          () => fixture.close(),
        ]);
      }
    }, 90_000);

    it("归档恢复往返保留分组，删除清除成员且迟到删除与重复读取不能恢复顺序", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      let secondProject:
        | Awaited<ReturnType<typeof createTaskProject>>
        | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await prepareTaskForArchive(fixture, host, model);
        secondProject = await createTaskProject(host);
        const member = taskReadRef(host);
        const initial = await hostState(member);
        const root = await createRootTask(
          host,
          secondProject,
          initial.snapshot.config.modelSelection,
        );
        const beforeRoot = await hostState(root);
        const expected = await seedReadMaterial(fixture, member, root);
        for (let round = 0; round < 2; round++) {
          const archived = await organizeTask(
            host,
            "archiveTask",
            await observedTaskTarget(host),
          );
          expect(archived.status, JSON.stringify(archived.body)).toBe(200);
          expect((await readGroups(host.client)).body.result).toEqual(expected);
          const restored = await organizeTask(
            host,
            "unarchiveTask",
            await observedTaskTarget(host),
          );
          expect(restored.status, JSON.stringify(restored.body)).toBe(200);
          expect((await readGroups(host.client)).body.result).toEqual(expected);
        }
        const archived = await organizeTask(
          host,
          "archiveTask",
          await observedTaskTarget(host),
        );
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        const deletedTarget = await observedTaskTarget(host);
        const deleted = await organizeTask(
          host,
          "deleteArchivedTask",
          deletedTarget,
        );
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        expect(deleted.body.result).toBe(true);
        const afterDelete = { ...expected, members: [], revision: 18 };
        for (let round = 0; round < 2; round++) {
          const read = await readGroups(host.client);
          expect(read.status, JSON.stringify(read.body)).toBe(200);
          expect(read.body.result).toEqual(afterDelete);
          const lateDelete = await organizeTask(
            host,
            "deleteArchivedTask",
            deletedTarget,
          );
          expect(lateDelete.status, JSON.stringify(lateDelete.body)).toBe(200);
          expect(lateDelete.body.result).toBe(false);
          expect(await hostState(root)).toEqual(beforeRoot);
        }
        expect(
          (await host.client.request(`/api/code-ui/sessions/${host.sessionId}`))
            .status,
        ).toBe(404);
        expect(model.requests).toHaveLength(1);
      } catch (error) {
        failures.push(error);
      } finally {
        await closeReadResources(failures, [
          async () => {
            if (!secondProject) return;
            const removed = await fixture.client.request(
              `/api/projects/${secondProject.projectId}`,
              undefined,
              "DELETE",
            );
            expect(removed.status, JSON.stringify(removed.body)).toBe(204);
          },
          () => host?.dispose(),
          () => model.close(),
          () => fixture.close(),
        ]);
      }
    }, 90_000); // 真实归档恢复、删除及原 Task 关闭的独占集成期限。
  },
);
