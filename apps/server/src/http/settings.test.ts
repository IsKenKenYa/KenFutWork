import {
  instanceSettingsSchema,
  instanceSettingsUpdateRequestSchema,
} from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createLocalInstanceService } from "../features/local-instance/service.js";
import type { LocalActor } from "../features/local-instance/types.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../features/persistence/providers/postgres.js";
import { createSettingsRepository } from "../features/settings/repository.js";
import { createSettingsService } from "../features/settings/settings-service.js";
import { registerSettingsRoutes } from "./settings.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR: LocalActor = {
  instanceId: INSTANCE_ID,
  accessClientId: "desktop",
};
const FULL_SETTINGS = instanceSettingsSchema.parse({
  modelDefaults: {
    chat: null,
    image: { mode: "auto" },
    video: { mode: "auto" },
  },
  defaultModel: "glm-5.3-flash",
  terminalShell: "git-bash",
  codeIndexEnabled: true,
  codeIndexAutoNewFolder: true,
  userRules: "永远用中文回答",
  ruleEntries: ["不要动 .env"],
  agentMaxRetries: 10,
});

/** 真正的服务/仓储由可变 SQL 夹具支撑，验证 PATCH 后 GET 读到的实际设置。 */
function buildRouteApp() {
  const stored: Record<string, unknown> = {
    default_model: FULL_SETTINGS.defaultModel,
    terminal_shell: FULL_SETTINGS.terminalShell,
    code_index_enabled: FULL_SETTINGS.codeIndexEnabled,
    code_index_auto_new_folder: FULL_SETTINGS.codeIndexAutoNewFolder,
    user_rules: FULL_SETTINGS.userRules,
    rule_entries: FULL_SETTINGS.ruleEntries,
    agent_max_retries: FULL_SETTINGS.agentMaxRetries,
    runtime_governance: {},
  };
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const query: PostgresQueryRunner["query"] = async (sql, values) => {
    if (sql.trimStart().startsWith("insert")) {
      const column = sql.match(/\(instance_id,\s*([a-z_]+)\)/)?.[1];
      if (!column || values.at(-1) !== INSTANCE_ID)
        throw new Error("设置写入未绑定真实实例。");
      writes.push({ sql, values });
      const value = sql.includes("$1::jsonb")
        ? JSON.parse(String(values[0]))
        : values[0];
      if (column === "runtime_governance") {
        stored[column] = { ...Object(stored[column]), ...value };
      } else stored[column] = value;
    }
    return {
      rowCount: 1,
      rows: values.at(-1) === INSTANCE_ID ? [{ ...stored }] : [],
    };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("设置夹具不建立任务宿主会话。");
    },
    end: async () => {},
  };
  const localInstance = createLocalInstanceService({
    repository: { ensure: async () => INSTANCE_ID },
    dataDir: "/tmp/settings-http-test",
  });
  const service = createSettingsService({
    repository: createSettingsRepository(createPersistenceFromRunner(runner)),
    localInstance,
  });
  const update = vi.spyOn(service, "updateInstanceSettings");
  let actor: LocalActor | null = ACTOR;
  const validateSpecifier = vi.fn(
    async (_actor: LocalActor, specifier: string) =>
      specifier === "glm-5.3-flash" || specifier === "inst-1:glm-5.3-flash"
        ? { ok: true as const }
        : { ok: false as const, message: "模型不在当前本地实例目录。" },
  );
  const app = Fastify();
  void registerSettingsRoutes(app, {
    localAccess: { authenticate: async () => actor },
    localInstance,
    settingsService: service,
    modelCatalog: { validateSpecifier },
  });
  return {
    app,
    update,
    writes,
    validateSpecifier,
    setActor: (value: LocalActor | null) => {
      actor = value;
    },
  };
}

