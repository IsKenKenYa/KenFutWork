import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import multipart from "@fastify/multipart";
import { instanceSettingsSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalActor } from "../features/local-instance/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import type {
  SkillImportSourceStager,
  SkillImportStagedSource,
} from "../features/skills/import-source-staging.js";
import { registerSkillImportSourceRoutes } from "./skill-import-sources.js";

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const ACTOR: LocalActor = Object.freeze({
  instanceId: "00000000-0000-4000-8000-0000000000a1",
  accessClientId: null,
});

type SettingsFixture = ReturnType<typeof instanceSettingsSchema.parse>;

/** 暂存桩：记录调用、把 zip 流读干净、release 按真实登记表语义工作。 */
function createStagedSourcesStub() {
  const calls: Array<Record<string, unknown>> = [];
  const registry = new Map<string, SkillImportStagedSource>();
  let nextId = 0;
  const make = (
    kind: SkillImportStagedSource["kind"],
    label: string,
    instanceId: string,
  ): SkillImportStagedSource => ({
    id: `staged-${nextId++}`,
    instanceId,
    kind,
    label,
    rootPath: "<stub>",
    workDirectory: "<stub>",
    sourceKey: `${kind}:stub`,
    createdAt: 0,
  });
  const stager: SkillImportSourceStager = {
    async stageGit(input) {
      const source = make("git", input.url, input.instanceId);
      registry.set(source.id, source);
      calls.push({ op: "git", ...input });
      return source;
    },
    async stageZip(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) {
        chunks.push(chunk as Buffer);
      }
      const source = make("zip", input.fileName, input.instanceId);
      registry.set(source.id, source);
      calls.push({
        op: "zip",
        fileName: input.fileName,
        limits: input.limits,
        instanceId: input.instanceId,
        body: Buffer.concat(chunks),
      });
      return source;
    },
    async list(instanceId) {
      return [...registry.values()].filter(
        (source) => source.instanceId === instanceId,
      );
    },
    async find(instanceId, id) {
      return registry.get(id)?.instanceId === instanceId
        ? registry.get(id)
        : undefined;
    },
    async release(instanceId, id) {
      const source = registry.get(id);
      if (!source || source.instanceId !== instanceId) return false;
      registry.delete(id);
      return true;
    },
    async releaseAll(instanceId) {
      for (const [id, source] of [...registry]) {
        if (source.instanceId === instanceId) registry.delete(id);
      }
    },
    dispose() {
      registry.clear();
    },
  };
  return { stager, calls, registry };
}

async function fixture(overrides: {
  settings?: Partial<SettingsFixture>;
  unauthenticated?: boolean;
  checkUrlPolicy?: (
    url: string,
  ) => { decision: "allow" | "deny"; reason?: string } | undefined;
}) {
  const app = Fastify();
  // 与 app.ts 同口径：全局 multipart 插件；本路由再按实例预算放行单文件体积。
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });
  cleanups.push(() => void app.close());
  const settings = instanceSettingsSchema.parse({
    defaultModel: "",
    ...(overrides.settings ?? {}),
  });
  const settingsService = {
    getInstanceSettings: async () => settings,
  } as Pick<SettingsService, "getInstanceSettings">;
  const stagedSources = createStagedSourcesStub();
  // 本机接入的真实流程由 local-access 自己的测试覆盖；这里只区分「有/无凭据」。
  const localAccess = {
    authenticate: async () => (overrides.unauthenticated ? null : ACTOR),
  };
  const localInstance = { resolve: async () => ACTOR };
  await registerSkillImportSourceRoutes(app, {
    localAccess: localAccess as never,
    localInstance: localInstance as never,
    settings: settingsService,
    stagedSources: stagedSources.stager,
    checkUrlPolicy: overrides.checkUrlPolicy,
    gitBinary: "git",
  });
  return { app, stagedSources };
}

const BOUNDARY = "----kfw-skill-import-test";

