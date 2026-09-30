/**
 * zcode 照搬：`@/lib/tokenNumberFormat.ts`（references/zcode/packages/ui/src/lib/tokenNumberFormat.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
export function formatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  // token 数值仍应走本地化 compact；中文展示万/亿，英文展示 K/M/B。
  // 之前为了修 Start Plan 的英文 long unit 误把所有 locale 都强制成 K/M/B。
  return new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatModelContextWindowLabel(
  contextWindow: number,
  _locale = "en-US",
): string {
  // 模型列表的容量 badge 是技术规格，不应随中文 locale 变成“万/亿”。
  return formatCompactTokenNumber("en-US", contextWindow);
}