describe("GET/PATCH /api/instance/settings", () => {
  it("只送一个键只改该键，随后 GET 保留终端、规则及其他开关", async () => {
    const { app, update } = buildRouteApp();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/instance/settings",
        payload: { codeIndexAutoNewFolder: false },
      });
      expect(response.statusCode).toBe(200);
      expect(update.mock.calls[0]).toEqual([
        ACTOR,
        INSTANCE_ID,
        { codeIndexAutoNewFolder: false },
      ]);
      const read = await app.inject({
        method: "GET",
        url: "/api/instance/settings",
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().settings).toEqual({
        ...FULL_SETTINGS,
        codeIndexAutoNewFolder: false,
      });
    } finally {
      await app.close();
    }
  });

  it("模型与重试上限真实保存，不夹带默认值；空 PATCH 不写任何列", async () => {
    const { app, update, writes, validateSpecifier } = buildRouteApp();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/instance/settings",
        payload: { defaultModel: "inst-1:glm-5.3-flash", agentMaxRetries: 3 },
      });
      expect(response.statusCode).toBe(200);
      expect(update.mock.calls[0]?.[2]).toEqual({
        defaultModel: "inst-1:glm-5.3-flash",
        agentMaxRetries: 3,
      });
      expect(validateSpecifier).toHaveBeenCalledWith(
        ACTOR,
        "inst-1:glm-5.3-flash",
      );
      const previousWrites = writes.length;
      const empty = await app.inject({
        method: "PATCH",
        url: "/api/instance/settings",
        payload: {},
      });
      expect(empty.statusCode).toBe(200);
      expect(update.mock.calls.at(-1)?.[2]).toEqual({});
      expect(writes).toHaveLength(previousWrites);
      expect(empty.json().settings).toEqual({
        ...FULL_SETTINGS,
        defaultModel: "inst-1:glm-5.3-flash",
        agentMaxRetries: 3,
      });
    } finally {
      await app.close();
    }
  });

  it("body 中的实例或账户归属不能替换真实调用上下文", async () => {
    const { app, update, writes } = buildRouteApp();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/instance/settings",
        payload: {
          instanceId: "foreign",
          workspaceId: "foreign",
          userId: "foreign",
          codeIndexEnabled: false,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(update.mock.calls[0]).toEqual([
        ACTOR,
        INSTANCE_ID,
        { codeIndexEnabled: false },
      ]);
      expect(writes.every((write) => write.values.at(-1) === INSTANCE_ID)).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it("缺失接入凭据与伪造实例拒绝，不能写入或观察模型目录", async () => {
    const { app, setActor, update, validateSpecifier } = buildRouteApp();
    try {
      setActor(null);
      expect(
        (await app.inject({ method: "GET", url: "/api/instance/settings" }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/instance/settings",
            payload: { defaultModel: "glm-5.3-flash" },
          })
        ).statusCode,
      ).toBe(401);
      setActor({ instanceId: "foreign", accessClientId: "desktop" });
      const response = await app.inject({
        method: "PATCH",
        url: "/api/instance/settings",
        payload: { defaultModel: "glm-5.3-flash" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("instance_forbidden");
      expect(update).not.toHaveBeenCalled();
      expect(validateSpecifier).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("不存在的默认模型及非法设置返回 400，真实设置不变", async () => {
    const { app, update, writes } = buildRouteApp();
    try {
      const invalidModel = await app.inject({
        method: "PATCH",
        url: "/api/instance/settings",
        payload: { defaultModel: "missing" },
      });
      expect(invalidModel.statusCode).toBe(400);
      expect(invalidModel.json().error.code).toBe("invalid_model");
      const invalidSettings = await app.inject({
        method: "PATCH",
        url: "/api/instance/settings",
        payload: { terminalShell: "invalid" },
      });
      expect(invalidSettings.statusCode).toBe(400);
      expect(update).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      expect(
        (
          await app.inject({ method: "GET", url: "/api/instance/settings" })
        ).json().settings,
      ).toEqual(FULL_SETTINGS);
    } finally {
      await app.close();
    }
  });

  it("旧 URI 和新 URI 的 PUT 已退役", async () => {
    const { app } = buildRouteApp();
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/workspace/settings" }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/instance/settings",
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("实例设置 PATCH 契约", () => {
  it("省略字段不夹带 schema 默认值，校验仍生效", () => {
    const parsed = instanceSettingsUpdateRequestSchema.parse({
      codeIndexAutoNewFolder: false,
    });
    expect(parsed).toEqual({ codeIndexAutoNewFolder: false });
    expect(
      instanceSettingsUpdateRequestSchema.safeParse({ agentMaxRetries: 999 })
        .success,
    ).toBe(false);
    expect(
      instanceSettingsUpdateRequestSchema.safeParse({ terminalShell: "nope" })
        .success,
    ).toBe(false);
    expect(
      instanceSettingsUpdateRequestSchema.safeParse({ ruleEntries: [""] })
        .success,
    ).toBe(false);
  });
});
