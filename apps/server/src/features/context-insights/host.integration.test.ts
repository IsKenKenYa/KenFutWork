import {
  contextRequestInputSchema,
  contextRequestListSchema,
  contextRequestPageSchema,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "../code-ui/code-ui-http.fixture.js";
import { waitPhase } from "../code-ui/history-fork.fixture.js";
import { createCodeSessionFixture } from "../code-ui/host-session.fixture.js";
import { heldModel } from "../code-ui/model-stream.fixture.js";

describe.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "上下文检查公开宿主链路",
  () => {
    it("模型实际调用保存最终输入，受保护RPC可分页回读并关联供应商用量", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel({
        usage: { promptTokens: 37, completionTokens: 9 },
      });
      const host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const list = async () => {
        const response = await host.client.request("/api/code-ui/rpc", {
          service: "context-insights",
          method: "list",
          args: [{ taskId: host.sessionId }],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return contextRequestListSchema.parse(response.body.result);
      };
      try {
        expect((await list()).requests).toEqual([]);
        await host.command("sendText", { text: "INSPECT_ACTUAL_USER_CONTEXT" });
        await model.firstRequest;
        await vi.waitFor(async () =>
          expect((await list()).requests).toHaveLength(1),
        );
        model.finish(0);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        const records = await list();
        const record = records.requests[0];
        if (!record) throw new Error("请求记录未保存。");
        await vi.waitFor(async () =>
          expect((await list()).requests[0]?.status).toBe("completed"),
        );
        expect((await list()).requests[0]?.usage).toEqual({
          inputTokens: 37,
          outputTokens: 9,
        });
        const outputResponse = await host.client.request("/api/code-ui/rpc", {
          service: "context-insights",
          method: "read",
          args: [
            { taskId: host.sessionId, requestId: record.id, part: "output" },
          ],
        });
        expect(outputResponse.status).toBe(200);
        const output = contextRequestPageSchema.parse(
          outputResponse.body.result,
        );
        expect(JSON.parse(output.text)).toMatchObject([
          { type: "ai", data: { content: "正在运行 1", finishReason: "stop" } },
        ]);
        const chunks: string[] = [];
        let offset = 0;
        for (;;) {
          const response = await host.client.request("/api/code-ui/rpc", {
            service: "context-insights",
            method: "read",
            args: [
              {
                taskId: host.sessionId,
                requestId: record.id,
                part: "input",
                offset,
              },
            ],
          });
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const page = contextRequestPageSchema.parse(response.body.result);
          chunks.push(page.text);
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
        const input = contextRequestInputSchema.parse(
          JSON.parse(chunks.join("")),
        );
        const wire = model.requests[0]?.body;
        if (!wire) throw new Error("模型没有实际请求。");
        expect(JSON.stringify(input)).toContain("INSPECT_ACTUAL_USER_CONTEXT");
        expect(input.tools).toEqual(wire.tools);
        expect(JSON.stringify(input)).not.toContain(
          "integration-only-not-a-key",
        );
        expect(
          input.messages
            .flat()
            .filter((message) => message.type === "system")
            .map((message) => message.data.content),
        ).toEqual(
          (
            wire.messages as Array<{
              role: string;
              content: unknown;
            }>
          )
            .filter((message) => message.role === "system")
            .map((message) => message.content),
        );
      } finally {
        await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 60_000);
  },
);
