import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  providerCompatSchema,
  providerInstanceCreateRequestSchema,
  providerInstanceHeadersSchema,
  providerInstanceModelSchema,
  providerInstanceResponseSchema,
  providerInstanceUpdateRequestSchema,
} from "@kenfutwork/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalInstanceService } from "../local-instance/service.js";
import type { LocalActor } from "../local-instance/types.js";
import { createLocalCredentialStore } from "./local-credential-store.js";
import { createModelCatalogService } from "./model-catalog-service.js";
import { createModelProviderService } from "./model-provider-service.js";
import type {
  ModelProviderRepository,
  NewProviderInstance,
  ProviderInstanceRecord,
} from "./repository.js";

const LOCAL_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR: LocalActor = { instanceId: LOCAL_ID, accessClientId: "desktop" };
const directories: string[] = [];

function createRepository() {
  const rows = new Map<string, ProviderInstanceRecord>();
  const insertions: NewProviderInstance[] = [];
  const find = (instanceId: string, providerId: string) => {
    const row = rows.get(providerId);
    return row?.instance_id === instanceId ? row : null;
  };
  const repository: ModelProviderRepository = {
    async listInstances(instanceId) {
      return [...rows.values()].filter((row) => row.instance_id === instanceId);
    },
    async findInstance(instanceId, providerId) {
      return find(instanceId, providerId);
    },
    async insertInstance(input) {
      insertions.push(input);
      const row: ProviderInstanceRecord = {
        id: input.id,
        instance_id: input.instanceId,
        name: input.name,
        protocol: input.protocol,
        base_url: input.baseUrl ?? null,
        api_key_ref: input.apiKeyRef,
        models: providerInstanceModelSchema.array().parse(input.models),
        compat: input.compat ?? null,
        headers: input.headers ?? null,
        enabled: input.enabled,
        config_revision: "1",
        probe_result: null,
        probed_at: null,
      };
      rows.set(input.id, row);
      return row;
    },
    async updateInstance(instanceId, providerId, patch, expectedRevision) {
      const row = find(instanceId, providerId);
      if (
        !row ||
        (expectedRevision !== undefined &&
          Number(row.config_revision) !== expectedRevision)
      ) {
        return null;
      }
      const next = {
        ...row,
        config_revision: String(Number(row.config_revision) + 1),
      };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.protocol !== undefined) next.protocol = patch.protocol;
      if (patch.base_url !== undefined) next.base_url = patch.base_url;
      if (patch.api_key_ref !== undefined) next.api_key_ref = patch.api_key_ref;
      if (patch.models !== undefined)
        next.models = providerInstanceModelSchema.array().parse(patch.models);
      if (patch.compat !== undefined)
        next.compat = providerCompatSchema.parse(patch.compat);
      if (patch.headers !== undefined)
        next.headers = providerInstanceHeadersSchema.parse(patch.headers);
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      rows.set(providerId, next);
      return next;
    },
    async deleteInstance(instanceId, providerId) {
      if (!find(instanceId, providerId)) return 0;
      rows.delete(providerId);
      return 1;
    },
    async setProbeResult(instanceId, providerId, result) {
      const row = find(instanceId, providerId);
      if (!row) return null;
      const next = {
        ...row,
        probe_result: result,
        probed_at: String(result.probedAt),
      };
      rows.set(providerId, next);
      return next;
    },
  };
  return { repository, rows, insertions };
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "kenfutwork-providers-"));
  directories.push(dataDir);
  const state = createRepository();
  const localInstance = createLocalInstanceService({
    repository: { ensure: async () => LOCAL_ID },
    dataDir,
  });
  const service = createModelProviderService({
    repository: state.repository,
    localInstance,
  });
  return {
    ...state,
    dataDir,
    localInstance,
    service,
    credentials: createLocalCredentialStore(dataDir),
    filePath: join(dataDir, "credentials", "byok.json"),
  };
}

