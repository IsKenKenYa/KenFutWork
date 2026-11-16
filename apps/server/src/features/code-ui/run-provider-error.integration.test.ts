import { taskRunsResponseSchema, zcodeUiProtocol } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "供应商拒绝输入时对话和运行记录显示同一处理建议",
  async () => {
    const detail = "PRIVATE_PROVIDER_REQUEST_DETAIL";
    const expected = "供应商未接受当前输入，请检查输入和附件或更换模型。";
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel({
      rejectStatus: 422,
      rejectRequestIndexes: [0],
      rejectError: { message: detail, code: "invalid_request_error" },
    });
    let host: Awaited<ReturnType<typeof createCodeSessionFixture>> | undefined;
    try {
      const task = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
        initializeGit: false,
      });
      host = task;
      const path = `/api/agent/tasks/${task.sessionId}/runs?projectId=${task.projectId}`;
      const readRuns = async () => {
        const result = await task.client.request(path);
        expect(result.status).toBe(200);
        return taskRunsResponseSchema.parse(result.body).runs;
      };
      const accepted = await task.command("sendText", { text: "测试输入" });
      expect(accepted.body.result.status).toBe("accepted");
      await vi.waitFor(
        async () => {
          const snapshot = zcodeUiProtocol.conversationSnapshotSchema.parse(
            await task.snapshot(),
          );
          expect(snapshot.control.phase).toBe("error");
        },
        { timeout: 30_000 },
      );
      const failed = zcodeUiProtocol.conversationSnapshotSchema.parse(
        await task.snapshot(),
      );
      expect(failed.control.lastError?.message).toBe(expected);
      expect(JSON.stringify(failed)).not.toContain(detail);
      expect(await readRuns()).toMatchObject([
        { status: "failed", errorMessage: expected },
      ]);
      expect(model.requests).toHaveLength(1);

      const next = await task.command("sendText", { text: "调整后的输入" });
      expect(next.body.result.status).toBe("accepted");
      await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
        timeout: 30_000,
      });
      model.finish(1);
      await vi.waitFor(
        async () => {
          const runs = await readRuns();
          expect(runs).toHaveLength(2);
          expect(runs).toContainEqual(
            expect.objectContaining({
              status: "completed",
              errorMessage: null,
            }),
          );
          expect(runs).toContainEqual(
            expect.objectContaining({
              status: "failed",
              errorMessage: expected,
            }),
          );
        },
        { timeout: 30_000 },
      );
    } finally {
      await host?.dispose();
      await model.close();
      await fixture.close();
    }
  },
  120_000,
);
