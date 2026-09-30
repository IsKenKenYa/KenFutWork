/**
 * zcode 照搬：`@/lib/trustedImageUrl.ts`（references/zcode/packages/ui/src/lib/trustedImageUrl.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
/** UI 远端图片只允许 HTTPS；失败时由各展示组件回退到本地图标。 */
export function isTrustedImageUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://");
}
