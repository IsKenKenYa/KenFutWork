/**
 * zcode 照搬：`@/mentions/mentionTypes.ts`（references/zcode/packages/ui/src/mentions/mentionTypes.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；P5 适配：可选属性放宽 `| undefined`（exactOptionalPropertyTypes，照搬调用点显式传 undefined）；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
export type MentionCategory =
  | "files"
  | "skills"
  | "commands"
  | "subagents"
  | "whiteboards"
  | "sessions"
  | "plugins";

export interface MentionItemData {
  kind?: "file" | "directory" | "whiteboard" | undefined;
  path?: string | undefined;
  relativePath?: string | undefined;
  boardId?: string | undefined;
  scope?: "built-in" | "workspace" | "user" | "plugin" | undefined;
  source?: "built-in" | "user" | "plugin" | undefined;
  model?: string | undefined;
  /** Plugin 引用的稳定身份（`name@marketplace`），canonical 链接目标；label 不参与身份。 */
  pluginId?: string;
  /** Plugin 商店 listing 原始图标；仅用于 UI，必须经 HTTPS 校验后加载。 */
  icon?: string;
}

export interface MentionItem {
  id: string;
  category: MentionCategory;
  label: string;
  description: string;
  value: string;
  markdown: string;
  keywords?: string[] | undefined;
  data?: MentionItemData | undefined;
  /**
   * 仅供面板渲染的本地化展示名（如 Plugin listing 的 displayName）。
   * `label` 同时是面板文案与 chip/markdown 载体的 label，直接本地化 `label` 会让
   * composer chip 与消息气泡（按 markdown label 重建）显示不一致；面板展示名单独走此字段。
   */
  displayLabel?: string;
  /** 禁选态（V1 同名 Plugin 冲突 fail closed）：面板可见但不可选择。 */
  disabled?: boolean;
  /** 禁选原因，展示在候选行右侧弱信息位。 */
  disabledReason?: string;
}

export interface MentionCategoryResult {
  items: MentionItem[];
  loading: boolean;
  error: Error | null;
  emptyText: string;
  title: string;
  refresh?: () => Promise<void>;
}
