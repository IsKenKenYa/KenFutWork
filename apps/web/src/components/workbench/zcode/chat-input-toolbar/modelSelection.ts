/**
 * zcode 照搬：`@/chat-input-toolbar/modelSelection.ts`（references/zcode/packages/ui/src/chat-input-toolbar/modelSelection.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */

import { decodeCustomModelValue } from "@zui/lib/zcodeCustomModelValue";
import type { ModelSelectGroup } from "@zui/ModelConfigSelect";

export function shouldShowManageModelsAction(
  onManageModels?: () => void,
): boolean {
  return typeof onManageModels === "function";
}

function resolveModelValueDisplayLabel(value: string): string {
  const customSelection = decodeCustomModelValue(value);
  if (customSelection?.modelName?.trim()) {
    return customSelection.modelName.trim();
  }

  const normalizedValue = value.trim();
  const separatorIndex = normalizedValue.indexOf("/");
  if (separatorIndex > 0 && separatorIndex < normalizedValue.length - 1) {
    const modelName = normalizedValue.slice(separatorIndex + 1).trim();
    if (modelName) return modelName;
  }
  return normalizedValue;
}

export function resolveModelSelectTriggerDisplay(
  normalizedValue: string,
  modelGroups: readonly ModelSelectGroup[],
  showManageModelsAction: boolean,
  manageModelsLabel?: string,
  options?: {
    allowUnavailableCustomModelPlaceholder?: boolean;
    allowUnavailableModelPlaceholder?: boolean;
  },
): { value: string | undefined; placeholder: string | undefined } {
  if (normalizedValue.trim().toLocaleLowerCase() === "<synthetic>") {
    return { value: undefined, placeholder: undefined };
  }
  if (
    modelGroups.some((group) =>
      group.items.some((item) => item.value === normalizedValue),
    )
  ) {
    return { value: normalizedValue, placeholder: undefined };
  }

  const customSelection = decodeCustomModelValue(normalizedValue);
  if (
    options?.allowUnavailableCustomModelPlaceholder &&
    customSelection?.modelName?.trim()
  ) {
    return { value: undefined, placeholder: customSelection.modelName.trim() };
  }
  if (options?.allowUnavailableModelPlaceholder && normalizedValue.trim()) {
    return {
      value: undefined,
      placeholder: resolveModelValueDisplayLabel(normalizedValue),
    };
  }
  if (modelGroups.length === 0 && showManageModelsAction) {
    return { value: undefined, placeholder: manageModelsLabel };
  }
  return { value: undefined, placeholder: undefined };
}
