import {
  findUnknownProviderHeaderPlaceholders,
  isReservedProviderHeaderName,
  providerHeaderPlaceholders,
} from "@kenfutwork/shared";

/**
 * 实例自定义请求头的**发送时刻**渲染（《改造计划》§4.8）。
 *
 * 契约层（`providerInstanceHeadersSchema`）已在写入时拒掉非法头名/头值与保留头；
 * 这里做三件运行时才能做的事，全部 fail loud（不静默丢弃配置）：
 *  1. 白名单占位符按会话上下文替换——亲和类头必须逐会话取值；
 *  2. 占位符拿不到上下文（如无 session 的路径）即抛错，不把字面量 `{{sessionId}}` 发出去；
 *  3. 替换后再校验一次保留头与字符集（纵深防御：DB 里的历史值可能早于当前规则）。
 */

export interface HeaderRenderContext {
  sessionId?: string | undefined;
  threadId?: string | undefined;
}

/** RFC 7230 token + 可打印 ASCII，与契约层同口径（此处只做兜底断言）。 */
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]*$/;
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

function contextValue(
  name: string,
  context: HeaderRenderContext,
): string | undefined {
  return (context as Record<string, string | undefined>)[name];
}

function renderHeaderValue(
  headerName: string,
  value: string,
  context: HeaderRenderContext,
): string {
  const unknown = findUnknownProviderHeaderPlaceholders(value);
  if (unknown.length > 0) {
    throw new Error(
      `[providers] 自定义头 ${headerName} 含不支持的占位符 ${unknown
        .map((n) => `{{${n}}}`)
        .join(", ")}；白名单为 ${providerHeaderPlaceholders
        .map((n) => `{{${n}}}`)
        .join(" / ")}（fail loud）。`,
    );
  }

  const rendered = value.replace(
    PLACEHOLDER_PATTERN,
    (_match, rawName: string) => {
      const resolved = contextValue(rawName, context);
      if (!resolved) {
        throw new Error(
          `[providers] 自定义头 ${headerName} 的占位符 {{${rawName}}} 在当前上下文取不到值（该路径没有会话标识），拒绝发送字面量（fail loud）。`,
        );
      }
      return resolved;
    },
  );

  if (!PRINTABLE_ASCII_PATTERN.test(rendered)) {
    throw new Error(
      `[providers] 自定义头 ${headerName} 渲染后含非可打印字符，拒绝发送（fail loud）。`,
    );
  }

  return rendered;
}

/**
 * 把实例自定义头渲染成可直接交给适配器的头表；无配置返回 undefined
 * （适配器据此保持库默认行为，不注入空对象）。
 */
export function renderInstanceHeaders(
  headers: Record<string, string> | undefined,
  context: HeaderRenderContext,
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }

  const rendered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HTTP_TOKEN_PATTERN.test(name)) {
      throw new Error(
        `[providers] 自定义头名 ${name} 不是合法 HTTP token，拒绝发送（fail loud）。`,
      );
    }
    if (isReservedProviderHeaderName(name)) {
      throw new Error(
        `[providers] 自定义头 ${name} 命中保留头（凭证/帧界类由适配器持有），拒绝覆盖（fail loud）。`,
      );
    }
    rendered[name] = renderHeaderValue(name, value, context);
  }

  return rendered;
}

/**
 * 便捷展开：`...instanceHeadersOption(credentials.headers, { sessionId, threadId })`。
 * 无配置时展开为空对象，适配器保持库默认行为。
 */
export function instanceHeadersOption(
  headers: Record<string, string> | undefined,
  context: HeaderRenderContext,
): { headers?: Record<string, string> } {
  const rendered = renderInstanceHeaders(headers, context);
  return rendered ? { headers: rendered } : {};
}
