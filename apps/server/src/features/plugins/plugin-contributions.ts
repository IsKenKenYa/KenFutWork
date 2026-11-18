import { posix } from "node:path";

import type { BundleFiles } from "./bundle-manifest.js";

/**
 * 插件贡献面：从已安装 bundle 的文件里读技能之外的资源。
 *
 * 本仓内核早期只公开技能（`skills/**\/SKILL.md`）与可执行入口；zcode 官方插件还带
 * 三类**声明式**贡献：远程/本地 MCP server、斜杠命令 Markdown、会话钩子脚本。
 * 这里把它们归一化成宿主可消费的结构，安装/停用由 registry 统一裁决——文件格式保持
 * zcode 原样（`mcp.json`、`commands/*.md`、`hooks/hooks.json`），不要求改上游包。
 */

export interface PluginMcpServerContribution {
  pluginId: string;
  pluginName: string;
  name: string;
  kind: "stdio" | "http";
  command: string;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  timeoutMs: number | null;
  enabled: boolean;
}

export interface PluginCommandContribution {
  pluginId: string;
  pluginName: string;
  name: string;
  description: string;
  prompt: string;
}

export interface PluginHookContribution {
  pluginId: string;
  pluginName: string;
  event: "turn-start";
  matcher: string;
  command: string;
  args: string[];
  timeoutMs: number;
  /** 已安装包根目录：运行时把参数里的 `${ZCODE_PLUGIN_ROOT}` 换成它。 */
  pluginRoot: string;
}

export interface PluginContributions {
  mcpServers: PluginMcpServerContribution[];
  commands: PluginCommandContribution[];
  hooks: PluginHookContribution[];
  /** 被跳过的条目原因（坏 JSON、非法命令名等），供日志与测试。 */
  issues: string[];
}

const COMMAND_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/u;
const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

function readJson(
  files: BundleFiles,
  path: string,
  issues: string[],
): Record<string, unknown> | null {
  const raw = files[path];
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    issues.push(`${path} 不是合法 JSON`);
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** `${user_config.<key>}` 用插件清单里的默认值替换（Unreal endpoint 等）。 */
function substituteUserConfig(
  value: string,
  defaults: Record<string, string>,
): string {
  return value.replace(
    /\$\{user_config\.([A-Za-z0-9_-]+)\}/gu,
    (token, key: string) => defaults[key] ?? token,
  );
}

function userConfigDefaults(
  pkg: Record<string, unknown> | null,
): Record<string, string> {
  const config = asRecord(asRecord(pkg?.kenfutwork)?.userConfig);
  if (!config) return {};
  const defaults: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    const item = asRecord(value);
    if (typeof item?.default === "string") defaults[key] = item.default;
  }
  return defaults;
}

function parseMcpServers(input: {
  files: BundleFiles;
  pkg: Record<string, unknown> | null;
  pluginId: string;
  pluginName: string;
  issues: string[];
}): PluginMcpServerContribution[] {
  const { files, pkg, pluginId, pluginName, issues } = input;
  const defaults = userConfigDefaults(pkg);
  const fromPackage = asRecord(asRecord(pkg?.kenfutwork)?.mcpServers);
  const fromFile = asRecord(readJson(files, "mcp.json", issues)?.mcpServers);
  const merged = new Map<string, unknown>([
    ...Object.entries(fromPackage ?? {}),
    ...Object.entries(fromFile ?? {}),
  ]);
  const servers: PluginMcpServerContribution[] = [];
  for (const [name, value] of merged) {
    const spec = asRecord(value);
    if (!spec) {
      issues.push(`MCP ${name} 配置不是对象`);
      continue;
    }
    const kind =
      spec.type === "http" || spec.kind === "http" ? "http" : "stdio";
    const url =
      typeof spec.url === "string"
        ? substituteUserConfig(spec.url, defaults)
        : null;
    const command =
      typeof spec.command === "string"
        ? substituteUserConfig(spec.command, defaults)
        : "";
    if (kind === "http" && (!url || !/^https?:\/\//u.test(url))) {
      issues.push(`MCP ${name} 缺少合法 url`);
      continue;
    }
    if (kind === "stdio" && !command.trim()) {
      issues.push(`MCP ${name} 缺少 command`);
      continue;
    }
    servers.push({
      pluginId,
      pluginName,
      name,
      kind,
      command,
      args: asStringArray(spec.args).map((arg) =>
        substituteUserConfig(arg, defaults),
      ),
      url: kind === "http" ? url : null,
      env: Object.fromEntries(
        Object.entries(asStringRecord(spec.env)).map(([key, item]) => [
          key,
          substituteUserConfig(item, defaults),
        ]),
      ),
      headers: Object.fromEntries(
        Object.entries(asStringRecord(spec.headers)).map(([key, item]) => [
          key,
          substituteUserConfig(item, defaults),
        ]),
      ),
      timeoutMs:
        typeof spec.timeoutMs === "number" && Number.isFinite(spec.timeoutMs)
          ? spec.timeoutMs
          : null,
      enabled: spec.enabled !== false,
    });
  }
  return servers;
}

function parseFrontmatterDescription(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(content);
  if (!match) return "";
  const line = match[1]
    ?.split(/\r?\n/u)
    .find((entry) => entry.trimStart().startsWith("description:"));
  if (!line) return "";
  return line.replace(/^\s*description:\s*/u, "").trim();
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "").trim();
}

