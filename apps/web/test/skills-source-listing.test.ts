import { groupSkillsByPlugin } from "@zui/settings/pluginManagedResourceGroups.js";
import { describe, expect, it } from "vitest";

type TestSkill = Parameters<typeof groupSkillsByPlugin>[0][number];

function skill({
  id,
  ...over
}: Partial<TestSkill> & { id: string }): TestSkill {
  return {
    id,
    name: id,
    description: "描述",
    body: "",
    path: "",
    scope: "user",
    enabled: true,
    ...over,
  };
}

/**
 * 回归背景：DB 技能没有本机文件路径（host 返回 path: ""），分组去重若以空 path
 * 作键，会把整库技能折叠成 1 条（实测 5 个只显示 1 个）。去重必须退回技能 id。
 */
describe("技能分组按真实身份去重", () => {
  it("多来源技能全部列出：多个无路径的 DB 技能 + 插件技能", () => {
    const skills = [
      skill({ id: "u1", name: "kenfut-daily-quote" }),
      skill({ id: "u2", name: "kenfut-工作流自检" }),
      skill({ id: "u3", name: "kfw-wordstats" }),
      skill({
        id: "kenfutwork-plugin-skill:probe/skills%2Finspect%2FSKILL.md",
        name: "inspect",
        scope: "plugin",
        pluginId: "probe@local",
        pluginName: "probe",
      }),
      skill({
        id: "kenfutwork-plugin-skill:probe/skills%2Fscan%2FSKILL.md",
        name: "scan",
        scope: "plugin",
        pluginId: "probe@local",
        pluginName: "probe",
      }),
    ];
    const grouped = groupSkillsByPlugin(skills, "");
    expect(grouped.local.map((item) => item.id)).toEqual(["u1", "u2", "u3"]);
    expect(grouped.plugin.map((item) => item.id)).toEqual(
      skills.slice(3).map((item) => item.id),
    );
  });

  it("仍按路径去重：同一文件被多个来源发现时只保留一条", () => {
    const grouped = groupSkillsByPlugin(
      [
        skill({ id: "a", path: "/skills/shared/SKILL.md" }),
        skill({ id: "b", path: "/SKILLS\\shared\\SKILL.md" }),
      ],
      "",
    );
    expect(grouped.local).toHaveLength(1);
    expect(grouped.local[0]?.id).toBe("a");
  });

  it("去重后仍按关键字过滤名称/描述/插件名", () => {
    const grouped = groupSkillsByPlugin(
      [
        skill({ id: "u1", name: "日报", description: "每日摘要" }),
        skill({ id: "u2", name: "周报", description: "每周摘要" }),
      ],
      "日报",
    );
    expect(grouped.local.map((item) => item.id)).toEqual(["u1"]);
  });
});
