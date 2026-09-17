import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import {
  createModelProviderService,
  ModelProviderServiceError,
} from "./model-provider-service.js";
import {
  createModelProviderRepository,
  type ProviderInstanceRecord,
} from "./repository.js";
import { decryptSecret } from "./secret-store.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";
const INSTANCE_ID = "instance-1";
const CREDENTIAL_SECRET = "test-credential-secret";

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
    async end() {},
  };

  return {
    calls,
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

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

const INSTANCE_ROW: ProviderInstanceRecord = {
  id: INSTANCE_ID,
  scope: "workspace",
  workspace_id: WORKSPACE_ID,
  name: "我的 OpenAI",
  protocol: "openai-compatible",
  base_url: "https://api.example.com/v1",
  encrypted_api_key: "v1:iv:tag:cipher",
  models: [{ id: "gpt-4.1", name: "GPT-4.1", capability: "chat" }],
  compat: { streamUsage: true },
  headers: null,
  enabled: true,
  config_revision: "1",
};

const SYSTEM_ROW: ProviderInstanceRecord = {
  ...INSTANCE_ROW,
  id: "system-1",
  scope: "system",
  workspace_id: null,
  name: "平台池 OpenAI",
};

function buildService(options: {
  rows?: unknown[];
  rowCount?: number;
  /** `null` = 显式模拟 worker 形态（不提供 viewer）。 */
  viewerService?: ViewerService | null | undefined;
  credentialSecret?: string | undefined;
}) {
  const runner = createRunner(() => ({
    rowCount: options.rowCount ?? options.rows?.length ?? 0,
    rows: options.rows ?? [],
  }));
  const repository = createModelProviderRepository(
    createPersistenceFromRunner(runner.runner),
  );

  return {
    calls: runner.calls,
    service: createModelProviderService({
      credentialEnv: {
        ...(options.credentialSecret === undefined
          ? { credentialSecret: CREDENTIAL_SECRET }
          : options.credentialSecret === ""
            ? {}
            : { credentialSecret: options.credentialSecret }),
      },
      repository,
      ...(options.viewerService === undefined
        ? { viewerService: VIEWER_STUB }
        : options.viewerService === null
          ? {}
          : { viewerService: options.viewerService }),
    }),
  };
}

describe("model-providers 服务（BYOK 凭证红线）", () => {
  it("列表按工作区 + scope='workspace' 限定，响应不含 Key", async () => {
    const { calls, service } = buildService({ rows: [INSTANCE_ROW] });
    const instances = await service.listInstances(USER);

    expect(instances).toEqual([
      {
        id: INSTANCE_ID,
        scope: "workspace",
        name: "我的 OpenAI",
        protocol: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        hasCredential: true,
        models: [{ id: "gpt-4.1", name: "GPT-4.1", capability: "chat" }],
        compat: { streamUsage: true },
        headerKeys: [],
        enabled: true,
      },
    ]);
    expect(JSON.stringify(instances)).not.toContain("cipher");

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("where workspace_id = $1 and scope = 'workspace'");
    expect(calls[0]?.values).toEqual([WORKSPACE_ID]);
  });

  it("创建写入加密后的 Key，明文不入库不入响应", async () => {
    const { calls, service } = buildService({
      rows: [INSTANCE_ROW],
      rowCount: 1,
    });
    await service.createInstance(USER, {
      apiKey: "sk-plaintext-secret",
      models: [{ id: "gpt-4.1", name: "GPT-4.1", capability: "chat" }],
      name: "我的 OpenAI",
      protocol: "openai-compatible",
    });

    const values = calls[0]?.values ?? [];
    const stored = String(values[3]);
    expect(stored).not.toContain("sk-plaintext-secret");
    expect(stored).toMatch(/^v1:/);
    // 密文可被同一密钥解回（SecretStore 往返）
    expect(decryptSecret({ credentialSecret: CREDENTIAL_SECRET }, stored)).toBe(
      "sk-plaintext-secret",
    );
    // 末位参数是工作区（:workspace 追加）
    expect(values.at(-1)).toBe(WORKSPACE_ID);
  });

  it("未配置凭证主密钥时创建即 fail loud", async () => {
    const { service } = buildService({ credentialSecret: "" });
    await expect(
      service.createInstance(USER, {
        apiKey: "k",
        models: [],
        name: "x",
        protocol: "anthropic",
      }),
    ).rejects.toMatchObject({ code: "credential_unavailable" });
  });

  it("更新只写显式字段；空补丁 400；未命中 404", async () => {
    const empty = buildService({ rows: [] });
    await expect(
      empty.service.updateInstance(USER, INSTANCE_ID, {}),
    ).rejects.toMatchObject({
      code: "instance_update_failed",
      statusCode: 400,
    });

    const miss = buildService({ rows: [] });
    await expect(
      miss.service.updateInstance(USER, INSTANCE_ID, { name: "新名" }),
    ).rejects.toMatchObject({ code: "instance_not_found", statusCode: 404 });

    const hit = buildService({ rows: [{ ...INSTANCE_ROW, name: "新名" }] });
    await hit.service.updateInstance(USER, INSTANCE_ID, { name: "新名" });
    const sql = hit.calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("config_revision = config_revision + 1");
    expect(sql).toContain("name = $2");
    expect(sql).toContain(
      "where workspace_id = $3 and id = $1 and scope = 'workspace'",
    );
  });

  it("更新 Key 时同样加密落库", async () => {
    const { calls, service } = buildService({ rows: [INSTANCE_ROW] });
    await service.updateInstance(USER, INSTANCE_ID, { apiKey: "sk-new" });

    const values = calls[0]?.values ?? [];
    expect(String(values[1])).toMatch(/^v1:/);
    expect(String(values[1])).not.toContain("sk-new");
  });

  it("删除是幂等操作：未命中不报错", async () => {
    const { service } = buildService({ rowCount: 0 });
    await expect(
      service.deleteInstance(USER, INSTANCE_ID),
    ).resolves.toBeUndefined();
  });

  it("凭证解析解密 Key；停用 409；不存在 404", async () => {
    const { encryptSecret } = await import("./secret-store.js");
    const enc = encryptSecret(
      { credentialSecret: CREDENTIAL_SECRET },
      "sk-live",
    );

    const ok = buildService({
      rows: [{ ...INSTANCE_ROW, encrypted_api_key: enc }],
    });
    await expect(
      ok.service.resolveCredentials(USER, INSTANCE_ID),
    ).resolves.toMatchObject({ apiKey: "sk-live", instanceId: INSTANCE_ID });

    // 解析结果仍不含密文
    const resolved = await ok.service.resolveCredentials(USER, INSTANCE_ID);
    expect(JSON.stringify(resolved)).not.toContain("v1:");

    const disabled = buildService({
      rows: [{ ...INSTANCE_ROW, enabled: false, encrypted_api_key: enc }],
    });
    await expect(
      disabled.service.resolveCredentials(USER, INSTANCE_ID),
    ).rejects.toMatchObject({
      code: "credential_unavailable",
      statusCode: 409,
    });

    const missing = buildService({ rows: [] });
    await expect(
      missing.service.resolveCredentials(USER, INSTANCE_ID),
    ).rejects.toMatchObject({ code: "instance_not_found", statusCode: 404 });
  });

  it("工作区未命中时回退到平台池（scope='system'）：平台池模型选得中", async () => {
    const { encryptSecret } = await import("./secret-store.js");
    const enc = encryptSecret(
      { credentialSecret: CREDENTIAL_SECRET },
      "sk-pool",
    );
    const runner = createRunner((text) =>
      // 工作区查询为空；按 id 的查询返回系统池实例
      text.includes("scope = 'workspace'")
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ ...SYSTEM_ROW, encrypted_api_key: enc }] },
    );
    const service = createModelProviderService({
      credentialEnv: { credentialSecret: CREDENTIAL_SECRET },
      repository: createModelProviderRepository(
        createPersistenceFromRunner(runner.runner),
      ),
      viewerService: VIEWER_STUB,
    });

    await expect(
      service.resolveCredentials(USER, SYSTEM_ROW.id),
    ).resolves.toMatchObject({
      instanceId: SYSTEM_ROW.id,
      apiKey: "sk-pool",
    });
  });

  it("回退**只接受** system 作用域：别人的工作区实例仍然 404（隔离不放宽）", async () => {
    const { encryptSecret } = await import("./secret-store.js");
    const enc = encryptSecret(
      { credentialSecret: CREDENTIAL_SECRET },
      "sk-other",
    );
    const runner = createRunner((text) =>
      text.includes("scope = 'workspace'")
        ? { rowCount: 0, rows: [] }
        : {
            rowCount: 1,
            // 按 id 查到了，但它是**另一个工作区**的实例
            rows: [
              {
                ...INSTANCE_ROW,
                workspace_id: "other-workspace",
                encrypted_api_key: enc,
              },
            ],
          },
    );
    const service = createModelProviderService({
      credentialEnv: { credentialSecret: CREDENTIAL_SECRET },
      repository: createModelProviderRepository(
        createPersistenceFromRunner(runner.runner),
      ),
      viewerService: VIEWER_STUB,
    });

    await expect(
      service.resolveCredentials(USER, INSTANCE_ID),
    ).rejects.toMatchObject({ code: "instance_not_found", statusCode: 404 });
  });

  it("resolveCredentialsById 按 id 取（不做工作区限定），供 worker 使用", async () => {
    const { encryptSecret } = await import("./secret-store.js");
    const enc = encryptSecret(
      { credentialSecret: CREDENTIAL_SECRET },
      "sk-worker",
    );
    const { calls, service } = buildService({
      rows: [{ ...INSTANCE_ROW, encrypted_api_key: enc }],
    });

    const resolved = await service.resolveCredentialsById(INSTANCE_ID);
    expect(resolved.apiKey).toBe("sk-worker");

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("where id = $1");
    expect(sql).not.toContain("where workspace_id");
  });

  it("平台池实例：列表/创建/更新/删除都按 scope='system' 限定", async () => {
    const list = buildService({ rows: [SYSTEM_ROW] });
    await expect(list.service.listSystemInstances()).resolves.toMatchObject([
      { id: "system-1", scope: "system", name: "平台池 OpenAI" },
    ]);
    expect(list.calls[0]?.text.replace(/\s+/g, " ").trim()).toContain(
      "where scope = 'system'",
    );

    const create = buildService({ rows: [SYSTEM_ROW] });
    await create.service.createSystemInstance(
      {
        apiKey: "sk-pool",
        models: [],
        name: "平台池",
        protocol: "openai-compatible",
      },
      "admin-1",
    );
    expect(create.calls[0]?.text.replace(/\s+/g, " ").trim()).toContain(
      "values (null, 'system'",
    );
    expect(create.calls[0]?.values.at(-1)).toBe("admin-1");

    const update = buildService({ rows: [SYSTEM_ROW] });
    await update.service.updateSystemInstance("system-1", { enabled: false });
    expect(update.calls[0]?.text.replace(/\s+/g, " ").trim()).toContain(
      "where id = $1 and scope = 'system'",
    );

    const remove = buildService({ rowCount: 0 });
    await expect(
      remove.service.deleteSystemInstance("system-1"),
    ).resolves.toBeUndefined();
  });

  it("getInstanceScope 区分平台池与工作区；不存在返回 null", async () => {
    const system = buildService({ rows: [SYSTEM_ROW] });
    await expect(system.service.getInstanceScope("system-1")).resolves.toBe(
      "system",
    );

    const workspace = buildService({ rows: [INSTANCE_ROW] });
    await expect(workspace.service.getInstanceScope(INSTANCE_ID)).resolves.toBe(
      "workspace",
    );

    const missing = buildService({ rows: [] });
    await expect(missing.service.getInstanceScope("ghost")).resolves.toBeNull();
  });

  it("worker 形态（无 viewer）：工作区方法 fail loud，系统方法照常", async () => {
    const { service } = buildService({
      rows: [SYSTEM_ROW],
      viewerService: null,
    });

    const error = await service.listInstances(USER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelProviderServiceError);
    expect(error).toMatchObject({ code: "instance_query_failed" });

    await expect(service.listSystemInstances()).resolves.toMatchObject([
      { scope: "system" },
    ]);
  });
});