function parseCommands(input: {
  files: BundleFiles;
  pluginId: string;
  pluginName: string;
  issues: string[];
}): PluginCommandContribution[] {
  const { files, pluginId, pluginName, issues } = input;
  const commands: PluginCommandContribution[] = [];
  const seen = new Set<string>();
  for (const [path, content] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!path.startsWith("commands/") || !path.endsWith(".md")) continue;
    if (posix.dirname(path) !== "commands") continue;
    const name = posix.basename(path, ".md");
    if (!COMMAND_NAME.test(name)) {
      issues.push(`命令文件名不合法：${path}`);
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      issues.push(`命令名重复：${name}`);
      continue;
    }
    const prompt = stripFrontmatter(content);
    if (!prompt) {
      issues.push(`命令 ${name} 缺少提示词正文`);
      continue;
    }
    seen.add(key);
    commands.push({
      pluginId,
      pluginName,
      name,
      description: parseFrontmatterDescription(content),
      prompt,
    });
  }
  return commands;
}

function parseHooks(input: {
  files: BundleFiles;
  pluginId: string;
  pluginName: string;
  pluginRoot: string;
  issues: string[];
}): PluginHookContribution[] {
  const { files, pluginId, pluginName, pluginRoot, issues } = input;
  const raw = readJson(files, "hooks/hooks.json", issues);
  const groups = asRecord(raw?.hooks)?.SessionStart;
  if (!Array.isArray(groups)) return [];
  const hooks: PluginHookContribution[] = [];
  for (const group of groups) {
    const record = asRecord(group);
    const entries = record?.hooks;
    if (!Array.isArray(entries)) continue;
    const matcher =
      typeof record?.matcher === "string"
        ? record.matcher
        : "startup|clear|compact";
    for (const entry of entries) {
      const hook = asRecord(entry);
      if (hook?.type !== "process") {
        issues.push(`Hook 只支持 process：${String(hook?.type ?? "unknown")}`);
        continue;
      }
      const command =
        typeof hook.command === "string" ? hook.command.trim() : "";
      if (!command) {
        issues.push("Hook 缺少 command");
        continue;
      }
      hooks.push({
        pluginId,
        pluginName,
        event: "turn-start",
        matcher,
        command,
        args: asStringArray(hook.args),
        timeoutMs:
          typeof hook.timeoutMs === "number" &&
          Number.isFinite(hook.timeoutMs) &&
          hook.timeoutMs > 0
            ? hook.timeoutMs
            : DEFAULT_HOOK_TIMEOUT_MS,
        pluginRoot,
      });
    }
  }
  return hooks;
}

export function readPluginContributions(
  files: BundleFiles,
  input: { pluginId: string; pluginName: string; pluginRoot: string },
): PluginContributions {
  const issues: string[] = [];
  const pkg = readJson(files, "package.json", issues);
  return {
    mcpServers: parseMcpServers({
      files,
      pkg,
      pluginId: input.pluginId,
      pluginName: input.pluginName,
      issues,
    }),
    commands: parseCommands({
      files,
      pluginId: input.pluginId,
      pluginName: input.pluginName,
      issues,
    }),
    hooks: parseHooks({
      files,
      pluginId: input.pluginId,
      pluginName: input.pluginName,
      pluginRoot: input.pluginRoot,
      issues,
    }),
    issues,
  };
}
