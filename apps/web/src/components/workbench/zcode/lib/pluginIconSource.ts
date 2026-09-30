/**
 * zcode 照搬：`@/lib/pluginIconSource.ts`（references/zcode/packages/ui/src/lib/pluginIconSource.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：照搬 + 静态图片引入适配——Next 静态资源导入得 StaticImageData，取 `.src` 作 URL
 * 字符串；其余仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
import documentsIconUrl from "@zui/assets/plugin-icons/documents.png";
import imageSearchIconUrl from "@zui/assets/plugin-icons/image-search.png";
import pdfIconUrl from "@zui/assets/plugin-icons/pdf.png";
import pluginCreatorIconUrl from "@zui/assets/plugin-icons/plugin-creator.png";
import presentationsIconUrl from "@zui/assets/plugin-icons/presentations.png";
import spreadsheetsIconUrl from "@zui/assets/plugin-icons/spreadsheets.png";
import { isTrustedImageUrl } from "@zui/lib/trustedImageUrl";

const OFFICIAL_PLUGIN_ICON_BY_ID: Readonly<Record<string, string>> = {
  "documents@zcode-plugins-official": documentsIconUrl.src,
  "image-search@zcode-plugins-official": imageSearchIconUrl.src,
  "pdf@zcode-plugins-official": pdfIconUrl.src,
  "plugin-creator@zcode-plugins-official": pluginCreatorIconUrl.src,
  "presentations@zcode-plugins-official": presentationsIconUrl.src,
  "spreadsheets@zcode-plugins-official": spreadsheetsIconUrl.src,
};

const TRUSTED_BUNDLED_PLUGIN_ICONS = new Set(
  Object.values(OFFICIAL_PLUGIN_ICON_BY_ID),
);

/** 按完整身份解析客户端自有图标，避免商店、候选和消息各自维护不同例外。 */
export function resolvePluginIconSource(
  pluginId: string | undefined,
  icon?: string,
): string | undefined {
  if (pluginId) {
    const bundledIcon = OFFICIAL_PLUGIN_ICON_BY_ID[pluginId];
    if (bundledIcon) return bundledIcon;
  }
  return isTrustedImageUrl(icon) ? icon : undefined;
}

/** Session 投影已完成身份匹配；仅放行固定打包资源，不放宽任意本地 URL。 */
export function isTrustedPluginIconSource(
  icon: string | undefined,
): icon is string {
  return (
    Boolean(icon && TRUSTED_BUNDLED_PLUGIN_ICONS.has(icon)) ||
    isTrustedImageUrl(icon)
  );
}
