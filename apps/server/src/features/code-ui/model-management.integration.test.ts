import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "统一供应商管理的原 RPC integration",
  () => {
    it("原卡编辑生成及Flow地址时保留真实协议，不采纳聊天表单的缺省协议", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const stream = await fixture.client.openCodeStream();
        for (const protocol of ["google-image", "dify-engine"]) {
          const created = await fixture.client.request(
            "/api/provider-instances",
            { name: protocol, protocol, models: [] },
          );
          expect(created.status).toBe(201);
          const saved = await fixture.client.request("/api/code-ui/rpc", {
            connectionId: stream.ready.hello.connectionId,
            service: "providerSettingsService",
            method: "savePersonalProviderOverlay",
            args: [
              created.body.id,
              {
                api: {
                  type: "anthropic-messages",
                  baseUrl: "https://updated.example.invalid",
                },
              },
              { expectedRevision: created.body.configRevision },
            ],
          });
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          const rest = await fixture.client.request("/api/provider-instances");
          expect(
            rest.body.instances.find(
              (entry: { id: string }) => entry.id === created.body.id,
            ),
          ).toMatchObject({
            protocol,
            baseUrl: "https://updated.example.invalid",
          });
        }
      } finally {
        await fixture.close();
      }
    }, 90_000);

    it("生成模型原启停、排序与删除保存同一定义，删除后的草稿不能复活模型", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const stream = await fixture.client.openCodeStream();
        const rpc = (method: string, args: unknown[]) =>
          fixture.client.request("/api/code-ui/rpc", {
            connectionId: stream.ready.hello.connectionId,
            service: "providerSettingsService",
            method,
            args,
          });
        const created = await fixture.client.request(
          "/api/provider-instances",
          {
            name: "生成操作",
            protocol: "metaso",
            models: [
              { id: "图像/中文", name: "图像", capability: "image" },
              {
                id: "video",
                name: "视频",
                capability: "video",
                videoGeneration: { durations: [6, 12] },
              },
            ],
          },
        );
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const providerId = created.body.id;
        const toggled = await rpc("setPersonalModelEnabled", [
          providerId,
          "video",
          false,
        ]);
        expect(toggled.status, JSON.stringify(toggled.body)).toBe(200);
        const sorted = await rpc("reorderPersonalModels", [
          providerId,
          ["video", "图像/中文"],
        ]);
        expect(sorted.status, JSON.stringify(sorted.body)).toBe(200);
        const beforeDelete = await fixture.client.request(
          "/api/provider-instances",
        );
        const instance = beforeDelete.body.instances[0];
        expect(instance.models).toEqual([
          {
            id: "video",
            name: "视频",
            capability: "video",
            enabled: false,
            videoGeneration: { durations: [6, 12] },
          },
          { id: "图像/中文", name: "图像", capability: "image" },
        ]);
        const deleted = await rpc("deletePersonalModel", [providerId, "video"]);
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        const rest = await fixture.client.request("/api/provider-instances");
        expect(
          rest.body.instances[0].models.map(
            (model: { id: string }) => model.id,
          ),
        ).toEqual(["图像/中文"]);
        const late = await rpc("saveManagedModel", [
          {
            providerId,
            expectedRevision: rest.body.instances[0].configRevision,
            originalModelId: "video",
            model: instance.models[0],
          },
        ]);
        expect(late.status, JSON.stringify(late.body)).toBe(404);
        const final = await fixture.client.request("/api/provider-instances");
        expect(final.body.instances[0].models).toEqual(
          rest.body.instances[0].models,
        );
      } finally {
        await fixture.close();
      }
    }, 90_000);

    it("生成供应商连接更新与凭据清除沿统一管理RPC保存，普通REST不返回秘密值", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const stream = await fixture.client.openCodeStream();
        const created = await fixture.client.request(
          "/api/provider-instances",
          {
            name: "图像连接",
            protocol: "google-image",
            apiKey: "fixture-no-external-call",
            models: [{ id: "image", name: "图像", capability: "image" }],
          },
        );
        expect(created.status).toBe(201);
        const saved = await fixture.client.request("/api/code-ui/rpc", {
          connectionId: stream.ready.hello.connectionId,
          service: "providerSettingsService",
          method: "saveManagedProvider",
          args: [
            {
              providerId: created.body.id,
              patch: {
                baseUrl: "https://images.example.invalid/v1",
                apiKey: null,
                expectedRevision: created.body.configRevision,
              },
            },
          ],
        });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const rest = await fixture.client.request("/api/provider-instances");
        expect(rest.status).toBe(200);
        expect(rest.body.instances[0]).toMatchObject({
          baseUrl: "https://images.example.invalid/v1",
          hasCredential: false,
        });
        expect(JSON.stringify(rest.body)).not.toContain(
          "fixture-no-external-call",
        );
      } finally {
        await fixture.close();
      }
    }, 90_000); // 独占实例的测试凭据，不碰已配置供应商。

    it("统一管理保存生成供应商及实例默认，不建立隐式Task工作域", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const stream = await fixture.client.openCodeStream();
        const rpc = (method: string, args: unknown[]) =>
          fixture.client.request("/api/code-ui/rpc", {
            connectionId: stream.ready.hello.connectionId,
            service: "providerSettingsService",
            method,
            args,
          });
        const created = await fixture.client.request(
          "/api/provider-instances",
          {
            name: "统一图像配置",
            protocol: "google-image",
            apiKey: "fixture-no-external-call",
            models: [{ id: "image", name: "图像", capability: "image" }],
          },
        );
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const providerId = created.body.id;
        const defaults = {
          chat: null,
          image: { mode: "manual", models: [{ providerId, modelId: "image" }] },
          video: { mode: "auto" },
        };
        const saved = await rpc("saveModelDefaults", [defaults]);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.result).toEqual(defaults);
        const rest = await fixture.client.request("/api/instance/settings");
        expect(rest.status).toBe(200);
        expect(rest.body.settings.modelDefaults).toEqual(defaults);
        const read = await rpc("getModelDefaults", []);
        expect(read.status).toBe(200);
        expect(read.body.result).toEqual(defaults);
      } finally {
        await fixture.close();
      }
    }, 90_000); // 实例RPC不携带Project或Task，只操作独占夹具。

    it("原管理RPC编辑生成能力与普通REST读面使用同一模型定义和CAS", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const stream = await fixture.client.openCodeStream();
        const created = await fixture.client.request(
          "/api/provider-instances",
          {
            name: "视频配置",
            protocol: "metaso",
            apiKey: "fixture-no-external-call",
            models: [{ id: "video", name: "视频", capability: "video" }],
          },
        );
        expect(created.status).toBe(201);
        const saved = await fixture.client.request("/api/code-ui/rpc", {
          connectionId: stream.ready.hello.connectionId,
          service: "providerSettingsService",
          method: "saveManagedModel",
          args: [
            {
              providerId: created.body.id,
              expectedRevision: created.body.configRevision,
              originalModelId: "video",
              model: {
                id: "video",
                name: "视频",
                capability: "video",
                videoGeneration: {
                  durations: [6, 10],
                  aspectRatios: ["16:9"],
                  firstLastFrame: true,
                  audio: false,
                },
              },
            },
          ],
        });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const rest = await fixture.client.request("/api/provider-instances");
        expect(rest.status).toBe(200);
        expect(rest.body.instances[0].models).toEqual([
          {
            id: "video",
            name: "视频",
            capability: "video",
            videoGeneration: {
              durations: [6, 10],
              aspectRatios: ["16:9"],
              firstLastFrame: true,
              audio: false,
            },
          },
        ]);
        const stale = await fixture.client.request("/api/code-ui/rpc", {
          connectionId: stream.ready.hello.connectionId,
          service: "providerSettingsService",
          method: "saveManagedModel",
          args: [
            {
              providerId: created.body.id,
              expectedRevision: created.body.configRevision,
              originalModelId: "video",
              model: { id: "video", name: "迟到覆盖", capability: "video" },
            },
          ],
        });
        expect(stale.status, JSON.stringify(stale.body)).toBe(409);
      } finally {
        await fixture.close();
      }
    }, 90_000); // 独占PG/HTTP，不使用内部服务替身。

    it("无项目上下文的原设置读面展示真实图像、视频和Flow连接，聊天选择不混入生成模型", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const stream = await fixture.client.openCodeStream();
        const connectionId = stream.ready.hello.connectionId;
        for (const provider of [
          {
            name: "图像供应商",
            protocol: "google-image",
            models: [
              {
                id: "image/中文",
                name: "参考图编辑",
                capability: "image-edit",
                imageGeneration: { modes: ["edit"], maxInputImages: 2 },
              },
            ],
          },
          {
            name: "视频供应商",
            protocol: "metaso",
            models: [
              {
                id: "video",
                name: "首尾帧视频",
                capability: "video",
                videoGeneration: {
                  durations: [6, 10],
                  firstLastFrame: true,
                },
              },
            ],
          },
          { name: "Flow连接", protocol: "dify-engine", models: [] },
        ]) {
          const created = await fixture.client.request(
            "/api/provider-instances",
            { ...provider, apiKey: "fixture-no-external-call" },
          );
          expect(created.status, JSON.stringify(created.body)).toBe(201);
        }
        const settings = await fixture.client.request("/api/code-ui/rpc", {
          connectionId,
          service: "providerSettingsService",
          method: "getView",
          args: [],
        });
        expect(settings.status, JSON.stringify(settings.body)).toBe(200);
        expect(
          settings.body.result.providers.map(
            (provider: {
              providerName: string;
              native: { protocol: string };
            }) => [provider.providerName, provider.native.protocol],
          ),
        ).toEqual([
          ["图像供应商", "google-image"],
          ["视频供应商", "metaso"],
          ["Flow连接", "dify-engine"],
        ]);
        const selection = await fixture.client.request("/api/code-ui/rpc", {
          connectionId,
          service: "modelSelectionService",
          method: "getView",
          args: [],
        });
        expect(selection.status, JSON.stringify(selection.body)).toBe(200);
        expect(selection.body.result.providers).toEqual([]);
      } finally {
        await fixture.close();
      }
    }, 90_000); // 仅独占真实 PG/HTTP，未调用外部生成接口。
  },
);
