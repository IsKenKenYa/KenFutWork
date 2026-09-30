/**
 * zcode 照搬：`@/lib/modelThoughtOption.ts`（references/zcode/packages/ui/src/lib/modelThoughtOption.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import type { ModelSelectionView } from "@zui/lib/zcode-services";
import type { ZCodeConfigOption } from "@zui/lib/zcode-shared";

/** 从 Registry 的 ModelConfig Option Specs 读取思考档位。 */
export function resolveModelThoughtOption(params: {
  modelSelectionView: ModelSelectionView;
  providerId: string;
  modelId: string;
  currentValue?: string;
  formatLevelName?: (level: string) => string;
}): ZCodeConfigOption | null {
  const provider = params.modelSelectionView.providers.find(
    (candidate) => candidate.providerId === params.providerId,
  );
  const model = provider?.models.find(
    (candidate) => candidate.modelId === params.modelId,
  );
  const reasoning = model?.config.optionSpecs.reasoningLevel;
  if (!reasoning || reasoning.values.length === 0) return null;

  return {
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    type: "select",
    // Reasoning 没有默认档位；空字符串表示模型已选但用户尚未选择 reasoning。
    currentValue:
      params.currentValue && reasoning.values.includes(params.currentValue)
        ? params.currentValue
        : "",
    options: reasoning.values.map((level) => ({
      value: level,
      name: params.formatLevelName?.(level) ?? level,
    })),
  };
}
