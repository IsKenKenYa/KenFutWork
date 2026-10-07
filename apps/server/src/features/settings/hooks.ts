import type { InstanceSettings } from "@kenfutwork/shared";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";

import {
  detectTerminalShells,
  resolveTerminalShell,
  runTerminalCommand,
  type TerminalResult,
} from "../code-git/terminal-runner.js";

/**
 * 用户钩子（R5-2「钩子」条目）的执行面。
 *
 * **它是什么**：用户在设置里配的「本轮开始 / 本轮结束」命令，在**项目工作目录**里跑。
 * 典型用途：每轮结束自动格式化、生成一次索引、跑一遍 lint。
 *
 * **它不是什么**（三条边界，写在这里也是给下一个人的护栏）：
 * 1. **模型无法触发**：钩子不进工具注册表，也不受工具门（`tool-gate`）管——工具门管的是
 *    **模型发起的**调用；钩子只由 run 的生命周期触发，配置权只在用户手里；
 * 2. **不做新沙箱**：执行身份与目录同终端/agent（服务端进程身份 + 该项目的工作目录），
 *    用的是**同一个** `runTerminalCommand`（不另写一套 spawn）；
 * 3. **失败不阻断**：钩子是旁路，退出码与输出如实进转录，本轮照常继续。
 */

/** 钩子点。 */
export type HookEvent = "turn-start" | "turn-end";

/** 钩子超时：比终端的默认值短——它是旁路，不该拖住一轮。 */
export const HOOK_TIMEOUT_MS = AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs;
/** 进转录的输出上限（字符）。 */
export const HOOK_OUTPUT_CHARS =
  AGENT_GOVERNANCE_DEFAULTS.processPreviewMaxChars;

export interface HookRunResult {
  event: HookEvent;
  command: string;
  /** 被超时杀掉时为 null。 */
  exitCode: number | null;
  timedOut: boolean;
  /** 输出摘要（stdout 优先，其次 stderr），已按 {@link HOOK_OUTPUT_CHARS} 截断。 */
  output: string;
  durationMs: number;
}

/** 取该钩子点的命令（顺序即执行顺序）。 */
export function hooksFor(
  hooks: InstanceSettings["hooks"] | undefined,
  event: HookEvent,
): string[] {
  return (hooks ?? [])
    .filter((hook) => hook.event === event && hook.command.trim().length > 0)
    .map((hook) => hook.command.trim());
}

/**
 * 逐条执行钩子。**一条失败不影响下一条**，也不影响本轮（调用方只把结果发出去）。
 * `runCommand` 可注入（测试里替身掉真 spawn）。
 */
export async function runHooks(input: {
  event: HookEvent;
  commands: readonly string[];
  cwd: string;
  shell?: InstanceSettings["terminalShell"];
  runCommand?: typeof runTerminalCommand;
  timeoutMs?: number;
  previewMaxChars?: number;
}): Promise<HookRunResult[]> {
  const run = input.runCommand ?? runTerminalCommand;
  const results: HookRunResult[] = [];
  for (const command of input.commands) {
    const result: TerminalResult = await run({
      command,
      cwd: input.cwd,
      ...(input.shell ? { shell: input.shell } : {}),
      timeoutMs: input.timeoutMs ?? HOOK_TIMEOUT_MS,
    }).catch(
      (error: unknown): TerminalResult => ({
        command,
        shell: "auto",
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
        durationMs: 0,
      }),
    );
    const raw = result.stdout.trim() || result.stderr.trim();
    results.push({
      event: input.event,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: raw
        .replace(/\s+/g, " ")
        .slice(0, input.previewMaxChars ?? HOOK_OUTPUT_CHARS),
      durationMs: result.durationMs,
    });
  }
  return results;
}

/** 探测/解析 shell 的口径与终端一致（钩子不该另立一套 shell 判定）。 */
export { detectTerminalShells, resolveTerminalShell };
