import type { ProviderInstanceHeaders } from "@kenfutwork/shared";

/**
 * 供应商实例自定义请求头（§4.8）的**表单解析**：用户在 textarea 里贴 JSON。
 *
 * 只做两件事：空 → undefined（= 不带自定义头），非法/非对象 → 可读错误。
 * 真正的校验（头名 token、保留头、禁 CR/LF、占位符白名单）在服务端契约里，
 * 这里只是即时反馈——**前端不是安全边界**。
 */
export function parseHeadersJson(
  input: string,
): ProviderInstanceHeaders | undefined | Error {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return new Error("自定义请求头必须是合法 JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new Error('自定义请求头必须是 JSON 对象，如 {"x-tenant-id":"ws-1"}');
  }

  return parsed as ProviderInstanceHeaders;
}

/** 表单里的输入提示（用户与管理员两处表单共用同一句，避免两处口径漂移）。 */
export const providerHeadersHint =
  "值可用 {{sessionId}} / {{threadId}} 占位符；保存后不再显示值。";
