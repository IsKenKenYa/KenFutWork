import { randomUUID } from "node:crypto";
import {
  zcodeUiProtocol as protocol,
  providerInstanceCreateRequestSchema,
} from "@kenfutwork/shared";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { createKenFutWorkDeepAgent } from "../../agent/deep-agent.js";
import { BoundaryModel, createHarness } from "../agent-runs/test-harness.js";
import { createModelCatalogService } from "../model-providers/model-catalog-service.js";
import { createModelProviderService } from "../model-providers/model-provider-service.js";
import { createModelProviderRepository } from "../model-providers/repository.js";
import { createProjectService } from "../projects/project-service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import { createCodeUiRepository } from "./repository.js";
import { CodeUiService } from "./service.js";

function modelGate() {
  let release!: () => void;
  let started = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait,
    get started() {
      return started;
    },
    entered() {
      started = true;
    },
    release,
  };
}

/** 一次性本机PG；模型是唯一可控系统边界，队列/Scope/native/checkpoint/ledger均为真实实现。 */
describe.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "V4手动压缩与原生Harness integration",
  () => {
    it("busy时compact与追问沿同一FIFO执行，真实summary只更新一个marker且追问消费压缩后历史", async () => {
      const database = await createTaskWorkDatabase();
      const busy = modelGate();
      const summary = modelGate();
      const followup = modelGate();
      let nextGate: ReturnType<typeof modelGate> | undefined;
      const model = new BoundaryModel(async () => {
        const gate = nextGate;
        nextGate = undefined;
        gate?.entered();
        await gate?.wait;
      });
      const settings = createSettingsService({
        localInstance: createCodeUiTestInstance(
          database.context.scope.instanceId,
          null,
          database.directory,
        ).localInstance,
        repository: createSettingsRepository(database.persistence),
      });
      const f = await createHarness(database, model, undefined, false, {
        settingsService: settings,
        // V4固定BYOK specifier；只替换外部模型，仍走同一真实native factory与所有middleware。
        agentFactory: (options) =>
          createKenFutWorkDeepAgent({ ...options, model }),
      });
      let ui: CodeUiService | undefined;
      let activePublication: Promise<void> | undefined;
      try {
        const providers = createModelProviderService({
          repository: createModelProviderRepository(database.persistence),
          localInstance: f.localInstance,
        });
        const provider = await providers.createInstance(
          f.actor,
          providerInstanceCreateRequestSchema.parse({
            name: "隔离压缩模型",
            protocol: "openai-compatible",
            apiKey: "private-fixture-key",
            models: [
              {
                id: "test",
                name: "Test",
                capability: "chat",
                reasoningEfforts: ["low"],
                contextWindow: 100_000,
              },
            ],
          }),
        );
        const selection = {
          providerId: provider.id,
          modelId: "test",
          options: { reasoningLevel: "low" },
        };
        await settings.updateInstanceSettings(f.actor, f.scope.instanceId, {
          defaultModel: `${provider.id}:test`,
          autoCompactEnabled: false,
        });
        const repository = createCodeUiRepository(database.persistence);
        await repository.save(
          f.scope.instanceId,
          f.scope.taskId,
          0,
          createCodeUiConversation({
            sessionId: f.scope.taskId,
            workspacePath: f.scope.rootDirectory,
            config: {
              provider: "zcode",
              model: "test",
              thought: "",
              followupMode: "queue",
              modelSelection: selection,
            },
          }).exportState(),
          null,
        );
        ui = new CodeUiService({
          repository,
          localInstance: f.localInstance,
          threads: f.threads,
          executionScopes: f.executionScopes,
          projects: createProjectService({
            repository: createProjectRepository(database.persistence),
            localInstance: f.localInstance,
            blob: {} as never,
          }),
          modelProviders: providers,
          modelCatalog: createModelCatalogService({
            modelProviders: providers,
            localInstance: f.localInstance,
          }),
          settings,
          agentRuns: f.runtime,
          agentRunMetadata: f.service,
          taskWork: f.work,
          env: f.env,
        });
        const saved = await f.persistence.getPersistence();
        if (!saved) throw new Error("V4压缩必须共享真实MemorySaver");
        const native = createKenFutWorkDeepAgent({
          env: f.env,
          model,
          preset: "code",
          systemPrompt: "隔离历史",
          backendResult: {
            factory: () => f.handle.backend,
            sandboxDir: f.scope.rootDirectory,
            ephemeral: false,
          },
          ...saved,
        });
        // 历史通过真实graph写入；足够越过保留窗口，但远低于自动阈值。
        const history = Array.from(
          { length: 30 },
          (_, index): BaseMessage =>
            index % 2
              ? new AIMessage(`历史AI ${index}`)
              : new HumanMessage({
                  id: `history-user-${index}`,
                  content: `历史用户 ${index}`,
                }),
        );
        for await (const _event of native.streamEvents(
          { messages: history },
          {
            version: "v2",
            configurable: { thread_id: f.threadId },
          },
        )) {
          /* 真实native执行后持久化checkpoint。 */
        }
        if (!native.contextHistory) throw new Error("真实native缺少历史port");
        const callsAfterSeed = model.requests.length;
        const clientId = randomUUID();
        const connection = await ui.openConnection(
          f.actor,
          async () => {},
          () => {},
        );
        const connected = ui;
        const rpc = (method: string, value: unknown) =>
          connected.transportRpc(
            f.actor,
            connection.hello.connectionId,
            method,
            [value],
          );
        await rpc("initializeConversationV4", {
          kind: "clientHello",
          clientId,
          protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
          clientKind: "web",
          appVersion: "integration",
        });
        const ids = {
          busy: randomUUID(),
          compact: randomUUID(),
          followup: randomUUID(),
        };
        async function admit(
          commandId: string,
          type: "sendText" | "compact",
          text?: string,
          waitForPublication = true,
        ) {
          const response = await rpc("sendConversationCommandV4", {
            workspacePath: f.scope.rootDirectory,
            envelope: {
              clientId,
              commandId,
              sessionId: f.scope.taskId,
              type,
              payload:
                type === "compact" ? {} : { text, modelSelection: selection },
              issuedAt: Date.now(),
            },
          });
          if (!response) throw new Error("V4 admission没有返回结果");
          expect(response.result).toMatchObject({ status: "accepted" });
          const publication = response.publish?.();
          if (waitForPublication) await publication;
          else activePublication = publication;
        }
        nextGate = busy;
        await admit(ids.busy, "sendText", "正在执行的输入", false);
        await vi.waitFor(() => expect(busy.started).toBe(true), {
          timeout: 5_000,
        });
        await admit(ids.compact, "compact");
        await admit(ids.followup, "sendText", "压缩后的追问");
        const queued = await ui.getSnapshot(f.actor, f.scope.taskId);
        expect(
          queued.queue.items.map((item) => ({
            kind: item.kind,
            commandId: item.sourceCommandId,
          })),
        ).toEqual([
          { kind: "compact", commandId: ids.compact },
          { kind: "sendText", commandId: ids.followup },
        ]);
        expect(model.requests).toHaveLength(callsAfterSeed + 1);
        nextGate = summary;
        busy.release();
        await vi.waitFor(() => expect(summary.started).toBe(true), {
          timeout: 5_000,
        });
        const running = await ui.getSnapshot(f.actor, f.scope.taskId);
        const activeRecord = await repository.find(
          f.scope.instanceId,
          f.scope.taskId,
        );
        const compactInput = activeRecord?.state?.inputs?.find(
          (input) => input.intent.sourceCommandId === ids.compact,
        );
        if (!compactInput) throw new Error("compact持久admission缺失");
        expect(compactInput).toMatchObject({
          status: "active",
          intent: { kind: "compact", clientId, text: "" },
        });
        const runId = compactInput.runId;
        expect(running.queue.items.map((item) => item.sourceCommandId)).toEqual(
          [ids.followup],
        );
        expect(
          running.rows.window.filter((row) => row.kind === "timelineMarker"),
        ).toEqual([
          expect.objectContaining({
            entityId: `compact:${runId}`,
            marker: { type: "compact", origin: "manual", status: "running" },
          }),
        ]);
        expect(
          running.rows.window
            .filter((row) => row.kind === "userInput")
            .map((row) => row.text),
        ).toEqual(["正在执行的输入"]);
        const beforePair = await f
          .metadata()
          .getOwnedTurnBoundaries(f.actor, { taskId: f.scope.taskId, runId });
        if (
          beforePair.pre?.context.status !== "captured" ||
          !beforePair.pre.context.reference
        )
          throw new Error("compact实际pre引用缺失");
        const beforeRef = beforePair.pre.context.reference;
        const beforeState =
          await native.contextHistory.getEffectiveState(beforeRef);
        nextGate = followup;
        summary.release();
        await vi.waitFor(() => expect(followup.started).toBe(true), {
          timeout: 5_000,
        });
        const afterPair = await f
          .metadata()
          .getOwnedTurnBoundaries(f.actor, { taskId: f.scope.taskId, runId });
        for (const phase of ["pre", "post"] as const)
          expect(afterPair[phase]).toMatchObject({
            runId,
            phase,
            operation: { kind: "compact" },
            inputOrigin: "controlOperation",
            inputMessageId: null,
            inputIdentity: { clientId, sourceCommandId: ids.compact },
          });
        if (
          afterPair.post?.context.status !== "captured" ||
          !afterPair.post.context.reference
        )
          throw new Error("compact实际post引用缺失");
        const afterState = await native.contextHistory.getEffectiveState(
          afterPair.post.context.reference,
        );
        expect(afterPair.post.context.reference).not.toEqual(beforeRef);
        expect(
          afterState.messages.filter((message) => message.summary),
        ).toHaveLength(1);
        expect(afterState.messages.length).toBeLessThan(
          beforeState.messages.length,
        );
        expect(
          (await native.contextHistory.getEffectiveState(beforeRef)).messages,
        ).toEqual(beforeState.messages);
        expect(model.requests).toHaveLength(callsAfterSeed + 3);
        const followupRequest = model.requests.at(-1);
        if (!followupRequest) throw new Error("真实追问模型请求缺失");
        expect(
          followupRequest
            .filter(HumanMessage.isInstance)
            .filter((message) => message.content === "压缩后的追问"),
        ).toHaveLength(1);
        expect(
          followupRequest.some(
            (message) =>
              message.additional_kwargs.lc_source === "summarization",
          ),
        ).toBe(true);
        followup.release();
        await vi.waitFor(
          async () => {
            expect(f.runtime.hasActiveRunForTask(f.scope.taskId)).toBe(false);
            expect(
              (await repository.find(f.scope.instanceId, f.scope.taskId))
                ?.active_run_id,
            ).toBeNull();
          },
          { timeout: 5_000 },
        );
        const completed = await ui.getSnapshot(f.actor, f.scope.taskId);
        expect(completed.queue.items).toEqual([]);
        expect(
          completed.rows.window.filter((row) => row.kind === "timelineMarker"),
        ).toEqual([
          expect.objectContaining({
            entityId: `compact:${runId}`,
            marker: { type: "compact", origin: "manual", status: "success" },
          }),
        ]);
        expect(
          completed.rows.window
            .filter((row) => row.kind === "userInput")
            .map((row) => row.text),
        ).toEqual(["正在执行的输入", "压缩后的追问"]);
        expect(
          completed.rows.window.filter((row) => row.kind === "assistantText"),
        ).toHaveLength(2);
      } finally {
        busy.release();
        summary.release();
        followup.release();
        await activePublication;
        await ui?.closeConnections();
        await f.runtime.cancelTaskRuns(f.scope.taskId);
        await f.work.close("test cleanup");
        await database.close();
      }
    });
  },
);
