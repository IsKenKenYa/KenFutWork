/**
 * zcode 照搬：`@/hooks/useStableAccountAccess.ts`（references/zcode/packages/ui/src/hooks/useStableAccountAccess.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import type {
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zui/lib/zcode-shared";
import { useRef } from "react";

type StableAccountAccess = ZCodeProviderAccountAccess | ZCodeAccountAccess;

/** Schema 解析会为同一份 Account Access 生成新对象；hook 依赖必须按配置值稳定。 */
export function useStableAccountAccess(
  accountAccess: StableAccountAccess | null | undefined,
): StableAccountAccess | undefined {
  const normalized = accountAccess ?? undefined;
  const key = JSON.stringify(accountAccess ?? null);
  const stable = useRef({ key, value: normalized });
  if (stable.current.key !== key) {
    stable.current = { key, value: normalized };
  }
  return stable.current.value;
}
