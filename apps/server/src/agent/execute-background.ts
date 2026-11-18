import { tool } from "langchain";
import { z } from "zod";

import type { BackgroundTaskRegistry } from "./background-tasks.js";

/**
 * Code 模式长命令后台执行（DEC-15）：与后台子代理共用同一张注册表——
 * 立即返回 taskId，命令跑完后经通知中间件注入下一轮输入；输出缓冲在任务
 * summary（截断口径同子代理结论），task_output 可查。
 *
 * 超时由本工具的 timer 负责（毫秒，来自治理设置 `executeTimeoutMs`）；backend
 * 自身的秒级超时是兜底。backend 不接受外部 abort signal——取消路径上
 * registry.abortAll 触发的是「结算为 canceled」，命令进程由 backend 超时或
 * 自然结束回收（命令输出流式转发与进程精确收割在 v2，见方案 §六）。
 */

/** 与子代理结论同口径：任务 summary 的截断上限。 */
const COMMAND_OUTPUT_MAX_CHARS = 8_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（输出过长已截断）`;
}

export interface ExecuteBackend {
  execute(command: string): Promise<{
    output: string;
    exitCode: number | null;
    truncated: boolean;
  }>;
}

export function createExecuteBackgroundTool(deps: {
  registry: BackgroundTaskRegistry;
  backend: ExecuteBackend;
  /** 命令超时（毫秒）：治理设置 `executeTimeoutMs`（读侧已钳回护栏）。 */
  timeoutMs: number;
  now?: () => Date;
}) {
  const { registry, backend, timeoutMs } = deps;

  return tool(
    async (input) => {
      const controller = new AbortController();
      const registered = registry.register({
        kind: "command",
        label: input.command,
        abort: () => controller.abort(),
      });
      if (!registered.ok) return registered.error;
      const { taskId } = registered;

      const timer = setTimeout(
        () => controller.abort(new Error("命令超时")),
        Math.max(1_000, timeoutMs),
      );

      void (async () => {
        try {
          // backend 不接受 abort signal：用 race 把超时/取消翻译成 rejection，
          // 否则命令挂死时任务永远无法结算（轮末闸门会被它卡住）
          const result = await Promise.race([
            backend.execute(input.command),
            new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener(
                "abort",
                () =>
                  reject(
                    controller.signal.reason instanceof Error
                      ? controller.signal.reason
                      : new Error("命令已取消"),
                  ),
                { once: true },
              );
            }),
          ]);
          registry.settle(taskId, {
            status:
              result.exitCode === 0
                ? ("completed" as const)
                : ("failed" as const),
            summary: truncate(
              result.output || `exitCode=${result.exitCode}`,
              COMMAND_OUTPUT_MAX_CHARS,
            ),
            ...(result.exitCode !== 0
              ? {
                  nextStep:
                    "命令以非零退出码结束：可用 task_output 复核输出，修正后重跑或改用其他做法。",
                }
              : {}),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error ?? "unknown");
          const aborted = controller.signal.aborted;
          registry.settle(taskId, {
            status: aborted ? ("canceled" as const) : ("failed" as const),
            summary: truncate(message, COMMAND_OUTPUT_MAX_CHARS),
            ...(aborted
              ? {}
              : {
                  nextStep: "命令执行抛错：可用 task_output 复核后重试。",
                }),
          });
        } finally {
          clearTimeout(timer);
        }
      })();

      return `已转为后台命令（taskId=${taskId}，超时 ${timeoutMs}ms）。你可以继续其他工作，完成后会收到系统通知。`;
    },
    {
      name: "execute_background",
      description:
        "在项目工作目录里执行一条 shell 命令（后台、不阻塞）：立即返回 taskId，" +
        "命令跑完后以系统通知送达结果。适合长测试、构建、批处理等长时间命令；" +
        "需要立即拿输出的短命令仍用 execute。",
      schema: z.object({
        command: z.string().min(1).max(4_000).describe("要执行的 shell 命令"),
      }),
    },
  );
}
