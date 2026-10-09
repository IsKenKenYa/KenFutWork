import type { PluginDefinition } from "../../kernel/types.js";

/**
 * 动态 UI（《未做需求》R5-2「对话流」的落地）：允许 AI 在对话流里渲染**可视化组件**
 * ——流程图 / 架构图（mermaid）与数据图表（viz）。
 *
 * 本插件只贡献**提示段**：告诉模型这两种块的存在与形状。渲染在两端各自接（Design 的
 * react-markdown 与 Code 的 @zcode/ui 都认这两个语言标记，图表由共享组件
 * `@kenfutwork/ui` 画）。
 *
 * 三条边界（与渲染侧同一份口径）：
 * - 块是**文本约定**，不是新的事件/契约：助手正文原样进 `message.delta` 与历史回放，
 *   旧客户端不认这两个语言时退化成代码块（不报错）；
 * - 不输出 HTML / 脚本：渲染侧只认 mermaid 与 viz 两种标记（mermaid 走
 *   `securityLevel: "strict"`，viz 只画 SVG）；
 * - 图表 spec 用 JSON：字段少而固定（type/title/unit/data），坏 JSON 会回落代码块，
 *   所以提示里把形状写全，减少模型自由发挥。
 */
export const DYNAMIC_UI_PROMPT = [
  "## 可视化（动态 UI）",
  "需要展示流程、架构、时序、状态机时，用 ```mermaid 代码块（标准 mermaid 语法）。",
  '需要展示数据对比或趋势时，用 ```viz 代码块，内容是 JSON：{"type":"bar|line|pie","title":"可选标题","unit":"可选单位","data":[{"label":"名称","value":数值}]}。',
  "两者都会被界面渲染成图；不要输出 HTML 或脚本，也不要用其他图表语言（界面只认这两种）。",
].join("\n");

/** dynamic-ui 插件：只注册一个提示段（scope=always，Code 与 Design 两模式都挂）。 */
export function createDynamicUiPlugin(): PluginDefinition {
  return {
    name: "dynamic-ui",
    inject: ["systemPrompt"],
    apply(ctx) {
      ctx.get("systemPrompt").register({
        name: "dynamic-ui",
        // 与其它能力说明同档（模式段 order=0）；base 段在 -100，品牌 50、skills 200
        order: 0,
        scope: "always",
        resolve: () => DYNAMIC_UI_PROMPT,
      });
    },
  };
}
