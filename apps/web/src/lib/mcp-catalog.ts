import type { McpCuratedServer } from "@loomic/shared";

/**
 * 内置 MCP 目录 → 可直接提交的配置（纯函数）。
 *
 * 与服务端 `features/mcp/curated-catalog.ts#buildCuratedArgs` 同规则（前端不能 import
 * 服务端代码）：把 `argsTemplate` 里的 `{{key}}` 用用户填的值替换，必填缺失即报出来，
 * 避免把字面量 `{{dir}}` 当成参数提交给进程。
 */
export interface CuratedPayload {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildCuratedServerPayload(
  entry: McpCuratedServer,
  values: Record<string, string>,
): { payload: CuratedPayload; missing: string[] } {
  const missing: string[] = [];
  const args: string[] = [];

  for (const arg of entry.argsTemplate) {
    const match = /^\{\{(\w+)\}\}$/.exec(arg);
    if (!match) {
      args.push(arg);
      continue;
    }
    const key = match[1] as string;
    const value = (values[key] ?? "").trim();
    if (value) {
      args.push(value);
      continue;
    }
    const param = entry.params.find((item) => item.key === key);
    if (param?.required) {
      missing.push(param.label);
    }
  }

  return {
    payload: {
      name: entry.name,
      command: entry.command,
      args,
      env: {},
    },
    missing,
  };
}

/** 需要用户补的环境变量键（内置目录里声明了 envKeys 的条目）。 */
export function requiredEnvKeys(entry: McpCuratedServer): string[] {
  return entry.envKeys ?? [];
}
