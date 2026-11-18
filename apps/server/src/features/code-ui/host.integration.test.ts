import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  instanceSettingsResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import {
  clearManualModelConfig,
  extractManualModelConfig,
  ModelConfig,
  type ProviderSettingsView,
} from "@zcode/provider";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { nextHostServiceEvent } from "./host-client.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();
const { request, openCodeStream } = isolatedHttp;

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
type CodeStream = Awaited<ReturnType<typeof openCodeStream>>;

async function initializeCodeStream(
  streams: AbortController[],
  clientId: string = randomUUID(),
) {
  const stream = await openCodeStream(streams);
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId,
      appVersion: "host-public-integration",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  return { stream, clientId };
}

async function readOwnedConversationSnapshot(
  stream: CodeStream,
  target: { subscriptionId: string; sessionId: string; workspacePath: string },
) {
  const assembler = new protocol.TopicWireFrameAssembler(
    protocol.conversationTopicFrameSchema,
  );
  for (;;) {
    const event = await stream.next();
    if (event.event !== "onDynamicConversationFrame") continue;
    const wire = protocol.topicWireFrameCandidateSchema.parse(event.frame);
    if (wire.subscriptionId !== target.subscriptionId) continue;
    expect(event.workspacePath).toBe(target.workspacePath);
    expect(wire.topic).toBe(protocol.conversationTopic(target.sessionId));
    for (const result of assembler.accept(wire)) {
      if (result.kind === "fault")
        throw new Error(`会话帧无法解析：${result.fault.reasonCode}`);
      expect(result.deliveryKind).toBe("initial");
      if (result.frame.payload.kind !== "snapshot")
        throw new Error("原会话订阅没有返回初始快照。");
      return result.frame.payload.snapshot;
    }
  }
}

