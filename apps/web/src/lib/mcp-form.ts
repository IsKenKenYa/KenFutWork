/**
 * MCP server 表单的纯逻辑（解析/校验/密钥保留），供设置页与单测共用。
 *
 * 两个易错点在这里处理掉：
 * 1. **参数含空格**：`args` 用「一行一个」而不是空格分隔（`--path /a b` 这类值
 *    用空格切分会碎）；
 * 2. **密钥只写不读**：接口只回 `envKeys`，编辑时若不重填 env，请求必须
 *    **不带 env 字段**（带了就等于用空对象覆盖掉已存的密钥）。
 */

export const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 参数文本 → 数组（一行一个，去空行）。 */
export function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function formatArgsText(args: string[]): string {
  return args.join("\n");
}

export interface EnvParseResult {
  env: Record<string, string>;
  errors: string[];
}

/** env 文本 → 记录（一行 `KEY=VALUE`）。 */
export function parseEnvText(text: string): EnvParseResult {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const index = line.indexOf("=");
    if (index <= 0) {
      errors.push(`环境变量行缺少 KEY=：${line}`);
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`环境变量名不合法：${key}`);
      continue;
    }
    env[key] = value;
  }
  return { env, errors };
}

export interface McpServerFormInput {
  name: string;
  command: string;
  argsText: string;
  envText: string;
}

export interface McpServerFormResult {
  errors: string[];
  /** 可直接发请求的 payload（编辑态可能不含 env/name）。 */
  payload: {
    name?: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

/**
 * 校验并构造请求载荷。
 * @param mode create 时 name 必填且校验格式；edit 时 name 不参与（改名走不到此处）
 * @param envTouched 用户是否在编辑态改动过 env 输入（未改动则不下发 env，保住已存密钥）
 */
export function buildMcpServerPayload(
  input: McpServerFormInput,
  options: { mode: "create" | "edit"; envTouched: boolean },
): McpServerFormResult {
  const errors: string[] = [];
  const name = input.name.trim();
  const command = input.command.trim();

  if (options.mode === "create") {
    if (!name) {
      errors.push("名称必填。");
    } else if (!MCP_NAME_PATTERN.test(name)) {
      errors.push("名称只允许字母、数字、- 与 _。");
    }
  }
  if (!command) {
    errors.push("启动命令必填。");
  }

  const { env, errors: envErrors } = parseEnvText(input.envText);
  errors.push(...envErrors);

  const shouldSendEnv = options.mode === "create" || options.envTouched;

  return {
    errors,
    payload: {
      ...(options.mode === "create" ? { name } : {}),
      command,
      args: parseArgsText(input.argsText),
      ...(shouldSendEnv ? { env } : {}),
    },
  };
}
