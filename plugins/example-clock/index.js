/**
 * KenFutWork 参考插件（双端兼容 bundle）。
 *
 * 装载形状与 deepseek-harness 一致：导出 `name` / `inject` / `apply(ctx)`。
 * 因此同一份文件既能被 `dsh plugin add` 装载，也能被 KenFutWork 插件市场安装——
 * 这是「插件互通」的最小可用示例。
 *
 * 能力面：只依赖 `tools`。KenFutWork 的支持面见服务端 capability-binding.ts。
 * 工具结果用 dsh 的 ContentBlock 形状返回，KenFutWork 的适配层会归一化。
 *
 * `access` 是 KenFutWork 的执行效果声明（dsh 侧忽略）：`read` = 只读、默认档不审批；
 * `write` / `execute` = 进默认档审批；不声明按 `execute` 处理（未知效果人审）。
 */

export const name = "kenfutwork-example-clock";

export const inject = ["tools"];

export function apply(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: "clock_now",
      // 只读：默认档不拦截（写设备/落盘的插件工具应声明 write）。
      access: "read",
      description: "返回当前时间（本地时区 ISO 字符串与 UTC 时间戳）。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const now = new Date();
        const text = `${now.toISOString()}（本地 ${now.toLocaleString("zh-CN")}）`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            iso: now.toISOString(),
            epochMs: now.getTime(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        };
      },
    }),
  );
}
