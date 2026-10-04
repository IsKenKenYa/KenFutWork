import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import type { QueueClient } from "../queue/types.js";
import { createJobService, JobServiceError } from "./job-service.js";
import { createJobRepository, type JobRepository } from "./repository.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";
const JOB_ID = "job-1";

const USER: AuthenticatedUser = {
  accessToken: "token",
  email: "user@example.com",
  id: USER_ID,
  userMetadata: {},
};

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string, values: unknown[]) => FakeResult = () => ({
    rowCount: 0,
    rows: [],
  }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text, values);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async acquireSession() { throw new Error("此查询夹具不提供真实执行宿主会话。"); },
    async end() {},
  };

  return {
    calls,
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

const JOB_ROW = {
  id: JOB_ID,
  workspace_id: WORKSPACE_ID,
  project_id: null,
  canvas_id: "canvas-1",
  session_id: null,
  thread_id: null,
  queue_name: "image_generation_jobs",
  job_type: "image_generation",
  status: "queued",
  payload: { prompt: "一只猫" },
  result: null,
  error_code: null,
  error_message: null,
  attempt_count: 0,
  max_attempts: 3,
  provider_job_id: null,
  created_by: USER_ID,
  created_at: "2026-09-13T00:00:00+00:00",
  updated_at: "2026-09-13T00:00:00+00:00",
  started_at: null,
  completed_at: null,
  failed_at: null,
  canceled_at: null,
};

const VIEWER_STUB: ViewerService = {
  ensureViewer: async () => {
    throw new Error("not used");
  },
  resolveWorkspace: async () => ({
    id: WORKSPACE_ID,
    name: "Personal Workspace",
    ownerUserId: USER_ID,
    type: "personal",
  }),
  updateProfile: async () => {
    throw new Error("not used");
  },
};

function fakeQueue(overrides: Partial<QueueClient> = {}): QueueClient {
  return {
    archive: vi.fn(async () => true),
    deleteMsg: vi.fn(async () => true),
    read: vi.fn(async () => []),
    readWithPoll: vi.fn(async () => []),
    send: vi.fn(async () => 1),
    setVt: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  } as unknown as QueueClient;
}

describe("jobs repository（background_jobs）", () => {
  it("建任务按工作区绑定并序列化 payload", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [JOB_ROW],
    }));

    await createJobRepository(createPersistenceFromRunner(runner)).insert({
      canvasId: "canvas-1",
      jobType: "image_generation",
      payload: { prompt: "一只猫" },
      queueName: "image_generation_jobs",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("insert into public.background_jobs");
    expect(sql).toContain("$7::jsonb");
    expect(sql).toContain("values ($9, $1, $2, $3, $4, $5, $6, $7::jsonb, $8)");
    expect(calls[0]?.values).toEqual([
      null,
      "canvas-1",
      null,
      null,
      "image_generation_jobs",
      "image_generation",
      JSON.stringify({ prompt: "一只猫" }),
      USER_ID,
      WORKSPACE_ID,
    ]);
  });

  it("用户路径查询与取消都带工作区谓词，取消限定未终态", async () => {
    const find = createRunner(() => ({ rowCount: 1, rows: [JOB_ROW] }));
    await createJobRepository(
      createPersistenceFromRunner(find.runner),
    ).findByIdInWorkspace(WORKSPACE_ID, JOB_ID);
    expect(find.sqls()[0]).toContain("where workspace_id = $2 and id = $1");

    const cancel = createRunner(() => ({ rowCount: 1, rows: [JOB_ROW] }));
    await createJobRepository(
      createPersistenceFromRunner(cancel.runner),
    ).cancel(WORKSPACE_ID, JOB_ID);
    const cancelSql = cancel.sqls()[0] ?? "";
    expect(cancelSql).toContain("set status = 'canceled'");
    expect(cancelSql).toContain("and status in ('queued', 'running')");
    expect(cancelSql).toContain("where workspace_id = $2 and id = $1");
  });

  it("列表按工作区 + 创建者，可选过滤走参数化且限 50 条", async () => {
    const all = createRunner();
    await createJobRepository(
      createPersistenceFromRunner(all.runner),
    ).listByCreator(WORKSPACE_ID, USER_ID, {});
    expect(all.sqls()[0]).toContain(
      "where workspace_id = $2 and created_by = $1 order by created_at desc limit 50",
    );

    const filtered = createRunner();
    await createJobRepository(
      createPersistenceFromRunner(filtered.runner),
    ).listByCreator(WORKSPACE_ID, USER_ID, {
      jobType: "video_generation",
      status: "running",
    });
    const sql = filtered.sqls()[0] ?? "";
    expect(sql).toContain("and status = $2");
    expect(sql).toContain("and job_type = $3");
    expect(filtered.calls[0]?.values).toEqual([
      USER_ID,
      "running",
      "video_generation",
      WORKSPACE_ID,
    ]);
  });

  it("worker 路径按 id 改状态：markRunning 只从 queued 迁移", async () => {
    const running = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createJobRepository(
      createPersistenceFromRunner(running.runner),
    ).markRunning(JOB_ID);
    const sql = running.sqls()[0] ?? "";
    expect(sql).toContain("set status = 'running'");
    expect(sql).toContain("where id = $1 and status = 'queued'");
    expect(sql).not.toContain("workspace_id");

    const succeeded = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createJobRepository(
      createPersistenceFromRunner(succeeded.runner),
    ).markSucceeded(JOB_ID, { url: "https://x/y.png" });
    expect(succeeded.sqls()[0]).toContain("result = $2::jsonb");
    expect(succeeded.calls[0]?.values).toEqual([
      JOB_ID,
      JSON.stringify({ url: "https://x/y.png" }),
    ]);

    const failed = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createJobRepository(
      createPersistenceFromRunner(failed.runner),
    ).markDeadLetter(JOB_ID, "provider_error", "超时");
    expect(failed.sqls()[0]).toContain("set status = 'dead_letter'");
    expect(failed.calls[0]?.values).toEqual([JOB_ID, "provider_error", "超时"]);

    const credits = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createJobRepository(
      createPersistenceFromRunner(credits.runner),
    ).setCreditsInfo(JOB_ID, 12, "tx-1");
    expect(credits.calls[0]?.values).toEqual([JOB_ID, 12, "tx-1"]);
  });

  it("尝试次数走库函数（原子累加）；未命中回默认值", async () => {
    const hit = createRunner(() => ({
      rowCount: 1,
      rows: [{ attempt_count: 2, max_attempts: 3 }],
    }));
    await expect(
      createJobRepository(
        createPersistenceFromRunner(hit.runner),
      ).incrementAttempt(JOB_ID),
    ).resolves.toEqual({ attempt_count: 2, max_attempts: 3 });
    expect(hit.sqls()[0]).toContain("public.increment_job_attempt($1)");
    expect(hit.calls[0]?.values).toEqual([JOB_ID]);

    const miss = createRunner();
    await expect(
      createJobRepository(
        createPersistenceFromRunner(miss.runner),
      ).incrementAttempt(JOB_ID),
    ).resolves.toEqual({ attempt_count: 1, max_attempts: 3 });
  });

  it("扣费信息按 id 取最小字段（死信退款用；credits_cost 不在对外契约里）", async () => {
    const hit = createRunner(() => ({
      rowCount: 1,
      rows: [{ credits_cost: 12, created_by: "user-1", workspace_id: "ws-1" }],
    }));
    await expect(
      createJobRepository(
        createPersistenceFromRunner(hit.runner),
      ).findCreditsInfo(JOB_ID),
    ).resolves.toEqual({
      createdBy: "user-1",
      creditsCost: 12,
      workspaceId: "ws-1",
    });

    const sql = hit.sqls()[0] ?? "";
    expect(sql).toContain(
      "select credits_cost, workspace_id, created_by from public.background_jobs where id = $1",
    );
    expect(hit.calls[0]?.values).toEqual([JOB_ID]);

    // credits_cost 可空（未扣费的任务），归一为 0 而不是 undefined
    const nullCredits = createRunner(() => ({
      rowCount: 1,
      rows: [{ credits_cost: null, created_by: null, workspace_id: null }],
    }));
    await expect(
      createJobRepository(
        createPersistenceFromRunner(nullCredits.runner),
      ).findCreditsInfo(JOB_ID),
    ).resolves.toEqual({ createdBy: null, creditsCost: 0, workspaceId: null });

    const miss = createRunner();
    await expect(
      createJobRepository(
        createPersistenceFromRunner(miss.runner),
      ).findCreditsInfo(JOB_ID),
    ).resolves.toBeNull();
  });
});

