import {
  type ClaudeMcpMarketplaceAddRequest,
  type ClaudeMcpMarketplaceInput,
  type ClaudeMcpMarketplaceServer,
  mcpServerCreateRequestSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import type { McpServerCreateRaw } from "./server-store.js";

/**
 * Claude Code 官方插件市场的 MCP 声明解析。
 *
 * Claude Code 的 MCP 服务随插件分发：市场仓库的 `.claude-plugin/marketplace.json`
 * 列出插件，插件在根目录 `.mcp.json` 或 `plugin.json` 的 `mcpServers` 里声明服务。
 * 本文件只做纯换算——把读到的文本变成「可添加的服务 + 要填的变量」，不做网络读写；
 * 读取与缓存在 `claude-marketplace-service.ts`。
 */

/** 官方市场；清单里写相对路径的插件也从这里读。 */
export const CLAUDE_OFFICIAL_MARKETPLACE = {
  name: "claude-plugins-official",
  owner: "Anthropic",
  repository: {
    owner: "anthropics",
    repo: "claude-plugins-official",
    ref: "main",
  },
} as const;

export class ClaudeMarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeMarketplaceError";
  }
}

const marketplaceFileSchema = z.object({
  name: z.string().min(1),
  owner: z.unknown().optional(),
  plugins: z.array(
    z.object({
      name: z.string().min(1),
      source: z.unknown(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      homepage: z.string().optional(),
      author: z.unknown().optional(),
    }),
  ),
});

export interface MarketplacePlugin {
  name: string;
  source: unknown;
  title: string;
  description: string;
  category: string | null;
  homepage: string | null;
  author: string | null;
}

export interface MarketplaceFile {
  name: string;
  owner: string;
  plugins: MarketplacePlugin[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const UNKNOWN_OWNER = "未知";

function readOwner(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  const name = asRecord(value)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : UNKNOWN_OWNER;
}

/** 解析市场清单；格式不对时抛可读原因。 */
export function parseMarketplaceFile(text: string): MarketplaceFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ClaudeMarketplaceError("市场清单不是合法 JSON。");
  }
  const parsed = marketplaceFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ClaudeMarketplaceError("市场清单格式不对，读不出插件列表。");
  }
  return {
    name: parsed.data.name,
    owner: readOwner(parsed.data.owner),
    plugins: parsed.data.plugins.map((plugin) => {
      const author = readOwner(plugin.author);
      return {
        name: plugin.name,
        source: plugin.source,
        title: plugin.displayName?.trim() || plugin.name,
        description: plugin.description?.trim() || "",
        category: plugin.category?.trim() || null,
        homepage: plugin.homepage?.trim() || null,
        author: author === UNKNOWN_OWNER ? null : author,
      };
    }),
  };
}

/** 插件文件所在的仓库位置：`ref` 是固定提交号或分支，`subdir` 是包在仓库里的目录。 */
export interface PluginLocation {
  owner: string;
  repo: string;
  ref: string;
  subdir: string;
}

export type PluginLocationResult =
  | { kind: "located"; location: PluginLocation }
  /** 构建命令、npm 包、压缩包这类来源没有可以静态读取的目录。 */
  | { kind: "noFiles" }
  | { kind: "failed"; reason: string };

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const GITHUB_REPO = /^[A-Za-z0-9_.-]+$/u;
/** 提交号、分支或标签；不允许 `..`。 */
const GIT_REF = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/u;

/** `https://github.com/owner/repo(.git)` 或 `owner/repo` 简写。 */
function parseGitHubRemote(
  raw: string,
): { owner: string; repo: string } | null {
  const text = raw.trim();
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(
    text,
  );
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/u.exec(text);
  const match = url ?? shorthand;
  if (!match) return null;
  const [, owner, repo] = match;
  if (!GITHUB_OWNER.test(owner ?? "") || !GITHUB_REPO.test(repo ?? "")) {
    return null;
  }
  return { owner: owner as string, repo: repo as string };
}

