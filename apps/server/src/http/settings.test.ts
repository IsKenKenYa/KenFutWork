import { workspaceSettingsUpdateRequestSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerSettingsRoutes } from "./settings.js";

/**
 * `PUT /api/workspace/settings` 是**部分更新**——这条口径在本轮真机上又被打破过一次：
 * `workspaceSettingsSchema.partial()` 会**保留字段上的 `.default(...)`**，于是只送一个键的
 * payload 里会多出一堆默认值（`codeIndexEnabled: false` / `terminalShell: "auto"` /
 * `userRules: ""` …），服务层逐列写下去就把**用户没碰过的设置全部重置**了。
 *
 * 界面上的表现极具迷惑性：改一个索引开关，另一个索引开关自己关了、终端 shell 回到 auto、
 * 「规则与记忆」里的用户规则被清空——而且每一步都「保存成功」。
 *
 * 所以这里锁的是**路由交给服务层的那份 patch**：必须只含客户端真的送来的键。
 */
const FULL_SETTINGS = {
  defaultModel: "glm-5.3-flash",
  terminalShell: "git-bash" as const,
  codeIndexEnabled: true,
  codeIndexAutoNewFolder: true,
  userRules: "永远用中文回答",
  ruleEntries: ["不要动 .env"],
  agentMaxRetries: 10,
};

function buildRouteApp() {
  let received: unknown = null;
  const app = Fastify();
  registerSettingsRoutes(app, {
    auth: {
      authenticate: async () => ({
        accessToken: "tok",
        email: "u@example.com",
        id: "user-1",
        userMetadata: {},
      }),
      resolveUser: async () => null,
    } as never,
    viewerService: {
      ensureViewer: async () => ({ workspace: { id: "ws-1" } }),
    } as never,
    settingsService: {
      getWorkspaceSettings: async () => FULL_SETTINGS,
      updateWorkspaceSettings: async (
        _user: unknown,
        _workspaceId: string,
        patch: unknown,
      ) => {
        received = patch;
        return FULL_SETTINGS;
      },
    } as never,
  });
  return { app, received: () => received };
}

describe("PUT /api/workspace/settings（部分更新）", () => {
  it("只送一个键：交给服务层的 patch 也只有这一个键（不夹带默认值）", async () => {
    const { app, received } = buildRouteApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/workspace/settings",
        payload: { codeIndexAutoNewFolder: false },
      });
      expect(response.statusCode).toBe(200);
      expect(received()).toEqual({ codeIndexAutoNewFolder: false });
    } finally {
      await app.close();
    }
  });

  it("送模型与重试上限：同样不夹带其它设置（用户规则/终端/索引开关都不能被重置）", async () => {
    const { app, received } = buildRouteApp();
    try {
      await app.inject({
        method: "PUT",
        url: "/api/workspace/settings",
        payload: { defaultModel: "inst-1:glm-5.3-flash", agentMaxRetries: 3 },
      });
      expect(received()).toEqual({
        defaultModel: "inst-1:glm-5.3-flash",
        agentMaxRetries: 3,
      });
    } finally {
      await app.close();
    }
  });

  it("空对象：patch 也是空的（服务层一条都不写）", async () => {
    const { app, received } = buildRouteApp();
    try {
      await app.inject({
        method: "PUT",
        url: "/api/workspace/settings",
        payload: {},
      });
      expect(received()).toEqual({});
    } finally {
      await app.close();
    }
  });
});

describe("workspaceSettingsUpdateRequestSchema（默认值泄漏的根因）", () => {
  it("缺省的键不进结果——`.partial()` 之外的 `.default(...)` 必须被剥掉", () => {
    const parsed = workspaceSettingsUpdateRequestSchema.parse({
      codeIndexAutoNewFolder: false,
    });
    expect(Object.keys(parsed)).toEqual(["codeIndexAutoNewFolder"]);
    expect(parsed).not.toHaveProperty("codeIndexEnabled");
    expect(parsed).not.toHaveProperty("terminalShell");
    expect(parsed).not.toHaveProperty("userRules");
  });

  it("校验规则还在（不是把 schema 放松成 any）", () => {
    expect(
      workspaceSettingsUpdateRequestSchema.safeParse({ agentMaxRetries: 999 })
        .success,
    ).toBe(false);
    expect(
      workspaceSettingsUpdateRequestSchema.safeParse({ terminalShell: "nope" })
        .success,
    ).toBe(false);
    expect(
      workspaceSettingsUpdateRequestSchema.safeParse({ ruleEntries: [""] })
        .success,
    ).toBe(false);
  });
});
