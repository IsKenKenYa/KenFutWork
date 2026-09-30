/**
 * zcode 照搬：`@/chat-input-toolbar/contextPanelAction.ts`（references/zcode/packages/ui/src/chat-input-toolbar/contextPanelAction.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀；P5 适配：可选属性放宽 `| undefined`（exactOptionalPropertyTypes，照搬调用点显式传 undefined）
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
export function runContextPanelActionWithClose({
  action,
  close,
}: {
  action?: (() => void) | undefined;
  close: () => void;
}) {
  // HoverCard 内按钮点击不会像外部 hover leave 一样自动关闭面板。
  // 入口动作会切到设置页或 usage 详情，必须先收起 context 面板，避免旧浮层残留。
  close();
  action?.();
}
