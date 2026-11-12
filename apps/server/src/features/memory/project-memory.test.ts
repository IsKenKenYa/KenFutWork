import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceSettings } from "@kenfutwork/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { LocalActor } from "../local-instance/types.js";
import { createProjectMemoryPromptSection } from "./consumer.js";
import { createProjectMemoryService } from "./project-memory.js";

const actor: LocalActor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "33333333-3333-4333-8333-333333333333";

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
  });
  return { dataDir, memory, preferences, settings };
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

  // listProjects 按单个 kind 过滤，缺省落到 design；Code 项目只查 design 会把
  // 标签退化成项目 UUID，用户看不到自己起的名字。
  it("Code 项目的标签取自真实项目名", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kfw-memory-"));
    fixtures.push(dataDir);
    const memory = createProjectMemoryService({
      dataDir,
      projects: {
        listProjects: async (_actor: LocalActor, kind?: string) =>
          (kind ?? "design") === "code"
            ? [{ id: projectId, name: "代码演示项目" }]
            : [],
      } as never,
      localInstance: {
        resolve: async (value: LocalActor) => ({
          instanceId: value.instanceId,
        }),
      } as never,
      preferences: {
        readHumanPreferences: async () => ({ memoryEnabled: true }),
      } as never,
      settings: {
        getInstanceSettings: async () =>
          ({
            codeReadMaxBytes: 4_000,
            codeReadPageCharacters: 300,
          }) as unknown as InstanceSettings,
      } as never,
    });
    await memory.saveMemory(actor, {
      projectId,
      title: "条目",
      content: "正文",
    });

    const catalog = await memory.listProjectMemories(actor);

    expect(catalog[0]?.label).toBe("代码演示项目");
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
      }),
    ).toBeNull();
    expect(await section.resolve({ preset: "design" })).toBeNull();
  });
});
