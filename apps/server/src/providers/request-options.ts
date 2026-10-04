/** 模型行为参数不能覆盖可信调用身份、输入、工具目录或凭证。 */
export function validateInstanceModelExtraBody(
  extraBody: Record<string, unknown> | undefined,
): void {
  const reserved = new Set([
    "model",
    "modelid",
    "messages",
    "input",
    "contents",
    "headers",
    "apikey",
    "api_key",
    "authorization",
    "baseurl",
    "base_url",
    "configuration",
    "credentials",
    "__proto__",
    "prototype",
    "constructor",
    "tools",
    "system",
    "systeminstruction",
    "stream",
  ]);
  for (const key of Object.keys(extraBody ?? {})) {
    if (reserved.has(key.toLowerCase()))
      throw new Error(`模型选项不得覆盖请求身份或凭证字段：${key}`);
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 已编译的完整参数覆盖SDK缺省；嵌套配置合并，显式false/null原样发送。 */
export function mergeInvocationParameters<T extends object>(
  base: T,
  extraBody: Record<string, unknown>,
): T {
  const original = base as Record<string, unknown>;
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(extraBody).map(([key, value]) => [
        key,
        record(value) && record(original[key])
          ? mergeInvocationParameters(original[key], value)
          : value,
      ]),
    ),
  };
}
