import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createUnifiedMediaRecoveryFixture } from "./unified-media-recovery.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "共享Task实际生成工具等待跨停止间隔 integration",
  () => {
    it.each([
      { media: "image", ending: "host_shutdown", waitMs: 2_500 },
      { media: "image", ending: "manual_stop", waitMs: 2_500 },
      { media: "video", ending: "host_shutdown", waitMs: 3_500 },
      { media: "video", ending: "manual_stop", waitMs: 3_500 },
    ] as const)(
      "$media在$ending后同一app与PG跨过原wait间隔，已受理Job尊重真实停止原因",
      async ({ media, ending, waitMs }) => {
        const f = await createUnifiedMediaRecoveryFixture({
          media,
          submitThroughTool: true,
        });
        try {
          const before = await f.job();
          expect(before).toMatchObject({
            status: "running",
            provider_job_id: f.supplier.handle,
          });
          expect(f.supplier.requests.submissions).toBe(1);
          if (ending === "host_shutdown")
            await f.app().kernel.get("agentRuns").stopAllRuns("host_shutdown");
          else
            expect(
              (
                await f.host.command("stop", {
                  expectedForegroundExecutionId: f.runId,
                })
              ).body.result.status,
            ).toBe("accepted");

          // Intentionally real time: image/video waiters wake every 2/3 seconds.
          // App and PG stay open throughout; a rapid process exit cannot hide cancelJob.
          await delay(waitMs);
          expect((await f.client().request("/api/health")).status).toBe(200);
          const after = await f.job();
          expect(after.id).toBe(before.id);
          expect(after.provider_job_id).toBe(before.provider_job_id);
          expect(after.file_target).toEqual(before.file_target);
          expect(after.status).toBe(
            ending === "host_shutdown" ? "running" : "canceled",
          );
          expect(f.supplier.requests.submissions).toBe(1);
          expect(f.supplier.requests.downloads).toBe(0);
        } finally {
          await f.close();
        }
      },
      120_000,
    );
  },
);
