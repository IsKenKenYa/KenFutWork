/**
 * zcode 照搬：`@/hooks/useInterfaceMode.ts`（references/zcode/packages/ui/src/hooks/useInterfaceMode.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
import { useZCodeStoreWithDefault } from "@zui/store/StoreProvider";

export function useIsOfficeMode(): boolean {
  return useZCodeStoreWithDefault(
    (state) => state.interfaceMode === "office",
    false,
  );
}
