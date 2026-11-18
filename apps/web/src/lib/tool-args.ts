/**
 * 工具事件入参的归一化。
 *
 * 服务端把 `tool.started.input` 原样透传 LangGraph 的节点输入，**实测形状是包了一层的**：
 *
 * ```json
 * { "input": "{\"todos\":[{\"content\":\"…\",\"status\":\"in_progress\"}]}" }
 * ```
 *
 * 而逻辑上的参数是 `{ todos: [...] }`。按逻辑形状取值的消费方（待办表解析、
 * 子代理名/描述）因此**静默拿不到值**——面板不出现、条目名回落成工具名，且没有任何报错。
 * 这里统一归一化：剥掉包装层，并对字符串做一次 JSON 解析。
 *
 * 保守规则：只有当外层对象**除了 `input` 之外没有别的键**时才解包——工具真的有个
 * 叫 `input` 的参数时（外层还会带别的键）不会被误剥。
 */
export function normalizeToolArgs(
  input: unknown,
): Record<string, unknown> | null {
  if (!isPlainObject(input)) return null;

  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === "input") {
    const inner = input.input;
    if (typeof inner === "string") {
      const parsed = tryParseJsonObject(inner);
      if (parsed) return parsed;
      return null;
    }
    if (isPlainObject(inner)) return inner;
    return null;
  }

  return input;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
