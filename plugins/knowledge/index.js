/**
 * 本地知识库插件（市场 bundle 层）。
 *
 * 真能力在宿主内核（`apps/server/src/features/knowledge/`：CLI Provider、pre-step
 * preflight、提示段与工具）。bundle 只承担安装开关与侧栏入口；面板数据走宿主
 * `/api/knowledge/*`，不使用插件私有路由（bundle 沙箱没有子进程与文件能力）。
 *
 * 运行时 `ctx.ui.register` 必须保留：宿主动态工具用 `listUiEntries()` 做同步安装态
 * 门控（卸载/停用即收回），与清单 `ui` 同一 id，市场侧按 id 去重为一条。
 */

export const name = "kenfutwork-knowledge";

export const inject = ["ui"];

export function apply(ctx) {
  ctx.ui.register({
    id: "knowledge-sidebar",
    title: "知识库",
    slot: "sidebar",
    url: "assets/panel.html",
  });
}
