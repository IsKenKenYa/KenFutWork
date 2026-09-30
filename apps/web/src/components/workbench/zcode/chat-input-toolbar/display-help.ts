/**
 * zcode 照搬：`@/chat-input-toolbar/display-help.ts`（references/zcode/packages/ui/src/chat-input-toolbar/display-help.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import type { ZCodeProvider } from "@zui/lib/zcode-shared";

export const ZCODE_MODE_OPTION_LABEL_IDS: Record<
  ZCodeProvider,
  Record<string, string>
> = {
  glm: {
    build: "mode.label.glm.build",
    edit: "mode.label.glm.edit",
    plan: "mode.label.glm.plan",
    yolo: "mode.label.glm.yolo",
  },
};

export const ZCODE_MODE_OPTION_DESCRIPTION_IDS: Record<
  ZCodeProvider,
  Record<string, string>
> = {
  glm: {
    build: "mode.description.glm.build",
    edit: "mode.description.glm.edit",
    plan: "mode.description.glm.plan",
    yolo: "mode.description.glm.yolo",
  },
};
