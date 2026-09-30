/**
 * zcode 照搬 + 宿主适配 stub：`@/store/index.ts`（references/zcode/packages/ui/src/store/index.ts）
 * 许可证：Apache-2.0（zcode）。
 *
 * 消费切片：本仓照搬组件当前只以类型位消费 `CodePreviewSettings`
 * （GitPaneChangeCard；上游即从 @/lib/codePreviewSettings 转出口）。zcode 的 zustand
 * 全局 store（workspaceSession/tabStore 之外的面板态）不在照搬范围，其余导出按需再补。
 */
export type { CodePreviewSettings } from "../lib/codePreviewSettings";
