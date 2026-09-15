import type { SkillCategory, SkillListItem, SkillSource } from "@kenfutwork/shared";

/**
 * 技能管理页的纯视图逻辑（列表合并 / 过滤 / 标签）。
 *
 * 背景：后端把「可见技能」与「本工作区已启用技能」分成两个端点
 * （`GET /api/skills` 不含启用态，`GET /api/workspaces/skills` 才有
 * installed/enabled），页面需要把它们合成一份可操作列表——放入 lib 便于单测。
 */

export interface SkillView extends SkillListItem {
  /** 本工作区已启用（启用后才会注入 agent 的技能清单）。 */
  enabled: boolean;
  /** 本工作区已安装（含被停用）。 */
  installed: boolean;
  /** 仅本人创建的技能可删除（服务端按 created_by 判定）。 */
  deletable: boolean;
  /** 系统内置技能不可卸载。 */
  toggleable: boolean;
}

const SOURCE_LABEL: Record<SkillSource, string> = {
  system: "系统",
  community: "社区",
  user: "我的",
};

const CATEGORY_LABEL: Record<SkillCategory, string> = {
  design: "设计",
  generation: "生成",
  code: "代码",
  data: "数据",
  writing: "写作",
  custom: "自定义",
};

export function skillSourceLabel(source: SkillSource): string {
  return SOURCE_LABEL[source];
}

export function skillCategoryLabel(category: SkillCategory): string {
  return CATEGORY_LABEL[category];
}

/**
 * 合并可见技能与工作区已启用技能。
 * 排序：已启用在前 → 名称升序（保证渲染稳定，便于测试与视觉一致）。
 */
export function mergeSkillViews(
  visible: SkillListItem[],
  installed: SkillListItem[],
): SkillView[] {
  const installedById = new Map(
    installed.map((skill) => [skill.id, skill] as const),
  );
  return visible
    .map((skill) => {
      const row = installedById.get(skill.id);
      return {
        ...skill,
        enabled: Boolean(row?.enabled),
        installed: Boolean(row),
        deletable: skill.source === "user",
        toggleable: skill.source !== "system",
      };
    })
    .sort((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

/** 关键字过滤：名称 / 描述 / 分类标签 / 作者。 */
export function filterSkillViews(
  rows: SkillView[],
  query: string,
): SkillView[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return rows;
  }
  return rows.filter((row) =>
    [row.name, row.description, skillCategoryLabel(row.category), row.author]
      .join(" ")
      .toLowerCase()
      .includes(keyword),
  );
}

/** 启用态副标题：让「已启用 / 已停用 / 未安装」三态在列表里可读。 */
export function skillStateLabel(row: SkillView): string {
  if (row.enabled) {
    return "已启用";
  }
  return row.installed ? "已停用" : "未启用";
}

/** 导入来源说明（与后端 detectImportSource 支持的来源保持一致）。 */
export const SKILL_IMPORT_HINT =
  "支持 GitHub 仓库链接、npm tarball（.tgz/.tar.gz）与 ZIP 压缩包（.zip/.skill）；包内需含 SKILL.md（或 package.json + README.md 回落）。";
