import { randomUUID } from "node:crypto";
import {
  instanceSettingsSchema,
  type ProviderInstanceResponse,
  providerInstanceCreateRequestSchema,
  providerInstanceResponseSchema,
  providerInstanceUpdateRequestSchema,
} from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import type { LocalActor } from "../local-instance/types.js";
import {
  type CodeUiProviderSettingsRpcDeps,
  createCodeUiProviderSettingsRpc,
} from "./provider-settings-rpc.js";
import { CodeUiRepositoryError } from "./repository.js";

const actor: LocalActor = { instanceId: randomUUID(), accessClientId: null };
const foreign: LocalActor = { ...actor, instanceId: randomUUID() };

it("原Root省略模型查询参数经过HTTP序列化后仍能读取默认模型view，畸形对象仍拒绝", async () => {
  const { rpc } = fixture();
  const omitted = await rpc.call(actor, "modelSelectionService", "getView", []);
  // 原ServiceProxy保留方法参数位置，JSON把显式undefined编码成null。
  const transported = JSON.parse(JSON.stringify([undefined]));
  expect(
    await rpc.call(actor, "modelSelectionService", "getView", transported),
  ).toEqual(omitted);
  await expect(
    rpc.call(actor, "modelSelectionService", "getView", [{}]),
  ).rejects.toThrow();
});

function fixture() {
  const rows = new Map<string, ProviderInstanceResponse[]>();
  const preferences = new Map<string, Record<string, unknown>>();
  const credentials = new Map<string, string>();
  const own = (user: LocalActor) => rows.get(user.instanceId) ?? [];
  const createInstance = vi.fn(async (user: LocalActor, input: unknown) => {
    const parsed = providerInstanceCreateRequestSchema.parse(input);
    const id = randomUUID();
    if (parsed.apiKey) credentials.set(id, parsed.apiKey);
    const row = providerInstanceResponseSchema.parse({
      ...parsed,
      id,
      scope: "local",
      hasCredential: Boolean(parsed.apiKey),
      configRevision: 1,
      headerKeys: Object.keys(parsed.headers ?? {}),
      enabled: parsed.enabled ?? true,
    });
    rows.set(user.instanceId, [...own(user), row]);
    return structuredClone(row);
  });
  const updateInstance = vi.fn(
    async (user: LocalActor, id: string, input: unknown) => {
      const patch = providerInstanceUpdateRequestSchema.parse(input);
      const current = own(user).find((row) => row.id === id);
      if (!current)
        throw new CodeUiRepositoryError("not_found", "外工作区供应商不可写");
      if (
        patch.expectedRevision !== undefined &&
        patch.expectedRevision !== current.configRevision
      )
        throw new CodeUiRepositoryError("revision_conflict", "实例已更新");
      if (patch.apiKey === null) credentials.delete(id);
      else if (patch.apiKey) credentials.set(id, patch.apiKey);
      const updated = providerInstanceResponseSchema.parse({
        ...current,
        ...patch,
        hasCredential: credentials.has(id),
        configRevision: current.configRevision + 1,
      });
      rows.set(
        user.instanceId,
        own(user).map((row) => (row.id === id ? updated : row)),
      );
      return structuredClone(updated);
    },
  );
  const listInstances = vi.fn(async (user: LocalActor) =>
    structuredClone(own(user)),
  );
  const notifyViews = vi.fn(async () => {});
  const testConnectivity = vi.fn(async () => ({ success: true as const }));
  const deps: CodeUiProviderSettingsRpcDeps = {
    modelProviders: {
      readCredential: async (user, id) => {
        if (!own(user).some((row) => row.id === id))
          throw new CodeUiRepositoryError("not_found", "外实例供应商不可读");
        return credentials.get(id) ?? null;
      },
      listInstances,
      createInstance,
      updateInstance,
      deleteInstance: async (user, id) => {
        rows.set(
          user.instanceId,
          own(user).filter((row) => row.id !== id),
        );
        credentials.delete(id);
      },
      listProviderPresets: () => [
        {
          id: "google",
          name: "Google",
          api: "https://generativelanguage.googleapis.com/v1beta",
          env: ["GOOGLE_API_KEY"],
          models: [
            { id: "gemini-2.5-flash", name: "Flash", capability: "chat" },
          ],
        },
      ],
    },
    modelCatalog: { listCatalog: async () => [] },
    settings: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({ defaultModel: "test" }),
    },
    instanceId: async (user) => user.instanceId,
    preferences: {
      readHumanPreferences: async (id) => preferences.get(id) ?? {},
      updateHumanPreferences: async (id, patch) => {
        preferences.set(id, { ...preferences.get(id), ...patch });
        return true;
      },
    },
    notifyViews,
    testConnectivity,
  };
  const rpc = createCodeUiProviderSettingsRpc(deps);
  const call = async (method: string, args: unknown[] = [], user = actor) =>
    (await rpc.call(user, "providerSettingsService", method, args))?.result;
  const create = async (input: unknown = {}) =>
    (await call("createPersonalProvider", [input])) as {
      providerId: string;
      view: { revision: number };
    };
  return {
    rpc,
    call,
    create,
    rows,
    credentials,
    createInstance,
    updateInstance,
    listInstances,
    notifyViews,
    testConnectivity,
    preferences,
  };
}

