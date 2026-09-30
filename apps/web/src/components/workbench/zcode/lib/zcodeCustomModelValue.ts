/**
 * zcode 照搬：`@/lib/zcodeCustomModelValue.ts`（references/zcode/packages/ui/src/lib/zcodeCustomModelValue.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
import {
  decodeCustomModelValue as decodeSharedCustomModelValue,
  encodeCustomModelValue as encodeSharedCustomModelValue,
} from "@zui/lib/zcode-shared";

interface DecodedCustomModelValue {
  providerId: string;
  modelName?: string;
}

export function encodeCustomModelValue(
  providerId: string,
  modelName?: string,
): string {
  return encodeSharedCustomModelValue(providerId, modelName);
}

export function decodeCustomModelValue(
  value: string,
): DecodedCustomModelValue | null {
  return decodeSharedCustomModelValue(value);
}
