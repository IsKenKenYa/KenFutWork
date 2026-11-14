import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceSettings } from "@kenfutwork/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { LocalActor } from "../local-instance/types.js";
import {
  createMemorySaveTool,
  createMemorySearchTool,
  createProjectMemoryPromptSection,
} from "./consumer.js";
import { createProjectMemoryService } from "./project-memory.js";

const actor: LocalActor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "33333333-3333-4333-8333-333333333333";
const canvasId = "44444444-4444-4444-8444-444444444444";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createFixture(options?: {
  memoryEnabled?: boolean;
  codeReadMaxBytes?: number;
  codeReadPageCharacters?: number;
  canvasProjectId?: string;
  canvasError?: Error;
  legacyItems?: Array<{ key: string; value: unknown }>;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "kfw-memory-"));
  fixtures.push(dataDir);
  const preferences = {
    memoryEnabled: options?.memoryEnabled ?? true,
  };
  const settings = {
    codeReadMaxBytes: options?.codeReadMaxBytes ?? 4_000,
    codeReadPageCharacters: options?.codeReadPageCharacters ?? 300,
  } as unknown as InstanceSettings;
  const legacyItems = options?.legacyItems ?? [];
  const store = {
    search: async () => legacyItems,
  };
  const memory = createProjectMemoryService({
    dataDir,
    projects: {
      listProjects: async () => [
        {
          id: projectId,
          name: "记忆测试项目",
        },
        {
          id: otherProjectId,
          name: "另一个项目",
        },
      ],
    } as never,
    localInstance: {
      resolve: async (value: LocalActor) => ({
        instanceId: value.instanceId,
      }),
    } as never,
    preferences: {
      readHumanPreferences: async () => preferences,
    } as never,
    settings: {
      getInstanceSettings: async () => settings,
    } as never,
    canvases: {
      getCanvas: async (_value: LocalActor, value: string) => {
        if (options?.canvasError) throw options.canvasError;
        if (value !== canvasId) throw new Error("画布不存在。");
        return { projectId: options?.canvasProjectId ?? projectId };
      },
    } as never,
    agentPersistence: {
      getPersistence: async () => ({ store }),
    } as never,
  });
  return { dataDir, memory, preferences, settings, store };
}

