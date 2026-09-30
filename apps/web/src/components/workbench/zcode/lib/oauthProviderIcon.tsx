/**
 * zcode 照搬：`@/lib/oauthProviderIcon.tsx`（references/zcode/packages/ui/src/lib/oauthProviderIcon.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：照搬 + SVG 引入适配——Next 静态资源导入得 StaticImageData，取 `.src` 作 URL 字符串；
 * 其余仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */

import bigModelIcon from "@zui/assets/provider-icons/logo-bigmodel.svg";
import zaiIcon from "@zui/assets/provider-icons/logo-zai.svg";
import { cn } from "@zui/components/lib/utils";
import type { OAuthProviderId } from "@zui/lib/zcode-shared";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zui/lib/zcode-shared";
import { LogInIcon } from "lucide-react";

const OAUTH_PROVIDER_ICON_SRC: Partial<Record<OAuthProviderId, string>> = {
  [BIGMODEL_PROVIDER_ID]: bigModelIcon.src,
  [ZAI_PROVIDER_ID]: zaiIcon.src,
};

export function renderOAuthProviderIcon(
  provider: OAuthProviderId,
  className?: string,
) {
  const src = OAUTH_PROVIDER_ICON_SRC[provider];
  if (!src) {
    return <LogInIcon className={cn("shrink-0", className)} />;
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
