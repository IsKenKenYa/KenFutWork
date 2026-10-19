import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type CodeGoalControl,
  codeGoalControlStateSchema,
  instanceSettingsSchema,
  zcodeUiProtocol as protocol,
  providerInstanceResponseSchema,
  type StreamEvent,
} from "@kenfutwork/shared";
import type { ToolContributionSnapshot } from "../../kernel/types.js";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import { createGoalService } from "../goals/service.js";
import type { CodeApprovalMode } from "../permissions/approval-types.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import { createCodeUiRepository } from "./repository.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export interface ControlledGoalRun {
  approvalCeiling?: CodeApprovalMode;
  runId: string;
  prompt: string;
  modelInvocation?: ModelInvocationSnapshot;
  frozenContributions?: ToolContributionSnapshot;
  sink(event: StreamEvent): Promise<void>;
  release: ReturnType<typeof deferred>;
  ended: ReturnType<typeof deferred>;
  canceled: boolean;
}
async function prepareGoalDatabase() {
  const database = await createTaskWorkDatabase();
  const scope = database.context.scope;
  const actor = { instanceId: scope.instanceId, accessClientId: null };
  const goals = createGoalService();
  const repository = createCodeUiRepository(database.persistence, goals);
  const provider = providerInstanceResponseSchema.parse({
    id: randomUUID(),
    scope: "local",
    name: "Goal fixture",
    protocol: "openai-compatible",
    configRevision: 1,
    hasCredential: true,
    enabled: true,
    headerKeys: [],
    models: [
      {
        id: "test",
        name: "test",
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
    thought: "low",
    followupMode: "queue" as const,
    modelSelection: selection,
  };
  await database.persistence
    .forInstance(scope.instanceId)
    .execute(
      "insert into public.chat_sessions(id,instance_id,project_id,mode,created_by_client_id,thread_id) values($1,:instance,$2,'code',null,$3)",
      [scope.taskId, scope.projectId, `thread:${scope.taskId}`],
    );
  await database.persistence
    .forInstance(scope.instanceId)
    .execute(
      "update public.code_ui_sessions set chat_session_id=$1 where instance_id=:instance and id=$1",
      [scope.taskId],
    );
  await repository.save(
    scope.instanceId,
    scope.taskId,
    0,
    createCodeUiConversation({
      sessionId: scope.taskId,
      workspacePath: scope.rootDirectory,
      config,
      goals,
    }).exportState(),
    null,
  );
  return { database, scope, actor, goals, repository, provider };
}
function createControlledRuntime() {
  const runs: ControlledGoalRun[] = [];
  const starters: Array<{
    count: number;
    deferred: ReturnType<typeof deferred>;
  }> = [];
  const runtime = {
    createRun(
      input: { prompt: string },
      options: {
        approvalCeiling?: CodeApprovalMode;
        runId: string;
        modelInvocation?: ModelInvocationSnapshot;
        frozenContributions?: ToolContributionSnapshot;
        eventSink(event: StreamEvent): Promise<void>;
      },
    ) {
      const run = {
        ...(options.approvalCeiling
          ? { approvalCeiling: options.approvalCeiling }
          : {}),
        runId: options.runId,
        prompt: input.prompt,
        ...(options.modelInvocation
          ? { modelInvocation: structuredClone(options.modelInvocation) }
          : {}),
        ...(options.frozenContributions
          ? {
              frozenContributions: structuredClone(options.frozenContributions),
            }
          : {}),
        sink: options.eventSink,
        release: deferred(),
        ended: deferred(),
        canceled: false,
      };
      runs.push(run);
      for (const item of starters)
        if (runs.length >= item.count) item.deferred.resolve();
      return { runId: run.runId };
    },
    async *streamRun(runId: string) {
      const run = runs.find((item) => item.runId === runId)!;
      try {
        await run.release.promise;
        await run.sink({
          type: run.canceled ? "run.canceled" : "run.completed",
          runId,
          timestamp: new Date().toISOString(),
        });
      } finally {
        run.ended.resolve();
      }
    },
    cancelRun(runId: string) {
      const run = runs.find((item) => item.runId === runId);
      if (run) {
        run.canceled = true;
        run.release.resolve();
      }
    },
    async cancelRunAndWait(runId: string) {
      runtime.cancelRun(runId);
      await runs.find((item) => item.runId === runId)?.ended.promise;
    },
  };
  return {
    runtime,
    runs,
    async waitRuns(count: number) {
      if (runs.length >= count) return;
      const item = { count, deferred: deferred() };
      starters.push(item);
      await item.deferred.promise;
    },
  };
}
function makeGoalHost(
  base: Awaited<ReturnType<typeof prepareGoalDatabase>>,
  runtime: ReturnType<typeof createControlledRuntime>["runtime"],
  name: string,
  captureContributions?: CodeUiServiceDeps["captureContributions"],
  workContextProvider?: CodeUiServiceDeps["workContextProvider"],
  taskWork?: CodeUiServiceDeps["taskWork"],
) {
  const { database, scope, goals, repository, provider } = base;
  const service = new CodeUiService({
    goals,
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
          name: "Goal fixture",
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
      resolveCredentials: async () => ({
        instanceId: provider.id,
        configRevision: provider.configRevision,
        apiKey: "credential-only-at-access-boundary",
        headers: { authorization: "credential-header" },
      }),
      listProviderPresets: () => [],
    },
    modelCatalog: {
      listCatalog: async () => [],
      validateSpecifier: async (_actor: unknown, specifier: string) =>
        provider.enabled &&
        provider.models.some(
          (model) =>
            model.enabled !== false &&
            `${provider.id}:${model.id}` === specifier,
        )
          ? { ok: true }
          : { ok: false, message: "所选模型已停用" },
    },
    settings: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({ defaultModel: "test" }),
    },
    threads: {
      resolveOwnedSessionThread: async (_actor: unknown, taskId: string) => ({
        threadId: `thread:${taskId}`,
      }),
      createThreadId: randomUUID,
    },
    executionScopes: {
      openTask: async (_actor: unknown, taskId: string) => {
        const task = await repository.find(scope.instanceId, taskId);
        return {
          describe: () => ({
            ...scope,
            taskId,
            generation: Number(task!.scope_generation),
            rootDirectory: task!.root_directory!,
            sandboxMode: task!.sandbox_mode,
            additionalDirectories: task!.additional_directories,
          }),
        };
      },
    },
    agentRunMetadata: {
      createAcceptedRun: async () => {},
      updateRun: async () => {},
    },
    agentRuns: runtime,
    taskWork: {
      initialize: async () => [],
      notifyReady: async () => {},
      list: async () => [],
    },
    ...(taskWork ? { taskWork } : {}),
    env: { checkpointRoot: join(database.directory, name) },
    ...(captureContributions ? { captureContributions } : {}),
    ...(workContextProvider ? { workContextProvider } : {}),
  } as unknown as CodeUiServiceDeps);
  return service;
}
async function connectGoalHost(
  base: Awaited<ReturnType<typeof prepareGoalDatabase>>,
  service: CodeUiService,
  publications: Promise<void>[],
) {
  const { actor, scope } = base;
  const clientId = randomUUID();
  let observed: CodeGoalControl | undefined;
  const connection = await service.openConnection(
    actor,
    async (event) => {
      if (event.event === "service" && event.name === "onGoalControlState") {
        const state = codeGoalControlStateSchema.parse(event.data);
        if (state.taskId === scope.taskId)
          observed = { expectedGoal: state.goal };
      }
    },
    () => {},
  );
  const rpc = (method: string, value: unknown) =>
    service.transportRpc(actor, connection.hello.connectionId, method, [value]);
  await rpc("initializeConversationV4", {
    kind: "clientHello",
    clientId,
    protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
    clientKind: "web",
    appVersion: "integration",
  });
  await rpc("subscribeConversationV4", {
    workspacePath: scope.rootDirectory,
    sessionId: scope.taskId,
  });
  return Object.assign(
    async (
      type: protocol.CommandType,
      payload: unknown,
      commandId = randomUUID(),
      control?: CodeGoalControl | null,
    ) => {
      const root = await base.repository.find(scope.instanceId, scope.taskId);
      const snapshot = root?.state?.snapshots.find(
        (item) => item.sessionId === scope.taskId,
      );
      if (!snapshot) throw new Error("Goal测试没有可用Task快照");
      const response = await rpc("sendConversationCommandV4", {
        workspacePath: scope.rootDirectory,
        ...(["sendGoalCommand", "pauseGoal", "resumeGoal"].includes(type) &&
        control !== null
          ? { goalControl: structuredClone(control ?? observed) }
          : {}),
        envelope: {
          clientId,
          commandId,
          sessionId: scope.taskId,
          type,
          payload,
          baseRevision: snapshot.revision,
          baseLogEpoch: snapshot.logEpoch,
          issuedAt: Date.now(),
        },
      });
      const settled = response?.publish?.() ?? Promise.resolve();
      void settled.catch(() => {});
      publications.push(settled);
      return { result: response?.result, settled };
    },
    { connectionId: connection.hello.connectionId, clientId },
  );
}
export async function createGoalServiceFixture() {
  const base = await prepareGoalDatabase();
  const controlled = createControlledRuntime();
  const services: CodeUiService[] = [];
  const publications: Promise<void>[] = [];
  return {
    ...base,
    runs: controlled.runs,
    waitRuns: controlled.waitRuns,
    host(
      name: string,
      captureContributions?: CodeUiServiceDeps["captureContributions"],
      workContextProvider?: CodeUiServiceDeps["workContextProvider"],
      taskWork?: CodeUiServiceDeps["taskWork"],
    ) {
      const service = makeGoalHost(
        base,
        controlled.runtime,
        name,
        captureContributions,
        workContextProvider,
        taskWork,
      );
      services.push(service);
      return service;
    },
    connect(service: CodeUiService) {
      return connectGoalHost(base, service, publications);
    },
    async finish(index: number) {
      const run = controlled.runs[index]!;
      run.release.resolve();
      await run.ended.promise;
    },
    async close() {
      for (const run of controlled.runs)
        controlled.runtime.cancelRun(run.runId);
      for (const service of services.reverse())
        await service.closeConnections();
      await Promise.allSettled(controlled.runs.map((run) => run.ended.promise));
      await Promise.allSettled(publications);
      await base.database.close();
    },
  };
}