/** 仓库内目录：去掉 `./` 与空段；出现 `..`、反斜杠或特殊字符就不认。空串表示仓库根。 */
function normalizeSubdir(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  if (raw.includes("\\")) return null;
  const segments: string[] = [];
  for (const segment of raw.trim().split("/")) {
    if (segment === "" || segment === ".") continue;
    // `..` 一律拒绝：虽然拼进相对路径后未必越界，但显示与排查都不可控
    if (segment === ".." || !PATH_SEGMENT.test(segment)) return null;
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * 把市场条目的来源换算成可读取的仓库位置。
 *
 * 只读 GitHub 公开仓库：文件经 raw.githubusercontent.com 按固定提交号取，
 * 「清单里写的是哪一版」与「读到的就是哪一版」一致。
 */
export function resolvePluginLocation(
  plugin: MarketplacePlugin,
  marketplace: typeof CLAUDE_OFFICIAL_MARKETPLACE = CLAUDE_OFFICIAL_MARKETPLACE,
): PluginLocationResult {
  const source = plugin.source;
  if (typeof source === "string") {
    const subdir = normalizeSubdir(source);
    if (subdir === null) {
      return { kind: "failed", reason: "插件路径不合法。" };
    }
    return {
      kind: "located",
      location: { ...marketplace.repository, subdir },
    };
  }
  const record = asRecord(source);
  const kind = typeof record?.source === "string" ? record.source : "";
  if (!["github", "git", "git-subdir", "url"].includes(kind)) {
    return { kind: "noFiles" };
  }
  const remote =
    kind === "github"
      ? parseGitHubRemote(String(record?.repo ?? ""))
      : parseGitHubRemote(String(record?.url ?? ""));
  if (!remote) {
    return { kind: "failed", reason: "插件来源不是 GitHub 公开仓库。" };
  }
  const ref = [record?.sha, record?.ref, record?.commit].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (!ref) {
    return { kind: "failed", reason: "插件来源没有固定版本。" };
  }
  if (!GIT_REF.test(ref.trim())) {
    return { kind: "failed", reason: "插件的版本号不合法。" };
  }
  const subdir = normalizeSubdir(record?.path);
  if (subdir === null) {
    return { kind: "failed", reason: "插件路径不合法。" };
  }
  return {
    kind: "located",
    location: { ...remote, ref: ref.trim(), subdir },
  };
}

/** 插件内相对路径（`plugin.json` 里声明的文件）；越界、绝对路径、带转义的一律不认。 */
function normalizePluginRelativePath(raw: string): string | null {
  if (raw.startsWith("/") || /[%\\]/u.test(raw)) return null;
  const normalized = normalizeSubdir(raw);
  return normalized ? normalized : null;
}

/** 插件内某个文件的 raw 地址。 */
export function pluginFileUrl(
  rawBaseUrl: string,
  location: PluginLocation,
  relativePath: string,
): string {
  const parts = [location.subdir, relativePath].filter(Boolean).join("/");
  return `${rawBaseUrl.replace(/\/+$/u, "")}/${location.owner}/${location.repo}/${location.ref}/${parts}`;
}

/** `mcpServers` 里的一个条目：服务名与原始定义（定义不是对象时原样保留）。 */
export interface RawServerDefinition {
  name: string;
  spec: unknown;
}

/** `plugin.json` 的 `userConfig` 选项：`${user_config.KEY}` 的填写提示。 */
export interface UserConfigOption {
  title: string | null;
  description: string | null;
  required: boolean | null;
  sensitive: boolean;
  default: string | null;
}

export type UserConfigMap = Record<string, UserConfigOption>;

function readUserConfig(manifest: Record<string, unknown>): UserConfigMap {
  const config: UserConfigMap = {};
  for (const [key, value] of Object.entries(
    asRecord(manifest.userConfig) ?? {},
  )) {
    const option = asRecord(value);
    if (!option) continue;
    config[key] = {
      title:
        typeof option.title === "string" && option.title.trim()
          ? option.title.trim()
          : null,
      description:
        typeof option.description === "string" && option.description.trim()
          ? option.description.trim()
          : null,
      required: typeof option.required === "boolean" ? option.required : null,
      sensitive: option.sensitive === true,
      default:
        typeof option.default === "string" && option.default.trim()
          ? option.default
          : null,
    };
  }
  return config;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ClaudeMarketplaceError(`${label} 不是合法 JSON。`);
  }
  const record = asRecord(json);
  if (!record) {
    throw new ClaudeMarketplaceError(`${label} 的内容不是对象。`);
  }
  return record;
}

/** 一份 `mcpServers` 映射；不是对象时抛可读原因。 */
function readServerMap(value: unknown, label: string): RawServerDefinition[] {
  const map = asRecord(value);
  if (!map) {
    throw new ClaudeMarketplaceError(`${label} 里的 mcpServers 不是对象。`);
  }
  return Object.entries(map).map(([name, spec]) => ({ name, spec }));
}

/** 文件内容里的 `mcpServers` 映射。 */
function readServersFromDocument(
  document: Record<string, unknown>,
  label: string,
): RawServerDefinition[] {
  return readServerMap(document.mcpServers, label);
}

/**
 * 读一个插件的 MCP 声明，顺序与 Claude Code 一致：先根目录 `.mcp.json`，
 * 再 `plugin.json` 的 `mcpServers`（内联映射或文件路径）；同名服务后者覆盖前者。
 * `readFile` 对不存在的文件返回 null。
 */
export async function readPluginDefinitions(input: {
  readFile(relativePath: string): Promise<string | null>;
}): Promise<{
  servers: RawServerDefinition[];
  userConfig: UserConfigMap;
}> {
  const merged = new Map<string, RawServerDefinition>();
  const mcpText = await input.readFile(".mcp.json");
  if (mcpText !== null) {
    for (const definition of readServersFromDocument(
      parseJsonObject(mcpText, ".mcp.json"),
      ".mcp.json",
    )) {
      merged.set(definition.name, definition);
    }
  }

  const manifestText = await input.readFile(".claude-plugin/plugin.json");
  if (manifestText === null) {
    return { servers: [...merged.values()], userConfig: {} };
  }
  const manifest = parseJsonObject(manifestText, "plugin.json");
  if ("mcpServers" in manifest) {
    // 声明可以是单个形状，也可以是多种形状的数组（Claude Code 按顺序合并）
    for (const shape of [manifest.mcpServers].flat()) {
      if (typeof shape === "string") {
        if (/^https?:\/\//u.test(shape) || /\.(?:mcpb|dxt)$/iu.test(shape)) {
          throw new ClaudeMarketplaceError("插件用 MCP 安装包声明服务。");
        }
        const relativePath = normalizePluginRelativePath(shape);
        if (!relativePath) {
          throw new ClaudeMarketplaceError(
            `插件声明的文件路径不合法：${shape}`,
          );
        }
        const text = await input.readFile(relativePath);
        if (text === null) {
          throw new ClaudeMarketplaceError(`插件声明的文件不存在：${shape}`);
        }
        for (const definition of readServersFromDocument(
          parseJsonObject(text, shape),
          shape,
        )) {
          merged.set(definition.name, definition);
        }
      } else {
        for (const definition of readServerMap(shape, "plugin.json")) {
          merged.set(definition.name, definition);
        }
      }
    }
  }
  return {
    servers: [...merged.values()],
    userConfig: readUserConfig(manifest),
  };
}

/** `${VAR}` 与 `${VAR:-默认值}`；名字里的点只出现在 `user_config.KEY`。 */
const PLACEHOLDER =
  /\$\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)(?::-([^}]*))?\}/gu;

