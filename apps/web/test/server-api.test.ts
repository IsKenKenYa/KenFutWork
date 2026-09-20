// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiAuthError,
  connectCdp,
  createProject,
  createRun,
  fetchDirectoryPickerStatus,
  fetchProjects,
  fetchVideoModels,
  fetchViewer,
  pickDirectory,
} from "../src/lib/server-api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe("authenticated server API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("fetchViewer sends bearer token and returns viewer response", async () => {
    const viewer = {
      profile: {
        id: "u1",
        email: "a@b.com",
        displayName: "A",
        avatarUrl: null,
      },
      workspace: { id: "w1", name: "W", type: "personal", ownerUserId: "u1" },
      membership: { workspaceId: "w1", userId: "u1", role: "owner" },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => viewer,
    });

    const result = await fetchViewer("token_abc");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/viewer",
      expect.objectContaining({
        headers: { Authorization: "Bearer token_abc" },
      }),
    );
    expect(result.profile.id).toBe("u1");
  });

  it("createRun sends bearer auth when access token is provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        runId: "run_123",
        sessionId: "session_123",
        conversationId: "conversation_123",
        status: "accepted",
      }),
    });

    await createRun(
      {
        sessionId: "session_123",
        conversationId: "conversation_123",
        prompt: "Hello",
      },
      { accessToken: "token_abc" },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/agent/runs",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer token_abc",
          "content-type": "application/json",
        },
      }),
    );
  });

  it("createRun keeps demo calls unauthenticated by default", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        runId: "run_123",
        sessionId: "session_123",
        conversationId: "conversation_123",
        status: "accepted",
      }),
    });

    await createRun({
      sessionId: "session_123",
      conversationId: "conversation_123",
      prompt: "Hello",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/agent/runs",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      }),
    );
  });

  it("createProject sends POST with bearer token and handles 201", async () => {
    const project = {
      project: {
        id: "p1",
        name: "Test",
        slug: "test",
        description: null,
        workspace: { id: "w1", name: "W", type: "personal", ownerUserId: "u1" },
        primaryCanvas: { id: "c1", name: "Main Canvas", isPrimary: true },
        createdAt: "2026-03-23T00:00:00Z",
        updatedAt: "2026-03-23T00:00:00Z",
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => project,
    });

    const result = await createProject("token_abc", { name: "Test" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/projects",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token_abc",
          "content-type": "application/json",
        }),
      }),
    );
    expect(result.project.id).toBe("p1");
  });

  it("fetchProjects sends bearer token and returns list", async () => {
    const list = { projects: [{ id: "p1", name: "Test", slug: "test" }] };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => list,
    });

    const result = await fetchProjects("token_abc");
    // 缺省取画布项目（design）；工作目录项目用 kind=code 单独取
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/projects?kind=design",
      expect.objectContaining({
        headers: { Authorization: "Bearer token_abc" },
      }),
    );
    expect(result.projects).toHaveLength(1);
  });

  it("fetchProjects 可指定 kind（Code 模式取工作目录项目）", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ projects: [] }),
    });

    await fetchProjects("token_abc", "code");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/projects?kind=code",
      expect.objectContaining({
        headers: { Authorization: "Bearer token_abc" },
      }),
    );
  });

  it("fetchVideoModels preserves capability, limits, and verified pricing metadata", async () => {
    const payload = {
      models: [
        {
          id: "metaso/minimax-h3",
          displayName: "MiniMax H3 (Metaso)",
          description: "Metaso H3",
          provider: "metaso",
          creditCost: 51,
          capabilities: {
            textToVideo: true,
            imageToVideo: true,
            videoToVideo: false,
            audio: false,
          },
          limits: {
            maxDuration: 15,
            allowedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            maxResolution: "1080p",
            maxInputImages: 2,
          },
          pricing: {
            currency: "CNY",
            billingUnit: "generated_second",
            providerPointsName: "H3 points",
            evidenceDate: "2026-08-19",
            rates: [
              {
                resolution: "720p",
                displayResolution: "768P",
                providerPointsPerSecond: 10.2,
                cnyPerSecond: { min: 0.0897, max: 0.1102 },
              },
            ],
          },
        },
      ],
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await fetchVideoModels();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/video-models",
    );
    expect(result.models[0]).toMatchObject({
      id: "metaso/minimax-h3",
      creditCost: 51,
      limits: { maxDuration: 15, maxInputImages: 2 },
      pricing: { evidenceDate: "2026-08-19" },
    });
  });

  it("createProject throws ApiApplicationError with code on 409", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: "project_slug_taken", message: "Slug taken." },
      }),
    });

    await expect(createProject("token_abc", { name: "Dup" })).rejects.toThrow(
      "Slug taken.",
    );
    try {
      await createProject("token_abc", { name: "Dup" });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("project_slug_taken");
    }
  });

  it("fetchViewer throws ApiAuthError on 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "Bad token." },
      }),
    });

    await expect(fetchViewer("expired")).rejects.toThrow("unauthorized");
  });

  it("fetchProjects throws ApiAuthError on 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "Bad token." },
      }),
    });

    await expect(fetchProjects("expired")).rejects.toThrow("unauthorized");
  });
});

