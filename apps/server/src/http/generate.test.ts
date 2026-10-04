import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createMemoryTaskWorkManager } from "../features/task-work/test-store.js";
import { createStartupPersistenceFixture } from "../test-startup-persistence.js";

/**
 * 直连生成路由的**会话上下文**回归（§4.8 自定义头占位符）。
 *
 * 背景：`/api/agent/generate-video` 建的 job 行带着 `session_id/thread_id`，
 * worker 侧正是按 job 行的这两列渲染 `{{sessionId}}` —— 所以「请求里带的会话有没有
 * 落进 job 行」是这条链路的关键，光看路由参数不够。
 */

const USER = {
  accessToken: "tok",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

const SESSION_ID = "3f1a1111-2222-4333-8444-555555555555";

function buildGenerateApp() {
  const createdJobs: Array<Record<string, unknown>> = [];
  const jobService = {
    cancelJob: vi.fn(async () => {}),
    createJob: vi.fn(async (_user: unknown, input: Record<string, unknown>) => {
      createdJobs.push(input);
      return { id: "job-1" };
    }),
    getJobAdmin: vi.fn(async () => ({
      id: "job-1",
      status: "succeeded",
      result: {
        signed_url: "https://cdn.example/v.mp4",
        asset_id: "asset-1",
        mime_type: "video/mp4",
        width: 1280,
        height: 720,
      },
    })),
    setCreditsInfo: vi.fn(async () => {}),
  };

  const app = buildApp({
    env: {
      databaseUrl: "postgres://localhost:5432/loomic-test",
      blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
      credentialSecret: "test-secret",
    },
    overrides: {
      taskWork: createMemoryTaskWorkManager(),
      persistence: createStartupPersistenceFixture(),
      auth: {
        authenticate: async () => USER,
        resolveUser: async () => USER,
      } as never,
      // 计费/配额与权限档位若走真实实现会去连库；本用例只关心「会话有没有落进 job 行」，
      // 故给最小替身：不扣费、不拦模型，确保路由走到 createJob。
      credits: {
        getSubscription: async () => ({ plan: "pro" }),
        deductCredits: async () => "tx-1",
      } as never,
      tierGuard: {
        calculateCreditCost: () => 0,
        checkConcurrency: async () => {},
        checkModelAccess: () => {},
        checkVideoResolution: () => {},
      } as never,
      jobs: jobService as never,
      modelProviders: {} as never,
      viewer: {
        ensureViewer: async () => ({ workspace: { id: "ws-1" } }),
      } as never,
    },
  });

  return { app, createdJobs, jobService };
}

describe("直连生成：会话上下文落进 job 行（§4.8 占位符渲染依赖它）", () => {
  it("generate-video 带 sessionId：写入 job 行的 session_id", async () => {
    const { app, createdJobs } = buildGenerateApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/generate-video",
        payload: {
          prompt: "一只猫在跑",
          model: "seedance-1-0-pro-250528",
          providerInstanceId: "11111111-2222-3333-8444-555555555555",
          sessionId: SESSION_ID,
        },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json().job_id).toBeTruthy();
      expect(createdJobs).toHaveLength(1);
      expect(createdJobs[0]?.sessionId).toBe(SESSION_ID);
    } finally {
      await app.close();
    }
  });

  it("不带会话时不留 session_id（实例若配了占位符会 fail loud，而不是拿到假值）", async () => {
    const { app, createdJobs } = buildGenerateApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/generate-video",
        payload: {
          prompt: "一只猫在跑",
          model: "seedance-1-0-pro-250528",
          providerInstanceId: "11111111-2222-3333-8444-555555555555",
        },
      });

      expect(response.statusCode).toBe(202);
      expect(createdJobs[0]).not.toHaveProperty("sessionId");
      expect(createdJobs[0]).not.toHaveProperty("threadId");
    } finally {
      await app.close();
    }
  });

  it("会话 id 口径同 run 路径：非空字符串即收，空串才拒（400）", async () => {
    const { app, createdJobs } = buildGenerateApp();
    try {
      // Code 模式的会话 id 由客户端自造，不保证是 uuid——按 uuid 校验会挡掉合法值
      const accepted = await app.inject({
        method: "POST",
        url: "/api/agent/generate-video",
        payload: {
          prompt: "一只猫在跑",
          model: "seedance-1-0-pro-250528",
          providerInstanceId: "11111111-2222-3333-8444-555555555555",
          sessionId: "client-made-session",
        },
      });
      expect(accepted.statusCode).toBe(202);
      expect(createdJobs[0]?.sessionId).toBe("client-made-session");

      const rejected = await app.inject({
        method: "POST",
        url: "/api/agent/generate-video",
        payload: { prompt: "一只猫在跑", sessionId: "" },
      });
      expect(rejected.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
