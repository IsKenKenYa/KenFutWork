import { spawn } from "node:child_process";
import path from "node:path";

import type { PluginHookContribution } from "./plugin-contributions.js";

/**
 * 插件会话钩子（zcode `SessionStart` 的等价面）。
 *
 * 与用户级 turn-start 钩子的区别：插件钩子**会回灌模型**——脚本 stdout 的
 * `hookSpecificOutput.additionalContext` 作为本 run 的提示段注入系统提示，
 * 用来保证「规则在每次会话都生效」而不依赖模型主动加载技能。
 *
 * 边界：仅主 run 执行；失败/超时只记录、不阻断；不另起沙箱，沿用服务端进程身份，
 * cwd 为 run 的项目工作目录。
 */

export interface PluginHookRunResult {
  pluginId: string;
  pluginName: string;
  event: "turn-start";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

export interface PluginHookOutcome {
  contexts: string[];
  results: PluginHookRunResult[];
}

/** zcode 钩子用 `node` 启动；开发/服务端进程本身即 node，直接用 execPath 避免 PATH 依赖。 */
function resolveCommand(command: string): string {
  if (command !== "node") return command;
  const base = path.basename(process.execPath).toLowerCase();
  return base === "node" || base === "node.exe" ? process.execPath : command;
}

function expandArgs(hook: PluginHookContribution): string[] {
  return hook.args.map((arg) =>
    arg.replaceAll("${ZCODE_PLUGIN_ROOT}", hook.pluginRoot),
  );
}

function parseAdditionalContext(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const context = (
      parsed as { hookSpecificOutput?: { additionalContext?: unknown } }
    ).hookSpecificOutput?.additionalContext;
    return typeof context === "string" && context.trim()
      ? context.trim()
      : null;
  } catch {
    return null;
  }
}

async function runOne(input: {
  hook: PluginHookContribution;
  cwd: string;
  signal: AbortSignal | undefined;
  previewMaxChars: number;
}): Promise<{ result: PluginHookRunResult; context: string | null }> {
  const { hook, cwd, signal, previewMaxChars } = input;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(resolveCommand(hook.command), expandArgs(hook), {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const raw = stdout.trim() || stderr.trim() || error || "";
      resolve({
        context: exitCode === 0 ? parseAdditionalContext(stdout) : null,
        result: {
          pluginId: hook.pluginId,
          pluginName: hook.pluginName,
          event: hook.event,
          command: [hook.command, ...hook.args].join(" "),
          exitCode,
          timedOut,
          output: raw.replace(/\s+/gu, " ").slice(0, previewMaxChars),
          durationMs: Date.now() - started,
        },
      });
    };
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, hook.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
    child.stdin.end(
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
    );
  });
}

export async function runPluginHooks(input: {
  hooks: readonly PluginHookContribution[];
  cwd: string;
  signal?: AbortSignal | undefined;
  previewMaxChars?: number | undefined;
}): Promise<PluginHookOutcome> {
  const contexts: string[] = [];
  const results: PluginHookRunResult[] = [];
  for (const hook of input.hooks) {
    if (input.signal?.aborted) break;
    const { result, context } = await runOne({
      hook,
      cwd: input.cwd,
      signal: input.signal,
      previewMaxChars: input.previewMaxChars ?? 2_000,
    });
    results.push(result);
    if (context) contexts.push(context);
  }
  return { contexts, results };
}