function createFakeRepository(
  overrides: Partial<JobRepository> = {},
): JobRepository {
  return {
    cancel: async () => JOB_ROW,
    countActive: async () => 0,
    delete: async () => 1,
    findById: async () => JOB_ROW,
    findByIdInWorkspace: async () => JOB_ROW,
    findCreditsInfo: async () => ({
      createdBy: "user-1",
      creditsCost: 0,
      workspaceId: "ws-1",
    }),
    incrementAttempt: async () => ({ attempt_count: 1, max_attempts: 3 }),
    insert: async () => JOB_ROW,
    listByCreator: async () => [],
    markDeadLetter: async () => 1,
    markFailed: async () => 1,
    markRunning: async () => 1,
    markSucceeded: async () => 1,
    setCreditsInfo: async () => 1,
    setProviderJobId: async () => 1,
    appendJobPayload: async () => 1,
    ...overrides,
  };
}

function buildService(
  options: {
    repository?: Partial<JobRepository>;
    queue?: QueueClient;
    viewerService?: ViewerService | null | undefined;
  } = {},
) {
  return createJobService({
    queue: options.queue ?? fakeQueue(),
    repository: createFakeRepository(options.repository),
    ...(options.viewerService === null
      ? {}
      : { viewerService: options.viewerService ?? VIEWER_STUB }),
  });
}