function multipartBody(
  fileName: string,
  content: Buffer,
  mimetype = "application/zip",
): { payload: Buffer; contentType: string } {
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

const encoder = new TextEncoder();

describe("技能导入来源路由", () => {
  it("不带本机凭据一律 401", async () => {
    const { app } = await fixture({ unauthenticated: true });
    const response = await app.inject({
      method: "post",
      path: "/api/skills/import-sources/git",
      payload: { url: "https://github.com/anthropics/skills" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("git 地址必须 https 且写到仓库名，不进暂存", async () => {
    const { app, stagedSources } = await fixture({});
    for (const url of ["http://github.com/a/b", "https://github.com/owner"]) {
      const response = await app.inject({
        method: "post",
        path: "/api/skills/import-sources/git",
        payload: { url },
      });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().error.code).toBe("skill_import_source_failed");
    }
    expect(stagedSources.calls).toEqual([]);
  });

  it("请求体不是 { url } 时按请求内容无效处理", async () => {
    const { app } = await fixture({});
    const response = await app.inject({
      method: "post",
      path: "/api/skills/import-sources/git",
      payload: { address: "https://github.com/a/b" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("请求内容无效");
  });

  it("被网络安全规则拒绝的地址给 403 与规则原因，不进暂存", async () => {
    const { app, stagedSources } = await fixture({
      checkUrlPolicy: () => ({
        decision: "deny",
        reason: "该域名不在允许列表。",
      }),
    });
    const response = await app.inject({
      method: "post",
      path: "/api/skills/import-sources/git",
      payload: { url: "https://git.internal/a/b" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("skill_import_source_denied");
    expect(response.json().error.message).toBe("该域名不在允许列表。");
    expect(stagedSources.calls).toEqual([]);
  });

  it("合法 git 地址进入暂存，limits 来自实例设置", async () => {
    const { app, stagedSources } = await fixture({});
    const response = await app.inject({
      method: "post",
      path: "/api/skills/import-sources/git",
      payload: { url: "https://github.com/anthropics/skills.git/" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.source.kind).toBe("git");
    expect(body.source.label).toBe("https://github.com/anthropics/skills");
    expect(stagedSources.calls).toEqual([
      {
        op: "git",
        url: "https://github.com/anthropics/skills",
        instanceId: ACTOR.instanceId,
        binary: "git",
        limits: {
          timeoutMs: 120_000,
          maxBytes: 20_971_520,
          maxEntries: 10_000,
        },
      },
    ]);
  });

  it("zip 以表单上传，文件名规范化后进入暂存", async () => {
    const { app, stagedSources } = await fixture({});
    const content = Buffer.from(
      zipSync({ "SKILL.md": encoder.encode("内容") }),
    );
    const { payload, contentType } = multipartBody("demo 技能.zip", content);
    const response = await app.inject({
      method: "post",
      path: "/api/skills/import-sources/zip",
      headers: { "content-type": contentType },
      payload,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.source.kind).toBe("zip");
    expect(body.source.label).toBe("demo 技能.zip");
    expect(stagedSources.calls).toHaveLength(1);
    expect(stagedSources.calls[0]?.op).toBe("zip");
    expect(stagedSources.calls[0]?.fileName).toBe("demo 技能.zip");
    expect(stagedSources.calls[0]?.body).toEqual(content);
  });

  it("非 zip 类型的上传被拒绝", async () => {
    const { app, stagedSources } = await fixture({});
    const { payload, contentType } = multipartBody(
      "notes.txt",
      Buffer.from("文本"),
      "text/plain",
    );
    const response = await app.inject({
      method: "post",
      path: "/api/skills/import-sources/zip",
      headers: { "content-type": contentType },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("只支持 ZIP 压缩包。");
    expect(stagedSources.calls).toEqual([]);
  });

  it("缺少 file 字段时说明期望的表单格式", async () => {
    const { app } = await fixture({});
    const response = await app.inject({
      method: "post",
      path: "/api/skills/import-sources/zip",
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="other"\r\n\r\nx\r\n--${BOUNDARY}--\r\n`,
      ),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("multipart 的 file 字段");
  });

  it("上传超过实例设置的字节预算给 413，不进暂存", async () => {
    const { app, stagedSources } = await fixture({
      settings: { skillImportSourceMaxBytes: 1_048_576 },
    });
    // 随机字节不可压缩，保证 zip 本体超过 1 MB（全零会被 deflate 压到几 KB）
    const { payload, contentType } = multipartBody(
      "big.zip",
      Buffer.from(randomBytes(2 * 1_048_576)),
    );
    const response = await app.inject({
      method: "post",
      path: "/api/skills/import-sources/zip",
      headers: { "content-type": contentType },
      payload,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("skill_import_source_failed");
    expect(response.json().error.message).toContain("调大");
    // 截断的包先暂存、核对标志后立即撤销：请求结束后不保留任何暂存来源
    expect(stagedSources.calls).toHaveLength(1);
    expect(stagedSources.registry.size).toBe(0);
  });

  it("不是表单方式的请求说明表单格式", async () => {
    const { app } = await fixture({});
    const response = await app.inject({
      method: "post",
      path: "/api/skills/import-sources/zip",
      payload: { url: "https://github.com/a/b" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("表单");
  });

  it("释放已暂存的来源返回 204，再释放同一个返回 404", async () => {
    const { app, stagedSources } = await fixture({});
    const staged = await stagedSources.stager.stageZip({
      instanceId: ACTOR.instanceId,
      fileName: "demo.zip",
      stream: ReadableOf(Buffer.from("zip")),
      limits: { timeoutMs: 1_000, maxBytes: 1_048_576, maxEntries: 10 },
    });
    const first = await app.inject({
      method: "delete",
      path: `/api/skills/import-sources/${staged.id}`,
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: "delete",
      path: `/api/skills/import-sources/${staged.id}`,
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe("skill_import_source_not_found");
  });

  it("释放别的实例的来源按不存在处理", async () => {
    const { app, stagedSources } = await fixture({});
    const staged = await stagedSources.stager.stageZip({
      instanceId: "00000000-0000-4000-8000-999999999999",
      fileName: "other.zip",
      stream: ReadableOf(Buffer.from("zip")),
      limits: { timeoutMs: 1_000, maxBytes: 1_048_576, maxEntries: 10 },
    });
    const response = await app.inject({
      method: "delete",
      path: `/api/skills/import-sources/${staged.id}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("skill_import_source_not_found");
  });
});

function ReadableOf(content: Buffer): Readable {
  return Readable.from([content]);
}
