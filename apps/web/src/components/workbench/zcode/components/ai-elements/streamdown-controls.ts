/**
 * zcode 照搬：`@/components/ai-elements/streamdown-controls.ts`（references/zcode/packages/ui/src/components/ai-elements/streamdown-controls.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）；源文件自带头注保留于下。
 */
// 交互调整：表格本身已经能在消息流里完整浏览，再保留 fullscreen 入口会把阅读路径打断。
// 这里统一关闭表格放大，只保留复制/导出等轻量操作，消息正文和推理面板共用同一份配置。
export const STREAMDOWN_CONTROLS = {
  table: {
    fullscreen: false,
  },
} as const;