/** Claude Code 自己提供的路径变量；本项目的 MCP 服务不随插件安装，填不出来。 */
const CLAUDE_VARIABLE_PREFIX = "CLAUDE_";
/** 变量名像密钥时按密码框输入。 */
const SECRET_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE)/iu;
const USER_CONFIG_PREFIX = "user_config.";

interface VariableSpec {
  name: string;
  label: string;
  description: string | null;
  required: boolean;
  secret: boolean;
  defaultValue: string | null;
}

/** 可添加服务的模板：原文照留，变量在添加时按用户填写替换。 */
export interface ServerTemplate {
  kind: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  variables: Map<string, VariableSpec>;
}

export interface CompiledMarketplaceServer {
  view: ClaudeMcpMarketplaceServer;
  /** 可添加时是模板；不可添加为 null。 */
  template: ServerTemplate | null;
}

function describeVariable(
  name: string,
  fallback: string | null,
  userConfig: UserConfigMap,
): VariableSpec {
  const option = name.startsWith(USER_CONFIG_PREFIX)
    ? userConfig[name.slice(USER_CONFIG_PREFIX.length)]
    : undefined;
  const leaf = name.split(".").at(-1) ?? name;
  const label = option?.title ?? leaf;
  return {
    name,
    label,
    description: option?.description ?? null,
    // 本项目不读服务进程的环境变量：没有默认值的变量都要用户填
    required: fallback === null && option?.required !== false,
    secret: option?.sensitive === true || SECRET_NAME.test(leaf),
    defaultValue: fallback,
  };
}

