/**
 * zcode 照搬：`@/chat-input-toolbar/contextQuotaMeterGrid.ts`（references/zcode/packages/ui/src/chat-input-toolbar/contextQuotaMeterGrid.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
export function getContextQuotaMeterGridClass(count: number): string {
  // Start/Coding 额度来自服务端快照，实际可能是 1/2/3 条；官方 MCP
  // 已改为网格下方的贯穿行，因此即使误传更大计数也不能把 320px 浮层压成四列。
  // 固定三列会让两条额度留下空洞，也会让单条额度被无意义压窄。
  if (count <= 1) {
    return "grid-cols-1";
  }
  if (count === 2) {
    return "grid-cols-2";
  }
  if (count === 3) {
    return "grid-cols-3";
  }
  return "grid-cols-3";
}