it("原空provider草稿真落库，Google模板映射Gemini，无Key不进入选择器", async () => {
  const { rpc, create, createInstance } = fixture();
  const draft = await create();
  expect(createInstance).toHaveBeenCalledWith(
    actor,
    expect.objectContaining({ protocol: "openai-compatible", models: [] }),
  );
  const google = await create({
    templateId: "google",
    providerName: "我的 Google",
  });
  expect(createInstance).toHaveBeenLastCalledWith(
    actor,
    expect.objectContaining({
      protocol: "gemini",
      models: [
        {
          id: "gemini-2.5-flash",
          name: "gemini-2.5-flash",
          capability: "chat",
        },
      ],
    }),
  );
  const views = await rpc.readViews(actor);
  expect(views.settings.providers.map((row) => row.providerId)).toEqual([
    draft.providerId,
    google.providerId,
  ]);
  expect(
    views.settings.providers.every((row) => row.credentialConfigured === false),
  ).toBe(true);
  expect(views.selection.providers).toEqual([]);
});

it("授权设置可读Key，普通投影无Key；空表单值不覆盖，null明确删除；协议编辑保存真实Responses", async () => {
  const { rpc, create, call, credentials, updateInstance } = fixture();
  const { providerId } = await create();
  await call("savePersonalProviderOverlay", [
    providerId,
    {
      access: { type: "api-key", apiKey: "typed-key" },
      api: { type: "openai-responses", baseUrl: "https://gateway.test/v1" },
    },
  ]);
  expect(updateInstance).toHaveBeenLastCalledWith(
    actor,
    providerId,
    expect.objectContaining({
      apiKey: "typed-key",
      protocol: "openai-compatible",
      compat: expect.objectContaining({ chatApi: "responses" }),
    }),
  );
  const settingsRead = await rpc.call(
    actor,
    "providerSettingsService",
    "getView",
    [],
  );
  expect(settingsRead?.result).toMatchObject({
    providers: [
      { personalConfig: { access: { type: "api-key", apiKey: "typed-key" } } },
    ],
  });
  expect(JSON.stringify(await rpc.readViews(actor))).not.toContain("typed-key");
  expect(
    JSON.stringify(
      (await rpc.call(actor, "modelSelectionService", "getView", []))?.result,
    ),
  ).not.toContain("typed-key");
  expect((await rpc.readViews(actor)).settings.providers[0]).toMatchObject({
    credentialConfigured: true,
    personalConfig: { access: { type: "api-key" } },
  });
  await call("savePersonalProviderOverlay", [
    providerId,
    { access: { type: "api-key", apiKey: "" } },
    { providerName: "重命名" },
  ]);
  expect(credentials.get(providerId)).toBe("typed-key");
  await call("savePersonalProviderOverlay", [
    providerId,
    { access: { type: "api-key", apiKey: null } },
  ]);
  expect(credentials.has(providerId)).toBe(false);
  expect(
    (await rpc.readViews(actor)).settings.providers[0]?.credentialConfigured,
  ).toBe(false);
});

