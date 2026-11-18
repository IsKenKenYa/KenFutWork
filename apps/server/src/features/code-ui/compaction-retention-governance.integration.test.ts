import { randomUUID } from "node:crypto";
import {
  instanceSettingsResponseSchema,
  zcodeUiProtocol as protocol,
  resolveGovernanceEnvOverrides,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  CATALOG_COMPACT_MODEL,
  catalogCompactionModelFixture,
  catalogUserText,
} from "./compaction-catalog-metadata.fixture.js";
import {
  assertAutoEvidence,
  assertCatalogNoCanvas,
  assertFullHistory,
  assertOwnedRun,
  declareAndQualify,
  disposeCatalogFixture,
  type Fixture,
  finishRound,
  type Host,
  TEST_CASE_TIMEOUT_MS,
  TEST_SYNC_TIMEOUT_MS,
} from "./compaction-catalog-test.fixture.js";
import { task } from "./guide-state-test.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";

// 固定场景规模与用户选择的目标，只是测试数据，不定义运行时默认/护栏。
const TEST_TURNS = 5;
const KEEP_TARGET = 2;

async function readRetentionSettings(fixture: Fixture) {
  const response = await fixture.client.request("/api/instance/settings");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return instanceSettingsResponseSchema.parse(response.body).settings;
}