/**
 * 原生目录对话框（桌面形态）：能力探测与「弹一次对话框」两个端点。
 *
 * 客户端按 `status` 分流：picked 走绑定、cancelled 静默、unavailable 回落浏览器
 * 选择器、failed 报原因——四种都不能被客户端改写成别的意思。
 */
describe("原生目录对话框端点", () => {
  it("探测：带 bearer、返回 available 与原因", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        available: false,
        reason: "服务端在另一台机器上。",
      }),
    });
    const status = await fetchDirectoryPickerStatus("token_abc");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/system/directory-picker",
      expect.objectContaining({
        headers: { Authorization: "Bearer token_abc" },
      }),
    );
    expect(status.available).toBe(false);
    expect(status.reason).toContain("另一台机器");
  });

  it("选择：POST，四种状态原样回给调用方", async () => {
    const cases = [
      { status: "picked", path: "D:Desktop\test" },
      { status: "cancelled" },
      { status: "unavailable", reason: "没装 zenity。" },
      { status: "failed", reason: "退出码 3。" },
    ] as const;
    for (const payload of cases) {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      });
      await expect(pickDirectory("token_abc")).resolves.toEqual(payload);
      expect(mockFetch).toHaveBeenLastCalledWith(
        "http://localhost:3001/api/system/pick-directory",
        expect.objectContaining({ method: "POST" }),
      );
    }
  });

  it("未登录：抛 ApiAuthError（401 不落成普通应用错误）", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    await expect(pickDirectory("expired")).rejects.toBeInstanceOf(ApiAuthError);
  });
});

/**
 * CDP 三个动作（连接 / 开调试工具 / 断开）都走 POST JSON。
 *
 * **回归背景（真机踩到）**：带了 `Content-Type: application/json` 却**不带 body** 时，
 * Fastify 回 `FST_ERR_CTP_EMPTY_JSON_BODY`（400）——设置页的「连接到 Chrome」与右栏的
 * 「打开调试工具」都因此失败，界面只显示一句泛泛的「连接浏览器失败」。这条锁住「必须带 body」。
 */
describe("CDP 动作的请求形状", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connectCdp 是 POST + JSON 头 + **非空 body**", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cdp: { status: "connected", browser: "Chrome", tabs: 1 },
        opened: { targetId: "t", url: "https://example.com/" },
      }),
    });

    await connectCdp("token");

    const calls = mockFetch.mock.calls.map(
      (call) => call[1] as { method?: string; body?: string },
    );
    expect(calls).toHaveLength(1);
    for (const init of calls) {
      expect(init.method).toBe("POST");
      // 空 body + JSON 头 = 400（FST_ERR_CTP_EMPTY_JSON_BODY）
      expect(init.body).toBe("{}");
    }
  });

  /**
   * 回归背景（真机踩到）：`pickDirectory` 是同一个坑的漏网之鱼——POST + JSON 头 +
   * 空 body，服务端 400 `FST_ERR_CTP_EMPTY_JSON_BODY`，而 400 的默认响应体里
   * `error` 是字符串（不是 `{code,message}`），客户端只认得出 `error.message`，
   * 于是界面显示成一句无从下手的「系统文件夹对话框不可用：Request failed」。
   */
  it("pickDirectory 是 POST + JSON 头 + **非空 body**", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "cancelled" }),
    });

    await pickDirectory("token");

    const init = mockFetch.mock.calls[0]?.[1] as {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    };
    expect(init.method).toBe("POST");
    expect(init.headers?.["content-type"]).toBe("application/json");
    expect(init.body).toBe("{}");
  });
});