it("access与api明确null清除真实凭证、端点与头，模型不再可执行", async () => {
  const { rpc, create, call, rows, credentials, updateInstance } = fixture();
  const { providerId } = await create({
    initialConfig: {
      access: { type: "api-key", apiKey: "keep-key" },
      api: {
        type: "openai-responses",
        baseUrl: "https://gateway.test/v1",
        headers: { "x-custom": "keep" },
      },
      personalModelIds: ["chat"],
    },
  });
  await call("savePersonalProviderOverlay", [providerId, { api: null }]);
  expect(credentials.get(providerId)).toBe("keep-key");
  expect(rows.get(actor.instanceId)?.[0]?.baseUrl).toBe("");
  expect(updateInstance).toHaveBeenLastCalledWith(
    actor,
    providerId,
    expect.objectContaining({
      baseUrl: "",
      headers: {},
      expectedRevision: 1,
    }),
  );
  expect(rows.get(actor.instanceId)?.[0]?.compat?.chatApi).toBeUndefined();
  const cleared = await rpc.readViews(actor);
  expect(cleared.settings.providers[0]?.executable).toBe(false);
  expect(cleared.settings.providers[0]?.models[0]?.executable).toBe(false);
  expect(cleared.selection.providers).toEqual([]);
  expect(cleared.selection.effectiveSelection).toBeNull();
  expect(cleared.settings.providers[0]?.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: ["provider", "api", "baseUrl"] }),
    ]),
  );
  await call("savePersonalProviderOverlay", [providerId, { access: null }]);
  expect(credentials.has(providerId)).toBe(false);
  expect(updateInstance).toHaveBeenLastCalledWith(
    actor,
    providerId,
    expect.objectContaining({ apiKey: null, expectedRevision: 2 }),
  );
});

it("非空但仅含空白的Key在创建与保存时拒绝，保留原凭证与修订", async () => {
  const { create, call, rows, credentials, createInstance, updateInstance } =
    fixture();
  await expect(
    create({ initialConfig: { access: { type: "api-key", apiKey: "  \t" } } }),
  ).rejects.toMatchObject({ code: "command_conflict" });
  expect(createInstance).not.toHaveBeenCalled();
  const { providerId } = await create({
    initialConfig: { access: { type: "api-key", apiKey: "keep-key" } },
  });
  await expect(
    call("savePersonalProviderOverlay", [
      providerId,
      { access: { type: "api-key", apiKey: " \n" } },
    ]),
  ).rejects.toMatchObject({ code: "command_conflict" });
  expect(updateInstance).not.toHaveBeenCalled();
  expect(credentials.get(providerId)).toBe("keep-key");
  expect(rows.get(actor.instanceId)?.[0]?.configRevision).toBe(1);
});

