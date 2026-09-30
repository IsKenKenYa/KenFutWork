/**
 * zcode 照搬：`@/lib/slashPanelUpdateFilter.ts`（references/zcode/packages/ui/src/lib/slashPanelUpdateFilter.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
import { HISTORY_NAVIGATION_UPDATE_TAG } from "./editorUpdateTags";

/**
 * 判断 SlashCommandPlugin 的 update listener 是否应处理本次编辑器更新。
 *
 * 历史导航回填时返回 false，防止面板以 COMMAND_PRIORITY_CRITICAL 注册方向键处理器
 * 并吞掉后续的历史翻阅按键。其余更新（用户输入、其他程序化更新）均返回 true。
 */
export function shouldSlashPanelProcessUpdate(
  tags: ReadonlySet<string>,
): boolean {
  return !tags.has(HISTORY_NAVIGATION_UPDATE_TAG);
}
