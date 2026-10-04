import { expect, it } from "vitest";
import { renderSkillsSection } from "../features/agent-runs/prompt-sections.js";
import type { SkillCatalogRepository } from "../features/skills/repository.js";
import { createWorkspaceSkillResourceReader } from "../features/skills/skill-resource-service.js";
import { buildUserMessage } from "./runtime.js";
import { createWorkspaceSkillsByWorkspaceLoader } from "./workspace-skills.js";

function fixture() {
  let enabled = true;
  const queries: Array<{ workspace: string; ids?: readonly string[] }> = [];
  const repository: Pick<
    SkillCatalogRepository,
    "listWorkspaceSkills" | "listSkillFiles"
  > = {
    listWorkspaceSkills: async (workspace) => {
      queries.push({ workspace });
      return workspace === "own"
        ? [
            {
              skillId: "actual-skill-id",
              name: "实际技能",
              slug: "installed-skill",
              description: "Code真实正文",
              skillContent: "---\nname: installed-skill\n---\n完整正文",
              enabled,
            },
          ]
        : [];
    },
    listSkillFiles: async (workspace, ids) => {
      queries.push({ workspace, ids });
      return workspace === "own" && ids.includes("actual-skill-id")
        ? [
            {
              skillId: "actual-skill-id",
              path: "scripts/check.ts",
              content: "只读脚本正文",
            },
          ]
        : [];
    },
  };
  return {
    repository,
    queries,
    disable: () => {
      enabled = false;
    },
  };
}

it("Code工作区安装技能不用Canvas JOIN，提示使用真实use_skill而非Native Read虚假路径", async () => {
  const f = fixture();
  const loader = createWorkspaceSkillsByWorkspaceLoader({
    skills: f.repository,
  });
  const entries = await loader("own");
  expect(entries).toMatchObject([
    {
      name: "installed-skill",
      path: "kenfutwork-skill:actual-skill-id",
      content: expect.stringContaining("完整正文"),
      files: [{ path: "scripts/check.ts" }],
    },
  ]);
  const prompt = renderSkillsSection(entries);
  expect(prompt).toContain("use_skill");
  expect(prompt).not.toContain("Read `kenfutwork-skill:");
  expect(f.queries.every((entry) => entry.workspace === "own")).toBe(true);
});

it("只读DB resource seam提供真实正文与附属资源，跨工作区/停用/路径逃逸均不可读", async () => {
  const f = fixture();
  const reader = createWorkspaceSkillResourceReader({
    repository: f.repository,
  });
  expect(await reader.read("own", "installed-skill")).toMatchObject({
    resourceRef: "kenfutwork-skill:actual-skill-id",
    resourcePath: "SKILL.md",
    content: expect.stringContaining("完整正文"),
  });
  expect(
    await reader.read("own", "installed-skill", "scripts/check.ts"),
  ).toMatchObject({ content: "只读脚本正文" });
  expect(
    await reader.read("foreign", "installed-skill", "scripts/check.ts"),
  ).toBeUndefined();
  await expect(
    reader.read("own", "installed-skill", "../outside"),
  ).rejects.toThrow(/路径|资源/);
  f.disable();
  expect(await reader.read("own", "installed-skill")).toBeUndefined();
});

it("本机项目Skill路径仍使用Task Native Read，Design既有virtualStore路径保留", () => {
  const prompt = renderSkillsSection([
    {
      name: "local",
      description: "本机技能",
      path: "/authorized/.agents/skills/local/SKILL.md",
      files: [],
    },
    {
      name: "design",
      description: "Design Store",
      path: "/workspace-skills/design/SKILL.md",
      files: [],
    },
  ]);
  expect(prompt).toContain("Read `/authorized/.agents/skills/local/SKILL.md`");
  expect(prompt).toContain("Read `/workspace-skills/design/SKILL.md`");
});

it("Code明确skill mention使用use_skill，Design原Store读取提示保留", () => {
  const mentions = [
    {
      mentionType: "skill" as const,
      id: "installed-id",
      label: "安装技能",
      slug: "installed-skill",
    },
  ];
  const code = buildUserMessage(
    "按技能执行",
    [],
    undefined,
    mentions,
    undefined,
    undefined,
    "database",
  ).text;
  expect(code).toContain('use_skill with name "installed-skill"');
  expect(code).not.toContain("/workspace-skills/");
  const design = buildUserMessage("按技能执行", [], undefined, mentions).text;
  expect(design).toContain("Read `/workspace-skills/installed-skill/SKILL.md`");
});
