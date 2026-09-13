import { describe, expect, it, vi } from "vitest";

import type { CanvasRepository } from "../features/canvas/repository.js";
import type { SkillCatalogRepository } from "../features/skills/repository.js";
import { createWorkspaceSkillsLoader } from "./workspace-skills.js";

const CANVAS_ID = "canvas-1";
const WORKSPACE_ID = "ws-1";

function createFakes(
  options: {
    canvasWorkspaceId?: string | null;
    files?: Array<{ content: string; path: string; skillId: string }>;
    skills?: Array<{
      description: string;
      enabled: boolean;
      skillContent: string;
      skillId: string;
      slug: string;
    }>;
  } = {},
) {
  const fileQueries: Array<readonly string[]> = [];
  const canvasQueries: string[] = [];

  const canvases = {
    findById: async () => null,
    findWorkspaceIdByCanvas: async (canvasId: string) => {
      canvasQueries.push(canvasId);
      return options.canvasWorkspaceId === undefined
        ? WORKSPACE_ID
        : options.canvasWorkspaceId;
    },
    saveContent: async () => 1,
  } as unknown as CanvasRepository;

  const skills = {
    listSkillFiles: async (
      _workspaceId: string,
      skillIds: readonly string[],
    ) => {
      fileQueries.push(skillIds);
      return options.files ?? [];
    },
    listWorkspaceSkills: async () =>
      options.skills ?? [
        {
          description: "海报生成",
          enabled: true,
          skillContent: "---\nname: canvas-design\n---\n步骤…",
          skillId: "s1",
          slug: "canvas-design",
        },
      ],
  } as unknown as SkillCatalogRepository;

  return {
    canvasQueries,
    fileQueries,
    loader: createWorkspaceSkillsLoader({ canvases, skills }),
  };
}

describe("workspace-skills loader（技能加载缝）", () => {
  it("经画布解析工作区，返回启用技能的元数据与正文", async () => {
    const { canvasQueries, loader } = createFakes();
    const entries = await loader(CANVAS_ID);

    expect(canvasQueries).toEqual([CANVAS_ID]);
    expect(entries).toEqual([
      {
        name: "canvas-design",
        description: "海报生成",
        path: "/workspace-skills/canvas-design/SKILL.md",
        content: "---\nname: canvas-design\n---\n步骤…",
        files: [],
      },
    ]);
  });

  it("停用技能被过滤，且只为启用项查文件", async () => {
    const { fileQueries, loader } = createFakes({
      skills: [
        {
          description: "a",
          enabled: false,
          skillContent: "off",
          skillId: "s-off",
          slug: "off",
        },
        {
          description: "b",
          enabled: true,
          skillContent: "on",
          skillId: "s-on",
          slug: "on",
        },
      ],
    });

    const entries = await loader(CANVAS_ID);
    expect(entries.map((e) => e.name)).toEqual(["on"]);
    expect(fileQueries).toEqual([["s-on"]]);
  });

  it("附带文件按 skill 归组", async () => {
    const { loader } = createFakes({
      files: [
        { content: "print(1)", path: "scripts/a.py", skillId: "s1" },
        { content: "ref", path: "references/b.md", skillId: "s1" },
        { content: "orphan", path: "x", skillId: "s-other" },
      ],
    });

    const [entry] = await loader(CANVAS_ID);
    expect(entry?.files).toEqual([
      { content: "print(1)", path: "scripts/a.py" },
      { content: "ref", path: "references/b.md" },
    ]);
  });

  it("启用但正文为空的技能被跳过并告警（不静默注入空技能）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loader } = createFakes({
      skills: [
        {
          description: "empty",
          enabled: true,
          skillContent: "",
          skillId: "s-empty",
          slug: "empty-skill",
        },
      ],
    });

    await expect(loader(CANVAS_ID)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("empty-skill"));
    warn.mockRestore();
  });

  it("画布解析不到工作区时返回空（不起查询）", async () => {
    const { fileQueries, loader } = createFakes({ canvasWorkspaceId: null });
    await expect(loader(CANVAS_ID)).resolves.toEqual([]);
    expect(fileQueries).toEqual([]);
  });

  it("数据访问失败降级为空数组（技能是增强，不炸主链路）", async () => {
    const broken = createWorkspaceSkillsLoader({
      canvases: {
        findWorkspaceIdByCanvas: async () => {
          throw new Error("connection reset");
        },
      } as unknown as CanvasRepository,
      skills: {} as unknown as SkillCatalogRepository,
    });

    await expect(broken(CANVAS_ID)).resolves.toEqual([]);
  });
});
