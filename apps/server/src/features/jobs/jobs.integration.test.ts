import { describe, expect, it } from "vitest";

import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createJobRepository } from "./repository.js";

/**
 * jobs 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明任务行的本机路径（实例作用域）与 worker 路径（按 id 迁移状态）
 * 在真库上都成立，且跨实例不可读写；尝试次数经库函数原子累加。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @kenfutwork/server exec vitest run jobs.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const FOREIGN_INSTANCE = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!DATABASE_URL)("jobs 真实库集成", () => {
  async function withJobFixture(
    run: (input: {
      jobId: string;
      persistence: ReturnType<typeof createPostgresPersistence>;
      instanceId: string;
    }) => Promise<void>,
  ) {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const instanceId =
        await createLocalInstanceRepository(persistence).ensure();
      expect(instanceId).toBeTruthy();

      const created = await createJobRepository(persistence).insert({
        jobType: "image_generation",
        payload: { prompt: "集成测试：一只猫" },
        queueName: "image_generation_jobs",
        createdByClientId: null,
        instanceId,
      });
      const jobId = created?.id as string;
      expect(jobId).toBeTruthy();

      try {
        await run({ jobId, persistence, instanceId });
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

  it("建任务后可按实例读回、按实例列出", async () => {
    await withJobFixture(async ({ jobId, persistence, instanceId }) => {
      const jobs = createJobRepository(persistence);

      await expect(
        jobs.findByIdInInstance(instanceId, jobId),
      ).resolves.toMatchObject({
        id: jobId,
        status: "queued",
        payload: { prompt: "集成测试：一只猫" },
      });

      const listed = await jobs.listForInstance(instanceId, {});
      expect(listed.map((row) => row.id)).toContain(jobId);

      const filtered = await jobs.listForInstance(instanceId, {
        status: "queued",
      });
      expect(filtered.map((row) => row.id)).toContain(jobId);

      const byOtherStatus = await jobs.listForInstance(instanceId, {
        status: "succeeded",
      });
      expect(byOtherStatus.map((row) => row.id)).not.toContain(jobId);
    });
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
    await withJobFixture(async ({ jobId, persistence, instanceId }) => {
      const jobs = createJobRepository(persistence);

      await expect(jobs.cancel(instanceId, jobId)).resolves.toMatchObject({
        status: "canceled",
      });
      await expect(jobs.cancel(instanceId, jobId)).resolves.toBeNull();
    });
  });

  it("取消后迟到的成功、失败与死信写入都不复活任务", async () => {
    await withJobFixture(async ({ jobId, persistence, instanceId }) => {
      const jobs = createJobRepository(persistence);
      await jobs.markRunning(jobId);
      await jobs.cancel(instanceId, jobId);
      await jobs.markSucceeded(jobId, {
        url: "https://example.invalid/late.png",
      });
      await jobs.markFailed(jobId, "late_failure", "迟到失败");
      await jobs.markDeadLetter(jobId, "late_failure", "迟到死信");
      const row = await jobs.findByIdInInstance(instanceId, jobId);
      expect(row?.status).toBe("canceled");
      expect(row?.result).toBeNull();
      expect(row?.canceled_at).not.toBeNull();
    });
  });

  it("跨实例读不到、取消不了、删不掉（FORM-9 隔离门禁）", async () => {
    await withJobFixture(async ({ jobId, persistence, instanceId }) => {
      const jobs = createJobRepository(persistence);

      await expect(
        jobs.findByIdInInstance(FOREIGN_INSTANCE, jobId),
      ).resolves.toBeNull();
      await expect(jobs.cancel(FOREIGN_INSTANCE, jobId)).resolves.toBeNull();
      await expect(jobs.delete(FOREIGN_INSTANCE, jobId)).resolves.toBe(0);
      await expect(jobs.listForInstance(FOREIGN_INSTANCE, {})).resolves.toEqual(
        [],
      );

      // 越权尝试后本实例数据完好
      await expect(
        jobs.findByIdInInstance(instanceId, jobId),
      ).resolves.toMatchObject({ id: jobId, status: "queued" });
    });
  });

  it("标死信保留供应商失败事实", async () => {
    await withJobFixture(async ({ jobId, persistence }) => {
      const jobs = createJobRepository(persistence);

      await jobs.markDeadLetter(jobId, "provider_error", "上游 500");

      const row = await jobs.findById(jobId);
      expect(row?.status).toBe("dead_letter");
      expect(row?.error_code).toBe("provider_error");
      expect(row?.error_message).toBe("上游 500");
      expect(row?.failed_at).not.toBeNull();
    });
  });
});