const INPUT = providerInstanceCreateRequestSchema.parse({
  name: "本地网关",
  protocol: "openai-compatible",
  baseUrl: "https://example.test/v1",
  apiKey: "plaintext-provider-key",
  models: [{ id: "gpt-x", name: "GPT X", capability: "chat" }],
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("modelProviders（本地实例 BYOK）", () => {
  it("创建保存真实明文文件，数据库与普通响应只有凭据引用", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    expect(created).toMatchObject({
      scope: "local",
      hasCredential: true,
      configRevision: 1,
    });
    expect(JSON.parse(await readFile(context.filePath, "utf8"))).toEqual({
      [created.id]: INPUT.apiKey,
    });
    expect(context.rows.get(created.id)?.api_key_ref).toBe(created.id);
    expect(JSON.stringify(context.insertions)).not.toContain(INPUT.apiKey);
    expect(JSON.stringify(created)).not.toContain(INPUT.apiKey);
    expect(providerInstanceResponseSchema.parse(created)).toEqual(created);
    expect(await context.service.readCredential(ACTOR, created.id)).toBe(
      INPUT.apiKey,
    );
  });

  it("原设置可保存无 Key 的空模型草稿，缺凭据运行显示可读原因", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, {
      name: "草稿",
      protocol: "anthropic",
      models: [],
    });
    expect(created).toMatchObject({
      hasCredential: false,
      models: [],
      configRevision: 1,
    });
    expect(context.rows.get(created.id)?.api_key_ref).toBeNull();
    expect(await context.service.readCredential(ACTOR, created.id)).toBeNull();
    await expect(
      context.service.resolveCredentials(ACTOR, created.id),
    ).rejects.toMatchObject({
      code: "credential_unavailable",
      statusCode: 409,
    });
  });

  it("重启服务后从同一数据目录读取 Key，另一接入客户端共享同一供应商", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    const restarted = createModelProviderService({
      repository: context.repository,
      localInstance: createLocalInstanceService({
        repository: { ensure: async () => LOCAL_ID },
        dataDir: context.dataDir,
      }),
    });
    const browser: LocalActor = {
      instanceId: LOCAL_ID,
      accessClientId: "browser",
    };
    expect(await restarted.listInstances(browser)).toEqual([created]);
    expect(await restarted.readCredential(browser, created.id)).toBe(
      INPUT.apiKey,
    );
    expect(await restarted.resolveCredentialsById(created.id)).toMatchObject({
      apiKey: INPUT.apiKey,
      configRevision: 1,
    });
  });

  it("原模型配置的能力、原生参数与显式 false 保存读取不变，目录不含 Key", async () => {
    const context = await fixture();
    const models = [
      {
        id: "native-model",
        name: "原生模型",
        capability: "chat" as const,
        vision: false,
        enabled: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        reasoningEfforts: ["low", "high"],
        inputModalities: ["text", "pdf"],
        structuredOutput: false,
        nativeWebSearch: true,
        systemMessage: false,
        extraBody: { thinking: { type: "enabled" } },
        imageGeneration: { requirePrompt: false, maxInputImages: 0 },
        videoGeneration: { audio: false, durations: [5] },
      },
    ];
    const created = await context.service.createInstance(ACTOR, {
      ...INPUT,
      models,
    });
    expect(created.models).toEqual(models);
    expect(
      (await context.service.resolveCredentials(ACTOR, created.id)).models,
    ).toEqual(models);
    const catalog = createModelCatalogService({
      modelProviders: context.service,
      localInstance: context.localInstance,
    });
    const snapshot = await catalog.listCatalog(ACTOR);
    expect(snapshot[0]?.model).toEqual(models[0]);
    expect(snapshot[0]?.provider.scope).toBe("local");
    expect(JSON.stringify(snapshot)).not.toContain(INPUT.apiKey);
    expect(JSON.stringify(snapshot)).not.toContain("apiKey");
  });

  it("省略 Key 不修改文件；null 真正清除，且可同时变更协议", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    const previous = await readFile(context.filePath, "utf8");
    const renamed = await context.service.updateInstance(ACTOR, created.id, {
      name: "改名",
      expectedRevision: 1,
    });
    expect(renamed).toMatchObject({
      name: "改名",
      hasCredential: true,
      configRevision: 2,
    });
    expect(await readFile(context.filePath, "utf8")).toBe(previous);
    const cleared = await context.service.updateInstance(
      ACTOR,
      created.id,
      providerInstanceUpdateRequestSchema.parse({
        apiKey: null,
        protocol: "anthropic",
        expectedRevision: 2,
      }),
    );
    expect(cleared).toMatchObject({
      protocol: "anthropic",
      hasCredential: false,
      configRevision: 3,
    });
    expect(await context.credentials.get(created.id)).toBeNull();
    expect(await context.service.readCredential(ACTOR, created.id)).toBeNull();
    await expect(
      context.service.resolveCredentials(ACTOR, created.id),
    ).rejects.toMatchObject({ code: "credential_unavailable" });
  });

  it("空字符串与空补丁拒绝，不能被当作清除 Key", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    await expect(
      context.service.updateInstance(ACTOR, created.id, { apiKey: "" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      context.service.updateInstance(ACTOR, created.id, {}),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await context.service.readCredential(ACTOR, created.id)).toBe(
      INPUT.apiKey,
    );
  });

  it("Key 与数据库 CAS 同修订并发仅一赢家，失败者不能覆盖已提交 Key", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    const keys = ["concurrent-a", "concurrent-b"];
    const results = await Promise.allSettled(
      keys.map((apiKey) =>
        context.service.updateInstance(ACTOR, created.id, {
          apiKey,
          expectedRevision: 1,
        }),
      ),
    );
    const winners = results.flatMap((result, index) =>
      result.status === "fulfilled" ? [index] : [],
    );
    expect(winners).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected")
      throw new Error("CAS 必须有冲突回执。");
    expect(rejected.reason).toMatchObject({
      code: "instance_revision_conflict",
      statusCode: 409,
    });
    expect(await context.service.readCredential(ACTOR, created.id)).toBe(
      keys[winners[0] ?? -1],
    );
    expect(
      (await context.service.listInstances(ACTOR))[0]?.configRevision,
    ).toBe(2);
  });

  it("旧修订冲突及缺失供应商精确回滚文件，区分 409 与 404", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    await context.service.updateInstance(ACTOR, created.id, {
      name: "新配置",
      expectedRevision: 1,
    });
    const previous = await readFile(context.filePath, "utf8");
    await expect(
      context.service.updateInstance(ACTOR, created.id, {
        apiKey: "stale",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "instance_revision_conflict",
      statusCode: 409,
    });
    await expect(
      context.service.updateInstance(ACTOR, "missing", {
        apiKey: "orphan",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "instance_not_found", statusCode: 404 });
    expect(await readFile(context.filePath, "utf8")).toBe(previous);
    expect(await context.credentials.get("missing")).toBeNull();
  });

  it("数据库失败在释放串行门前回滚，随后成功更新可继续", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    const failure = new Error("数据库提交失败");
    vi.spyOn(context.repository, "updateInstance").mockRejectedValueOnce(
      failure,
    );
    const attempt = context.service.updateInstance(ACTOR, created.id, {
      apiKey: "failed-key",
      expectedRevision: 1,
    });
    const rejection = expect(attempt).rejects.toBe(failure);
    const success = context.service.updateInstance(ACTOR, created.id, {
      apiKey: "committed-key",
      expectedRevision: 1,
    });
    await rejection;
    expect(await success).toMatchObject({
      configRevision: 2,
      hasCredential: true,
    });
    expect(await context.credentials.get(created.id)).toBe("committed-key");
  });

  it("数据库创建失败不会遗留孤立 Key，原文件不存在仍保持不存在", async () => {
    const context = await fixture();
    const failure = new Error("数据库拒绝创建");
    vi.spyOn(context.repository, "insertInstance").mockRejectedValueOnce(
      failure,
    );
    await expect(context.service.createInstance(ACTOR, INPUT)).rejects.toBe(
      failure,
    );
    expect(context.rows.size).toBe(0);
    await expect(readFile(context.filePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("数据库删除失败恢复 Key；成功删除及重复删除幂等", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    const failure = new Error("数据库拒绝删除");
    vi.spyOn(context.repository, "deleteInstance").mockRejectedValueOnce(
      failure,
    );
    await expect(
      context.service.deleteInstance(ACTOR, created.id),
    ).rejects.toBe(failure);
    expect(await context.service.readCredential(ACTOR, created.id)).toBe(
      INPUT.apiKey,
    );
    await context.service.deleteInstance(ACTOR, created.id);
    await context.service.deleteInstance(ACTOR, created.id);
    expect(await context.credentials.get(created.id)).toBeNull();
    expect(await context.service.listInstances(ACTOR)).toEqual([]);
  });

  it("停用供应商可在授权设置读 Key，但运行拒绝；后台不能读取其他实例", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, {
      ...INPUT,
      enabled: false,
    });
    expect(await context.service.readCredential(ACTOR, created.id)).toBe(
      INPUT.apiKey,
    );
    await expect(
      context.service.resolveCredentialsById(created.id),
    ).rejects.toMatchObject({
      code: "credential_unavailable",
      statusCode: 409,
    });
    const row = context.rows.get(created.id);
    if (!row) throw new Error("供应商夹具未创建。");
    context.rows.set(created.id, {
      ...row,
      instance_id: "foreign-instance",
      enabled: true,
    });
    await expect(
      context.service.resolveCredentialsById(created.id),
    ).rejects.toMatchObject({ code: "instance_not_found", statusCode: 404 });
  });

  it("伪造实例 Actor 在数据库和明文读取前被拒绝，不依赖客户端身份定权", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    const actor: LocalActor = {
      instanceId: "foreign-instance",
      accessClientId: ACTOR.accessClientId,
    };
    const lookup = vi.spyOn(context.repository, "findInstance");
    await expect(
      context.service.readCredential(actor, created.id),
    ).rejects.toMatchObject({ code: "instance_forbidden", statusCode: 403 });
    await expect(
      context.service.updateInstance(actor, created.id, {
        apiKey: "foreign-key",
      }),
    ).rejects.toMatchObject({ code: "instance_forbidden" });
    await expect(context.service.listInstances(actor)).rejects.toMatchObject({
      code: "instance_forbidden",
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(await context.service.readCredential(ACTOR, created.id)).toBe(
      INPUT.apiKey,
    );
  });

  it("凭据文件损坏与磁盘错误明确失败，不伪装成认证或缺 Key", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    await writeFile(context.filePath, '{"broken":"private-key"');
    await expect(
      context.service.resolveCredentials(ACTOR, created.id),
    ).rejects.toThrow(/有效 JSON/);
    await expect(
      context.service.readCredential(ACTOR, created.id),
    ).rejects.toThrow(/有效 JSON/);
    await rm(join(context.dataDir, "credentials"), { recursive: true });
    await writeFile(join(context.dataDir, "credentials"), "disk-obstruction");
    await expect(
      context.service.readCredential(ACTOR, created.id),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("文件缺 Key 时运行 fail loud，授权设置可识别凭据未恢复", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    await rm(context.filePath);
    expect(await context.service.readCredential(ACTOR, created.id)).toBeNull();
    await expect(
      context.service.resolveCredentialsById(created.id),
    ).rejects.toMatchObject({
      code: "credential_unavailable",
      statusCode: 409,
    });
  });

  it("显式 completions/responses 方言与探测值都保留，包括 false", async () => {
    for (const chatApi of ["responses", "completions"] as const) {
      const context = await fixture();
      const created = await context.service.createInstance(ACTOR, {
        ...INPUT,
        compat: { chatApi },
      });
      await context.repository.setProbeResult(LOCAL_ID, created.id, {
        responsesApi: true,
      });
      expect(
        await context.service.resolveCredentials(ACTOR, created.id),
      ).toMatchObject({
        useResponsesApi: chatApi === "responses",
        responsesApi: true,
      });
    }
  });

  it("空模型草稿与停用聊天模型不伪造探测模型，也不发送请求", async () => {
    for (const models of [
      [],
      [
        {
          id: "off",
          name: "停用",
          capability: "chat" as const,
          enabled: false,
        },
      ],
    ]) {
      const context = await fixture();
      const created = await context.service.createInstance(ACTOR, {
        ...INPUT,
        models,
      });
      const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
      await expect(
        context.service.probeInstance(ACTOR, created.id, fetchFn),
      ).rejects.toMatchObject({
        code: "instance_model_unavailable",
        statusCode: 409,
      });
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });
});

describe("本地供应商自定义请求头", () => {
  it("创建及解析保留头原文，普通响应仅回键名；更新 {} 真正清空", async () => {
    const context = await fixture();
    const headers = {
      "x-session": "{{sessionId}}",
      "x-custom": "private-header",
    };
    const created = await context.service.createInstance(ACTOR, {
      ...INPUT,
      headers,
    });
    expect(context.rows.get(created.id)?.headers).toEqual(headers);
    expect(created.headerKeys).toEqual(Object.keys(headers));
    expect(JSON.stringify(created)).not.toContain("private-header");
    expect(
      (await context.service.resolveCredentials(ACTOR, created.id)).headers,
    ).toEqual(headers);
    const cleared = await context.service.updateInstance(ACTOR, created.id, {
      headers: {},
    });
    expect(cleared.headerKeys).toEqual([]);
    expect(
      (await context.service.resolveCredentials(ACTOR, created.id)).headers,
    ).toEqual({});
  });

  it("未声明自定义头时解析不添加字段，模型目录不含头值", async () => {
    const context = await fixture();
    const created = await context.service.createInstance(ACTOR, INPUT);
    expect(created.headerKeys).toEqual([]);
    expect(
      await context.service.resolveCredentials(ACTOR, created.id),
    ).not.toHaveProperty("headers");
  });
});
