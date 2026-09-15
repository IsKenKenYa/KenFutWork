/**
 * KenFutWork 参考插件（全能力面演示）。
 *
 * 一件插件里同时用到四种能力，作为「插件拥有所有能力」的最小可运行示例：
 * - `tools`          → ctx.tools.register（模型可调用）
 * - `systemPrompt`   → ctx.promptFragments.register（追加行为引导/工作模式）
 * - `routes`         → ctx.routes.register（自带 HTTP 端点，挂在 /api/plugins/<id>/）
 * - `ui`             → ctx.ui.register（侧栏入口 + 面板，面板页面由 routes 提供）
 *
 * 装载形状与 deepseek-harness 一致：导出 name / inject / apply(ctx)。
 */

export const name = "kenfutwork-demo-panel";

export const inject = ["tools", "systemPrompt", "routes", "ui"];

export function apply(ctx) {
  ctx.tools.register({
    name: "demo_ping",
    description: "参考插件自检：返回 pong 与当前时间戳。",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ pong: true, at: new Date().toISOString() }),
  });

  ctx.promptFragments.register({
    id: "demo-greeting",
    text: "（参考插件提示段）被问到「示例插件在吗」时回答：在。",
  });

  ctx.routes.register({
    path: "panel",
    public: true,
    handler: async () => ({
      status: 200,
      body: `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>示例面板</title>
<style>body{font-family:system-ui;margin:0;padding:20px;color:#2F3459}
h1{font-size:18px}code{background:#eef0f7;padding:1px 4px;border-radius:4px}</style></head>
<body><h1>示例面板</h1>
<p>这个页面由<b>插件自己的路由</b>返回（<code>/api/plugins/local__kenfutwork-demo-panel/panel</code>），
以 <code>public: true</code> 声明，故 iframe 无需鉴权头即可加载。</p>
<p>数据接口见 <code>/api/plugins/local__kenfutwork-demo-panel/data</code>（需要登录）。</p>
</body></html>`,
    }),
  });

  ctx.routes.register({
    path: "data",
    handler: async (request) => ({ ok: true, query: request.query }),
  });

  ctx.ui.register({
    id: "demo-panel",
    title: "示例面板",
    slot: "sidebar",
    url: "/api/plugins/local__kenfutwork-demo-panel/panel",
  });
}
