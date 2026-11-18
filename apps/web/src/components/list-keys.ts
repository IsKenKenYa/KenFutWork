/**
 * 列表渲染的稳定 key（noArrayIndexKey 的正面修法）。
 *
 * React 的 key 只要求「同列表内唯一 + 同一项跨渲染不变」。用业务内容（id/url/name/文本）当基键
 * 比下标稳：列表被过滤、重排、插入时，下标会让 React 认错项，把组件状态挂到别的行上。
 * 内容本身重复时（例如两条文本完全相同的待办）追加「第几次出现」，既保证唯一性，
 * 又不随列表长度漂移。
 */
export function keyed<T>(
  items: readonly T[],
  toBaseKey: (item: T) => string,
): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = toBaseKey(item);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: occurrence === 0 ? base : `${base}#${occurrence}`, item };
  });
}