describe("项目长期记忆服务", () => {
  it("未开启记忆时不读不写，目录为空也返回空列表", async () => {
    const { memory } = await createFixture({ memoryEnabled: false });
    expect(await memory.isEnabled(actor.instanceId)).toBe(false);
    expect(await memory.listProjectMemories(actor)).toEqual([]);
    await expect(
      memory.saveMemory(actor, {
        projectId,
        title: "偏好",
        content: "用户喜欢简短回复",
      }),
    ).rejects.toThrow("记忆功能已关闭");
    expect(await memory.readIndex(actor.instanceId, projectId)).toBeNull();
  });

  it("保存写入独立文件与索引，列表与读取都能拿到真实内容", async () => {
    const { memory } = await createFixture();
    const saved = await memory.saveMemory(actor, {
      projectId,
      title: "构建命令",
      content: "pnpm --filter @kenfutwork/server test",
    });
    expect(saved.fileName).toBe("构建命令.md");

    const index = await readFile(
      join(memory.memoryDirectory(projectId), "MEMORY.md"),
      "utf8",
    );
    expect(index).toContain("[构建命令](构建命令.md)");
    expect(index).toContain("pnpm --filter @kenfutwork/server test");

    const catalog = await memory.listProjectMemories(actor);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      id: projectId,
      label: "记忆测试项目",
    });
    expect(catalog[0]?.files.map((file) => file.name)).toEqual([
      "MEMORY.md",
      "构建命令.md",
    ]);
    expect(catalog[0]?.files[0]?.kind).toBe("index");

    const read = await memory.readProjectMemoryFile(actor, {
      workspaceId: projectId,
      fileName: "构建命令.md",
    });
    expect(read.content.trim()).toBe("pnpm --filter @kenfutwork/server test");
    expect(read.updatedAt).toBeGreaterThan(0);
  });

  it("同名标题追加序号，不覆盖已有记忆", async () => {
    const { memory } = await createFixture();
    await memory.saveMemory(actor, {
      projectId,
      title: "测试偏好",
      content: "第一条",
    });
    const second = await memory.saveMemory(actor, {
      projectId,
      title: "测试偏好",
      content: "第二条",
    });
    expect(second.fileName).toBe("测试偏好-2.md");
    const catalog = await memory.listProjectMemories(actor);
    expect(catalog[0]?.files.map((file) => file.name)).toEqual([
      "MEMORY.md",
      "测试偏好-2.md",
      "测试偏好.md",
    ]);
  });

  it("服务重建后仍能读到之前写入的记忆（刷新后保留）", async () => {
    const first = await createFixture();
    await first.memory.saveMemory(actor, {
      projectId,
      title: "部署",
      content: "发布前先跑全量测试",
    });
    const second = createProjectMemoryService({
      dataDir: first.dataDir,
      projects: {
        listProjects: async () => [],
      } as never,
      localInstance: {
        resolve: async (value: LocalActor) => ({
          instanceId: value.instanceId,
        }),
      } as never,
      preferences: {
        readHumanPreferences: async () => ({ memoryEnabled: true }),
      },
      settings: {
        getInstanceSettings: async () =>
          ({
            codeReadMaxBytes: 4_000,
            codeReadPageCharacters: 300,
          }) as unknown as InstanceSettings,
      } as never,
      canvases: {
        getCanvas: async () => ({ projectId }),
      } as never,
      agentPersistence: {
        getPersistence: async () => ({ store: { search: async () => [] } }),
      } as never,
    });
    const catalog = await second.listProjectMemories(actor);
    expect(catalog[0]?.files.some((file) => file.name === "部署.md")).toBe(
      true,
    );
  });

  it("拒绝空标题、空正文、越界文件名与超限文件", async () => {
    const { memory } = await createFixture({
      codeReadMaxBytes: 20,
    });
    await expect(
      memory.saveMemory(actor, { projectId, title: " ", content: "正文" }),
    ).rejects.toThrow("标题不能为空");
    await expect(
      memory.saveMemory(actor, { projectId, title: "标题", content: " " }),
    ).rejects.toThrow("正文不能为空");
    await expect(
      memory.saveMemory(actor, {
        projectId,
        title: "标题",
        content: "这段正文超过二十字节",
      }),
    ).rejects.toThrow("超过可保存大小");

    await mkdir(memory.memoryDirectory(projectId), { recursive: true });
    await writeFile(
      join(memory.memoryDirectory(projectId), "大文件.md"),
      "0123456789012345678901234567890",
      "utf8",
    );
    await expect(
      memory.readProjectMemoryFile(actor, {
        workspaceId: projectId,
        fileName: "大文件.md",
      }),
    ).rejects.toThrow("超过可读取大小");
    await expect(
      memory.readProjectMemoryFile(actor, {
        workspaceId: projectId,
        fileName: "../MEMORY.md",
      }),
    ).rejects.toThrow("路径无效");
    await expect(
      memory.readProjectMemoryFile(actor, {
        workspaceId: projectId,
        fileName: "不存在.md",
      }),
    ).rejects.toThrow("不存在");
  });

  it("只有存在记忆文件的项目出现在目录里", async () => {
    const { memory } = await createFixture();
    await memory.saveMemory(actor, {
      projectId,
      title: "条目",
      content: "正文",
    });
    const catalog = await memory.listProjectMemories(actor);
    expect(catalog.map((workspace) => workspace.id)).toEqual([projectId]);
    expect(catalog.some((workspace) => workspace.id === otherProjectId)).toBe(
      false,
    );
  });
});

