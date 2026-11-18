import type { PromptSectionDefinition } from "../../kernel/types.js";

/**
 * 品牌套件段（design 且项目已绑定）：与 get_brand_kit 工具同属主、同口径——
 * 工具按 scope=design 过滤，本段也只在 design preset 出现，绑定不存在即隐去。
 */
export const brandKitPromptSection: PromptSectionDefinition = {
  name: "design.brand-kit",
  order: 50,
  scope: "design",
  resolve: (ctx) =>
    ctx.brandKitId
      ? "当前项目已绑定品牌套件。在进行设计相关工作时，请先使用 get_brand_kit 工具查询品牌信息，确保设计符合品牌规范。"
      : null,
};
