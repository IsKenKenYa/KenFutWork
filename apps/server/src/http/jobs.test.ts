import { backgroundJobSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeTestInstance } from "../agent/runtime-test-fixtures.js";
import type { CreateJobInput } from "../features/jobs/job-service.js";
import type { LocalActor } from "../features/local-instance/types.js";
import { registerJobRoutes } from "./jobs.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR = { instanceId: INSTANCE_ID, accessClientId: CLIENT_ID };
function fixture(authorized = true) {
  const app = Fastify();
  const localInstance = createRuntimeTestInstance(INSTANCE_ID);
  const row = backgroundJobSchema.parse({
    id: "44444444-4444-4444-8444-444444444444",
    instance_id: INSTANCE_ID,
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "queued",
    payload: {},
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    provider_job_id: null,
    created_by_client_id: CLIENT_ID,
    created_at: "2026-10-05T00:00:00Z",
    updated_at: "2026-10-05T00:00:00Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  });
  const createJob = vi.fn(
    async (_actor: LocalActor, input: CreateJobInput) => ({
      ...row,
      job_type: input.jobType,
      payload: input.payload,
    }),
  );
  const resolveCredentials = vi.fn(async () => ({}));
  void registerJobRoutes(app, {
    localAccess: { authenticate: async () => (authorized ? ACTOR : null) },
    localInstance,
    modelProviders: { resolveCredentials } as never,
    jobService: {
      createJob,
      getJob: async () => row,
      listJobs: async () => [row],
      cancelJob: async () => ({
        ...row,
        status: "canceled",
        canceled_at: "2026-10-05T01:00:00Z",
      }),
    } as never,
  });
  return { app, createJob, resolveCredentials, localInstance };
}

describe("本地 BYOK Jobs HTTP", () => {
  it("提交失败释放实例准入；迁移准备拒绝新任务且不再解析供应商", async () => {
    const { app, createJob, resolveCredentials, localInstance } = fixture();
    const payload = {
      prompt: "BYOK",
      model: "local-model",
      provider_instance_id: PROVIDER_ID,
    };
    createJob.mockRejectedValueOnce(new Error("队列不可用"));
    try {
      const failed = await app.inject({
        method: "POST",
        url: "/api/jobs/image-generation",
        payload,
      });
      expect(failed.statusCode).toBe(500);
      expect(localInstance.activeAdmissionCount()).toBe(0);
      await localInstance.beginMaintenance(async () => {});
      const draining = await app.inject({
        method: "POST",
        url: "/api/jobs/image-generation",
        payload,
      });
      expect(draining.statusCode).toBe(503);
      expect(draining.json().error.code).toBe("instance_draining");
      expect(createJob).toHaveBeenCalledTimes(1);
      expect(resolveCredentials).toHaveBeenCalledTimes(1);
      expect(localInstance.activeAdmissionCount()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each(["image", "video"])(
    "免账户%s任务创建验证同实例供应商，并透传其引用",
    async (kind) => {
      const { app, createJob, resolveCredentials } = fixture();
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/jobs/${kind}-generation`,
          payload: {
            prompt: "BYOK",
            model: "local-model",
            provider_instance_id: PROVIDER_ID,
            accessToken: "must-not-persist",
          },
        });
        expect(response.statusCode).toBe(201);
        expect(resolveCredentials).toHaveBeenCalledWith(ACTOR, PROVIDER_ID);
        expect(createJob).toHaveBeenCalledWith(
          ACTOR,
          expect.objectContaining({
            jobType: `${kind}_generation`,
            payload: expect.objectContaining({
              model: "local-model",
              provider_instance_id: PROVIDER_ID,
            }),
          }),
        );
        expect(JSON.stringify(createJob.mock.calls)).not.toContain(
          "must-not-persist",
        );
        expect(response.json().job.instance_id).toBe(INSTANCE_ID);
      } finally {
        await app.close();
      }
    },
  );
  it.each([
    { prompt: "BYOK", model: "local" },
    { prompt: "BYOK", provider_instance_id: PROVIDER_ID },
  ])("缺模型或供应商引用拒绝入队", async (payload) => {
    const { app, createJob } = fixture();
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/jobs/image-generation",
            payload,
          })
        ).statusCode,
      ).toBe(400);
      expect(createJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("没有接入凭据拒绝请求；有效实例主人可取消同实例任务", async () => {
    const unauth = fixture(false);
    const local = fixture();
    try {
      expect((await unauth.app.inject({ url: "/api/jobs" })).statusCode).toBe(
        401,
      );
      const canceled = await local.app.inject({
        method: "POST",
        url: "/api/jobs/44444444-4444-4444-8444-444444444444/cancel",
      });
      expect(canceled.statusCode).toBe(200);
      expect(canceled.json().job.status).toBe("canceled");
    } finally {
      await unauth.app.close();
      await local.app.close();
    }
  });
});