describe("项目记忆召回", () => {
  it("索引与正文都能命中，关键词大小写不敏感", async () => {
    const { memory } = await createFixture();
    await memory.saveMemory(actor, {
      projectId,
      title: "Build Command",
      content: "使用 PNPM 构建\n构建前先跑测试",
    });
    const result = await memory.searchMemories(actor, {
      projectId,
      query: "pnpm",
    });
    expect(result.matches.map((match) => match.fileName)).toEqual([
      "MEMORY.md",
      "build-command.md",
    ]);
    expect(result.matches[0]?.title).toBe("记忆索引");
    expect(result.matches[1]?.title).toBe("Build Command");
    expect(result.truncated).toBe(false);
  });

  it("多个关键词全部命中才算匹配", async () => {
    const { memory } = await createFixture();
    await memory.saveMemory(actor, {
      projectId,
      title: "发布流程",
      content: "发布前跑全量测试\n只跑单元测试不算发布",
    });
    const result = await memory.searchMemories(actor, {
      projectId,
      query: "发布 全量",
    });
    expect(result.matches.map((match) => match.snippet)).toEqual([
      "- [发布流程](发布流程.md) — 发布前跑全量测试",
      "发布前跑全量测试",
    ]);
  });

  it("不跨项目：只搜当前项目目录", async () => {
    const { memory } = await createFixture();
    await memory.saveMemory(actor, {
      projectId: otherProjectId,
      title: "另一个项目",
      content: "只有另一个项目知道的口令",
    });
    const result = await memory.searchMemories(actor, {
      projectId,
      query: "口令",
    });
    expect(result.matches).toEqual([]);
  });

  it("超过单次读取上限时截断并如实标记", async () => {
    const { memory } = await createFixture({ codeReadPageCharacters: 8 });
    await memory.saveMemory(actor, {
      projectId,
      title: "长记忆",
      content: "这是一条很长的记忆内容用于确认截断行为",
    });
    const result = await memory.searchMemories(actor, {
      projectId,
      query: "很长的记忆",
    });
    expect(result.truncated).toBe(true);
    const total = result.matches.reduce(
      (sum, match) => sum + match.snippet.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(8);
    for (const match of result.matches)
      expect(match.snippet.length).toBeLessThanOrEqual(8);
  });

  it("关闭记忆或搜索词为空时快速失败", async () => {
    const disabled = await createFixture({ memoryEnabled: false });
    await expect(
      disabled.memory.searchMemories(actor, { projectId, query: "构建" }),
    ).rejects.toThrow("记忆功能已关闭");
    const { memory } = await createFixture();
    await expect(
      memory.searchMemories(actor, { projectId, query: "   " }),
    ).rejects.toThrow("搜索词不能为空");
  });

  it("工具在未选定项目或缺少参数时拒绝，命中项目时返回结果", async () => {
    const { memory } = await createFixture();
    await memory.saveMemory(actor, {
      projectId,
      title: "画布约定",
      content: "设计稿命名用中文",
    });
    const tool = createMemorySearchTool(memory);
    await expect(
      tool.execute({ query: "" }, {
        actor,
        runId: "run-search",
        signal: new AbortController().signal,
        canvasId,
        workContext: { preset: "design", canvasId },
      } as never),
    ).rejects.toThrow("需要 query 参数");
    await expect(
      tool.execute({ query: "命名" }, {
        actor,
        runId: "run-search-2",
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow("Code Task 或 Design 画布");
    const result = await tool.execute({ query: "命名" }, {
      actor,
      runId: "run-search-3",
      signal: new AbortController().signal,
      canvasId,
      workContext: { preset: "design", canvasId },
    } as never);
    expect(result).toEqual(
      expect.objectContaining({
        truncated: false,
        matches: expect.arrayContaining([
          expect.objectContaining({ snippet: "设计稿命名用中文" }),
        ]),
      }),
    );
  });
});

describe("项目记忆提示段", () => {
  it("开启且有索引时把索引与目录注入提示词", async () => {
    const { memory } = await createFixture();
    await memory.saveMemory(actor, {
      projectId,
      title: "约定",
      content: "提交信息用中文",
    });
    const section = createProjectMemoryPromptSection(memory);
    const composed = await section.resolve({
      preset: "code",
      instanceId: actor.instanceId,
      scopeHandle: {
        describe: () => ({
          instanceId: actor.instanceId,
          projectId,
        }),
      } as never,
      execution: {
        actor,
        runId: "run-0",
        signal: new AbortController().signal,
      } as never,
    });
    expect(composed).toContain("## 项目长期记忆");
    expect(composed).toContain("[约定](约定.md)");
    expect(composed).toContain(memory.memoryDirectory(projectId));
  });

  it("关闭记忆或缺少项目定位时不出现提示段", async () => {
    const { memory } = await createFixture({ memoryEnabled: false });
    const section = createProjectMemoryPromptSection(memory);
    expect(
      await section.resolve({
        preset: "code",
        instanceId: actor.instanceId,
        scopeHandle: {
          describe: () => ({ instanceId: actor.instanceId, projectId }),
        } as never,
        execution: {
          actor,
          runId: "run-5",
          signal: new AbortController().signal,
        } as never,
      }),
    ).toBeNull();
    expect(await section.resolve({ preset: "design" })).toBeNull();
  });
});

describe("Design 记忆归属与旧通道迁移", () => {
  it("Code 仍用 Task 句柄的项目 id；Design 无句柄时经画布映射", async () => {
    const { memory } = await createFixture();
    expect(
      await memory.resolveProjectId(actor, { projectId: otherProjectId }),
    ).toBe(otherProjectId);
    expect(await memory.resolveProjectId(actor, { canvasId })).toBe(projectId);
    expect(await memory.resolveProjectId(actor, {})).toBeNull();
  });

  it("画布删除或不属于调用者时拒绝，不回落成空记忆", async () => {
    const { memory } = await createFixture({
      canvasError: new Error("画布不存在。"),
    });
    await expect(memory.resolveProjectId(actor, { canvasId })).rejects.toThrow(
      "画布不存在",
    );
    await expect(
      memory.migrateLegacyCanvasMemory(actor, {
        projectId,
        canvasId,
      }),
    ).rejects.toThrow("画布不存在");
  });

  it("提示段在 Design 用画布映射，并把旧 /memories/ 数据迁进项目目录", async () => {
    const legacy = {
      key: "/memories/notes/旧约定.md",
      value: { content: ["发布前先跑全量测试。"] },
    };
    const { memory } = await createFixture({
      legacyItems: [
        legacy,
        {
          key: "/memories/MEMORY.md",
          value: { content: ["- [旧索引](notes-旧约定.md) — 发布检查"] },
        },
      ],
    });
    const section = createProjectMemoryPromptSection(memory);
    const composed = await section.resolve({
      preset: "design",
      instanceId: actor.instanceId,
      execution: {
        actor,
        runId: "run-1",
        signal: new AbortController().signal,
        canvasId,
      } as never,
    });
    expect(composed).toContain("## 项目长期记忆");
    expect(composed).toContain("notes-旧约定.md");
    const catalog = await memory.listProjectMemories(actor);
    expect(catalog[0]?.files.map((file) => file.name)).toContain(
      "notes-旧约定.md",
    );
    expect(
      (
        await memory.readProjectMemoryFile(actor, {
          workspaceId: projectId,
          fileName: "notes-旧约定.md",
        })
      ).content,
    ).toContain("发布前先跑全量测试。");
  });

  it("Code 运行不会迁移画布旧通道", async () => {
    const { memory } = await createFixture({
      legacyItems: [
        { key: "/memories/旧约定.md", value: { content: ["旧正文"] } },
      ],
    });
    const section = createProjectMemoryPromptSection(memory);
    await section.resolve({
      preset: "code",
      instanceId: actor.instanceId,
      scopeHandle: {
        describe: () => ({ instanceId: actor.instanceId, projectId }),
      } as never,
      execution: {
        actor,
        runId: "run-2",
        signal: new AbortController().signal,
        canvasId,
      } as never,
    });
    expect(await memory.listProjectMemories(actor)).toEqual([]);
  });

  it("迁移幂等：重复扫描不生成副本，晚到的旧写入下一轮补进来", async () => {
    const first = { key: "/memories/约定.md", value: { content: ["第一条"] } };
    const fixture = await createFixture({ legacyItems: [first] });
    expect(
      await fixture.memory.migrateLegacyCanvasMemory(actor, {
        projectId,
        canvasId,
      }),
    ).toEqual({ migrated: 1 });
    expect(
      await fixture.memory.migrateLegacyCanvasMemory(actor, {
        projectId,
        canvasId,
      }),
    ).toEqual({ migrated: 0 });
    const names = (
      await fixture.memory.listProjectMemories(actor)
    )[0]?.files.map((file) => file.name);
    expect(names).toEqual(["MEMORY.md", "约定.md"]);

    fixture.store.search = async () => [
      first,
      { key: "/memories/后写.md", value: { content: ["第二条"] } },
    ];
    expect(
      await fixture.memory.migrateLegacyCanvasMemory(actor, {
        projectId,
        canvasId,
      }),
    ).toEqual({ migrated: 1 });
    expect(
      (await fixture.memory.listProjectMemories(actor))[0]?.files.map(
        (file) => file.name,
      ),
    ).toEqual(["MEMORY.md", "后写.md", "约定.md"]);
  });

  it("Design 画布上 memory_save 写进所属项目；无归属时拒绝", async () => {
    const { memory } = await createFixture();
    const tool = createMemorySaveTool(memory);
    const result = await tool.execute(
      { title: "画布约定", content: "设计稿命名用中文" },
      {
        actor,
        runId: "run-3",
        signal: new AbortController().signal,
        canvasId,
        workContext: { preset: "design", canvasId },
      } as never,
    );
    expect(result).toMatchObject({ saved: true, fileName: "画布约定.md" });
    await expect(
      tool.execute({ title: "无归属", content: "正文" }, {
        actor,
        runId: "run-4",
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow("Code Task 或 Design 画布");
  });
});
