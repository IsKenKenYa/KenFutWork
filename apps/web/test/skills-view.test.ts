import type { SkillListItem } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import {
  filterSkillViews,
  mergeSkillViews,
  SKILL_IMPORT_HINT,
  skillCategoryLabel,
  skillSourceLabel,
  skillStateLabel,
} from "../src/lib/skills-view.js";

function skill(over: Partial<SkillListItem> & { id: string }): SkillListItem {
  return {
    name: over.id,
    slug: over.id,
    description: "描述",
    author: "tester",
    version: "1.0.0",
    category: "custom",
    iconName: null,
    source: "user",
    isFeatured: false,
    metadata: {},
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...over,
  };
}

/**
 * 回归背景：后端把「可见技能」与「工作区已启用技能」分成两个端点，
 * 页面必须自行合并出「已启用 / 已停用 / 未启用」三态并提供启停与删除操作。
 */
describe("技能管理页视图逻辑", () => {
  const visible = [
    skill({ id: "canvas-design", name: "canvas-design", source: "system" }),
    skill({
      id: "json-image-prompt",
      name: "json-image-prompt",
      source: "community",
    }),
    skill({ id: "my-skill", name: "my-skill", source: "user" }),
  ];
  const installed = [
    skill({ id: "my-skill", enabled: true }),
    skill({ id: "canvas-design", enabled: false }),
  ];

  it("合并两端点：启用态、安装态、可操作性各自正确", () => {
    const rows = mergeSkillViews(visible, installed);
    const byId = new Map(rows.map((r) => [r.id, r] as const));

    expect(byId.get("my-skill")).toMatchObject({
      enabled: true,
      installed: true,
      deletable: true,
      toggleable: true,
    });
    // 系统技能：已安装但被停用；不可删除也不可卸载
    expect(byId.get("canvas-design")).toMatchObject({
      enabled: false,
      installed: true,
      deletable: false,
      toggleable: false,
    });
    // 社区技能：未安装；可启用但不可删除（非本人创建）
    expect(byId.get("json-image-prompt")).toMatchObject({
      enabled: false,
      installed: false,
      deletable: false,
      toggleable: true,
    });
  });

  it("排序稳定：已启用在前，其余按名称升序", () => {
    const rows = mergeSkillViews(visible, installed);
    expect(rows.map((r) => r.id)).toEqual([
      "my-skill",
      "canvas-design",
      "json-image-prompt",
    ]);
  });

  it("三态文案可区分（已启用/已停用/未启用）", () => {
    const rows = mergeSkillViews(visible, installed);
    const labels = Object.fromEntries(
      rows.map((r) => [r.id, skillStateLabel(r)] as const),
    );
    expect(labels).toEqual({
      "my-skill": "已启用",
      "canvas-design": "已停用",
      "json-image-prompt": "未启用",
    });
  });

  it("过滤命中名称/描述/分类标签/作者，空关键字原样返回", () => {
    const rows = mergeSkillViews(
      [
        skill({ id: "a", name: "摘要技能", description: "长文案精简" }),
        skill({ id: "b", name: "b", description: "x", category: "design" }),
      ],
      [],
    );
    expect(filterSkillViews(rows, "").length).toBe(2);
    expect(filterSkillViews(rows, "摘要").map((r) => r.id)).toEqual(["a"]);
    expect(filterSkillViews(rows, "长文案").map((r) => r.id)).toEqual(["a"]);
    expect(filterSkillViews(rows, "设计").map((r) => r.id)).toEqual(["b"]);
    expect(filterSkillViews(rows, "  ").length).toBe(2);
    expect(filterSkillViews(rows, "不存在的关键字")).toEqual([]);
  });

  it("来源与分类有中文标签（不裸露枚举值）", () => {
    expect(skillSourceLabel("system")).toBe("系统");
    expect(skillSourceLabel("user")).toBe("我的");
    expect(skillCategoryLabel("design")).toBe("设计");
    expect(skillCategoryLabel("custom")).toBe("自定义");
  });

  it("导入提示覆盖三种来源（含 ZIP，与后端 detectImportSource 对齐）", () => {
    expect(SKILL_IMPORT_HINT).toContain("GitHub");
    expect(SKILL_IMPORT_HINT).toContain(".tgz");
    expect(SKILL_IMPORT_HINT).toContain(".zip");
    expect(SKILL_IMPORT_HINT).toContain("SKILL.md");
  });

  it("已安装列表里出现但不在可见列表的技能不会凭空出现（以可见列表为准）", () => {
    const rows = mergeSkillViews(
      [skill({ id: "only-visible" })],
      [skill({ id: "ghost", enabled: true })],
    );
    expect(rows.map((r) => r.id)).toEqual(["only-visible"]);
  });
});
