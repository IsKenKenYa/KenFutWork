import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeUiEvent,
  type CodeUiWorkspace,
  zcodeUiProtocol as protocol,
  workspaceSettingsSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { CodeUiConnections } from "./connections.js";
import { createCodeUiWindowController } from "./controller-host.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiRepository } from "./repository.js";

function finishedConversation(sessionId: string, root: string, text: string) {
  const conversation = createCodeUiConversation({
    sessionId,
    workspacePath: root,
    config: {
      provider: "zcode",
      model: "fixture-model",
      thought: "",
      followupMode: "queue",
    },
  });
  const runId = randomUUID();
  conversation.startTurn({ runId, commandId: randomUUID(), text });
  conversation.recordEvent({
    type: "run.completed",
    runId,
    timestamp: "2026-10-04T00:00:00.000Z",
  });
  return conversation.exportState();
}

/** 使用一次性本机集群；不读取 .env 或现有 DATABASE_URL。 */
describe.skipIf(process.env.KENFUTWORK_CONTROLLER_HOST_TEST_PG !== "1")(
  "Controller 私有Postgres生产consumer integration",
  () => {
    it("Project 默认A改B后真实Task固定A和新TaskB保留身份，删除A释放来源与成员", async () => {
      const database = await createTaskWorkDatabase();
      const connections = new CodeUiConnections();
      let host: ReturnType<typeof createCodeUiWindowController> | undefined;
      let human: ReturnType<CodeUiConnections["open"]> | undefined;
      try {
        expect(database.replayed).toHaveLength(database.expectedMigrations);
        expect(database.secondReplay).toHaveLength(0);
        const scope = database.context.scope;
        const repository = createCodeUiRepository(database.persistence);
        const owner = await database.persistence.queryOne<{
          owner_user_id: string;
        }>("select owner_user_id from public.workspaces where id=$1", [
          scope.workspaceId,
        ]);
        if (!owner) throw new Error("隔离工作区不存在");
        const actor = {
          id: owner.owner_user_id,
          email: "controller@integration.test",
          accessToken: "private-test",
          userMetadata: {},
        };
        const initial = await repository.find(scope.workspaceId, scope.taskId);
        if (!initial) throw new Error("隔离Task不存在");
        await repository.save(
          scope.workspaceId,
          scope.taskId,
          Number(initial.revision),
          finishedConversation(scope.taskId, scope.rootDirectory, "原目录Task"),
          null,
        );
        const newRoot = join(database.directory, "new-root");
        await mkdir(newRoot);
        await database.persistence
          .forWorkspace(scope.workspaceId)
          .execute(
            "update public.projects set work_dir=$2 where workspace_id=:workspace and id=$1",
            [scope.projectId, newRoot],
          );
        const newTaskId = randomUUID();
        await repository.createRoot(scope.workspaceId, {
          sessionId: newTaskId,
          projectId: scope.projectId,
          scope: { ...scope, taskId: newTaskId, rootDirectory: newRoot },
          userId: actor.id,
          threadId: randomUUID(),
          state: finishedConversation(newTaskId, newRoot, "新默认目录Task"),
          command: {
            clientId: "controller-integration",
            commandId: randomUUID(),
            fingerprint: "controlled-create-task",
          },
        });
        const sent: CodeUiEvent[] = [];
        human = connections.open(
          scope.workspaceId,
          actor.id,
          async (event) => {
            sent.push(event);
          },
          () => {},
        );
        connections.initialize(scope.workspaceId, human.hello.connectionId, {
          kind: "clientHello",
          protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
          clientId: "human-controller-integration",
          clientKind: "web",
          appVersion: "test",
        });
        host = createCodeUiWindowController({
          actor,
          workspaceId: scope.workspaceId,
          connectionId: human.hello.connectionId,
          connections,
          repository,
          settings: {
            onUpdated: () => () => {},
            getWorkspaceSettings: async () => workspaceSettingsSchema.parse({ defaultModel: "fixture" }),
            updateWorkspaceSettings: async () => {
              throw new Error("Controller 只读来源不得写工作区设置");
            },
          },
          listWorkspaces: async () => {
            const projects = await database.persistence
              .forWorkspace(scope.workspaceId)
              .query<{ id: string; name: string; work_dir: string }>(
                "select id,name,work_dir from public.projects where workspace_id=:workspace and kind='code' and archived_at is null",
              );
            return projects.map(
              (project): CodeUiWorkspace => ({
                projectId: project.id,
                name: project.name,
                path: project.work_dir,
                additionalDirectories: [],
              }),
            );
          },
        });
        const oldIdentity = JSON.stringify([
          scope.projectId,
          scope.rootDirectory,
        ]);
        const newIdentity = JSON.stringify([scope.projectId, newRoot]);
        const both = {
          kind: "active",
          workspaceScopes: [
            {
              workspacePath: scope.rootDirectory,
              workspaceIdentity: oldIdentity,
            },
            { workspacePath: newRoot, workspaceIdentity: newIdentity },
          ],
          sortBy: "updated",
        };
        expect((await host.call("listTaskList", both))?.result).toMatchObject({
          total: 2,
          items: expect.arrayContaining([
            expect.objectContaining({
              taskId: scope.taskId,
              projectId: scope.projectId,
              workspacePath: scope.rootDirectory,
              workspaceIdentity: oldIdentity,
            }),
            expect.objectContaining({
              taskId: newTaskId,
              projectId: scope.projectId,
              workspacePath: newRoot,
              workspaceIdentity: newIdentity,
            }),
          ]),
        });
        await host.call("subscribeControllerV4", {
          topic: protocol.CONTROLLER_TASKS_INDEX_TOPIC,
        });
        await host.refresh();
        const snapshots = sent.flatMap((event) => {
          if (
            event.event !== "service" ||
            event.service !== "window-controller" ||
            event.name !== "onDynamicControllerFrame"
          )
            return [];
          const frame = protocol.windowHostControllerTaskFrameSchema.parse(
            event.data,
          );
          return frame.payload.kind === "snapshot"
            ? [frame.payload.snapshot]
            : [];
        });
        expect(snapshots.at(-1)?.tasks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              meta: expect.objectContaining({
                taskId: scope.taskId,
                projectId: scope.projectId,
                workspaceIdentity: oldIdentity,
              }),
            }),
            expect.objectContaining({
              meta: expect.objectContaining({
                taskId: newTaskId,
                projectId: scope.projectId,
                workspaceIdentity: newIdentity,
              }),
            }),
          ]),
        );
        await repository.delete(scope.workspaceId, scope.taskId);
        await host.refresh();
        await expect(
          host.call("listTaskList", {
            ...both,
            workspaceScopes: [
              {
                workspacePath: scope.rootDirectory,
                workspaceIdentity: oldIdentity,
              },
            ],
          }),
        ).rejects.toMatchObject({ code: "not_found" });
        expect(
          (
            await host.call("listTaskList", {
              ...both,
              workspaceScopes: [
                { workspacePath: newRoot, workspaceIdentity: newIdentity },
              ],
            })
          )?.result,
        ).toMatchObject({
          total: 1,
          items: [{ taskId: newTaskId, projectId: scope.projectId }],
        });
      } finally {
        await host?.dispose();
        human?.dispose();
        connections.closeAll();
        await database.close();
      }
    });
  },
);
