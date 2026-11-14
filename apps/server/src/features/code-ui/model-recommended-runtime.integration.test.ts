import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import {
  extractManualModelConfig,
  type ProviderSettingsView,
  type SavePersonalModelDraftInput,
} from "@zcode/provider";
import { modelSelectionSchema } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

async function snapshot(host: Host) {
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

async function providerRpc(host: Host, method: string, args: unknown[] = []) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method,
    args,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const view: ProviderSettingsView = response.body.result;
  return view;
}

async function preferredSelection(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "modelSelectionService",
    method: "getView",
    args: [],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return modelSelectionSchema.parse(response.body.result.preferredSelection);
}

async function manualConfiguration(host: Host) {
  const selection = await preferredSelection(host);
  const view = await providerRpc(host, "getView");
  const model = view.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((entry) => entry.modelId === selection.modelId);
  if (!model) throw new Error("原模型设置缺少当前选择");
  const manual = extractManualModelConfig(model.effectiveConfig);
  const input: SavePersonalModelDraftInput = {
    providerId: selection.providerId,
    originalModelId: selection.modelId,
    nextModelId: selection.modelId,
    personalConfig: {
      ...manual,
      properties: { ...manual.properties, contextWindow: 260000 },
      optionSpecs: {
        ...manual.optionSpecs,
        maxOutputTokens: { max: 9000 },
      },
    },
    useRecommendedConfig: false,
    basedOnRevision: view.revision,
  };
  const saved = await providerRpc(host, "savePersonalModelDraft", [input]);
  return { input, revision: saved.revision };
}

async function send(host: Host, text: string) {
  const selection = await preferredSelection(host);
  const commandId = randomUUID();
  const response = await host.command(
    "sendText",
    { text, modelSelection: selection, mode: "build", planEnabled: false },
    commandId,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(response.body.result).status).toBe(
    "accepted",
  );
  return commandId;
}

async function waitForCompletion(
  host: Host,
  commandId: string,
  count: number,
  maxTokens: number,
) {
  return vi.waitFor(
    async () => {
      const current = await snapshot(host);
      expect(
        current.control.phase,
        JSON.stringify(current.control.lastError),
      ).toBe("completedSuccess");
      expect(current.control.activeWorks).toEqual([]);
      expect(current.pendingInteractions).toEqual([]);
      const input = current.rows.window.find(
        (row) => row.kind === "userInput" && row.sourceCommandId === commandId,
      );
      if (input?.kind !== "userInput" || !input.turnId)
        throw new Error("原输入缺少Run身份");
      expect(
        current.rows.window.filter((row) => row.kind === "turnHeader"),
      ).toHaveLength(count);
      expect(current.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "turnHeader",
          turnId: input.turnId,
          state: "completedSuccess",
        }),
      );
      expect(current.usage.contextWindow?.maxTokens).toBe(maxTokens);
      return { current, runId: input.turnId };
    },
    { timeout: 30_000 },
  ); // 等待真实模型与持久投影完成，非Agent运行时限额。
}

/** 真实HTTP/RPC/PG/Harness；外部模型HTTP材料不代表真实付费模型验收。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原模型恢复推荐后的实际运行 integration",
  () => {
    it("同一Task恢复推荐后新Run使用推荐输出上限与窗口并保留原历史", async () => {
      const model = await heldModel({
        usage: { promptTokens: 11, completionTokens: 7 },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        const configured = await manualConfiguration(host);
        const firstCommand = await send(host, "MANUAL_MODEL_CONFIGURATION");
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        expect(model.requests[0]?.body).toMatchObject({
          model: "stop-model",
          max_completion_tokens: 9000,
        });
        model.finish(0);
        const first = await waitForCompletion(host, firstCommand, 1, 260000);
        expect(first.current.usage.cumulative).toMatchObject({
          inputTokens: 11,
          outputTokens: 7,
        });
        await providerRpc(host, "savePersonalModelDraft", [
          {
            ...configured.input,
            personalConfig: {},
            useRecommendedConfig: true,
            basedOnRevision: configured.revision,
          },
        ]);
        const secondCommand = await send(host, "RESTORED_MODEL_CONFIGURATION");
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        expect(model.requests[1]?.body).toMatchObject({
          model: "stop-model",
          max_completion_tokens: 32000,
        });
        expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
          "MANUAL_MODEL_CONFIGURATION",
        );
        expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
          "正在运行 1",
        );
        model.finish(1);
        const second = await waitForCompletion(host, secondCommand, 2, 200000);
        expect(second.runId).not.toBe(first.runId);
        expect(second.current.usage.cumulative).toMatchObject({
          inputTokens: 22,
          outputTokens: 14,
        });
        for (const [turnId, sourceCommandId, text] of [
          [first.runId, firstCommand, "MANUAL_MODEL_CONFIGURATION"],
          [second.runId, secondCommand, "RESTORED_MODEL_CONFIGURATION"],
        ]) {
          expect(second.current.rows.window).toContainEqual(
            expect.objectContaining({
              kind: "userInput",
              turnId,
              sourceCommandId,
              text,
            }),
          );
        }
        for (const [turnId, text] of [
          [first.runId, "正在运行 1"],
          [second.runId, "正在运行 2"],
        ]) {
          expect(second.current.rows.window).toContainEqual(
            expect.objectContaining({
              kind: "assistantText",
              turnId,
              text,
              state: "complete",
            }),
          );
        }
        expect(model.requests).toHaveLength(2);
      } finally {
        try {
          if (host && (await snapshot(host)).control.canStop)
            await host.command("stop", {});
        } finally {
          try {
            await model.close();
          } finally {
            await host?.dispose();
          }
        }
      }
    }, 90_000); // 独占HTTP、PG和两次模型流的测试期限，非运行时治理值。
  },
);