it("模型草稿两读之间外部实例更新不能借新CAS修订覆盖旧草稿", async () => {
  const { rpc, create, call, rows, listInstances, updateInstance } = fixture();
  const { providerId } = await create({
    initialConfig: { personalModelIds: ["chat"] },
  });
  const revision = (await rpc.readViews(actor)).settings.revision;
  listInstances.mockImplementationOnce(async (user) => {
    const snapshot = structuredClone(rows.get(user.instanceId) ?? []);
    const current = rows.get(actor.instanceId)?.[0];
    if (!current) throw new Error("测试供应商未创建");
    rows.set(actor.instanceId, [
      {
        ...current,
        configRevision: current.configRevision + 1,
        models: current.models.map((model) => ({
          ...model,
          contextWindow: 8192,
        })),
      },
    ]);
    return snapshot;
  });
  await expect(
    call("savePersonalModelDraft", [
      {
        providerId,
        originalModelId: "chat",
        nextModelId: "chat",
        personalConfig: { properties: { contextWindow: 4096 } },
        basedOnRevision: revision,
      },
    ]),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(updateInstance).not.toHaveBeenCalled();
  expect(rows.get(actor.instanceId)?.[0]?.models[0]?.contextWindow).toBe(8192);
});

it("模型草稿已核UI修订后外部更新仍由实例CAS拒绝", async () => {
  const { rpc, create, call, rows, updateInstance } = fixture();
  const { providerId } = await create({
    initialConfig: { personalModelIds: ["chat"] },
  });
  const revision = (await rpc.readViews(actor)).settings.revision;
  const update = updateInstance.getMockImplementation();
  if (!update) throw new Error("测试供应商更新实现缺失");
  updateInstance.mockImplementationOnce(async (user, id, input) => {
    const current = rows.get(actor.instanceId)?.[0];
    if (!current) throw new Error("测试供应商未创建");
    rows.set(actor.instanceId, [
      {
        ...current,
        configRevision: current.configRevision + 1,
        models: current.models.map((model) => ({
          ...model,
          contextWindow: 8192,
        })),
      },
    ]);
    return update(user, id, input);
  });
  await expect(
    call("savePersonalModelDraft", [
      {
        providerId,
        originalModelId: "chat",
        nextModelId: "chat",
        personalConfig: { properties: { contextWindow: 4096 } },
        basedOnRevision: revision,
      },
    ]),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(rows.get(actor.instanceId)?.[0]?.models[0]?.contextWindow).toBe(8192);
});

it("provider旧修订表单409，保持另一客户端最新URL和凭证", async () => {
  const { create, call, rows, updateInstance } = fixture();
  const { providerId } = await create({
    initialConfig: { access: { type: "api-key", apiKey: "keep" } },
  });
  const current = rows.get(actor.instanceId)?.[0];
  if (!current) throw new Error("测试供应商未创建");
  current.baseUrl = "https://other-client.test/v1";
  current.configRevision++;
  await expect(
    call("savePersonalProviderOverlay", [
      providerId,
      { api: { baseUrl: "https://old.test/v1" } },
      { expectedRevision: 1 },
    ]),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(rows.get(actor.instanceId)?.[0]?.baseUrl).toBe(
    "https://other-client.test/v1",
  );
  expect(updateInstance).toHaveBeenLastCalledWith(
    actor,
    providerId,
    expect.objectContaining({ expectedRevision: 1 }),
  );
});

it("模型增改/重命名/停用/排序/删到空都持久化，ModelDraft用真实view+native CAS", async () => {
  const { rpc, create, call, updateInstance } = fixture();
  const { providerId } = await create({
    initialConfig: {
      api: { type: "google-generative-language" },
      access: { type: "api-key", apiKey: "google-key" },
    },
  });
  await call("addPersonalModel", [
    providerId,
    "first",
    {
      properties: {
        contextWindow: 8192,
        inputFormat: { supportsImage: true, supportsPdf: true },
      },
      optionSpecs: {
        reasoningLevel: { values: ["low", "high"] },
        maxOutputTokens: { max: 1024 },
      },
    },
    true,
  ]);
  await call("addPersonalModel", [providerId, "second", {}, true]);
  await call("reorderPersonalModels", [providerId, ["second", "first"]]);
  expect(
    (await rpc.readViews(actor)).settings.providers[0]?.models.map(
      (model) => model.modelId,
    ),
  ).toEqual(["second", "first"]);
  const revision = (await rpc.readViews(actor)).settings.revision;
  await call("savePersonalModelDraft", [
    {
      providerId,
      originalModelId: "first",
      nextModelId: "renamed",
      personalConfig: {
        properties: {
          contextWindow: 16384,
          inputFormat: { supportsImage: false, supportsPdf: false },
        },
      },
      useRecommendedConfig: true,
      basedOnRevision: revision,
    },
  ]);
  expect(updateInstance).toHaveBeenLastCalledWith(
    actor,
    providerId,
    expect.objectContaining({
      expectedRevision: expect.any(Number),
      models: expect.arrayContaining([
        expect.objectContaining({
          id: "renamed",
          contextWindow: 16384,
          vision: false,
          inputModalities: ["text"],
        }),
      ]),
    }),
  );
  await expect(
    call("savePersonalModelDraft", [
      {
        providerId,
        originalModelId: "renamed",
        nextModelId: "renamed",
        personalConfig: {},
        basedOnRevision: revision,
      },
    ]),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await call("renamePersonalModel", [providerId, "second", "second-renamed"]);
  await call("setPersonalModelEnabled", [providerId, "renamed", false]);
  expect(
    (await rpc.readViews(actor)).selection.providers[0]?.models.map(
      (model) => model.modelId,
    ),
  ).not.toContain("renamed");
  expect((await rpc.readViews(actor)).settings.providers[0]?.models).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ modelId: "renamed", enabled: false }),
    ]),
  );
  await call("deletePersonalModel", [providerId, "renamed"]);
  await call("deletePersonalModel", [providerId, "second-renamed"]);
  expect((await rpc.readViews(actor)).settings.providers[0]?.models).toEqual(
    [],
  );
});