/** 只留字母数字与 - _ 的 MCP 服务名（与新建表单同一条规则）。 */
function suggestServerName(serverName: string, pluginName: string): string {
  const sanitize = (value: string) =>
    value
      .replace(/[^a-zA-Z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64)
      .replace(/-+$/gu, "");
  return sanitize(serverName) || sanitize(pluginName) || "mcp";
}

/**
 * 把一条服务声明换算成界面形态。`disabled: true` 的服务 Claude Code 也不启动，
 * 返回 null 表示不列出。
 */
export function compileMarketplaceServer(input: {
  definition: RawServerDefinition;
  plugin: MarketplacePlugin;
  userConfig: UserConfigMap;
}): CompiledMarketplaceServer | null {
  const { name, spec } = input.definition;
  const record = asRecord(spec);
  if (!record) {
    return {
      view: {
        id: `${input.plugin.name}:${name}`,
        serverName: name,
        suggestedName: suggestServerName(name, input.plugin.name),
        plugin: input.plugin.name,
        pluginTitle: input.plugin.title,
        description: input.plugin.description,
        author: input.plugin.author,
        category: input.plugin.category,
        homepage: input.plugin.homepage,
        kind: "stdio",
        summary: JSON.stringify(spec).slice(0, 200),
        inputs: [],
        addable: false,
        unsupportedReason: "服务定义不是对象",
      },
      template: null,
    };
  }
  // `disabled: true` 的服务 Claude Code 也不启动，不列出
  if (record.disabled === true) return null;

  let reason: string | null = null;
  const fail = (message: string) => {
    if (reason === null) reason = message;
  };

  const declared =
    typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  const command = typeof record.command === "string" ? record.command : "";
  const url = typeof record.url === "string" ? record.url : "";
  let kind: "stdio" | "http" | null;
  if (declared === "") {
    // 没写类型：有启动命令就是本地服务，否则看远程地址
    kind = !command.trim() && url.trim() ? "http" : "stdio";
  } else if (declared === "stdio") {
    kind = "stdio";
  } else if (["http", "streamable-http", "sse"].includes(declared)) {
    // 本项目的 http 类型先走 Streamable HTTP，不通再退到 SSE
    kind = "http";
  } else {
    kind = null;
    fail(`不支持的服务类型（${declared}）`);
  }
  const effectiveKind = kind ?? (url.trim() ? "http" : "stdio");

  if (record.headersHelper !== undefined) {
    fail("要运行脚本生成请求头");
  }
  if (record.oauth !== undefined) {
    fail("要登录授权才能连接");
  }

  let args: string[] = [];
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const usedFields: string[] = [];
  if (effectiveKind === "stdio") {
    if (!command.trim()) fail("缺少启动命令");
    if (
      !Array.isArray(record.args) ||
      record.args.some((arg) => typeof arg !== "string")
    ) {
      fail("启动参数不是字符串");
    } else {
      args = record.args as string[];
    }
    const envRecord = asRecord(record.env);
    if (
      envRecord &&
      Object.values(envRecord).every((item) => typeof item === "string")
    ) {
      Object.assign(env, envRecord);
    } else if (record.env !== undefined) {
      fail("环境变量的值不是字符串");
    }
    usedFields.push(command, ...args, ...Object.values(env));
  } else {
    if (!url.trim()) fail("缺少服务地址");
    const headerRecord = asRecord(record.headers);
    if (
      headerRecord &&
      Object.values(headerRecord).every((item) => typeof item === "string")
    ) {
      Object.assign(headers, headerRecord);
    } else if (record.headers !== undefined) {
      fail("请求头的值不是字符串");
    }
    usedFields.push(url, ...Object.values(headers));
  }

  const variables = new Map<string, VariableSpec>();
  for (const field of usedFields) {
    for (const match of field.matchAll(PLACEHOLDER)) {
      const variableName = match[1];
      const defaultValue = match[2];
      if (!variableName) continue;
      if (variableName.startsWith(CLAUDE_VARIABLE_PREFIX)) {
        fail("依赖 Claude 插件目录里的文件");
        continue;
      }
      if (!variables.has(variableName)) {
        const fallback = defaultValue?.trim() ? defaultValue : null;
        variables.set(
          variableName,
          describeVariable(variableName, fallback, input.userConfig),
        );
      }
    }
  }

  const inputs: ClaudeMcpMarketplaceInput[] = [...variables.values()].map(
    (variable) => ({
      name: variable.name,
      label: variable.label,
      description: variable.description,
      required: variable.required,
      secret: variable.secret,
      default: variable.defaultValue,
    }),
  );
  const summary =
    effectiveKind === "stdio"
      ? [command, ...args].filter(Boolean).join(" ")
      : url.trim();
  const addable = reason === null;
  return {
    view: {
      id: `${input.plugin.name}:${name}`,
      serverName: name,
      suggestedName: suggestServerName(name, input.plugin.name),
      plugin: input.plugin.name,
      pluginTitle: input.plugin.title,
      description: input.plugin.description,
      author: input.plugin.author,
      category: input.plugin.category,
      homepage: input.plugin.homepage,
      kind: effectiveKind,
      summary: summary || JSON.stringify(record).slice(0, 200),
      inputs,
      addable,
      unsupportedReason: reason,
    },
    template: addable
      ? {
          kind: effectiveKind,
          command: command || null,
          args,
          env,
          url: url || null,
          headers,
          variables,
        }
      : null,
  };
}

/**
 * 按用户填写的变量值生成 MCP 新建请求。变量先取填写值，没有就用默认值；
 * 必填的没有值时抛可读原因。生成的请求再过一遍与新建表单相同的校验。
 */
export function instantiateMarketplaceServer(
  compiled: CompiledMarketplaceServer,
  input: ClaudeMcpMarketplaceAddRequest,
): McpServerCreateRaw {
  const template = compiled.template;
  if (!template) {
    throw new ClaudeMarketplaceError(
      compiled.view.unsupportedReason ?? "这个服务不能添加。",
    );
  }
  const name = input.name.trim();
  const nameCheck = mcpServerCreateRequestSchema.shape.name.safeParse(name);
  if (!nameCheck.success) {
    throw new ClaudeMarketplaceError(
      nameCheck.error.issues[0]?.message ?? "名称不合法。",
    );
  }

  const values: Record<string, string> = {};
  for (const variable of template.variables.values()) {
    const typed = input.values[variable.name];
    const value =
      typeof typed === "string" && typed.trim()
        ? typed.trim()
        : (variable.defaultValue ?? "");
    if (!value && variable.required) {
      throw new ClaudeMarketplaceError(`请填写 ${variable.label}`);
    }
    values[variable.name] = value;
  }
  // 只替换一轮：填写值里再写 ${...} 不会被继续展开
  const substitute = (text: string) =>
    text.replace(PLACEHOLDER, (whole, variableName: string) =>
      variableName in values ? (values[variableName] as string) : whole,
    );
  const mapValues = (record: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, substitute(value)]),
    );

  const request =
    template.kind === "stdio"
      ? {
          name,
          kind: "stdio" as const,
          command: substitute(template.command ?? ""),
          args: template.args.map(substitute),
          env: mapValues(template.env),
        }
      : {
          name,
          kind: "http" as const,
          url: substitute(template.url ?? ""),
          headers: mapValues(template.headers),
        };
  const parsed = mcpServerCreateRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new ClaudeMarketplaceError(
      parsed.error.issues[0]?.message ?? "填写的内容不符合要求。",
    );
  }
  return {
    name,
    kind: parsed.data.kind,
    command: parsed.data.command,
    args: parsed.data.args,
    url: parsed.data.url ?? null,
    env: parsed.data.env,
    headers: parsed.data.headers,
    enabled: parsed.data.enabled,
  };
}
