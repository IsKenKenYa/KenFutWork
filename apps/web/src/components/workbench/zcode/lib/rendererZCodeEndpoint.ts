/**
 * zcode 照搬：`@/lib/rendererZCodeEndpoint.ts`（references/zcode/packages/ui/src/lib/rendererZCodeEndpoint.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */
import {
  buildRuntimeZCodeEndpointUrls,
  type RuntimeZCodeEndpointEnv,
  ZCODE_ENV,
} from "@zui/lib/zcode-shared";

interface RendererImportMetaEnv {
  VITE_ZCODE_BASE_URL?: string | undefined;
  VITE_ZCODE_ENDPOINT_ORIGIN?: string | undefined;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

function createRendererZCodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeZCodeEndpointEnv {
  return {
    ZCODE_ENV,
    // UI 侧的 zcode-plan 占位 provider 以前只看 ZCODE_ENV，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    ZCODE_BASE_URL: env.VITE_ZCODE_BASE_URL,
    ZCODE_ENDPOINT_ORIGIN: env.VITE_ZCODE_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_ZCODE_ENDPOINT_URLS = buildRuntimeZCodeEndpointUrls(
  createRendererZCodeEndpointEnv(),
);
