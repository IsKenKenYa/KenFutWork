import { describe, expect, it, vi } from "vitest";

import { createCreateSkillTool } from "./create-skill-tool.js";
import type { SkillCatalogRepository } from "./repository.js";

const USER = {
  accessToken: "tok-1",
  email: "creator@test.kenfutwork.com",
  id: "u-1",
  userMetadata: {},
};

const SKILL_MD = `---
name: en-zh-translate
description: 把英文段落翻译成中文
---

# 步骤
1. 读输入
2. 输出中文
`;

function makeRepository(
  calls: Record<string, unknown[]>,
): SkillCatalogRepository {
  return {
    insertOwned: async (userId, input) => {
      calls.insertOwned = [userId, input];
      return { id: "skill-1" };
    },
    insertFilesForOwnedSkill: async (userId, skillId, files) => {
      calls.insertFiles = [userId, skillId, files];
      return files.length;
    },
    upsertInstallation: async (input) => {
      calls.install = [input];
    },
    // 其余方法本用例不触发
    deleteOwnedById: async () => 0,
    findVisibleById: async () => null,
    findVisibleSkill: async () => null,
    listFilesForVisibleSkill: async () => [],
    listInstalled: async () => [],
    listSkillFiles: async () => [],
    listVisible: async () => [],
    listWorkspaceSkills: async () => [],
    uninstall: async () => 0,
    updateOwnedById: async () => null,
  } as SkillCatalogRepository;
}

describe("create_skill 工具（创造模式的发布动作）", () => {
  it("发布技能：写入技能库 + 附带文件 + 装进当前工作区", async () => {
    const calls: Record<string, unknown[]> = {};
    const tool = createCreateSkillTool({
      repository: makeRepository(calls),
      auth: { authenticate: async () => USER },
    });

    const result = (await tool.execute(
      {
        name: "en-zh-translate",
        description: "英译中",
        content: SKILL_MD,
        files: [{ path: "scripts/run.py", content: "print('x')" }],
      },
      { workspaceId: "ws-9", accessToken: "tok-1" },
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      installed: true,
      slug: "en-zh-translate",
      skillId: "skill-1",
      files: 1,
    });
    expect(calls.insertOwned?.[0]).toBe("u-1");
    expect(calls.insertOwned?.[1]).toMatchObject({
      name: "en-zh-translate",
      skillContent: SKILL_MD,
      slug: "en-zh-translate",
    });
    expect(calls.install?.[0]).toMatchObject({
      enabled: true,
      installedBy: "u-1",
      skillId: "skill-1",
      workspaceId: "ws-9",
    });
  });

  it("缺工作区 / 缺凭据 / 缺参数都如实报错（不静默）", async () => {
    const tool = createCreateSkillTool({
      repository: makeRepository({}),
      auth: { authenticate: async () => null },
    });

    await expect(
      tool.execute(
        { name: "a", description: "b", content: SKILL_MD },
        { accessToken: "tok-1" },
      ),
    ).rejects.toThrow(/工作区/);

    await expect(
      tool.execute(
        { name: "a", description: "b", content: SKILL_MD },
        { workspaceId: "ws-9" },
      ),
    ).rejects.toThrow(/用户凭据/);

    // 参数校验在凭据之后：这条用「认证能过」的工具实例才能命中
    const authorized = createCreateSkillTool({
      repository: makeRepository({}),
      auth: { authenticate: async () => USER },
    });
    await expect(
      authorized.execute(
        { name: "a", description: "", content: SKILL_MD },
        { workspaceId: "ws-9", accessToken: "tok-1" },
      ),
    ).rejects.toThrow(/name \/ description \/ content/);
  });

  it("SKILL.md 缺 frontmatter 时按导入错误拒绝（不落库）", async () => {
    const calls: Record<string, unknown[]> = {};
    const insertSpy = vi.fn(async () => ({ id: "skill-1" }));
    const tool = createCreateSkillTool({
      repository: {
        ...makeRepository(calls),
        insertOwned: insertSpy,
      } as SkillCatalogRepository,
      auth: { authenticate: async () => USER },
    });

    await expect(
      tool.execute(
        { name: "bad", description: "b", content: "没有 frontmatter" },
        { workspaceId: "ws-9", accessToken: "tok-1" },
      ),
    ).rejects.toThrow(/frontmatter/);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
