import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createJobRepository } from "./repository.js";

/**
 * jobs 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明任务行的用户路径（工作区作用域）与 worker 路径（按 id 迁移状态）
 * 在真库上都成立，且跨工作区不可读写；尝试次数经库函数原子累加。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @kenfutwork/server exec vitest run jobs.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const FOREIGN_WORKSPACE = "00000000-0000-0000-0000-000000000000";

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("jobs 真实库集成", () => {
  async function withJobFixture(
    run: (input: {
      jobId: string;
      persistence: ReturnType<typeof createPostgresPersistence>;
      userId: string;
      workspaceId: string;
    }) => Promise<void>,
  ) {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();
      const userId = (profile as IdRow).id;

      const workspace =
        await createViewerRepository(persistence).findPersonalWorkspace(userId);
      const workspaceId = workspace?.id as string;
      expect(workspaceId).toBeTruthy();

      const created = await createJobRepository(persistence).insert({
        jobType: "image_generation",
        payload: { prompt: "集成测试：一只猫" },
        queueName: "image_generation_jobs",
        userId,
        workspaceId,
      });
      const jobId = created?.id as string;
      expect(jobId).toBeTruthy();

      try {
        await run({ jobId, persistence, userId, workspaceId });
      } finally {
        await persistence.query(
          "delete from public.background_jobs where id = $1",
          [jobId],
        );
      }
    } finally {
      await persistence.close();
    }
  }

  it("建任务后可按工作区读回、按创建者列出", async () => {
    await withJobFixture(
      async ({ jobId, persistence, userId, workspaceId }) => {
        const jobs = createJobRepository(persistence);

        await expect(
          jobs.findByIdInWorkspace(workspaceId, jobId),
        ).resolves.toMatchObject({
          id: jobId,
          status: "queued",
          payload: { prompt: "集成测试：一只猫" },
        });

        const listed = await jobs.listByCreator(workspaceId, userId, {});
        expect(listed.map((row) => row.id)).toContain(jobId);

        const filtered = await jobs.listByCreator(workspaceId, userId, {
          status: "queued",
        });
        expect(filtered.map((row) => row.id)).toContain(jobId);

        const byOtherStatus = await jobs.listByCreator(workspaceId, userId, {
          status: "succeeded",
        });
        expect(byOtherStatus.map((row) => row.id)).not.toContain(jobId);
      },
    );
  });

  it("worker 路径：按 id 累加尝试次数并迁移状态", async () => {
    await withJobFixture(async ({ jobId, persistence }) => {
      const jobs = createJobRepository(persistence);

      // 库函数原子累加
      const first = await jobs.incrementAttempt(jobId);
      expect(first.attempt_count).toBe(1);
      expect(first.max_attempts).toBeGreaterThanOrEqual(1);
      const second = await jobs.incrementAttempt(jobId);
      expect(second.attempt_count).toBe(2);

      // queued → running → succeeded
      await expect(jobs.markRunning(jobId)).resolves.toBe(1);
      await expect(jobs.markRunning(jobId)).resolves.toBe(0); // 已非 queued
      await expect(
        jobs.markSucceeded(jobId, { object_path: "ws/1.png" }),
      ).resolves.toBe(1);

      const row = await jobs.findById(jobId);
      expect(row?.status).toBe("succeeded");
      expect(row?.result).toEqual({ object_path: "ws/1.png" });
      expect(row?.completed_at).not.toBeNull();
    });
  });

  it("取消是条件更新：首次生效，重复取消返回 null（已终态）", async () => {
    await withJobFixture(async ({ jobId, persistence, workspaceId }) => {
      const jobs = createJobRepository(persistence);

      await expect(jobs.cancel(workspaceId, jobId)).resolves.toMatchObject({
        status: "canceled",
      });
      await expect(jobs.cancel(workspaceId, jobId)).resolves.toBeNull();
    });
  });

  it("跨工作区读不到、取消不了、删不掉（FORM-9 隔离门禁）", async () => {
    await withJobFixture(async ({ jobId, persistence, workspaceId }) => {
      const jobs = createJobRepository(persistence);

      await expect(
        jobs.findByIdInWorkspace(FOREIGN_WORKSPACE, jobId),
      ).resolves.toBeNull();
      await expect(jobs.cancel(FOREIGN_WORKSPACE, jobId)).resolves.toBeNull();
      await expect(jobs.delete(FOREIGN_WORKSPACE, jobId)).resolves.toBe(0);
      await expect(
        jobs.listByCreator(
          FOREIGN_WORKSPACE,
          "11111111-1111-1111-1111-111111111111",
          {},
        ),
      ).resolves.toEqual([]);

      // 越权尝试后本工作区数据完好
      await expect(
        jobs.findByIdInWorkspace(workspaceId, jobId),
      ).resolves.toMatchObject({ id: jobId, status: "queued" });
    });
  });

  it("标死信与写 credits 信息落到对应列", async () => {
    await withJobFixture(async ({ jobId, persistence }) => {
      const jobs = createJobRepository(persistence);

      // credits_transaction_id 是 uuid 列，夹具须给合法 UUID
      await jobs.setCreditsInfo(
        jobId,
        7,
        "22222222-2222-4222-8222-222222222222",
      );
      await jobs.markDeadLetter(jobId, "provider_error", "上游 500");

      const row = await jobs.findById(jobId);
      expect(row?.status).toBe("dead_letter");
      expect(row?.error_code).toBe("provider_error");
      expect(row?.error_message).toBe("上游 500");
      expect(row?.failed_at).not.toBeNull();
    });
  });
});
