import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerRunRoutes } from "./runs.js";

/**
 * `GET /api/agent/subagents`（设置 →「子智能体」的数据源）的**路由级**回归。
 *
 * 这一层的价值在于契约形状：响应要过 `agentSubagentListResponseSchema`，客户端据此渲染
 * （漏字段/多字段都会被 zod 拦下或剥掉）。同时钉住「未登录不给清单」这条基本线。
 */
const USER = {
  accessToken: "tok",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

function buildApp(authenticated: boolean, deps: Record<string, unknown> = {}) {
  const app = Fastify();
  void registerRunRoutes(app, {} as never, {
    auth: {
      authenticate: async () => (authenticated ? USER : null),
      resolveUser: async () => null,
    } as never,
    ...deps,
  });
  return app;
}

describe("GET /api/agent/subagents", () => {
  it("装配了设置服务时：自定义子智能体从工作区设置透出（与内置撞名的剔除）", async () => {
    const getWorkspaceSettings = async () => ({
      subagents: [
        {
          name: "translator",
          label: "翻译官",
          description: "把长文翻译成中文。",
          systemPrompt: "You are a translator.",
        },
        {
          name: "video_generate",
          label: "撞名项",
          description: "x",
          systemPrompt: "y",
        },
      ],
    });
    const app = buildApp(true, {
      settingsService: { getWorkspaceSettings },
      viewerService: {
        ensureViewer: async () => ({
          workspace: { id: "ws-1" },
        }),
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/subagents",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        custom: Array<{ name: string }>;
      };
      expect(body.custom.map((entry) => entry.name)).toEqual(["translator"]);
    } finally {
      await app.close();
    }
  });

  it("未装配设置服务：custom 为空数组（内置清单照常可用）", async () => {
    const app = buildApp(true);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/subagents",
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { custom: unknown[] }).custom).toEqual([]);
    } finally {
      await app.close();
    }
  });
  it("登录后返回声明的子代理与内置分发工具（形状过契约）", async () => {
    const app = buildApp(true);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/subagents",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        subagents: Array<{ name: string; label: string; tools: string[] }>;
        builtin: Array<{ name: string }>;
      };
      expect(body.subagents.map((entry) => entry.name)).toContain(
        "video_generate",
      );
      expect(body.builtin.map((entry) => entry.name)).toContain("task");
      // 中文短名与工具名都要在（界面直接上屏，缺了就是空白行）
      for (const entry of body.subagents) {
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.tools.length).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  });

  it("未登录：401（清单不外泄）", async () => {
    const app = buildApp(false);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/subagents",
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

/**
 * `GET /api/agent/runs/latest`（失败轮的原因要给界面看服务端原文）的路由级回归。
 *
 * 钉三件事：未登录 401；按 `resolveWorkspace` 解析出的工作区查；会话不在该工作区
 * 链上时按「没有这轮」返回 null（与 activity 同一口径，不给资源枚举留信号）。
 */
describe("GET /api/agent/runs/latest", () => {
  it("未登录：401", async () => {
    const app = buildApp(false);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/runs/latest?sessionId=s-1",
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("归属工作区：交回终态与失败原因原文（查询带工作区过滤）", async () => {
    const calls: Array<{ sessionId: string; workspaceId: string }> = [];
    const app = buildApp(true, {
      viewerService: {
        resolveWorkspace: async () => ({ id: "ws-1" }),
      },
      latestRunQuery: async (input: {
        sessionId: string;
        workspaceId: string;
      }) => {
        calls.push(input);
        return {
          status: "failed",
          errorCode: "run_failed",
          errorMessage:
            "服务重启，本轮已中断（进程在生成过程中退出，未有终态事件）。",
          startedAt: "2026-09-29T12:00:00.000Z",
          completedAt: "2026-09-29T12:00:09.000Z",
        };
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/runs/latest?sessionId=384c8166-995c-4890-97e2-678be1495057",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        run: { status: string; errorMessage: string | null } | null;
      };
      expect(body.run?.status).toBe("failed");
      expect(body.run?.errorMessage).toContain("服务重启，本轮已中断");
      expect(calls).toEqual([
        {
          sessionId: "384c8166-995c-4890-97e2-678be1495057",
          workspaceId: "ws-1",
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("会话没有 run / 不属于该工作区：run 为 null", async () => {
    const app = buildApp(true, {
      viewerService: { resolveWorkspace: async () => ({ id: "ws-1" }) },
      latestRunQuery: async () => null,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/runs/latest?sessionId=someone-else",
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { run: unknown }).run).toBeNull();
    } finally {
      await app.close();
    }
  });
});
