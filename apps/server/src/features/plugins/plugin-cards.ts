import {
  type PluginCardDeclaration,
  resolveGovernanceNumber,
} from "@kenfutwork/shared";

export interface PluginCardLimits {
  maxFields: number;
  maxValueCharacters: number;
}

/**
 * 卡片上限的缺省值来自治理表，业务代码不写固定字面量。
 * 调用方（HTTP 路由）会传入实例设置里的当前值。
 */
export function defaultPluginCardLimits(): PluginCardLimits {
  return {
    maxFields: resolveGovernanceNumber("pluginCardMaxFields", null),
    maxValueCharacters: resolveGovernanceNumber(
      "pluginCardFieldValueMaxChars",
      null,
    ),
  };
}

/**
 * 按治理上限裁剪卡片：超出键值行按声明顺序截掉，标签与值超过字符上限时保留开头并加省略号。
 * 数值类型原样保留，避免把数字变成字符串影响界面读数。
 */
export function truncatePluginCards(
  cards: readonly PluginCardDeclaration[],
  limits: PluginCardLimits,
): PluginCardDeclaration[] {
  const maxFields = Math.max(1, Math.floor(limits.maxFields));
  const maxChars = Math.max(1, Math.floor(limits.maxValueCharacters));
  return cards.map((card) => ({
    ...card,
    fields: card.fields.slice(0, maxFields).map((field) => ({
      label: truncateText(field.label, maxChars),
      value:
        typeof field.value === "number"
          ? field.value
          : truncateText(field.value, maxChars),
    })),
  }));
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}