async function configureRetention(fixture: Fixture) {
  const before = await fixture.client.request("/api/instance/settings");
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  const initial = instanceSettingsResponseSchema.parse(before.body);
  expect(initial.settings.autoCompactEnabled).toBe(true);
  // 原公开HTTP发送真实新字段；不能先在客户端parse后把unknown剥掉。
  const updated = await fixture.client.request(
    "/api/instance/settings",
    { compactKeepMessages: KEEP_TARGET },
    "PATCH",
  );
  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  // 首个产品RED必须是原PATCH回执缺少保留目标，不能让后续模型行为掩盖它。
  expect(updated.body.settings).toMatchObject({
    compactKeepMessages: KEEP_TARGET,
    compactFallbackKeepMessages: 6,
    autoCompactEnabled: true,
  });
  instanceSettingsResponseSchema.parse(updated.body);
  const reread = await fixture.client.request("/api/instance/settings");
  expect(reread.status, JSON.stringify(reread.body)).toBe(200);
  expect(reread.body.settings).toMatchObject({
    compactKeepMessages: KEEP_TARGET,
    compactFallbackKeepMessages: 6,
    autoCompactEnabled: true,
  });
  instanceSettingsResponseSchema.parse(reread.body);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "实例压缩保留目标的实际自动摘要 integration",
  () => {
    it(
      "公开读回采用库值优先于已解析env，非法env格式落默认且局部保存不覆盖另一个目标",
      async () => {
        const fixture = await createCodeUiHttpFixture({
          governanceEnv: resolveGovernanceEnvOverrides({
            KENFUTWORK_COMPACT_KEEP_MESSAGES: "7",
            KENFUTWORK_COMPACT_FALLBACK_KEEP_MESSAGES: "9",
          }),
        });
        try {
          expect(await readRetentionSettings(fixture)).toMatchObject({
            compactKeepMessages: 7,
            compactFallbackKeepMessages: 9,
          });
          const saved = await fixture.client.request(
            "/api/instance/settings",
            { compactKeepMessages: 2 },
            "PATCH",
          );
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          expect(await readRetentionSettings(fixture)).toMatchObject({
            compactKeepMessages: 2,
            compactFallbackKeepMessages: 9,
          });
        } finally {
          await fixture.close();
        }
        const defaults = await createCodeUiHttpFixture({
          governanceEnv: resolveGovernanceEnvOverrides({
            KENFUTWORK_COMPACT_KEEP_MESSAGES: "2.5",
            KENFUTWORK_COMPACT_FALLBACK_KEEP_MESSAGES: "invalid",
          }),
        });
        try {
          expect(await readRetentionSettings(defaults)).toMatchObject({
            compactKeepMessages: 20,
            compactFallbackKeepMessages: 6,
          });
        } finally {
          await defaults.close();
        }
      },
      TEST_CASE_TIMEOUT_MS,
    );

    it(
      "保留目标拒绝越界、非整数和错误类型，同一请求的自动开关不被部分写入",
      async () => {
        const fixture = await createCodeUiHttpFixture();
        try {
          const saved = await fixture.client.request(
            "/api/instance/settings",
            { compactKeepMessages: 2, compactFallbackKeepMessages: 3 },
            "PATCH",
          );
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          const original = await readRetentionSettings(fixture);
          const invalidValues = [
            { compactKeepMessages: 0 },
            { compactKeepMessages: 10_001 },
            { compactKeepMessages: 2.5 },
            { compactFallbackKeepMessages: -1 },
            { compactFallbackKeepMessages: null },
            { compactFallbackKeepMessages: "3" },
          ];
          for (const invalid of invalidValues) {
            const response = await fixture.client.request(
              "/api/instance/settings",
              { ...invalid, autoCompactEnabled: false },
              "PATCH",
            );
            expect(response.status, JSON.stringify(response.body)).toBe(400);
            expect(response.body.error.code).toBe("invalid_request");
            expect(await readRetentionSettings(fixture)).toEqual(original);
          }
        } finally {
          await fixture.close();
        }
      },
      TEST_CASE_TIMEOUT_MS,
    );

    it(
      "公开保存keep=2后已声明自定义模型五轮真实输入触发SDK摘要，下一请求消费摘要且全转录保留",
      async () => {
        const model = await catalogCompactionModelFixture({
          turns: TEST_TURNS,
        });
        let fixture: Fixture | undefined;
        let host: Host | undefined;
        try {
          fixture = await createCodeUiHttpFixture();
          await configureRetention(fixture);
          expect(model.requests).toEqual([]);
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          const selection = await declareAndQualify(host);
          const original = await task(fixture, host);
          await assertCatalogNoCanvas(fixture, host, original);
          const commandIds: string[] = [];
          const runIds: string[] = [];
          for (let round = 1; round <= TEST_TURNS; round++) {
            const commandId = randomUUID();
            commandIds.push(commandId);
            const sent = await host.command(
              "sendText",
              {
                text: catalogUserText(round),
                modelSelection: selection,
                mode: "build",
                planEnabled: false,
              },
              commandId,
            );
            expect(sent.status, JSON.stringify(sent.body)).toBe(200);
            expect(
              protocol.commandAckSchema.parse(sent.body.result).status,
            ).toBe("accepted");
            const runId = await finishRound(host, commandId, round);
            runIds.push(runId);
            await assertOwnedRun(
              fixture,
              host,
              original,
              runId,
              commandId,
              selection,
            );
          }
          expect(commandIds).toHaveLength(TEST_TURNS);
          expect(new Set(runIds).size).toBe(commandIds.length);
          expect(
            model.requests
              .filter((request) => request.kind === "normal")
              .map((request) => request.round),
          ).toEqual(commandIds.map((_, index) => index + 1));
          expect(
            model.requests.every(
              (request) => request.body.model === CATALOG_COMPACT_MODEL,
            ),
          ).toBe(true);
          await assertAutoEvidence(fixture, host, model, runIds, {
            keepMessages: KEEP_TARGET,
          });
          const finalRunId = runIds.at(-1);
          if (!finalRunId) throw new Error("五轮原输入没有最后Run。");
          await assertFullHistory(fixture, host, finalRunId, commandIds);
          await vi.waitFor(
            () =>
              expect(model.requests.every((request) => request.closed)).toBe(
                true,
              ),
            { timeout: TEST_SYNC_TIMEOUT_MS },
          );
        } finally {
          await disposeCatalogFixture(model, host, fixture);
        }
      },
      TEST_CASE_TIMEOUT_MS,
    );
  },
);
