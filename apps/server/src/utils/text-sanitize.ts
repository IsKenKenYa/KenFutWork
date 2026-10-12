/**
 * 落库前的文本清洗：剥掉 U+0000。
 *
 * 为什么必须有：Postgres 的 `jsonb` 与 `text` 都存不了 NUL 字符——
 *   - 写 jsonb：`JSON.stringify` 会把 NUL 转义成字面量 `\u0000`，Postgres 解析时
 *     报 `unsupported Unicode escape sequence`（detail：`\u0000 cannot be converted to text.`）；
 *   - 写 text：报 `invalid byte sequence for encoding "UTF8": 0x00`。
 *
 * 而 NUL 在真实数据里并不罕见：Windows 上 `wsl`/部分系统工具按 UTF-16LE 输出，
 * 被按 UTF-8 解码后**每个 ASCII 字符后面都跟一个 U+0000**；二进制文件片段、终端控制
 * 序列也会带。实测后果是整轮 run 被 `run_failed` 终结（用户只看到一行英文报错），
 * 见《未做需求》#13。
 *
 * 口径：NUL 对文本没有语义，直接剥掉（不是替换成占位符——UTF-16LE 的 ASCII 文本剥掉
 * NUL 后正好还原成可读文本，替换反而会变成一串 `�`）。原始字节仍在磁盘上的
 * `outputPath` 里，需要逐字节比对时可回读。
 */

const NUL = "\u0000";

/** 剥掉字符串里的全部 U+0000；不含 NUL 时原样返回（不产生新字符串）。 */
export function stripNulCharacters(text: string): string {
  return text.includes(NUL) ? text.replaceAll(NUL, "") : text;
}

/**
 * 深拷贝并剥掉字符串里的 NUL。**不改动入参**（调用方可能复用同一对象继续跑）。
 * 只处理 JSON 可表达的结构：对象 / 数组 / 字符串；其余（数字、布尔、null、
 * undefined、函数、Symbol）按原值透传，由 `JSON.stringify` 决定最终行为。
 *
 * 用 Map 记忆「原对象 → 已清洗副本」而不是 WeakSet：共享引用（DAG，同一子对象被
 * 两个字段引用）必须也拿到清洗后的副本，否则第二次出现会漏洗。真环交给
 * `JSON.stringify` 去抛（保持原有报错行为），这里只保证不死循环。
 */
export function sanitizeNulDeep(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (typeof value === "string") return stripNulCharacters(value);
  if (value === null || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const entry of value) clone.push(sanitizeNulDeep(entry, seen));
    return clone;
  }
  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const key of Object.keys(source)) {
    clone[key] = sanitizeNulDeep(source[key], seen);
  }
  return clone;
}

/** 递归剥 NUL 的 JSON 序列化：给所有 `::jsonb` 参数用（语义与 `JSON.stringify` 一致）。 */
export function jsonbSafeStringify(value: unknown): string | undefined {
  return JSON.stringify(sanitizeNulDeep(value));
}