describe("job service", () => {
  it("建任务：工作区由服务解析，落库后投递队列", async () => {
    const send = vi.fn(async () => 1);
    const service = buildService({ queue: fakeQueue({ send }) });

    const job = await service.createJob(USER, {
      canvasId: "canvas-1",
      jobType: "image_generation",
      payload: { prompt: "一只猫" },
    });

    expect(job.id).toBe(JOB_ID);
    expect(job.job_type).toBe("image_generation");
    expect(send).toHaveBeenCalledWith(
      "image_generation_jobs",
      expect.objectContaining({
        job_id: JOB_ID,
        job_type: "image_generation",
        workspace_id: WORKSPACE_ID,
      }),
    );
  });

  it("投递失败时回滚任务行并报 job_create_failed", async () => {
    const removed: string[] = [];
    const service = buildService({
      queue: fakeQueue({
        send: vi.fn(async () => {
          throw new Error("pgmq down");
        }),
      }),
      repository: {
        delete: async (_workspaceId, jobId) => {
          removed.push(jobId);
          return 1;
        },
      },
    });

    await expect(
      service.createJob(USER, {
        jobType: "video_generation",
        payload: { prompt: "x" },
      }),
    ).rejects.toMatchObject({ code: "job_create_failed", statusCode: 500 });
    expect(removed).toEqual([JOB_ID]);
  });

  it("落库失败报 job_create_failed 且不投递", async () => {
    const send = vi.fn(async () => 1);
    const service = buildService({
      queue: fakeQueue({ send }),
      repository: { insert: async () => null },
    });

    await expect(
      service.createJob(USER, { jobType: "image_generation", payload: {} }),
    ).rejects.toMatchObject({ code: "job_create_failed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("查询未命中 404，取消未命中 404（含已终态语义）", async () => {
    const missing = buildService({
      repository: { findByIdInWorkspace: async () => null },
    });
    await expect(missing.getJob(USER, JOB_ID)).rejects.toMatchObject({
      code: "job_not_found",
      statusCode: 404,
    });

    const notCancelable = buildService({
      repository: { cancel: async () => null },
    });
    const error = await notCancelable
      .cancelJob(USER, JOB_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobServiceError);
    expect(error).toMatchObject({ code: "job_not_found", statusCode: 404 });
    expect((error as Error).message).toContain("already completed");
  });

  it("列表透传过滤条件并映射契约形状", async () => {
    const seen: unknown[] = [];
    const service = buildService({
      repository: {
        listByCreator: async (_workspaceId, _userId, filters) => {
          seen.push(filters);
          return [JOB_ROW];
        },
      },
    });

    const jobs = await service.listJobs(USER, {
      jobType: "image_generation",
      status: "queued",
    });

    expect(seen).toEqual([{ jobType: "image_generation", status: "queued" }]);
    expect(jobs[0]).toMatchObject({
      id: JOB_ID,
      queue_name: "image_generation_jobs",
      status: "queued",
      payload: { prompt: "一只猫" },
    });
  });

  it("worker 形态（无 viewer）：按 id 的状态迁移照常，用户方法 fail loud", async () => {
    const service = buildService({ viewerService: null });

    await expect(service.markRunning(JOB_ID)).resolves.toBeUndefined();
    await expect(service.getJobAdmin(JOB_ID)).resolves.toMatchObject({
      id: JOB_ID,
    });
    await expect(service.incrementAttempt(JOB_ID)).resolves.toEqual({
      attempt_count: 1,
      max_attempts: 3,
    });

    await expect(service.getJob(USER, JOB_ID)).rejects.toMatchObject({
      code: "job_query_failed",
    });
    await expect(
      service.createJob(USER, { jobType: "image_generation", payload: {} }),
    ).rejects.toBeInstanceOf(JobServiceError);
  });
});
