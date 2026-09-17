import type { BackgroundJob } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorContext } from "../job-executor.js";
import { PROVIDER_POLL_SCHEDULED } from "./video-generation.js";

/**
 * 视频执行器状态机（S6）：submit → 落引用+修订号 → 投延迟 poll 消息 →
 * poll 分支（in_progress 续投 / succeeded 落盘 / failed 死信），
 * 外加崩溃恢复（provider_job_id 在即续查）、跨修订拒绝、绝对超时。
 *
 * provider 经 resolveInstanceVideoProviderFromPayload 替身注入（vi.mock 模块），
 * 异步面为可控行为的桩；终态落盘链（blob/assetWriter）用最小替身。
 */

const JOB_ID = "aaaaaaaa-1111-1111-1111-111111111111";

function jobRow(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: JOB_ID,
    workspace_id: "ws-1",
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "video_generation_jobs",
    job_type: "video_generation",
    status: "running",
    payload: {
      prompt: "一只猫",
      model: "seedance-1-0-pro-250528",
      provider_instance_id: "bbbbbbbb-2222-2222-2222-222222222222",
    },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    provider_job_id: null,
    created_by: "user-1",
    created_at: "2026-09-18T00:00:00+00:00",
    updated_at: "2026-09-18T00:00:00+00:00",
    started_at: "2026-09-18T00:00:00+00:00",
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

function makeCtx(job: BackgroundJob) {
  const sent: Array<{ payload: Record<string, unknown>; delay?: number }> = [];
  const ctx = {
    jobService: {
      getJobAdmin: vi.fn(async () => job),
      setProviderJobId: vi.fn(async () => {}),
      appendJobPayload: vi.fn(async () => {}),
      markSucceeded: vi.fn(async () => {}),
    },
    queue: {
      send: vi.fn(
        async (
          _queue: string,
          payload: Record<string, unknown>,
          delaySeconds?: number,
        ) => {
          sent.push({ payload, delay: delaySeconds });
          return 1;
        },
      ),
    },
    env: {},
    renewVt: vi.fn(async () => {}),
    blob: {
      bucket: () => ({
        upload: vi.fn(async () => {}),
        resolveUrl: vi.fn(async () => "https://blobs.example/video.mp4"),
      }),
    },
    assetWriter: {
      recordGeneratedAsset: vi.fn(async () => "asset-1"),
    },
    creditService: {},
    usageService: undefined,
    sent,
  } as unknown as ExecutorContext & {
    sent: Array<{ payload: Record<string, unknown>; delay?: number }>;
  };
  return ctx;
}

// 可控的异步 provider 桩：行为由 options 决定
vi.mock("./instance-provider.js", () => ({
  resolveInstanceVideoProviderFromPayload: vi.fn(),
}));
vi.mock("../../../generation/video-generation.js", () => ({
  generateVideo: vi.fn(),
}));

import { getExecutor } from "../job-executor.js";
import { resolveInstanceVideoProviderFromPayload } from "./instance-provider.js";

// 副作用导入：触发执行器注册（在 mock 之后再 import）
import "./video-generation.js";

function stubInstance(overrides: {
  startAsync?: (params: unknown) => Promise<{ providerJobId: string }>;
  pollAsync?: (id: string) => Promise<{
    state: "in_progress" | "succeeded" | "failed";
    videoUrl?: string;
    errorMessage?: string;
  }>;
}) {
  return {
    provider: {
      name: "stub",
      models: [],
      generate: vi.fn(),
      ...overrides,
    },
    configRevision: 7,
  };
}

async function runExecutor(ctx: ExecutorContext) {
  const executor = getExecutor("video_generation");
  if (!executor) throw new Error("executor not registered");
  return executor(JOB_ID, {}, ctx);
}

function mockInstanceResolver(value: unknown) {
  vi.mocked(resolveInstanceVideoProviderFromPayload).mockResolvedValue(
    value as never,
  );
}

describe("video executor 状态机（S6）", () => {
  it("首次执行：submit → setProviderJobId + 修订号落 payload + 投延迟 poll 消息 + 抛 scheduled", async () => {
    const job = jobRow();
    const ctx = makeCtx(job);
    mockInstanceResolver(
      stubInstance({
        startAsync: async () => ({ providerJobId: "cloud-task-1" }),
        pollAsync: vi.fn(),
      }),
    );

    await expect(runExecutor(ctx)).rejects.toMatchObject({
      code: PROVIDER_POLL_SCHEDULED,
    });
    expect(ctx.jobService.setProviderJobId).toHaveBeenCalledWith(
      JOB_ID,
      "cloud-task-1",
    );
    expect(ctx.jobService.appendJobPayload).toHaveBeenCalledWith(JOB_ID, {
      provider_config_revision: 7,
    });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.payload).toMatchObject({
      job_id: JOB_ID,
      job_type: "video_generation",
    });
    expect(ctx.sent[0]?.delay).toBe(10);
  });

  it("崩溃恢复：provider_job_id 已在 → 直接 poll，不重复 submit", async () => {
    const job = jobRow({
      provider_job_id: '"cloud-task-1"',
      payload: {
        prompt: "一只猫",
        model: "seedance-1-0-pro-250528",
        provider_instance_id: "bbbbbbbb-2222-2222-2222-222222222222",
        provider_config_revision: 7,
      },
    });
    const ctx = makeCtx(job);
    const startAsync = vi.fn();
    mockInstanceResolver(
      stubInstance({
        startAsync,
        pollAsync: async () => ({ state: "in_progress" }),
      }),
    );

    await expect(runExecutor(ctx)).rejects.toMatchObject({
      code: PROVIDER_POLL_SCHEDULED,
    });
    expect(startAsync).not.toHaveBeenCalled();
    expect(ctx.jobService.setProviderJobId).not.toHaveBeenCalled();
    expect(ctx.sent).toHaveLength(1);
  });

  it("poll succeeded：下载产物落 blob 并组装 result", async () => {
    const job = jobRow({
      provider_job_id: '"cloud-task-1"',
      payload: {
        prompt: "一只猫",
        model: "seedance-1-0-pro-250528",
        provider_instance_id: "bbbbbbbb-2222-2222-2222-222222222222",
        provider_config_revision: 7,
      },
    });
    const ctx = makeCtx(job);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      ),
    );
    mockInstanceResolver(
      stubInstance({
        startAsync: vi.fn(),
        pollAsync: async () => ({
          state: "succeeded",
          videoUrl: "https://cdn.example/v.mp4",
        }),
      }),
    );

    const result = (await runExecutor(ctx)) as Record<string, unknown>;
    expect(result.signed_url).toBe("https://blobs.example/video.mp4");
    expect(result.asset_id).toBe("asset-1");
    vi.unstubAllGlobals();
  });

  it("poll failed → provider_task_failed（不可重试，走死信）", async () => {
    const job = jobRow({
      provider_job_id: '"cloud-task-1"',
      payload: {
        prompt: "一只猫",
        model: "seedance-1-0-pro-250528",
        provider_instance_id: "bbbbbbbb-2222-2222-2222-222222222222",
        provider_config_revision: 7,
      },
    });
    const ctx = makeCtx(job);
    mockInstanceResolver(
      stubInstance({
        startAsync: vi.fn(),
        pollAsync: async () => ({
          state: "failed",
          errorMessage: "内容审核未通过",
        }),
      }),
    );

    await expect(runExecutor(ctx)).rejects.toMatchObject({
      code: "provider_task_failed",
    });
  });

  it("跨修订拒绝：payload 修订 ≠ 当前修订 → 不触碰厂商 API", async () => {
    const job = jobRow({
      provider_job_id: '"cloud-task-1"',
      payload: {
        prompt: "一只猫",
        model: "seedance-1-0-pro-250528",
        provider_instance_id: "bbbbbbbb-2222-2222-2222-222222222222",
        provider_config_revision: 3,
      },
    });
    const ctx = makeCtx(job);
    const pollAsync = vi.fn();
    mockInstanceResolver(
      stubInstance({
        pollAsync,
      }),
    );

    await expect(runExecutor(ctx)).rejects.toMatchObject({
      code: "provider_config_stale",
    });
    expect(pollAsync).not.toHaveBeenCalled();
  });

  it("绝对超时：started_at 超过时限 → video_job_timeout（不可重试）", async () => {
    const stale = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const job = jobRow({
      provider_job_id: '"cloud-task-1"',
      started_at: stale,
      payload: {
        prompt: "一只猫",
        model: "seedance-1-0-pro-250528",
        provider_instance_id: "bbbbbbbb-2222-2222-2222-222222222222",
        provider_config_revision: 7,
      },
    });
    const ctx = makeCtx(job);
    mockInstanceResolver(
      stubInstance({
        startAsync: vi.fn(),
        pollAsync: async () => ({ state: "in_progress" }),
      }),
    );

    await expect(runExecutor(ctx)).rejects.toMatchObject({
      code: "video_job_timeout",
    });
  });
});
