import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import {
  extractManualModelConfig,
  type ProviderSettingsView,
} from "@zcode/provider";
import { describe, expect, it } from "vitest";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
const base = process.env.CODE_UI_TEST_BASE ?? "http://127.0.0.1:3001";
const origin = process.env.CODE_UI_TEST_ORIGIN ?? "http://localhost:3000";

async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body:
      response.status === 204
        ? {}
        : ((await response.json()) as Record<string, any>),
  };
}

async function openCodeStream(streams: AbortController[]) {
  const controller = new AbortController();
  streams.push(controller);
  const response = await fetch(`${base}/api/code-ui/events`, {
    headers: { origin },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async () => {
    while (!buffer.includes("\n\n")) {
      const part = await reader.read();
      if (part.done) throw new Error("Code 通道提前关闭");
      buffer += decoder.decode(part.value, { stream: true });
    }
    const boundary = buffer.indexOf("\n\n");
    const record = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    return JSON.parse(record.slice("data: ".length));
  };
  const ready = await next();
  const rpc = (method: string, args: unknown[] = []) =>
    request("/api/code-ui/rpc", {
      connectionId: ready.hello.connectionId,
      service: "zcodeAgentService",
      method,
      args,
    });
  expect(ready.hello).toMatchObject({
    kind: "hello",
    protocolVersion: 3,
    clientMode: "web-remote-replayable",
    deliveryProfile: "replayable",
  });
  return { next, rpc, controller, ready };
}

describe.skipIf(!enabled)("Code 宿主真实数据库公开接口 integration", () => {
  it("Code 宿主 ready 使用工作区持久重连间隔，刷新保留且非法限额拒绝", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    const original = await request("/api/workspace/settings");
    expect(original.status).toBe(200);
    const value = original.body.settings.codeUiReconnectDelayMs;
    const streams: AbortController[] = [];
    try {
      const saved = await request(
        "/api/workspace/settings",
        { codeUiReconnectDelayMs: 250 },
        "PUT",
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.settings.codeUiReconnectDelayMs).toBe(250);
      expect(
        (await request("/api/workspace/settings")).body.settings
          .codeUiReconnectDelayMs,
      ).toBe(250);
      const stream = await openCodeStream(streams);
      expect(stream.ready).toMatchObject({
        event: "ready",
        reconnectDelayMs: 250,
      });
      expect(
        (
          await request(
            "/api/workspace/settings",
            { codeUiReconnectDelayMs: 0 },
            "PUT",
          )
        ).status,
      ).toBe(400);
      expect(
        (await request("/api/workspace/settings")).body.settings
          .codeUiReconnectDelayMs,
      ).toBe(250);
    } finally {
      for (const controller of streams) controller.abort();
      await request(
        "/api/workspace/settings",
        { codeUiReconnectDelayMs: value ?? 1000 },
        "PUT",
      );
    }
  });
  it("原模型删除清理成员和精确规则，并发删除不丢失且迟到保存和启用不能复活", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    let providerId = "";
    try {
      const created = await rpc("createPersonalProvider", [
        { providerName: `模型删除 ${randomUUID()}` },
      ]);
      providerId = created.body.result.providerId;
      for (const id of ["甲", "乙", "丙"])
        expect(
          (await rpc("addPersonalModel", [providerId, id, {}])).status,
        ).toBe(200);
      const deleted = await rpc("deletePersonalModel", [providerId, "甲"]);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      const readModels = (view: ProviderSettingsView) =>
        view.providers.find((item) => item.providerId === providerId)!.models;
      expect(
        readModels(deleted.body.result).map((model) => model.modelId),
      ).toEqual(["乙", "丙"]);
      expect((await rpc("refresh")).body.result).toEqual(deleted.body.result);
      expect(
        (await rpc("setPersonalModelEnabled", [providerId, "甲", true])).status,
      ).toBe(404);
      expect(
        (
          await rpc("savePersonalModelDraft", [
            {
              providerId,
              originalModelId: "甲",
              nextModelId: "甲",
              personalConfig: {},
              basedOnRevision: deleted.body.result.revision,
            },
          ])
        ).status,
      ).toBe(404);
      expect(
        (await rpc("deletePersonalModel", [providerId, "甲"])).status,
      ).toBe(404);
      expect((await rpc("getView")).body.result).toEqual(deleted.body.result);
      const concurrent = await Promise.all([
        rpc("deletePersonalModel", [providerId, "乙"]),
        rpc("deletePersonalModel", [providerId, "丙"]),
      ]);
      expect(concurrent.map((result) => result.status)).toEqual([200, 200]);
      const empty = await rpc("refresh");
      expect(readModels(empty.body.result)).toEqual([]);
      const invalid = await rpc("deletePersonalModel", [providerId, " "]);
      expect(invalid.status).toBe(400);
      expect((await rpc("getView")).body.result).toEqual(empty.body.result);
    } finally {
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原模型启停只修改最新 enabled，保留手动模式与精确配置且刷新和同值重放一致", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    let providerId = "";
    try {
      const created = await rpc("createPersonalProvider", [
        { providerName: `模型启停 ${randomUUID()}` },
      ]);
      providerId = created.body.result.providerId;
      await rpc("savePersonalProviderOverlay", [
        providerId,
        {
          api: {
            type: "openai-chat-completions",
            baseUrl: "https://example.invalid/v1",
          },
          access: { type: "api-key", apiKey: "integration-only-not-a-key" },
        },
      ]);
      const selection = () =>
        request("/api/code-ui/rpc", {
          service: "modelSelectionService",
          method: "getView",
          args: [],
        });
      const added = await rpc("addPersonalModel", [
        providerId,
        "模型甲",
        { properties: { contextWindow: 256000 } },
      ]);
      const model = added.body.result.providers.find(
        (item: { providerId: string }) => item.providerId === providerId,
      ).models[0];
      const manual = await rpc("savePersonalModelDraft", [
        {
          providerId,
          originalModelId: "模型甲",
          nextModelId: "模型甲",
          personalConfig: extractManualModelConfig(model.effectiveConfig),
          useRecommendedConfig: false,
          basedOnRevision: added.body.result.revision,
        },
      ]);
      expect(manual.status, JSON.stringify(manual.body)).toBe(200);
      expect((await selection()).body.result.providers).toContainEqual(
        expect.objectContaining({
          providerId,
          models: [expect.objectContaining({ modelId: "模型甲" })],
        }),
      );
      const disabled = await rpc("setPersonalModelEnabled", [
        providerId,
        "模型甲",
        false,
      ]);
      expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
      const readModel = (view: ProviderSettingsView) =>
        view.providers.find((item) => item.providerId === providerId)!
          .models[0]!;
      expect(readModel(disabled.body.result)).toMatchObject({
        enabled: false,
        useRecommendedConfig: false,
        personalExactConfig: {
          enabled: false,
          properties: { contextWindow: 256000 },
          optionSpecs: { maxOutputTokens: { max: 32000 } },
        },
      });
      expect((await rpc("refresh")).body.result).toEqual(disabled.body.result);
      expect((await selection()).body.result.providers).toContainEqual(
        expect.objectContaining({ providerId, models: [] }),
      );
      const repeated = await rpc("setPersonalModelEnabled", [
        providerId,
        "模型甲",
        false,
      ]);
      expect(repeated.body.result).toEqual(disabled.body.result);
      const restored = await rpc("setPersonalModelEnabled", [
        providerId,
        "模型甲",
        true,
      ]);
      expect(restored.status).toBe(200);
      expect(readModel(restored.body.result)).toEqual(
        readModel(manual.body.result),
      );
      expect((await selection()).body.result.providers).toContainEqual(
        expect.objectContaining({
          providerId,
          models: [expect.objectContaining({ modelId: "模型甲" })],
        }),
      );
      expect(
        (await rpc("setPersonalModelEnabled", [providerId, "不存在", false]))
          .status,
      ).toBe(404);
      expect(
        (await rpc("setPersonalModelEnabled", [providerId, "模型甲", "false"]))
          .status,
      ).toBe(400);
      expect((await rpc("getView")).body.result).toEqual(restored.body.result);
    } finally {
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原模型恢复智能规则删除个人精确配置，刷新保留推荐且同值保存不推进修订", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    let providerId = "";
    try {
      const created = await rpc("createPersonalProvider", [
        { providerName: `恢复推荐 ${randomUUID()}` },
      ]);
      providerId = created.body.result.providerId;
      const added = await rpc("addPersonalModel", [
        providerId,
        "待恢复模型",
        { properties: { contextWindow: 260000 } },
      ]);
      const input = {
        providerId,
        originalModelId: "待恢复模型",
        nextModelId: "待恢复模型",
        personalConfig: { properties: {} },
        useRecommendedConfig: true,
        basedOnRevision: added.body.result.revision,
      };
      const restored = await rpc("savePersonalModelDraft", [input]);
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      const provider = restored.body.result.providers.find(
        (item: { providerId: string }) => item.providerId === providerId,
      );
      expect(provider.models).toHaveLength(1);
      expect(provider.models[0]).not.toHaveProperty("personalExactConfig");
      expect(provider.models[0]).toMatchObject({
        modelId: "待恢复模型",
        useRecommendedConfig: true,
        effectiveConfig: {
          enabled: true,
          properties: { contextWindow: 200000 },
          optionSpecs: { maxOutputTokens: { max: 32000 } },
        },
      });
      expect((await rpc("refresh")).body.result).toEqual(restored.body.result);
      const repeated = await rpc("savePersonalModelDraft", [
        {
          ...input,
          personalConfig: {},
          basedOnRevision: restored.body.result.revision,
        },
      ]);
      expect(repeated.status).toBe(200);
      expect(repeated.body.result).toEqual(restored.body.result);
      const manual = await rpc("savePersonalModelDraft", [
        {
          ...input,
          personalConfig: {},
          useRecommendedConfig: false,
          basedOnRevision: restored.body.result.revision,
        },
      ]);
      expect(manual.status).toBe(400);
      expect((await rpc("getView")).body.result).toEqual(restored.body.result);
    } finally {
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原模型草稿原子改名与保存精确规则，拒绝同修订并发和跨供应商过期修订", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    let providerId = "";
    let otherId = "";
    try {
      const created = await rpc("createPersonalProvider", [
        { providerName: `CAS ${randomUUID()}` },
      ]);
      providerId = created.body.result.providerId;
      await rpc("addPersonalModel", [providerId, "原模型", {}]);
      const initial = await rpc("addPersonalModel", [
        providerId,
        "保留模型",
        {},
      ]);
      const input = {
        providerId,
        originalModelId: "原模型",
        nextModelId: "新模型",
        personalConfig: {
          properties: { contextWindow: 260000 },
          optionSpecs: { maxOutputTokens: { max: 9000 } },
        },
        useRecommendedConfig: true,
        basedOnRevision: initial.body.result.revision,
      };
      const saved = await rpc("savePersonalModelDraft", [input]);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(
        saved.body.result.providers.find(
          (item: { providerId: string }) => item.providerId === providerId,
        ).models,
      ).toMatchObject([
        {
          modelId: "新模型",
          personalExactConfig: { properties: { contextWindow: 260000 } },
          effectiveConfig: {
            properties: { contextWindow: 260000 },
            optionSpecs: { maxOutputTokens: { max: 9000 } },
          },
        },
        { modelId: "保留模型" },
      ]);
      expect((await rpc("savePersonalModelDraft", [input])).status).toBe(409);
      expect((await rpc("getView")).body.result).toEqual(saved.body.result);
      const concurrent = {
        ...input,
        originalModelId: "新模型",
        nextModelId: "新模型",
        basedOnRevision: saved.body.result.revision,
      };
      const results = await Promise.all([
        rpc("savePersonalModelDraft", [
          {
            ...concurrent,
            personalConfig: { properties: { contextWindow: 270000 } },
          },
        ]),
        rpc("savePersonalModelDraft", [
          {
            ...concurrent,
            personalConfig: { properties: { contextWindow: 280000 } },
          },
        ]),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const fresh = await rpc("getView");
      const other = await rpc("createPersonalProvider", [
        { providerName: `其它 ${randomUUID()}` },
      ]);
      otherId = other.body.result.providerId;
      expect(
        (
          await rpc("savePersonalModelDraft", [
            { ...concurrent, basedOnRevision: fresh.body.result.revision },
          ])
        ).status,
      ).toBe(409);
      const current = await rpc("getView");
      const collision = await rpc("savePersonalModelDraft", [
        {
          ...concurrent,
          nextModelId: "保留模型",
          basedOnRevision: current.body.result.revision,
        },
      ]);
      expect(collision.status).toBe(409);
      expect((await rpc("getView")).body.result).toEqual(current.body.result);
    } finally {
      if (otherId) await rpc("deletePersonalProvider", [otherId]);
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原模型添加的并发成员不丢失，同键只成功一次，删除供应商后的迟到添加不能重建", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    let providerId = "";
    try {
      const created = await rpc("createPersonalProvider", [
        { providerName: `并发模型 ${randomUUID()}` },
      ]);
      providerId = created.body.result.providerId;
      const distinct = await Promise.all([
        rpc("addPersonalModel", [providerId, "一", {}]),
        rpc("addPersonalModel", [providerId, "二", {}]),
      ]);
      expect(distinct.map((result) => result.status)).toEqual([200, 200]);
      const same = await Promise.all([
        rpc("addPersonalModel", [providerId, "同键", {}]),
        rpc("addPersonalModel", [providerId, "同键", {}]),
      ]);
      expect(same.map((result) => result.status).sort()).toEqual([200, 409]);
      const view = await rpc("getView");
      expect(
        view.body.result.providers
          .find(
            (provider: { providerId: string }) =>
              provider.providerId === providerId,
          )
          .models.map((model: { modelId: string }) => model.modelId)
          .sort(),
      ).toEqual(["一", "二", "同键"].sort());
      expect(view.body.result.revision).toBe(
        created.body.result.view.revision + 3,
      );
      const deleted = await rpc("deletePersonalProvider", [providerId]);
      expect(
        (await rpc("addPersonalModel", [providerId, "迟到", {}])).status,
      ).toBe(404);
      expect((await rpc("getView")).body.result).toEqual(deleted.body.result);
      providerId = "";
    } finally {
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原模型编辑器解析原推荐规则并添加精确个人配置，刷新保持成员和完整配置且不产生假模型", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    let providerId = "";
    try {
      const created = await rpc("createPersonalProvider", [
        { providerName: `原模型 ${randomUUID()}` },
      ]);
      expect(created.status).toBe(200);
      providerId = created.body.result.providerId;
      const resolved = await rpc("resolveModelConfig", [
        { providerId, modelId: "模型-α" },
      ]);
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(resolved.body.result).toMatchObject({
        inheritedConfig: {
          properties: { contextWindow: 200000 },
          optionSpecs: { maxOutputTokens: { max: 32000 } },
        },
        effectiveConfig: { enabled: true },
        issues: [],
      });
      expect((await rpc("getView")).body.result.revision).toBe(
        created.body.result.view.revision,
      );
      const added = await rpc("addPersonalModel", [
        providerId,
        "模型-α",
        {
          enabled: false,
          properties: { contextWindow: 256000 },
          optionSpecs: { maxOutputTokens: { max: 8192 } },
        },
        true,
      ]);
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      const provider = added.body.result.providers.find(
        (item: { providerId: string }) => item.providerId === providerId,
      );
      expect(provider.models).toHaveLength(1);
      expect(provider.models[0]).toMatchObject({
        modelId: "模型-α",
        enabled: true,
        executable: false,
        useRecommendedConfig: true,
        personalExactConfig: {
          enabled: true,
          properties: { contextWindow: 256000 },
          optionSpecs: { maxOutputTokens: { max: 8192 } },
        },
        effectiveBuiltinConfig: { properties: { contextWindow: 200000 } },
        effectiveConfig: {
          properties: { contextWindow: 256000 },
          optionSpecs: { maxOutputTokens: { max: 8192 } },
        },
      });
      const fresh = await rpc("refresh", ["integration:model-editor"]);
      expect(fresh.body.result).toEqual(added.body.result);
      const existing = await rpc("resolveModelConfig", [
        { providerId, modelId: "模型-α" },
      ]);
      expect(
        existing.body.result.inheritedConfig.properties.contextWindow,
      ).toBe(256000);
      expect(
        existing.body.result.effectiveConfig.optionSpecs.maxOutputTokens.max,
      ).toBe(8192);
      const instances = await request("/api/provider-instances");
      const descriptor = instances.body.instances.find(
        (instance: { id: string }) => instance.id === providerId,
      ).models[0];
      expect(descriptor).toMatchObject({
        id: "模型-α",
        contextWindow: 256000,
        maxOutputTokens: 8192,
      });
      expect(descriptor).not.toHaveProperty("codeConfig");
    } finally {
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原供应商稀疏配置保存原格式与品牌字段，Key 和请求头只写，省略保留而明确 null 清除", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    let providerId = "";
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    const selected = (view: ProviderSettingsView) =>
      view.providers.find(
        (provider: { providerId: string }) =>
          provider.providerId === providerId,
      );
    try {
      const created = await rpc("createPersonalProvider", [
        { providerName: `写入 ${randomUUID()}` },
      ]);
      expect(created.status).toBe(200);
      providerId = created.body.result.providerId;
      const saved = await rpc("savePersonalProviderOverlay", [
        providerId,
        {
          api: {
            type: "openai-responses",
            baseUrl: "https://example.invalid/v1",
            headers: { "X-Private": "integration-header-private" },
          },
          access: {
            type: "api-key",
            apiKey: "integration-credential-private",
            apiKeyManagementUrl: "https://example.invalid/keys",
          },
          logo: { type: "builtin", key: "openai" },
          visibility: "visible",
        },
        { providerName: "原配置供应商", enabled: true },
      ]);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(selected(saved.body.result)).toMatchObject({
        providerName: "原配置供应商",
        credentialConfigured: true,
        executable: true,
        effectiveConfig: {
          logo: { type: "builtin", key: "openai" },
          api: {
            type: "openai-responses",
            baseUrl: "https://example.invalid/v1",
          },
          access: {
            type: "api-key",
            apiKeyManagementUrl: "https://example.invalid/keys",
          },
        },
      });
      expect(JSON.stringify(saved.body.result)).not.toMatch(
        /integration-credential-private|integration-header-private|apiKey"|headers"/,
      );
      const updated = await rpc("savePersonalProviderOverlay", [
        providerId,
        { api: { baseUrl: "https://example.invalid/v2" } },
      ]);
      expect(updated.status).toBe(200);
      expect(selected(updated.body.result)).toMatchObject({
        credentialConfigured: true,
        effectiveConfig: {
          logo: { type: "builtin", key: "openai" },
          api: {
            type: "openai-responses",
            baseUrl: "https://example.invalid/v2",
          },
          access: { apiKeyManagementUrl: "https://example.invalid/keys" },
        },
      });
      const instances = await request("/api/provider-instances");
      expect(
        instances.body.instances.find(
          (instance: { id: string }) => instance.id === providerId,
        ),
      ).toMatchObject({
        hasCredential: true,
        headerKeys: ["X-Private"],
        baseUrl: "https://example.invalid/v2",
      });
      const cleared = await rpc("savePersonalProviderOverlay", [
        providerId,
        { access: { type: "api-key", apiKey: null }, api: { headers: null } },
      ]);
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(selected(cleared.body.result)).toMatchObject({
        credentialConfigured: false,
        executable: false,
        effectiveConfig: {
          api: {
            type: "openai-responses",
            baseUrl: "https://example.invalid/v2",
          },
        },
      });
      expect(
        (await rpc("refresh", ["integration:write-only"])).body.result,
      ).toEqual(cleared.body.result);
      const publicRead = await request("/api/provider-instances");
      expect(
        publicRead.body.instances.find(
          (instance: { id: string }) => instance.id === providerId,
        ),
      ).toMatchObject({ hasCredential: false, headerKeys: [] });
      const deleted = await rpc("deletePersonalProvider", [providerId]);
      expect(deleted.status).toBe(200);
      const late = await rpc("savePersonalProviderOverlay", [
        providerId,
        { access: { type: "api-key", apiKey: "late-private-credential" } },
      ]);
      expect(late.status).toBe(404);
      expect((await rpc("getView")).body.result).toEqual(deleted.body.result);
      providerId = "";
    } finally {
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原设置保留停用模型与供应商候选，执行目录遵守各级开关，同值保存不推进修订", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    let providerId = "";
    const view = async (service = "providerSettingsService") =>
      request("/api/code-ui/rpc", { service, method: "getView", args: [] });
    try {
      const created = await request("/api/provider-instances", {
        name: `候选 ${randomUUID()}`,
        protocol: "openai-compatible",
        baseUrl: "https://example.invalid/v1",
        // 仅持久化 fixture，不发送任何真实模型请求。
        apiKey: "integration-credential-no-network",
        models: [
          {
            id: "glm-4.5-air",
            name: "停用模型",
            capability: "chat",
            enabled: false,
          },
          { id: "glm-4.6", name: "启用模型", capability: "chat" },
        ],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      providerId = created.body.id;
      const loaded = await view();
      expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
      const provider = loaded.body.result.providers.find(
        (item: { providerId: string }) => item.providerId === providerId,
      );
      expect(
        provider.models.map((model: { modelId: string }) => model.modelId),
      ).toEqual(["glm-4.5-air", "glm-4.6"]);
      expect(provider.models[0]).toMatchObject({
        enabled: false,
        executable: false,
        selectable: false,
      });
      expect(provider.models[1]).toMatchObject({
        enabled: true,
        executable: true,
        selectable: true,
      });
      const selection = await view("modelSelectionService");
      expect(
        selection.body.result.providers
          .find(
            (item: { providerId: string }) => item.providerId === providerId,
          )
          .models.map((model: { modelId: string }) => model.modelId),
      ).toEqual(["glm-4.6"]);
      expect(
        (
          await request(
            `/api/provider-instances/${providerId}`,
            { enabled: false },
            "PATCH",
          )
        ).status,
      ).toBe(200);
      const disabled = await view();
      expect(disabled.body.result.revision).toBe(
        loaded.body.result.revision + 1,
      );
      expect(
        disabled.body.result.providers.find(
          (item: { providerId: string }) => item.providerId === providerId,
        ),
      ).toMatchObject({
        enabled: false,
        executable: false,
        effectiveConfig: { visibility: "visible" },
        models: [{ modelId: "glm-4.5-air" }, { modelId: "glm-4.6" }],
      });
      expect(
        (await view("modelSelectionService")).body.result.providers.some(
          (item: { providerId: string }) => item.providerId === providerId,
        ),
      ).toBe(false);
      expect(
        (
          await request(
            `/api/provider-instances/${providerId}`,
            { enabled: false },
            "PATCH",
          )
        ).status,
      ).toBe(200);
      expect((await view()).body.result.revision).toBe(
        disabled.body.result.revision,
      );
      expect(JSON.stringify(disabled.body.result)).not.toContain(
        "integration-credential-no-network",
      );
    } finally {
      if (providerId)
        await request(
          `/api/provider-instances/${providerId}`,
          undefined,
          "DELETE",
        );
    }
  });
  it("原供应商草稿提交后向已连接原服务广播与应答相同的完整 View，刷新不推进修订", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    const streams: AbortController[] = [];
    let providerId = "";
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    try {
      const stream = await openCodeStream(streams);
      const created = await rpc("createPersonalProvider", [
        { providerName: `通知草稿 ${randomUUID()}` },
      ]);
      expect(created.status).toBe(200);
      providerId = created.body.result.providerId;
      // 仅测试通知可观察性：不改产品超时或运行治理值。
      const notification = await Promise.race([
        stream.next(),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("未收到原服务变更通知")),
            1000,
          );
          timer.unref();
        }),
      ]);
      expect(notification).toMatchObject({
        event: "service",
        service: "providerSettingsService",
        name: "onDidChange",
        data: created.body.result.view,
      });
      const selectable = await stream.next();
      const selection = await request("/api/code-ui/rpc", {
        service: "modelSelectionService",
        method: "getView",
        args: [],
      });
      expect(selectable).toMatchObject({
        event: "service",
        service: "modelSelectionService",
        name: "onDidChange",
        data: selection.body.result,
      });
      expect(selectable.data.revision).toBe(created.body.result.view.revision);
      const fresh = await rpc("refresh", ["integration:no-config-change"]);
      expect(fresh.body.result).toEqual(created.body.result.view);
      const removed = await rpc("deletePersonalProvider", [providerId]);
      expect(removed.status).toBe(200);
      providerId = "";
      expect(await stream.next()).toMatchObject({
        event: "service",
        service: "providerSettingsService",
        name: "onDidChange",
        data: removed.body.result,
      });
      expect(JSON.stringify(removed.body.result)).not.toMatch(
        /apiKey|encrypted_api_key/,
      );
    } finally {
      for (const stream of streams) stream.abort();
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原供应商创建操作保存真实无凭证无模型草稿，读取和刷新保持不可执行且不泄露凭证", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    let providerId = "";
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    try {
      const initial = await rpc("getView");
      expect(initial.status).toBe(200);
      const created = await rpc("createPersonalProvider", [
        { providerName: `Code 草稿 ${randomUUID()}`, locale: "zh-CN" },
      ]);
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body.result.view.revision).toBe(
        initial.body.result.revision + 1,
      );
      providerId = created.body.result.providerId;
      const draft = created.body.result.view.providers.find(
        (provider: { providerId: string }) =>
          provider.providerId === providerId,
      );
      expect(draft).toMatchObject({
        providerId,
        executable: false,
        models: [],
      });
      expect(draft.effectiveConfig.access).not.toHaveProperty("apiKey");
      expect(draft.personalConfig.access).not.toHaveProperty("apiKey");
      expect(draft).not.toHaveProperty("encrypted_api_key");
      const loaded = await rpc("getView");
      expect(loaded.status).toBe(200);
      expect(loaded.body.result.revision).toBe(
        created.body.result.view.revision,
      );
      expect(
        loaded.body.result.providers.find(
          (provider: { providerId: string }) =>
            provider.providerId === providerId,
        ),
      ).toEqual(draft);
      const fresh = await rpc("refresh", ["integration:reload"]);
      expect(fresh.status).toBe(200);
      expect(fresh.body.result.revision).toBe(loaded.body.result.revision);
      expect(
        fresh.body.result.providers.find(
          (provider: { providerId: string }) =>
            provider.providerId === providerId,
        ),
      ).toEqual(draft);
      const selectable = await request("/api/code-ui/rpc", {
        service: "modelSelectionService",
        method: "getView",
        args: [],
      });
      expect(
        selectable.body.result.providers.some(
          (provider: { providerId: string }) =>
            provider.providerId === providerId,
        ),
      ).toBe(false);
      const removed = await rpc("deletePersonalProvider", [providerId]);
      expect(removed.status).toBe(200);
      expect(removed.body.result.revision).toBe(fresh.body.result.revision + 1);
      expect(
        removed.body.result.providers.some(
          (provider: { providerId: string }) =>
            provider.providerId === providerId,
        ),
      ).toBe(false);
      providerId = "";
    } finally {
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原文件宿主读取空文件与 Unicode，拒绝项目外路径与 symlink 逃逸", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ken-code-ui-files-"));
    const outside = await mkdtemp(join(tmpdir(), "ken-code-ui-outside-"));
    let projectId = "";
    try {
      await writeFile(join(dir, "空.txt"), "");
      await writeFile(
        join(dir, "例子.ts"),
        'export const greeting = "你好 👋";\n',
      );
      await writeFile(join(outside, "private.txt"), "不能被这个项目读取");
      await symlink(join(outside, "private.txt"), join(dir, "escape.txt"));
      const created = await request("/api/projects", {
        name: `Code 文件验收 ${randomUUID()}`,
        kind: "code",
        work_dir: dir,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      projectId = created.body.project.id;
      const read = (path: string) =>
        request("/api/code-ui/rpc", {
          service: "file",
          method: "readTextFile",
          args: [{ path }],
        });
      const empty = await read(join(dir, "空.txt"));
      expect(empty.status).toBe(200);
      expect(empty.body.result).toMatchObject({
        content: "",
        bytesRead: 0,
        totalBytes: 0,
        truncated: false,
        isBinary: false,
      });
      expect((await read(join(dir, "例子.ts"))).body.result).toMatchObject({
        content: 'export const greeting = "你好 👋";\n',
        truncated: false,
        isBinary: false,
      });
      expect((await read(join(outside, "private.txt"))).status).toBe(404);
      expect((await read(join(dir, "escape.txt"))).status).toBe(404);
    } finally {
      if (projectId)
        await request(`/api/projects/${projectId}`, undefined, "DELETE");
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it.skipIf(process.env.RUN_CODE_UI_MODEL_SMOKE !== "1")(
    "原 sendText 驱动 GLM 真实运行，同命令重放不产生第二轮，正文和终态可刷新恢复",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "ken-code-ui-model-"));
      const streams: AbortController[] = [];
      let projectId = "";
      try {
        const created = await request("/api/projects", {
          name: `Code GLM 冒烟 ${randomUUID()}`,
          kind: "code",
          work_dir: dir,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        projectId = created.body.project.id;
        const stream = await openCodeStream(streams);
        const clientId = randomUUID();
        await stream.rpc("initializeConversationV4", [
          {
            kind: "clientHello",
            protocolVersion: 3,
            clientId,
            appVersion: "integration",
            clientKind: "web",
          },
        ]);
        const selection = {
          providerId: "29501127-e6e5-49ca-a3f6-cf642669ce2e",
          modelId: "glm-4.5-air",
        };
        const call = (envelope: unknown) =>
          stream.rpc("sendConversationCommandV4", [
            { workspacePath: dir, envelope },
          ]);
        const createdSession = await call({
          commandId: randomUUID(),
          clientId,
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: dir, config: { modelSelection: selection } },
          issuedAt: Date.now(),
        });
        const sessionId = createdSession.body.result.result.sessionId;
        await stream.rpc("subscribeConversationV4", [
          { workspacePath: dir, sessionId },
        ]);
        await stream.next();
        const envelope = {
          commandId: randomUUID(),
          clientId,
          sessionId,
          type: "sendText",
          payload: {
            text: "这是集成冒烟测试。不要调用工具，只回复 CODE_UI_SMOKE_OK。",
            modelSelection: selection,
          },
          issuedAt: Date.now(),
        };
        const results = await Promise.all([call(envelope), call(envelope)]);
        expect(results.map((result) => result.status)).toEqual([200, 200]);
        expect(
          results.map((result) => result.body.result.status).sort(),
        ).toEqual(["accepted", "duplicate"]);
        let snapshot: protocol.ConversationSnapshot | undefined;
        do {
          const event = await stream.next();
          if (event.event === "onDynamicConversationFrame")
            snapshot = event.frame.frame?.payload.snapshot;
        } while (!snapshot || snapshot.control.phase === "running");
        expect(
          snapshot.control,
          JSON.stringify(snapshot.control),
        ).toMatchObject({ phase: "completedSuccess", canStop: false });
        expect(
          snapshot.rows.window.filter(
            (row: { kind: string }) => row.kind === "userInput",
          ),
        ).toHaveLength(1);
        expect(
          snapshot.rows.window
            .flatMap((row) => (row.kind === "assistantText" ? [row.text] : []))
            .join(""),
        ).toContain("CODE_UI_SMOKE_OK");
        const restored = await request(`/api/code-ui/sessions/${sessionId}`);
        expect(restored.body.snapshot).toEqual(snapshot);
        const tasks = await request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "listTasks",
          args: [{ workspacePath: dir }],
        });
        expect(tasks.status).toBe(200);
        expect(tasks.body.result).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              taskId: sessionId,
              workspacePath: dir,
              status: "completed",
            }),
          ]),
        );
        const queried = await stream.rpc("queryConversationCommandsV4", [
          {
            workspacePath: dir,
            commands: [{ sessionId, commandId: envelope.commandId }],
          },
        ]);
        expect(queried.body.result.results[0]).toMatchObject({
          result: {
            status: "accepted",
            result: { type: "inputAccepted", delivery: "startNow" },
          },
        });
      } finally {
        for (const stream of streams) stream.abort();
        if (projectId)
          await request(`/api/projects/${projectId}`, undefined, "DELETE");
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  ); // 外部模型真实冒烟的测试期限，不是 Agent 运行限额。
  it("握手后的原协议订阅仅返回 ACK，独立通道发送 owned snapshot，重连从持久快照恢复", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ken-code-ui-subscription-"));
    let projectId = "";
    const streams: AbortController[] = [];
    try {
      const created = await request("/api/projects", {
        name: `Code 订阅验收 ${randomUUID()}`,
        kind: "code",
        work_dir: dir,
      });
      projectId = created.body.project.id;
      const stream = await openCodeStream(streams);
      const clientId = randomUUID();
      const initialize = () => [
        {
          kind: "clientHello",
          protocolVersion: 3,
          clientId,
          appVersion: "integration",
          clientKind: "web",
        },
      ];
      expect(
        (await stream.rpc("initializeConversationV4", initialize())).status,
      ).toBe(200);
      const command = await stream.rpc("sendConversationCommandV4", [
        {
          workspacePath: dir,
          envelope: {
            commandId: randomUUID(),
            clientId,
            sessionId: null,
            type: "createSession",
            payload: { workspaceId: dir },
            issuedAt: Date.now(),
          },
        },
      ]);
      const sessionId = command.body.result.result.sessionId;
      const subscription = await stream.rpc("subscribeConversationV4", [
        { workspacePath: dir, sessionId },
      ]);
      expect(subscription.status).toBe(200);
      expect(Object.keys(subscription.body.result)).toEqual(["ack"]);
      const frame = await stream.next();
      expect(frame).toMatchObject({
        event: "onDynamicConversationFrame",
        workspacePath: dir,
        frame: {
          deliveryKind: "initial",
          subscriptionId: subscription.body.result.ack.subscriptionId,
          frame: {
            topic: `conversation/${sessionId}`,
            payload: {
              kind: "snapshot",
              snapshot: { sessionId, control: { phase: "draft" } },
            },
          },
        },
      });
      stream.controller.abort();
      const reconnected = await openCodeStream(streams);
      await reconnected.rpc("initializeConversationV4", initialize());
      const foreign = await reconnected.rpc("resyncConversationV4", [
        {
          workspacePath: dir,
          subscriptionId: subscription.body.result.ack.subscriptionId,
          base: null,
        },
      ]);
      expect(foreign.status).toBe(404);
      const resumed = await reconnected.rpc("subscribeConversationV4", [
        {
          workspacePath: dir,
          sessionId,
          base: {
            logEpoch: frame.frame.frame.payload.snapshot.logEpoch,
            seq: 0,
          },
        },
      ]);
      expect(resumed.status).toBe(200);
      expect((await reconnected.next()).frame.frame.payload.snapshot).toEqual(
        frame.frame.frame.payload.snapshot,
      );
    } finally {
      for (const stream of streams) stream.abort();
      if (projectId)
        await request(`/api/projects/${projectId}`, undefined, "DELETE");
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("createSession 绑定真实项目主画布；同键重放同身份、异参冲突", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ken-code-ui-host-"));
    let projectId = "";
    try {
      const created = await request("/api/projects", {
        name: `Code UI 集成验收 ${randomUUID()}`,
        kind: "code",
        work_dir: dir,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const project = created.body.project;
      projectId = project.id;
      const envelope = {
        commandId: randomUUID(),
        clientId: randomUUID(),
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: dir },
        issuedAt: Date.now(),
      };
      const call = (value: unknown) =>
        request("/api/code-ui/rpc", {
          service: "zcodeAgentService",
          method: "sendConversationCommandV4",
          args: [{ workspacePath: dir, envelope: value }],
        });
      const first = await call(envelope);
      expect(first.status).toBe(200);
      const sessionId = first.body.result.result.sessionId;
      const second = await call(envelope);
      expect(second.body.result).toMatchObject({
        status: "duplicate",
        result: { type: "createSession", sessionId },
      });
      const sessions = await request(
        `/api/canvases/${project.primaryCanvas.id}/sessions`,
      );
      expect(
        sessions.body.sessions.map((session: { id: string }) => session.id),
      ).toContain(sessionId);
      const snapshot = await request(`/api/code-ui/sessions/${sessionId}`);
      expect(snapshot.body.snapshot).toMatchObject({
        sessionId,
        control: { phase: "draft" },
      });
      const conflict = await call({
        ...envelope,
        payload: { workspaceId: dir, config: { planEnabled: true } },
      });
      expect(conflict.status).toBe(409);
    } finally {
      if (projectId)
        await request(`/api/projects/${projectId}`, undefined, "DELETE");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
