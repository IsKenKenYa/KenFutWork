import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  CATALOG_COMPACT_MODEL,
  CATALOG_COMPACT_TURNS,
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
} from "./compaction-catalog-test.fixture.js";
import { task } from "./guide-state-test.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";

/** 公开HTTP/RPC、真实Actor/Task/PG/native；只替换外部模型HTTP边界。第一片仅核初始模型catalog metadata。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "初始自定义模型自动压缩metadata integration",
  () => {
    it(
      "真实Provider声明采用reserved-output/min4000，native摘要改有效历史且保留用户全转录",
      async () => {
        const model = await catalogCompactionModelFixture();
        let fixture: Fixture | undefined;
        let host: Host | undefined;
        try {
          fixture = await createCodeUiHttpFixture();
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          const selection = await declareAndQualify(host);
          const original = await task(fixture, host);
          await assertCatalogNoCanvas(fixture, host, original);
          const commandIds: string[] = [];
          const runIds: string[] = [];
          for (let round = 1; round <= CATALOG_COMPACT_TURNS; round++) {
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
            await assertOwnedRun(fixture, host, original, runId, commandId);
          }
          expect(new Set(runIds).size).toBe(CATALOG_COMPACT_TURNS);
          expect(
            model.requests.every(
              (request) => request.body.model === CATALOG_COMPACT_MODEL,
            ),
          ).toBe(true);
          await assertAutoEvidence(fixture, host, model, runIds);
          const finalRunId = runIds.at(-1);
          if (!finalRunId) throw new Error("有限自然用户轮次未产生最后Run。");
          await assertFullHistory(fixture, host, finalRunId, commandIds);
        } finally {
          await disposeCatalogFixture(model, host, fixture);
        }
      },
      TEST_CASE_TIMEOUT_MS,
    );
  },
);
