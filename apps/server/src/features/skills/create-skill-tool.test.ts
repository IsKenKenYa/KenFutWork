import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import { createCreateSkillTool } from "./create-skill-tool.js";
import type { SkillCatalogRepository } from "./repository.js";

const ACTOR = { instanceId: "instance-1", accessClientId: "client-1" };
const localInstance = createLocalInstanceService({
  repository: { ensure: async () => ACTOR.instanceId },
  dataDir: "/tmp/create-skill-test",
});
const CONTEXT: ToolExecutionContext = {
  actor: ACTOR,
  instanceId: ACTOR.instanceId,
};
const SKILL_MD =
  "---\nname: en-zh-translate\ndescription: 英译中\n---\n\n步骤…";
const INPUT = {
  name: "en-zh-translate",
  description: "英译中",
  content: SKILL_MD,
};

function repository(): SkillCatalogRepository {
  return {
    insertOwned: vi.fn(async () => ({ id: "skill-1" })),
    insertFilesForOwnedSkill: vi.fn(
      async (_instanceId, _skillId, files) => files.length,
    ),
    upsertInstallation: vi.fn(async () => {}),
    setEnabled: async () => false,
    deleteOwnedById: async () => 0,
    findVisibleById: async () => null,
    findVisibleSkill: async () => null,
    listFilesForVisibleSkill: async () => [],
    listInstalled: async () => [],
    listSkillFiles: async () => [],
    listVisible: async () => [],
    listInstanceSkills: async () => [],
    uninstall: async () => 0,
    updateOwnedById: async () => null,
  };
}

describe("create_skill（实例发布）", () => {
  it("以签发的 Actor 保存正文、文件和安装，不从模型参数提取归属", async () => {
    const store = repository();
    const tool = createCreateSkillTool({ repository: store, localInstance });
    const result = await tool.execute(
      {
        ...INPUT,
        instanceId: "foreign",
        actor: { instanceId: "foreign" },
        files: [{ path: "scripts/run.py", content: "print(1)" }],
      },
      CONTEXT,
    );
    expect(result).toMatchObject({
      installed: true,
      skillId: "skill-1",
      files: 1,
    });
    expect(store.insertOwned).toHaveBeenCalledWith(
      ACTOR.instanceId,
      expect.objectContaining({
        createdByClientId: ACTOR.accessClientId,
        skillContent: SKILL_MD,
        slug: "en-zh-translate",
      }),
    );
    expect(store.insertFilesForOwnedSkill).toHaveBeenCalledWith(
      ACTOR.instanceId,
      "skill-1",
      expect.any(Array),
    );
    expect(store.upsertInstallation).toHaveBeenCalledWith({
      enabled: true,
      installedByClientId: ACTOR.accessClientId,
      instanceId: ACTOR.instanceId,
      skillId: "skill-1",
    });
  });

  it("缺 Actor、Actor 不属实例、Task 与 Actor 不一致均在写入前拒绝", async () => {
    const store = repository();
    const tool = createCreateSkillTool({ repository: store, localInstance });
    await expect(
      tool.execute(INPUT, { instanceId: ACTOR.instanceId }),
    ).rejects.toThrow(/可信/);
    await expect(
      tool.execute(INPUT, { actor: ACTOR, instanceId: "foreign" }),
    ).rejects.toThrow(/不匹配/);
    await expect(
      tool.execute(INPUT, {
        actor: { instanceId: "foreign", accessClientId: null },
        instanceId: "foreign",
      }),
    ).rejects.toMatchObject({ code: "instance_forbidden" });
    expect(store.insertOwned).not.toHaveBeenCalled();
  });

  it("后台真实 serviceActor 的 null 客户端不会被当作缺凭据", async () => {
    const store = repository();
    const actor = await localInstance.serviceActor();
    const tool = createCreateSkillTool({ repository: store, localInstance });
    await tool.execute(INPUT, { actor, instanceId: actor.instanceId });
    expect(store.upsertInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: actor.instanceId,
        installedByClientId: null,
      }),
    );
  });

  it("缺参数与坏 frontmatter 拒绝，数据库故障原样传播", async () => {
    const store = repository();
    const tool = createCreateSkillTool({ repository: store, localInstance });
    await expect(
      tool.execute({ ...INPUT, description: "" }, CONTEXT),
    ).rejects.toThrow(/name \/ description \/ content/);
    await expect(
      tool.execute({ ...INPUT, content: "坏正文" }, CONTEXT),
    ).rejects.toThrow(/frontmatter/);
    expect(store.insertOwned).not.toHaveBeenCalled();
    const failure = new Error("数据库暂不可用");
    vi.mocked(store.insertOwned).mockRejectedValueOnce(failure);
    await expect(tool.execute(INPUT, CONTEXT)).rejects.toBe(failure);
  });
});