async function nextViewNotification(
  stream: CodeStream,
  service: string,
  revision: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for (;;) {
          const event = await nextHostServiceEvent(
            stream,
            service,
            "onDidChange",
          );
          if (event.data?.revision === revision) return event;
        }
      })(),
      new Promise<never>((_, reject) => {
        // 仅为公开通知的测试期限，不改变产品治理值。
        timer = setTimeout(
          () => reject(new Error("未收到对应修订的原服务通知")),
          1000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 校验实际凭据字段，诊断路径/文案中的 apiKey 名称不是凭据。 */
function expectNoPrivateConfigKeys(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(["apiKey", "headers", "encrypted_api_key"]).not.toContain(key);
    expectNoPrivateConfigKeys(child);
  }
}

describe.skipIf(!enabled)("Code 宿主真实数据库公开接口 integration", () => {
  it("原工作目录显式复用或独立创建，目录别名和并发选择保持真实项目及固定 Task 工作域", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ui-open-directory-"));
    const first = join(root, "甲", "同名目录");
    const second = join(root, "乙", "同名目录");
    const open = (
      path: string,
      choice?: { projectId?: string; directoryChoice?: "independent" },
    ) =>
      request("/api/code-ui/rpc", {
        service: "workspace",
        method: "open",
        args: [{ path, ...choice }],
      });
    const ids = new Set<string>();
    const streams: AbortController[] = [];
    let providerId = "";
    try {
      await mkdir(first, { recursive: true });
      await mkdir(second, { recursive: true });
      await symlink(first, join(root, "目录别名"));
      const opened = await open(first);
      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
      ids.add(opened.body.result.projectId);
      expect(opened.body.result).toMatchObject({
        name: "同名目录",
        path: await realpath(first),
      });
      const unselected = await Promise.all([
        open(first),
        open(join(root, "目录别名")),
        open(join(first, "..", "同名目录")),
      ]);
      for (const result of unselected) {
        expect(result.status, JSON.stringify(result.body)).toBe(409);
        expect(result.body.error.code).toBe("project_directory_conflict");
      }
      const concurrent = await Promise.all([
        open(first, { projectId: opened.body.result.projectId }),
        open(join(root, "目录别名"), {
          projectId: opened.body.result.projectId,
        }),
        open(join(first, "..", "同名目录"), {
          projectId: opened.body.result.projectId,
        }),
      ]);
      for (const result of concurrent) {
        expect(result.status).toBe(200);
        expect(result.body.result).toEqual(opened.body.result);
      }
      const other = await open(second);
      expect(other.status).toBe(200);
      ids.add(other.body.result.projectId);
      expect(other.body.result.projectId).not.toBe(
        opened.body.result.projectId,
      );
      expect(opened.body.result).not.toHaveProperty("canvasId");
      expect(other.body.result).not.toHaveProperty("canvasId");
      const projects = await request("/api/projects?kind=code");
      expect(
        projects.body.projects.filter((item: { id: string }) =>
          ids.has(item.id),
        ),
      ).toHaveLength(2);
      const restored = await request("/api/code-ui/workspaces");
      expect(restored.body.workspaces).toContainEqual(opened.body.result);
      expect(restored.body.workspaces).toContainEqual(other.body.result);
      const independent = await open(join(root, "目录别名"), {
        directoryChoice: "independent",
      });
      expect(independent.status, JSON.stringify(independent.body)).toBe(200);
      ids.add(independent.body.result.projectId);
      expect(independent.body.result.projectId).not.toBe(
        opened.body.result.projectId,
      );
      expect(independent.body.result.path).toBe(opened.body.result.path);
      const candidates = await request(
        `/api/projects/directory-candidates?path=${encodeURIComponent(first)}`,
      );
      expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
      expect(
        candidates.body.projects.map((project: { id: string }) => project.id),
      ).toEqual(
        expect.arrayContaining([
          opened.body.result.projectId,
          independent.body.result.projectId,
        ]),
      );
      expect(candidates.body.projects).toHaveLength(2);
      expect((await open(first)).status).toBe(409);
      expect(
        (await open(first, { projectId: independent.body.result.projectId }))
          .body.result,
      ).toEqual(independent.body.result);
      expect(
        (
          await request(
            `/api/projects/${independent.body.result.projectId}`,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(204);
      const providerRpc = (method: string, args: unknown[] = []) =>
        request("/api/code-ui/rpc", {
          service: "providerSettingsService",
          method,
          args,
        });
      const provider = await providerRpc("createPersonalProvider", [
        { providerName: "目录会话作用域验收" },
      ]);
      providerId = provider.body.result.providerId;
      await providerRpc("savePersonalProviderOverlay", [
        providerId,
        {
          api: {
            type: "openai-chat-completions",
            baseUrl: "https://example.invalid/v1",
          },
          access: { type: "api-key", apiKey: "integration-only-not-a-key" },
        },
      ]);
      await providerRpc("addPersonalModel", [providerId, "scope-model", {}]);
      const { stream, clientId } = await initializeCodeStream(streams);
      const createdSessions: string[] = [];
      for (const _round of [1, 2]) {
        const session = await stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: opened.body.result.path,
            projectId: opened.body.result.projectId,
            envelope: {
              commandId: randomUUID(),
              clientId,
              sessionId: null,
              type: "createSession",
              payload: {
                workspaceId: opened.body.result.projectId,
                config: {
                  modelSelection: {
                    providerId,
                    modelId: "scope-model",
                    options: {},
                  },
                },
              },
              issuedAt: Date.now(),
            },
          },
        ]);
        expect(session.status, JSON.stringify(session.body)).toBe(200);
        const ack = protocol.commandAckSchema.parse(session.body.result);
        expect(ack.status).toBe("accepted");
        if (ack.result?.type !== "createSession")
          throw new Error("工作目录创建没有返回真实 Task 身份。");
        createdSessions.push(ack.result.sessionId);
      }
      expect(new Set(createdSessions).size).toBe(2);
      for (const sessionId of createdSessions) {
        const scope = await request(`/api/code-ui/tasks/${sessionId}/scope`);
        expect(scope.status, JSON.stringify(scope.body)).toBe(200);
        expect(scope.body.scope).toMatchObject({
          taskId: sessionId,
          projectId: opened.body.result.projectId,
          rootDirectory: opened.body.result.path,
        });
        expect(scope.body.scope).not.toHaveProperty("canvasId");
      }
      const settings = (method: string, args: unknown[] = []) =>
        request("/api/code-ui/rpc", { service: "setting", method, args });
      const recent = [other.body.result.path, opened.body.result.path];
      const saved = await settings("update", [{ recentProjects: recent }]);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect((await settings("get")).body.result.recentProjects).toEqual(
        recent,
      );
      expect(
        (await settings("update", [{ recentProjects: [join(root, "缺失")] }]))
          .status,
      ).toBe(404);
      expect((await settings("get")).body.result.recentProjects).toEqual(
        recent,
      );
      const beforeInvalid = await request("/api/projects?kind=code");
      expect(beforeInvalid.status, JSON.stringify(beforeInvalid.body)).toBe(
        200,
      );
      for (const path of [join(root, "缺失"), "relative-path"]) {
        const rejected = await open(path);
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
        expect(rejected.body.error.code).toBe("code_ui_not_found");
        expect(rejected.body.error.message).toMatch(/目录|路径/);
      }
      const afterInvalid = await request("/api/projects?kind=code");
      expect(afterInvalid.status, JSON.stringify(afterInvalid.body)).toBe(200);
      const projectIds = (projects: Array<{ id: string }>) =>
        projects.map((project) => project.id).sort();
      expect(projectIds(afterInvalid.body.projects)).toEqual(
        projectIds(beforeInvalid.body.projects),
      );
      expect(
        (
          await request(
            `/api/projects/${opened.body.result.projectId}`,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(204);
      const lateOpen = await open(first, {
        projectId: opened.body.result.projectId,
      });
      expect(lateOpen.status).toBe(404);
      expect(lateOpen.body.error.code).toBe("code_ui_not_found");
      expect(
        (
          await settings("update", [
            { recentProjects: [opened.body.result.path] },
          ])
        ).status,
      ).toBe(404);
      expect(
        (await request("/api/code-ui/workspaces")).body.workspaces.some(
          (item: { projectId: string }) =>
            item.projectId === opened.body.result.projectId,
        ),
      ).toBe(false);
    } finally {
      for (const stream of streams) stream.abort();
      if (providerId)
        await request("/api/code-ui/rpc", {
          service: "providerSettingsService",
          method: "deletePersonalProvider",
          args: [providerId],
        });
      for (const id of ids)
        await request(`/api/projects/${id}`, undefined, "DELETE");
      await rm(root, { recursive: true, force: true });
    }
  });
  it("原目录选择器读取真实目录、隐藏项和 Unicode，符号链接保持原类型且不可用路径有可读错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-ui-directory-"));
    const rpc = (path: string, includeHidden?: boolean) =>
      request("/api/code-ui/rpc", {
        service: "file",
        method: "readdir",
        args: [
          {
            path,
            humanPurpose: "directory-picker",
            ...(includeHidden === undefined ? {} : { includeHidden }),
          },
        ],
      });
    try {
      await mkdir(join(dir, "中文目录"));
      await mkdir(join(dir, ".隐藏目录"));
      await writeFile(join(dir, "空文件.txt"), "");
      await symlink(join(dir, "中文目录"), join(dir, "链接目录"));
      await symlink(join(dir, "不存在"), join(dir, "损坏链接"));
      const visible = await rpc(dir);
      expect(visible.status, JSON.stringify(visible.body)).toBe(200);
      expect(visible.body.result).toEqual(
        expect.arrayContaining([
          {
            name: "中文目录",
            path: join(dir, "中文目录"),
            type: "directory",
          },
          {
            name: "链接目录",
            path: join(dir, "链接目录"),
            type: "directory",
            isSymbolicLink: true,
          },
        ]),
      );
      expect(visible.body.result).toHaveLength(2);
      expect(
        visible.body.result
          .slice(0, 2)
          .map((entry: { type: string }) => entry.type),
      ).toEqual(["directory", "directory"]);
      expect((await rpc(dir, true)).body.result).toContainEqual({
        name: ".隐藏目录",
        path: join(dir, ".隐藏目录"),
        type: "directory",
      });
      const empty = await rpc(join(dir, "中文目录"));
      expect(empty.status).toBe(200);
      expect(empty.body.result).toEqual([]);
      const spaced = join(dir, " 两侧空格 ");
      await mkdir(spaced);
      expect((await rpc(spaced)).status).toBe(200);
      for (const path of [
        join(dir, "缺失"),
        join(dir, "空文件.txt"),
        join(dir, "空文件.txt", "子目录"),
        join(dir, "损坏链接"),
        "relative-path",
      ]) {
        const rejected = await rpc(path);
        expect(rejected.status).toBe(404);
        expect(rejected.body.error.code).toBe("code_ui_not_found");
        expect(rejected.body.error.message).toMatch(/目录|路径/);
      }
      expect((await rpc(" ")).status).toBe(400);
      expect((await rpc(dir)).body.result).toContainEqual({
        name: " 两侧空格 ",
        path: spaced,
        type: "directory",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("Code 宿主 ready 使用实例持久重连间隔，刷新保留且非法限额拒绝", async () => {
    const original = await request("/api/instance/settings");
    expect(original.status).toBe(200);
    const value = instanceSettingsResponseSchema.parse(original.body).settings
      .codeUiReconnectDelayMs;
    const streams: AbortController[] = [];
    try {
      const saved = await request(
        "/api/instance/settings",
        { codeUiReconnectDelayMs: 250 },
        "PATCH",
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(
        instanceSettingsResponseSchema.parse(saved.body).settings
          .codeUiReconnectDelayMs,
      ).toBe(250);
      expect(
        (await request("/api/instance/settings")).body.settings
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
            "/api/instance/settings",
            { codeUiReconnectDelayMs: 0 },
            "PATCH",
          )
        ).status,
      ).toBe(400);
      expect(
        (await request("/api/instance/settings")).body.settings
          .codeUiReconnectDelayMs,
      ).toBe(250);
    } finally {
      for (const controller of streams) controller.abort();
      await request(
        "/api/instance/settings",
        { codeUiReconnectDelayMs: value },
        "PATCH",
      );
    }
  });
  it("原模型删除清理成员和精确规则，并发删除不丢失且迟到保存和启用不能复活", async () => {
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
  it("原模型恢复推荐保留停用、系统输入能力和原生扩展，清除手动能力与思考映射", async () => {
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    let providerId = "";
    const readModel = (view: ProviderSettingsView) => {
      const provider = view.providers.find(
        (item) => item.providerId === providerId,
      );
      if (!provider) throw new Error("恢复推荐的供应商不存在。");
      const model = provider.models[0];
      if (!model) throw new Error("恢复推荐的模型不存在。");
      return model;
    };
    try {
      const created = await rpc("createPersonalProvider", [
        { providerName: `恢复能力 ${randomUUID()}` },
      ]);
      providerId = created.body.result.providerId;
      const defaults = await rpc("resolveModelConfig", [
        { providerId, modelId: "custom-restore-inputs" },
      ]);
      expect(defaults.status, JSON.stringify(defaults.body)).toBe(200);
      const defaultMap: unknown =
        defaults.body.result.effectiveConfig?.optionSpecs?.reasoningLevel?.map;
      if (typeof defaultMap !== "string" || !defaultMap.trim())
        throw new Error("恢复推荐的默认思考映射不存在。");
      const customReasoningMap = '{"reasoning_effort": reasoningLevel}';
      const customConfig = ModelConfig.fromData({
        enabled: false,
        properties: {
          contextWindow: 260000,
          inputFormat: {
            supportsText: false,
            supportsImage: true,
            supportsVideo: true,
            supportsAudio: true,
            supportsPdf: true,
          },
        },
        optionSpecs: {
          maxOutputTokens: { max: 9000 },
          reasoningLevel: {
            values: ["low", "high"],
            map: customReasoningMap,
          },
        },
      }).toJSON();
      const added = await rpc("addPersonalModel", [
        providerId,
        "custom-restore-inputs",
        customConfig,
      ]);
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(readModel(added.body.result).personalExactConfig).toEqual(
        customConfig,
      );
      const original = await request("/api/provider-instances");
      expect(original.status, JSON.stringify(original.body)).toBe(200);
      const nativeProvider = original.body.instances.find(
        (item: { id: string }) => item.id === providerId,
      );
      const nativeModel = {
        ...nativeProvider.models[0],
        name: "保留的模型名称",
        extraBody: { temperature: 0.25 },
      };
      const extended = await request(
        `/api/provider-instances/${providerId}`,
        { models: [nativeModel] },
        "PATCH",
      );
      expect(extended.status, JSON.stringify(extended.body)).toBe(200);
      const current = await rpc("refresh");
      expect(current.status, JSON.stringify(current.body)).toBe(200);
      expect(readModel(current.body.result).personalExactConfig).toEqual(
        customConfig,
      );
      const personalConfig = readModel(current.body.result).personalExactConfig;
      if (!personalConfig) throw new Error("恢复推荐的个人配置不存在。");
      const input = {
        providerId,
        originalModelId: "custom-restore-inputs",
        nextModelId: "custom-restore-inputs",
        personalConfig: clearManualModelConfig(personalConfig),
        useRecommendedConfig: true,
        basedOnRevision: current.body.result.revision,
      };
      const restored = await rpc("savePersonalModelDraft", [input]);
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(readModel(restored.body.result).personalExactConfig).toEqual({
        enabled: false,
        properties: {
          inputFormat: { supportsText: false, supportsAudio: true },
        },
      });
      expect(readModel(restored.body.result)).toMatchObject({
        enabled: false,
        useRecommendedConfig: true,
        effectiveConfig: {
          enabled: false,
          properties: {
            contextWindow: 200000,
            inputFormat: {
              supportsText: false,
              supportsImage: false,
              supportsVideo: false,
              supportsAudio: true,
              supportsPdf: false,
            },
          },
          optionSpecs: {
            maxOutputTokens: { max: 32000 },
            reasoningLevel: { values: ["disabled", "enabled"] },
          },
        },
      });
      const restoredMap = readModel(restored.body.result).effectiveConfig
        .optionSpecs?.reasoningLevel?.map;
      expect(restoredMap).toBe(defaultMap);
      expect(restoredMap).not.toBe(customReasoningMap);
      expect((await rpc("refresh")).body.result).toEqual(restored.body.result);
      const nativeRead = await request("/api/provider-instances");
      expect(nativeRead.status, JSON.stringify(nativeRead.body)).toBe(200);
      expect(
        nativeRead.body.instances.find(
          (item: { id: string }) => item.id === providerId,
        ).models,
      ).toEqual([
        {
          ...nativeModel,
          contextWindow: 200000,
          maxOutputTokens: 32000,
          vision: false,
          inputModalities: ["audio"],
          reasoningEfforts: ["disabled", "enabled"],
        },
      ]);
      const repeated = await rpc("savePersonalModelDraft", [
        { ...input, basedOnRevision: restored.body.result.revision },
      ]);
      expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
      expect(repeated.body.result).toEqual(restored.body.result);
      expect((await request("/api/provider-instances")).body).toEqual(
        nativeRead.body,
      );
    } finally {
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原模型草稿原子改名与保存精确规则，拒绝同修订并发和跨供应商过期修订", async () => {
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
  it("原模型编辑器保留明确停用与原生容量，刷新保持成员和完整配置且不产生假模型", async () => {
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
        enabled: false,
        executable: false,
        selectable: false,
        useRecommendedConfig: true,
        personalExactConfig: {
          enabled: false,
          properties: { contextWindow: 256000 },
          optionSpecs: { maxOutputTokens: { max: 8192 } },
        },
        effectiveBuiltinConfig: {
          enabled: false,
          properties: { contextWindow: 256000 },
          optionSpecs: { maxOutputTokens: { max: 8192 } },
        },
        effectiveConfig: {
          enabled: false,
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
      expect(existing.body.result.effectiveConfig.enabled).toBe(false);
      const instances = await request("/api/provider-instances");
      const descriptor = instances.body.instances.find(
        (instance: { id: string }) => instance.id === providerId,
      ).models[0];
      expect(descriptor).toMatchObject({
        id: "模型-α",
        enabled: false,
        contextWindow: 256000,
        maxOutputTokens: 8192,
      });
      expect(descriptor).not.toHaveProperty("codeConfig");
    } finally {
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原供应商稀疏配置保存原格式与品牌字段，Key 和请求头只写，省略保留而明确 null 清除", async () => {
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
        {
          providerName: `写入 ${randomUUID()}`,
          initialConfig: {
            access: {
              type: "api-key",
              apiKeyManagementUrl: "https://example.invalid/initial-keys",
            },
          },
        },
      ]);
      expect(created.status).toBe(200);
      providerId = created.body.result.providerId;
      expect(
        selected(created.body.result.view)?.effectiveConfig.access,
      ).toEqual({
        type: "api-key",
        apiKeyManagementUrl: "https://example.invalid/initial-keys",
      });
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
      expect(
        saved.body.result.providers.find(
          (entry: ProviderSettingsView["providers"][number]) =>
            entry.providerId === providerId,
        )?.personalConfig.access,
      ).toMatchObject({
        type: "api-key",
        apiKey: "integration-credential-private",
      });
      const publicSelection = await request("/api/code-ui/rpc", {
        service: "modelSelectionService",
        method: "getView",
        args: [],
      });
      expectNoPrivateConfigKeys(publicSelection.body.result);
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
      const beforeClear = selected(updated.body.result);
      const clearUrl = {
        access: { type: "api-key", apiKeyManagementUrl: null },
      };
      const clearedUrl = await rpc("savePersonalProviderOverlay", [
        providerId,
        clearUrl,
        { expectedRevision: beforeClear?.configRevision },
      ]);
      expect(clearedUrl.status, JSON.stringify(clearedUrl.body)).toBe(200);
      const withoutUrl = selected(clearedUrl.body.result);
      expect(withoutUrl?.credentialConfigured).toBe(true);
      expect(withoutUrl?.effectiveConfig.access).toEqual({
        type: "api-key",
        apiKey: "integration-credential-private",
      });
      const repeated = await rpc("savePersonalProviderOverlay", [
        providerId,
        clearUrl,
        { expectedRevision: withoutUrl?.configRevision },
      ]);
      expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
      expect(repeated.body.result).toEqual(clearedUrl.body.result);
      const stale = await rpc("savePersonalProviderOverlay", [
        providerId,
        clearUrl,
        { expectedRevision: beforeClear?.configRevision },
      ]);
      expect(stale.status).toBe(409);
      const restoredUrl = await rpc("savePersonalProviderOverlay", [
        providerId,
        {
          access: {
            type: "api-key",
            apiKeyManagementUrl: "https://example.invalid/keys",
          },
        },
      ]);
      expect(restoredUrl.status, JSON.stringify(restoredUrl.body)).toBe(200);
      const cleared = await rpc("savePersonalProviderOverlay", [
        providerId,
        { access: { type: "api-key", apiKey: null }, api: { headers: null } },
      ]);
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(selected(cleared.body.result)).toMatchObject({
        credentialConfigured: false,
        executable: false,
        effectiveConfig: {
          access: { apiKeyManagementUrl: "https://example.invalid/keys" },
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
  it("原生成供应商设置读取管理链接，完整清除访问配置保留生成协议和模型", async () => {
    let providerId = "";
    try {
      const created = await request("/api/provider-instances", {
        name: `图片连接 ${randomUUID()}`,
        protocol: "google-image",
        baseUrl: "https://example.invalid/images",
        apiKey: "integration-image-credential-no-network",
        models: [{ id: "image-model", name: "图片", capability: "image" }],
        compat: {
          codeUi: { apiKeyManagementUrl: "https://example.invalid/image-keys" },
        },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      providerId = created.body.id;
      const loaded = await request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method: "getView",
        args: [],
      });
      expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
      expect(
        loaded.body.result.providers.find(
          (item: { providerId: string }) => item.providerId === providerId,
        ),
      ).toMatchObject({
        credentialConfigured: true,
        effectiveConfig: {
          access: { apiKeyManagementUrl: "https://example.invalid/image-keys" },
        },
      });
      const cleared = await request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method: "savePersonalProviderOverlay",
        args: [providerId, { access: null }],
      });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      const provider = cleared.body.result.providers.find(
        (item: { providerId: string }) => item.providerId === providerId,
      );
      expect(provider.credentialConfigured).toBe(false);
      expect(provider.effectiveConfig.access).toEqual({ type: "api-key" });
      const instances = await request("/api/provider-instances");
      expect(instances.status).toBe(200);
      expect(
        instances.body.instances.find(
          (item: { id: string }) => item.id === providerId,
        ),
      ).toMatchObject({
        protocol: "google-image",
        hasCredential: false,
        models: created.body.models,
      });
    } finally {
      if (providerId) {
        const deleted = await request(
          `/api/provider-instances/${providerId}`,
          undefined,
          "DELETE",
        );
        expect(deleted.status).toBe(204);
      }
    }
  });
  it("原设置保留停用模型与供应商候选，执行目录遵守各级开关，同值保存不推进修订", async () => {
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
      expect(selection.status, JSON.stringify(selection.body)).toBe(200);
      expectNoPrivateConfigKeys(selection.body.result);
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
        effectiveConfig: { visibility: "hidden" },
        models: [
          { modelId: "glm-4.5-air", enabled: false, executable: false },
          { modelId: "glm-4.6", enabled: true, executable: false },
        ],
      });
      const disabledSelection = await view("modelSelectionService");
      expect(
        disabledSelection.status,
        JSON.stringify(disabledSelection.body),
      ).toBe(200);
      expectNoPrivateConfigKeys(disabledSelection.body.result);
      expect(
        disabledSelection.body.result.providers.some(
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
      const reenabled = await request(
        `/api/provider-instances/${providerId}`,
        { enabled: true },
        "PATCH",
      );
      expect(reenabled.status, JSON.stringify(reenabled.body)).toBe(200);
      const restoredSelection = await view("modelSelectionService");
      expect(
        restoredSelection.status,
        JSON.stringify(restoredSelection.body),
      ).toBe(200);
      expectNoPrivateConfigKeys(restoredSelection.body.result);
      expect(
        restoredSelection.body.result.providers
          .find(
            (item: { providerId: string }) => item.providerId === providerId,
          )
          ?.models.map((model: { modelId: string }) => model.modelId),
      ).toEqual(["glm-4.6"]);
      const restoredSettings = await view();
      expect(
        restoredSettings.status,
        JSON.stringify(restoredSettings.body),
      ).toBe(200);
      expect(
        restoredSettings.body.result.providers.find(
          (item: { providerId: string }) => item.providerId === providerId,
        ),
      ).toMatchObject({
        enabled: true,
        effectiveConfig: { visibility: "visible" },
        models: [
          { modelId: "glm-4.5-air", enabled: false, executable: false },
          { modelId: "glm-4.6", enabled: true, executable: true },
        ],
      });
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
    const streams: AbortController[] = [];
    let providerId = "";
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    try {
      const { stream } = await initializeCodeStream(streams);
      const created = await rpc("createPersonalProvider", [
        { providerName: `通知草稿 ${randomUUID()}` },
      ]);
      expect(created.status).toBe(200);
      providerId = created.body.result.providerId;
      const notification = await nextViewNotification(
        stream,
        "providerSettingsService",
        created.body.result.view.revision,
      );
      expect(notification).toMatchObject({
        event: "service",
        service: "providerSettingsService",
        name: "onDidChange",
        data: created.body.result.view,
      });
      const selection = await request("/api/code-ui/rpc", {
        service: "modelSelectionService",
        method: "getView",
        args: [],
      });
      expect(selection.status, JSON.stringify(selection.body)).toBe(200);
      const selectable = await nextViewNotification(
        stream,
        "modelSelectionService",
        selection.body.result.revision,
      );
      expect(selectable).toMatchObject({
        event: "service",
        service: "modelSelectionService",
        name: "onDidChange",
        data: selection.body.result,
      });
      expect(selectable.data.revision).toBe(created.body.result.view.revision);
      const fresh = await rpc("refresh", ["integration:no-config-change"]);
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
      expect(fresh.body.result).toEqual(created.body.result.view);
      expect(
        (
          await nextViewNotification(
            stream,
            "providerSettingsService",
            fresh.body.result.revision,
          )
        ).data,
      ).toEqual(fresh.body.result);
      expect(
        (
          await nextViewNotification(
            stream,
            "modelSelectionService",
            selection.body.result.revision,
          )
        ).data,
      ).toEqual(selection.body.result);
      const removed = await rpc("deletePersonalProvider", [providerId]);
      expect(removed.status).toBe(200);
      providerId = "";
      const removalNotification = await nextViewNotification(
        stream,
        "providerSettingsService",
        removed.body.result.revision,
      );
      expect(removalNotification).toMatchObject({
        event: "service",
        service: "providerSettingsService",
        name: "onDidChange",
        data: removed.body.result,
      });
      expectNoPrivateConfigKeys(removed.body.result);
    } finally {
      for (const stream of streams) stream.abort();
      if (providerId) await rpc("deletePersonalProvider", [providerId]);
    }
  });
  it("原供应商创建操作保存真实无凭证无模型草稿，读取和刷新保持不可执行且不泄露凭证", async () => {
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
    const streams: AbortController[] = [];
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
      const stream = await openCodeStream(streams);
      const read = (path: string) =>
        request("/api/code-ui/rpc", {
          service: "file",
          method: "readTextFile",
          connectionId: stream.ready.hello.connectionId,
          args: [{ path, viewerScope: { kind: "project", projectId } }],
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
      for (const controller of streams) controller.abort();
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
          payload: {
            instanceId: projectId,
            config: { modelSelection: selection },
          },
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
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      projectId = created.body.project.id;
      const { stream, clientId } = await initializeCodeStream(streams);
      const command = await stream.rpc("sendConversationCommandV4", [
        {
          workspacePath: dir,
          projectId,
          envelope: {
            commandId: randomUUID(),
            clientId,
            sessionId: null,
            type: "createSession",
            payload: { workspaceId: projectId },
            issuedAt: Date.now(),
          },
        },
      ]);
      expect(command.status, JSON.stringify(command.body)).toBe(200);
      const createdAck = protocol.commandAckSchema.parse(command.body.result);
      expect(createdAck.status).toBe("accepted");
      if (createdAck.result?.type !== "createSession")
        throw new Error("订阅测试没有取得真实 Task 身份。");
      const sessionId = createdAck.result.sessionId;
      const persisted = await request(`/api/code-ui/sessions/${sessionId}`);
      expect(persisted.status, JSON.stringify(persisted.body)).toBe(200);
      const persistedSnapshot = protocol.conversationSnapshotSchema.parse(
        persisted.body.snapshot,
      );
      const subscription = await stream.rpc("subscribeConversationV4", [
        { workspacePath: dir, projectId, sessionId },
      ]);
      expect(subscription.status).toBe(200);
      const { ack } = protocol.v4ConversationSubscribeResultSchema.parse(
        subscription.body.result,
      );
      const snapshot = await readOwnedConversationSnapshot(stream, {
        subscriptionId: ack.subscriptionId,
        sessionId,
        workspacePath: dir,
      });
      expect(snapshot).toEqual(persistedSnapshot);
      expect(snapshot).toMatchObject({
        sessionId,
        control: { phase: "draft" },
      });
      stream.controller.abort();
      await stream.closed;
      const { stream: reconnected } = await initializeCodeStream(
        streams,
        clientId,
      );
      const foreign = await reconnected.rpc("resyncConversationV4", [
        {
          workspacePath: dir,
          subscriptionId: ack.subscriptionId,
          base: null,
        },
      ]);
      expect(foreign.status).toBe(404);
      expect(foreign.body.error.code).toBe("code_ui_not_found");
      const resumed = await reconnected.rpc("subscribeConversationV4", [
        {
          workspacePath: dir,
          projectId,
          sessionId,
          base: {
            logEpoch: snapshot.logEpoch,
            seq: snapshot.seq,
          },
        },
      ]);
      expect(resumed.status).toBe(200);
      const resumedAck = protocol.v4ConversationSubscribeResultSchema.parse(
        resumed.body.result,
      ).ack;
      expect(resumedAck.subscriptionId).not.toBe(ack.subscriptionId);
      expect(
        await readOwnedConversationSnapshot(reconnected, {
          subscriptionId: resumedAck.subscriptionId,
          sessionId,
          workspacePath: dir,
        }),
      ).toEqual(snapshot);
    } finally {
      for (const stream of streams) stream.abort();
      if (projectId)
        await request(`/api/projects/${projectId}`, undefined, "DELETE");
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("createSession 绑定真实Code项目/Task工作域；同键重放同身份、异参冲突", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ken-code-ui-host-"));
    let projectId = "";
    const streams: AbortController[] = [];
    try {
      const created = await request("/api/projects", {
        name: `Code UI 集成验收 ${randomUUID()}`,
        kind: "code",
        work_dir: dir,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const project = created.body.project;
      projectId = project.id;
      const { stream, clientId } = await initializeCodeStream(streams);
      const envelope = {
        commandId: randomUUID(),
        clientId,
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: projectId },
        issuedAt: Date.now(),
      };
      const call = (value: unknown) =>
        stream.rpc("sendConversationCommandV4", [
          { workspacePath: dir, projectId, envelope: value },
        ]);
      const first = await call(envelope);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const createdAck = protocol.commandAckSchema.parse(first.body.result);
      expect(createdAck.status).toBe("accepted");
      if (createdAck.result?.type !== "createSession")
        throw new Error("幂等创建测试没有取得真实 Task 身份。");
      const sessionId = createdAck.result.sessionId;
      const second = await call(envelope);
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(protocol.commandAckSchema.parse(second.body.result)).toMatchObject(
        {
          status: "duplicate",
          result: { type: "createSession", sessionId },
        },
      );
      expect(project).not.toHaveProperty("primaryCanvas");
      const scope = await request(`/api/code-ui/tasks/${sessionId}/scope`);
      expect(scope.status).toBe(200);
      expect(scope.body.scope).toMatchObject({
        taskId: sessionId,
        projectId,
        rootDirectory: await realpath(dir),
        additionalDirectories: [],
      });
      expect(scope.body.scope).not.toHaveProperty("canvasId");
      const snapshot = await request(`/api/code-ui/sessions/${sessionId}`);
      expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
      expect(
        protocol.conversationSnapshotSchema.parse(snapshot.body.snapshot),
      ).toMatchObject({
        sessionId,
        control: { phase: "draft" },
      });
      const conflict = await call({
        ...envelope,
        payload: { workspaceId: projectId, config: { planEnabled: true } },
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe("code_ui_command_conflict");
      const afterConflict = await request(`/api/code-ui/sessions/${sessionId}`);
      expect(afterConflict.status, JSON.stringify(afterConflict.body)).toBe(
        200,
      );
      expect(afterConflict.body.snapshot).toEqual(snapshot.body.snapshot);
    } finally {
      for (const stream of streams) stream.abort();
      if (projectId)
        await request(`/api/projects/${projectId}`, undefined, "DELETE");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