it("并发同ID只创建一次，外Workspace/重复排序/成员变化不写错对象", async () => {
  const { create, call, rows } = fixture();
  const { providerId } = await create();
  const outcomes = await Promise.allSettled([
    call("addPersonalModel", [providerId, "same", {}, true]),
    call("addPersonalModel", [providerId, "same", {}, true]),
  ]);
  expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(
    rows.get(actor.instanceId)?.[0]?.models.map((model) => model.id),
  ).toEqual(["same"]);
  await expect(
    call("deletePersonalProvider", [providerId], foreign),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    call("reorderPersonalModels", [providerId, ["same", "same"]]),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(
    call("reorderPersonalProviders", [[providerId, providerId]]),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});

it("provider排序与删除更新原views并广播，通知失败不撤销落库", async () => {
  const { create, call, rpc, notifyViews } = fixture();
  const first = await create();
  const second = await create();
  await call("reorderPersonalProviders", [
    [second.providerId, first.providerId],
  ]);
  expect((await rpc.readViews(actor)).settings.providerOrder).toEqual([
    second.providerId,
    first.providerId,
  ]);
  notifyViews.mockRejectedValueOnce(new Error("连接已关闭"));
  await call("deletePersonalProvider", [first.providerId]);
  expect((await rpc.readViews(actor)).settings.providerOrder).toEqual([
    second.providerId,
  ]);
  expect(notifyViews).toHaveBeenCalled();
});

it("连接测试使用所选实际model callback，draft/disabled不冒充成功", async () => {
  const { create, call, testConnectivity } = fixture();
  const { providerId } = await create({
    initialConfig: {
      access: { type: "api-key", apiKey: "key" },
      personalModelIds: ["first", "target"],
    },
  });
  expect(
    await call("testModelConnectivity", [
      { providerId, modelId: "target", workspacePath: "/work" },
    ]),
  ).toEqual({ success: true });
  expect(testConnectivity).toHaveBeenCalledWith(actor, {
    providerId,
    modelId: "target",
    workspacePath: "/work",
  });
  await call("setPersonalModelEnabled", [providerId, "target", false]);
  expect(
    await call("testModelConnectivity", [{ providerId, modelId: "target" }]),
  ).toMatchObject({ success: false, error: { code: "model-unavailable" } });
  expect(testConnectivity).toHaveBeenCalledTimes(1);
});
