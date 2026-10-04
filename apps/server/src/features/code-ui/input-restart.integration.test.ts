import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  zcodeUiProtocol as protocol,
  providerInstanceResponseSchema,
  workspaceSettingsSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiRepository } from "./repository.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

/** Disposable localhost cluster only; no running database credentials are read. */
describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "Code输入跨宿主重启 integration",
  () => {
    it("真实持久队列在重启后终结并返回原输入disposition，不重放，也不触碰其它宿主Task", async () => {
      const database = await createTaskWorkDatabase();
      const services: CodeUiService[] = [];
      try {
        const scope = database.context.scope;
        const account = await database.persistence.queryOne<{
          owner_user_id: string;
        }>("select owner_user_id from public.workspaces where id=$1", [
          scope.workspaceId,
        ]);
        const actor = {
          id: account!.owner_user_id,
          accessToken: "private",
          email: "host@integration.test",
          userMetadata: {},
        };
        const repository = createCodeUiRepository(database.persistence);
        const provider = providerInstanceResponseSchema.parse({
          id: randomUUID(),
          scope: "workspace",
          name: "Private fixture",
          protocol: "openai-compatible",
          configRevision: 1,
          hasCredential: true,
          enabled: true,
          headerKeys: [],
          models: [
            {
              id: "test",
              name: "Test",
              capability: "chat",
              reasoningEfforts: ["low", "high"],
            },
          ],
        });
        const selection = {
          providerId: provider.id,
          modelId: "test",
          options: { reasoningLevel: "low" },
        };
        const config = {
          provider: "zcode",
          model: "test",
          thought: "",
          followupMode: "queue" as const,
          modelSelection: selection,
        };
        await repository.save(
          scope.workspaceId,
          scope.taskId,
          0,
          createCodeUiConversation({
            sessionId: scope.taskId,
            workspacePath: scope.rootDirectory,
            config,
          }).exportState(),
          null,
        );
        const runs: string[] = [];
        function host(name: string) {
          const service = new CodeUiService({
            repository,
            viewer: {
              resolveWorkspace: async () => ({ id: scope.workspaceId }),
            },
            projects: {
              listProjects: async () => [
                {
                  id: scope.projectId,
                  kind: "code",
                  name: "Private",
                  workDir: scope.rootDirectory,
                  additionalDirectories: [],
                },
              ],
              getProject: async () => ({
                work_dir: scope.rootDirectory,
                additional_directories: [],
              }),
            },
            modelProviders: {
              listInstances: async () => [provider],
              listProviderPresets: () => [],
            },
            modelCatalog: { listCatalog: async () => [] },
            settings: {
              getWorkspaceSettings: async () =>
                workspaceSettingsSchema.parse({ defaultModel: "test" }),
            },
            threads: {
              resolveOwnedSessionThread: async (
                _actor: unknown,
                taskId: string,
              ) => ({ threadId: `thread:${taskId}` }),
              createThreadId: randomUUID,
            },
            executionScopes: {
              openTask: async (_actor: unknown, taskId: string) => {
                const task = await repository.find(scope.workspaceId, taskId);
                if (!task?.root_directory)
                  throw new Error("真实Task作用域不存在");
                return {
                  describe: () => ({
                    ...scope,
                    taskId,
                    generation: Number(task.scope_generation),
                    rootDirectory: task.root_directory!,
                    sandboxMode: task.sandbox_mode,
                    additionalDirectories: task.additional_directories,
                  }),
                };
              },
            },
            agentRunMetadata: { createAcceptedRun: async () => {} },
            // A host lost after durable admission has no terminal sink receipt. No process is started by this adapter.
            agentRuns: {
              createRun: (_input: unknown, options: { runId: string }) => {
                runs.push(options.runId);
                return { runId: options.runId };
              },
              async *streamRun() {},
              cancelRun() {},
            },
            taskWork: {
              initialize: async () => [],
              notifyReady: async () => {},
            },
            env: { checkpointRoot: join(database.directory, name) },
          } as unknown as CodeUiServiceDeps);
          services.push(service);
          return service;
        }
        const clientId = randomUUID();
        async function connect(service: CodeUiService) {
          const connection = await service.openConnection(
            actor,
            async () => {},
            () => {},
          );
          const rpc = (method: string, value: unknown) =>
            service.transportRpc(actor, connection.hello.connectionId, method, [
              value,
            ]);
          await rpc("initializeConversationV4", {
            kind: "clientHello",
            clientId,
            protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
            clientKind: "web",
            appVersion: "integration",
          });
          return rpc;
        }
        const old = host("owned-host");
        const rpc = await connect(old);
        const commandIds = [randomUUID(), randomUUID()];
        for (const [index, commandId] of commandIds.entries()) {
          const admitted = await rpc("sendConversationCommandV4", {
            workspacePath: scope.rootDirectory,
            envelope: {
              clientId,
              commandId,
              sessionId: scope.taskId,
              type: "sendText",
              payload: {
                text: index ? "queued" : "active",
                modelSelection: selection,
              },
              issuedAt: Date.now(),
            },
          });
          await admitted!.publish?.();
        }
        expect(
          (await old.getSnapshot(actor, scope.taskId)).queue.items,
        ).toHaveLength(1);
        const reservedCommandId = randomUUID();
        commandIds.push(reservedCommandId);
        const reserved = await rpc("sendConversationCommandV4", {
          workspacePath: scope.rootDirectory,
          envelope: {
            clientId,
            commandId: reservedCommandId,
            sessionId: scope.taskId,
            type: "sendText",
            payload: {
              text: "reserved",
              requestedDelivery: "startNow",
              modelSelection: selection,
            },
            issuedAt: Date.now(),
          },
        });
        expect(reserved!.result).toMatchObject({
          status: "accepted",
          result: { delivery: "startNow" },
        });
        // 宿主在停止前台/发布新输入之前丢失；恢复不能执行这条已认领输入。
        expect(
          (await old.getSnapshot(actor, scope.taskId)).pendingCommands,
        ).toHaveLength(1);
        const foreign = host("foreign-host");
        const fork = await foreign.createSession(actor, {
          clientId,
          commandId: randomUUID(),
          sessionId: null,
          type: "createSession",
          payload: {
            workspaceId: scope.projectId,
            config: { modelSelection: selection },
          },
          issuedAt: Date.now(),
        });
        const foreignTaskId = (fork.result as { sessionId: string }).sessionId;
        const foreignRpc = await connect(foreign);
        const foreignInput = await foreignRpc("sendConversationCommandV4", {
          workspacePath: scope.rootDirectory,
          envelope: {
            clientId,
            commandId: randomUUID(),
            sessionId: foreignTaskId,
            type: "sendText",
            payload: { text: "other host", modelSelection: selection },
            issuedAt: Date.now(),
          },
        });
        await foreignInput!.publish?.();
        const restarted = host("owned-host");
        const restartedRpc = await connect(restarted);
        const snapshot = await restarted.getSnapshot(actor, scope.taskId);
        expect(snapshot.queue.items).toEqual([]);
        expect(snapshot.control.phase).toBe("completedInterrupted");
        expect(snapshot.pendingCommands).toEqual([]);
        expect(
          snapshot.rows.window.filter((row) => row.kind === "userInput"),
        ).toMatchObject([{ text: "active" }]);
        const receipts = await restartedRpc("queryConversationCommandsV4", {
          commands: commandIds.map((commandId) => ({
            sessionId: scope.taskId,
            commandId,
          })),
        });
        expect(receipts!.result).toMatchObject({
          results: [
            {
              result: {
                status: "failed",
                reasonCode: "fault.command.inputDiscardedOnRestart",
                result: { type: "inputDisposition", delivery: "startNow" },
              },
            },
            {
              result: {
                status: "failed",
                reasonCode: "fault.command.inputDiscardedOnRestart",
                result: { type: "inputDisposition", delivery: "queue" },
              },
            },
            {
              result: {
                status: "failed",
                reasonCode: "fault.command.inputDiscardedOnRestart",
                result: { type: "inputDisposition", delivery: "startNow" },
              },
            },
          ],
        });
        const foreignControl = (
          await restarted.getSnapshot(actor, foreignTaskId)
        ).control;
        expect(
          foreignControl.phase,
          JSON.stringify(foreignControl.lastError),
        ).toBe("running");
        expect(runs).toHaveLength(2);
        expect(await restarted.getSnapshot(actor, scope.taskId)).toEqual(
          snapshot,
        );
      } finally {
        for (const service of services.reverse())
          await service.closeConnections();
        await database.close();
      }
    });
  },
);
