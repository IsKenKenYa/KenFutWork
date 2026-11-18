import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  backgroundJobSchema,
  instanceSettingsSchema,
  zcodeUiProtocol as protocol,
  providerInstanceResponseSchema,
  type StreamEvent,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { INTERRUPTED_RUN_MESSAGE } from "../agent-runs/reconcile.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import { createCodeUiRepository } from "./repository.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

/** Disposable localhost cluster only; no running database credentials are read. */
describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "Code输入跨宿主重启 integration",
  () => {
    const windows = [
      "preempt",
      "stop",
      "plain",
      "preempt-completed",
      "queue-preempt-completed",
      "plain-completed",
    ] as const;
    it.each(windows)("%s后冷恢复遵从原控制意图，输入不重放", async (window) => {
      const database = await createTaskWorkDatabase();
      const services: CodeUiService[] = [];
      const stopRequests: string[] = [];
      let stopGate: Promise<void> | undefined;
      let releaseStop = () => {};
      let pendingStop: Promise<unknown> | undefined;
      let stopSettled = false;
      const preempt = window.includes("preempt");
      const queuePreempt = window.startsWith("queue-");
      const completed = window.endsWith("-completed");
      try {
        const scope = database.context.scope;
        const actor = { instanceId: scope.instanceId, accessClientId: null };
        const repository = createCodeUiRepository(database.persistence);
        const provider = providerInstanceResponseSchema.parse({
          id: randomUUID(),
          scope: "local",
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
          scope.instanceId,
          scope.taskId,
          0,
          createCodeUiConversation({
            sessionId: scope.taskId,
            workspacePath: scope.rootDirectory,
            config,
          }).exportState(),
          null,
        );
        await database.persistence.forInstance(scope.instanceId).execute(
          `with chat as (
             insert into public.chat_sessions (id, instance_id, project_id, mode, thread_id)
             values ($1, :instance, $2, 'code', $3) returning id
           ) update public.code_ui_sessions root set chat_session_id=chat.id
             from chat where root.instance_id=:instance and root.id=chat.id`,
          [scope.taskId, scope.projectId, `thread:${scope.taskId}`],
        );
        const generationTargets = createGenerationTargets({
          persistence: database.persistence,
          executionScopes: createExecutionScopes({
            repository: createScopeRepository(database.persistence),
            localInstance: database.localInstance,
          }),
        });
        const runs: string[] = [];
        const eventSinks = new Map<
          string,
          (event: StreamEvent) => Promise<void>
        >();
        function host(name: string) {
          const service = new CodeUiService({
            repository,
            localInstance: createCodeUiTestInstance(
              scope.instanceId,
              null,
              database.directory,
            ).localInstance,
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
              getInstanceSettings: async () =>
                instanceSettingsSchema.parse({ defaultModel: "test" }),
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
                const task = await repository.find(scope.instanceId, taskId);
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
              createRun: (
                _input: unknown,
                options: {
                  runId: string;
                  eventSink: (event: StreamEvent) => Promise<void>;
                },
              ) => {
                runs.push(options.runId);
                eventSinks.set(options.runId, options.eventSink);
                return { runId: options.runId };
              },
              async *streamRun() {},
              cancelRun() {},
              async cancelRunAndWait(runId: string) {
                stopRequests.push(runId);
                await stopGate;
              },
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
        const originalRunId = runs[0];
        if (!originalRunId) throw new Error("持久接纳未生成原Run身份。");
        const origin = {
          actor,
          projectId: scope.projectId,
          sessionId: scope.taskId,
          runId: originalRunId,
          expectedScopeGeneration: scope.generation,
          expectedBranchGeneration: database.context.branchGeneration,
        };
        const acceptedMedia = backgroundJobSchema.parse({
          id: randomUUID(),
          instance_id: scope.instanceId,
          project_id: scope.projectId,
          session_id: scope.taskId,
          canvas_id: null,
          thread_id: `thread:${scope.taskId}`,
          file_target: await generationTargets.prepareOrigin(origin),
          queue_name: "image_generation_jobs",
          job_type: "image_generation",
          status: "running",
          payload: {},
          provider_job_id: "accepted-before-host-loss",
          result: null,
          error_code: null,
          error_message: null,
          attempt_count: 1,
          max_attempts: 3,
          created_by_client_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          failed_at: null,
          canceled_at: null,
        });
        expect(await generationTargets.resolve(acceptedMedia)).toEqual({
          kind: "task",
          taskId: scope.taskId,
        });
        if (queuePreempt) {
          const snapshot = await old.getSnapshot(actor, scope.taskId);
          const queued = snapshot.queue.items[0];
          if (!queued) throw new Error("公开快照缺少待立即发送的原排队输入。");
          const reserved = await rpc("sendConversationCommandV4", {
            workspacePath: scope.rootDirectory,
            envelope: {
              clientId,
              commandId: randomUUID(),
              sessionId: scope.taskId,
              type: "sendQueuedNow",
              payload: { queueItemId: queued.queueItemId },
              baseRevision: snapshot.revision,
              baseLogEpoch: snapshot.logEpoch,
              issuedAt: Date.now(),
            },
          });
          expect(reserved?.result).toMatchObject({ status: "accepted" });
          expect(
            (await old.getSnapshot(actor, scope.taskId)).pendingCommands,
          ).toHaveLength(1);
        } else if (preempt) {
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
          // 已accepted但未publish；旧Run尚未收到取消，恢复仍须保留抢占意图。
          expect(
            (await old.getSnapshot(actor, scope.taskId)).pendingCommands,
          ).toHaveLength(1);
        } else if (window === "stop") {
          stopGate = new Promise<void>((resolve) => {
            releaseStop = resolve;
          });
          pendingStop = rpc("sendConversationCommandV4", {
            workspacePath: scope.rootDirectory,
            envelope: {
              clientId,
              commandId: randomUUID(),
              sessionId: scope.taskId,
              type: "stop",
              payload: { expectedForegroundExecutionId: originalRunId },
              issuedAt: Date.now(),
            },
          }).then((reply) => {
            stopSettled = true;
            return reply;
          });
          // 取消能力只会在input.stop独立事务提交后被调用；ACK仍等待终态屏障。
          await vi.waitFor(() => expect(stopRequests).toEqual([originalRunId]));
          expect(stopSettled).toBe(false);
          expect(
            (await old.getSnapshot(actor, scope.taskId)).control.phase,
          ).toBe("running");
        }
        if (completed) {
          const sink = eventSinks.get(originalRunId);
          if (!sink) throw new Error("真实接纳未绑定运行终态事件入口。");
          await sink({
            type: "run.completed",
            runId: originalRunId,
            timestamp: new Date().toISOString(),
          });
          expect(
            (await old.getSnapshot(actor, scope.taskId)).control.phase,
          ).toBe("completedSuccess");
        }
        if (preempt || window === "stop")
          await expect(
            generationTargets.resolve(acceptedMedia),
          ).rejects.toMatchObject({ code: "invalid_input" });
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
        if (completed) {
          expect(snapshot.control.phase).toBe("completedSuccess");
          expect(snapshot.control.lastError).toBeNull();
        } else {
          expect(snapshot.control.phase).toBe("error");
          expect(snapshot.control.lastError).toMatchObject({
            code: "run_failed",
            message: INTERRUPTED_RUN_MESSAGE,
            recoverable: true,
            source: "runtime",
          });
        }
        expect(snapshot.pendingCommands).toEqual([]);
        // 普通冷恢复只续接旧句柄；已持久Stop或抢占意图绝不能变成恢复授权。
        if (!preempt && window !== "stop")
          expect(await generationTargets.resolve(acceptedMedia)).toEqual({
            kind: "task",
            taskId: scope.taskId,
          });
        else
          await expect(
            generationTargets.resolve(acceptedMedia),
          ).rejects.toMatchObject({ code: "invalid_input" });
        if (window === "stop") expect(stopSettled).toBe(false);
        if (!completed || preempt)
          await expect(
            generationTargets.resolve({
              ...acceptedMedia,
              provider_job_id: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_input" });
        else
          expect(
            await generationTargets.resolve({
              ...acceptedMedia,
              provider_job_id: null,
            }),
          ).toEqual({ kind: "task", taskId: scope.taskId });
        await expect(
          generationTargets.prepareOrigin(origin),
        ).rejects.toMatchObject({
          code: "invalid_input",
        });
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
            completed
              ? {
                  result: {
                    status: "accepted",
                    result: { type: "inputAccepted", delivery: "startNow" },
                  },
                }
              : {
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
            ...(preempt && !queuePreempt
              ? [
                  {
                    result: {
                      status: "failed",
                      reasonCode: "fault.command.inputDiscardedOnRestart",
                      result: {
                        type: "inputDisposition",
                        delivery: "startNow",
                      },
                    },
                  },
                ]
              : []),
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
        // 历史版本已把丢失的Run投影为取消；后到的持久失败不能再丢掉原因。
        const stored = await repository.find(scope.instanceId, scope.taskId);
        const historical = structuredClone(stored!.state!);
        const interrupted = historical.snapshots.find(
          (entry) => entry.sessionId === scope.taskId,
        )!;
        interrupted.control.phase = "completedInterrupted";
        interrupted.control.lastError = null;
        await repository.save(
          scope.instanceId,
          scope.taskId,
          Number(stored!.revision),
          historical,
          null,
        );
        await database.persistence.forInstance(scope.instanceId).execute(
          `insert into public.chat_sessions (id, instance_id, project_id, mode, thread_id)
           values ($1, :instance, $2, 'code', $3) on conflict (id) do nothing`,
          [scope.taskId, scope.projectId, `thread:${scope.taskId}`],
        );
        await database.persistence.execute(
          `insert into public.agent_runs (id, session_id, thread_id, status, error_code, error_message, completed_at)
           values ($1, $2, $3, 'failed', 'run_failed', $4, now())`,
          [
            historical.runId,
            scope.taskId,
            `thread:${scope.taskId}`,
            INTERRUPTED_RUN_MESSAGE,
          ],
        );
        const restored = await restarted.getSnapshot(actor, scope.taskId);
        expect(restored.control).toMatchObject({
          phase: "error",
          canStop: false,
          lastError: { code: "run_failed", message: INTERRUPTED_RUN_MESSAGE },
        });
        expect(await restarted.getSnapshot(actor, scope.taskId)).toEqual(
          restored,
        );
        expect(runs).toHaveLength(2);
        await database.persistence.execute(
          "update public.agent_runs set status = 'canceled', error_code = null, error_message = null where id = $1",
          [historical.runId],
        );
        await database.persistence.execute(
          `insert into public.agent_runs (id, session_id, thread_id, status, error_code, error_message)
           values ($1, $2, $3, 'failed', 'run_failed', '另一轮失败')`,
          [randomUUID(), scope.taskId, `thread:${scope.taskId}`],
        );
        const canceled = await restarted.getSnapshot(actor, scope.taskId);
        expect(canceled.control.phase).toBe("completedInterrupted");
        expect(canceled.control.lastError).toBeNull();
        expect(runs).toHaveLength(2);
      } finally {
        releaseStop();
        await pendingStop;
        for (const service of services.reverse())
          await service.closeConnections();
        await database.close();
      }
    });
  },
);
