/**
 * zcode 照搬：`@/lib/e2eStoreBridge.ts`（references/zcode/packages/ui/src/lib/e2eStoreBridge.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
type E2EStoreBridgeImportMetaEnv = {
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
};

function readE2EStoreBridgeImportMetaEnv(): E2EStoreBridgeImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: E2EStoreBridgeImportMetaEnv })
    .env ?? {}) as E2EStoreBridgeImportMetaEnv;
}

export function shouldExposeE2EStoreBridge(
  env: E2EStoreBridgeImportMetaEnv = readE2EStoreBridgeImportMetaEnv(),
): boolean {
  return (
    typeof window !== "undefined" && env.VITE_ZCODE_E2E_STORE_BRIDGE === "1"
  );
}
