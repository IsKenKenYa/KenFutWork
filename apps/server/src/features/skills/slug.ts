/**
 * 技能名 → slug。
 *
 * 抽到独立模块：HTTP 路由（创建/导入）与 agent 工具（create_skill）都要用同一口径——
 * 两处各写一份会让「同样的名字在两条路径下生成不同 slug」。
 *
 * 注意：非 ASCII（中文名）会被整体压成空串，调用方需自行兜底（历史上技能名多为英文；
 * 中文名技能走 `skill.name` 展示、slug 只作目录名，空 slug 会撞唯一约束并如实报错）。
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}