describe("model-providers 自定义请求头（§4.8，R6-1）", () => {
  const HEADERS = {
    "x-opencode-session": "{{sessionId}}",
    "x-tenant-id": "ws-42",
  };

  it("创建携带 headers：整批落库为 jsonb，响应只回键名", async () => {
    const { calls, service } = buildService({
      rows: [{ ...INSTANCE_ROW, headers: HEADERS }],
      rowCount: 1,
    });

    const created = await service.createInstance(USER, {
      apiKey: "sk-x",
      models: [{ id: "gpt-4.1", name: "GPT-4.1", capability: "chat" }],
      name: "opencode",
      protocol: "openai-compatible",
      headers: HEADERS,
    });

    expect(created.headerKeys).toEqual(["x-opencode-session", "x-tenant-id"]);
    // 响应体里没有值，只有键名
    expect(JSON.stringify(created)).not.toContain("{{sessionId}}");
    expect(JSON.stringify(created)).not.toContain("ws-42");

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("headers");
    const stored = (calls[0]?.values ?? []).find(
      (value) => typeof value === "string" && value.includes("x-opencode"),
    );
    expect(JSON.parse(String(stored))).toEqual(HEADERS);
  });

  it("更新 headers 为 {}：整体清空（而非忽略）", async () => {
    const { calls, service } = buildService({
      rows: [{ ...INSTANCE_ROW, headers: null }],
    });

    const updated = await service.updateInstance(USER, INSTANCE_ID, {
      headers: {},
    });

    expect(updated.headerKeys).toEqual([]);
    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("headers = $2::jsonb");
    expect(calls[0]?.values[1]).toBe("{}");
  });

  it("凭证解析带出 headers 原值（含占位符）——渲染在适配器调用点完成", async () => {
    const { encryptSecret } = await import("./secret-store.js");
    const enc = encryptSecret(
      { credentialSecret: CREDENTIAL_SECRET },
      "sk-live",
    );
    const { service } = buildService({
      rows: [{ ...INSTANCE_ROW, encrypted_api_key: enc, headers: HEADERS }],
    });

    const resolved = await service.resolveCredentials(USER, INSTANCE_ID);
    expect(resolved.headers).toEqual(HEADERS);
    // 键名可回，但解析结果属于「只进适配器」通道：不落日志、不进响应
    expect(resolved.apiKey).toBe("sk-live");
  });

  it("平台池实例（scope='system'）同样支持自定义头：整批落库、只回键名", async () => {
    const { calls, service } = buildService({
      rows: [{ ...SYSTEM_ROW, headers: HEADERS }],
      rowCount: 1,
    });

    const created = await service.createSystemInstance(
      {
        apiKey: "sk-pool",
        models: [{ id: "gpt-4.1", name: "GPT-4.1", capability: "chat" }],
        name: "平台池 opencode",
        protocol: "openai-compatible",
        headers: HEADERS,
      },
      "admin-1",
    );

    expect(created.headerKeys).toEqual(["x-opencode-session", "x-tenant-id"]);
    expect(JSON.stringify(created)).not.toContain("ws-42");

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("values (null, 'system'");
    expect(sql).toContain("headers");
    const stored = (calls[0]?.values ?? []).find(
      (value) => typeof value === "string" && value.includes("x-opencode"),
    );
    expect(JSON.parse(String(stored))).toEqual(HEADERS);
  });

  it("未设置 headers 的实例：凭证不含 headers 字段，响应 headerKeys 为空", async () => {
    const { encryptSecret } = await import("./secret-store.js");
    const { service } = buildService({
      rows: [
        {
          ...INSTANCE_ROW,
          encrypted_api_key: encryptSecret(
            { credentialSecret: CREDENTIAL_SECRET },
            "sk-live",
          ),
        },
      ],
    });

    const [instance] = await service.listInstances(USER);
    expect(instance?.headerKeys).toEqual([]);
    await expect(
      service.resolveCredentials(USER, INSTANCE_ID),
    ).resolves.not.toHaveProperty("headers");
  });
});
