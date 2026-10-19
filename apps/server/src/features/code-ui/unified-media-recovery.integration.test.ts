import { randomUUID } from "node:crypto";
import { generationFileTargetSchema } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createUnifiedMediaRecoveryFixture,
  mediaRecoveryLatch,
  RECOVERY_IMAGE,
} from "./unified-media-recovery.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "共享Task已受理媒体的完整宿主恢复 integration",
  () => {
    it("host_shutdown后同一Job仅续查原句柄、保存并发布一次，不重启Agent或重提生成", async () => {
      const f = await createUnifiedMediaRecoveryFixture();
      try {
        const before = await f.job();
        expect(f.supplier.requests.submissions).toBe(1);
        expect(before.status).toBe("running");
        const latest = await f.restart();
        expect(latest.status).toBe(200);
        expect(latest.body.run).toMatchObject({
          status: "canceled",
          stopReason: "host_shutdown",
        });

        f.startRecovery();
        const result = await f.terminalJob();
        expect(
          result.status,
          JSON.stringify({
            code: result.error_code,
            message: result.error_message,
          }),
        ).toBe("succeeded");
        expect(result.id).toBe(before.id);
        expect(result.provider_job_id).toBe(before.provider_job_id);
        expect(result.file_target).toEqual(before.file_target);
        expect(f.supplier.requests.submissions).toBe(1);
        expect(f.supplier.requests.polls).toBeGreaterThan(0);
        expect(f.supplier.requests.downloads).toBe(1);
        const assetId = result.result?.asset_id;
        if (typeof assetId !== "string")
          throw new Error("恢复结果缺少真实素材身份。");
        expect(
          Buffer.from(
            await f
              .app()
              .kernel.get("projectFiles")
              .read(f.actor, assetId, { maxBytes: RECOVERY_IMAGE.length }),
          ),
        ).toEqual(RECOVERY_IMAGE);
        const canvas = await f
          .app()
          .kernel.get("canvas")
          .getCanvas(f.actor, f.canvasId);
        expect(
          canvas.content.elements.filter(
            (element) => element.type === "image" && !element.isDeleted,
          ),
        ).toHaveLength(1);
        expect(
          Object.values(canvas.content.files).filter(
            (file) => file.assetId === assetId,
          ),
        ).toHaveLength(1);
        expect(f.model.requests).toHaveLength(1);
      } finally {
        await f.close();
      }
    }, 120_000);

    it("host_shutdown后没有已存供应商句柄的Job不自动提交生成", async () => {
      const f = await createUnifiedMediaRecoveryFixture({ submit: false });
      try {
        expect(await f.job()).toMatchObject({
          status: "queued",
          provider_job_id: null,
        });
        await f.restart();
        f.startRecovery();
        expect(await f.terminalJob()).toMatchObject({
          status: "dead_letter",
          error_code: "invalid_input",
        });
        expect(f.supplier.requests).toEqual({
          submissions: 0,
          polls: 0,
          downloads: 0,
        });
        expect(f.model.requests).toHaveLength(1);
      } finally {
        await f.close();
      }
    }, 120_000);

    it.each(["stop", "cancel", "revoke", "branch"] as const)(
      "明确%s后重启仍拒绝媒体副作用，不续查或重新生成",
      async (action) => {
        const f = await createUnifiedMediaRecoveryFixture();
        try {
          if (action === "stop") {
            expect(
              (
                await f.host.command("stop", {
                  expectedForegroundExecutionId: f.runId,
                })
              ).body.result.status,
            ).toBe("accepted");
          } else if (action === "cancel") {
            expect(
              (
                await f
                  .client()
                  .request(`/api/jobs/${f.jobId}/cancel`, {}, "POST")
              ).status,
            ).toBe(200);
          } else if (action === "revoke") {
            expect(
              (
                await f
                  .client()
                  .request(
                    `/api/code-ui/tasks/${f.host.sessionId}/scope`,
                    { sandboxMode: "read-only" },
                    "PATCH",
                  )
              ).status,
            ).toBe(200);
          } else {
            const handle = await f
              .app()
              .kernel.get("executionScopes")
              .openTask(f.actor, f.host.sessionId);
            const restored = await f
              .app()
              .kernel.get("codeUi")
              .rewindTask(
                f.actor,
                f.host.sessionId,
                handle.describe().generation,
              );
            await f
              .app()
              .kernel.get("codeUi")
              .finishTaskRestore(restored, f.actor, true);
          }
          const polls = f.supplier.requests.polls;
          await f.restart();
          f.startRecovery();
          const job = await f.terminalJob();
          expect(job.status).toBe(
            action === "cancel" ? "canceled" : "dead_letter",
          );
          expect(f.supplier.requests).toEqual({
            submissions: 1,
            polls,
            downloads: 0,
          });
          const canvas = await f
            .app()
            .kernel.get("canvas")
            .getCanvas(f.actor, f.canvasId);
          expect(canvas.content.elements).toEqual([]);
          expect(canvas.content.files).toEqual({});
          expect(f.model.requests).toHaveLength(1);
        } finally {
          await f.close();
        }
      },
      120_000,
    );

    it("没有可信原Run终态的旧来源仍拒绝，不从错误文案或当前权限推测恢复授权", async () => {
      const f = await createUnifiedMediaRecoveryFixture();
      try {
        const polls = f.supplier.requests.polls;
        await f.restart();
        const original = await f.job();
        const target = generationFileTargetSchema.parse(original.file_target);
        if (target.kind !== "task")
          throw new Error("恢复材料没有绑定真实Task。");
        await expect(
          f
            .app()
            .kernel.get("generationTargets")
            .resolve({
              ...original,
              file_target: { ...target, originRunId: randomUUID() },
            }),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(
          f
            .app()
            .kernel.get("generationTargets")
            .resolve({ ...original, provider_job_id: null }),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(
          f.app().kernel.get("generationTargets").prepareOrigin({
            actor: f.actor,
            projectId: target.projectId,
            sessionId: target.sessionId,
            runId: f.runId,
            expectedScopeGeneration: target.scopeGeneration,
            expectedBranchGeneration: target.branchGeneration,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
        expect(f.supplier.requests).toEqual({
          submissions: 1,
          polls,
          downloads: 0,
        });
      } finally {
        await f.close();
      }
    }, 120_000);

    it("恢复下载期间撤权仍阻止保存和发布，原句柄不重新生成", async () => {
      const f = await createUnifiedMediaRecoveryFixture();
      const download = mediaRecoveryLatch();
      try {
        await f.restart();
        f.supplier.holdDownload(download.promise);
        f.startRecovery();
        await vi.waitFor(() => expect(f.supplier.requests.downloads).toBe(1), {
          timeout: 30_000,
        });
        expect(
          (
            await f
              .client()
              .request(
                `/api/code-ui/tasks/${f.host.sessionId}/scope`,
                { sandboxMode: "read-only" },
                "PATCH",
              )
          ).status,
        ).toBe(200);
        download.release();
        expect((await f.terminalJob()).status).toBe("dead_letter");
        const canvas = await f
          .app()
          .kernel.get("canvas")
          .getCanvas(f.actor, f.canvasId);
        expect(canvas.content.elements).toEqual([]);
        expect(canvas.content.files).toEqual({});
        await expect(
          f.app().kernel.get("projectFiles").describe(f.actor, f.jobId),
        ).rejects.toThrow();
        expect(f.supplier.requests.submissions).toBe(1);
      } finally {
        download.release();
        await f.close();
      }
    }, 120_000);
  },
);
