import { tool } from "langchain";
import { z } from "zod";

import type { BackgroundTaskRegistry } from "./background-tasks.js";
import type { SubagentDefinition } from "./subagent-definitions.js";

/**
 * 子代理派发工具（DEC-14/DEC-15/DEC-16）：取代 deepagents 内置 task 的自有多工具面。
 *
 * - `task`：**前台**派生——等子代理跑完，结果作为工具结果回填（一条消息多个
 *   task 调用即并行 fan-out，langchain Send 原生并发）；
 * - `task_background`：**后台**派生——立即返回 taskId，主 agent 继续干活，
 *   结算后经通知中间件注入下一轮输入（run 轮末闸门保证通知必达）；
 * - `task_output`：按 taskId 读结果/列全部任务（后台任务细节查询口）。
 *
 * 子代理运行器由调用方注入（`runChild`）：本模块只管派发编排与注册表交互，
 * 不碰 langchain 装配——这是可测试的接缝。
 */

/** 子代理运行器：装配子代理并跑完，返回最终文本。实现见 deep-agent.ts 装配。 */
export type SubagentChildRunner = (input: {
  definition: SubagentDefinition;
  description: string;
  /** 中止信号：前台=父 run 信号联动的 controller；后台=注册表 abort 联动。 */
  signal: AbortSignal;
  /** 派发调用 id（父 run 的 toolCallId）：子代理事件按它路由进对应视图。 */
  callId: string;
}) => Promise<string>;

export type SubagentDispatchGate = (
  def: SubagentDefinition,
) => { allowed: true } | { allowed: false; reason: string };

/** 截断工具结果里的子代理结论（子代理长篇大论不该灌满主上下文）。 */
const CHILD_RESULT_MAX_CHARS = 8_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（结果过长已截断，可用 task_output 之前的结论为准）`;
}

const FAILURE_NEXT_STEP =
  "该子代理失败了：可读取上面的失败原因后重试派生、换一种做法，或直接自己完成该步骤。";

export function createSubagentTaskTools(deps: {
  registry: BackgroundTaskRegistry;
  /** 按 preset 过滤后的可用定义（工具描述与派发校验共用）。 */
  definitions: readonly SubagentDefinition[];
  childRunner: SubagentChildRunner;
  /**
   * 派发前置门（DEC-17）：plan 档按目标定义只读性放行/拒绝（explore/review/planner
   * 可派，batch_image/video_generate 拒绝）。拒绝发生在**注册之前**——被拒的派发
   * 不产生任务条目。未传 = 不设限（部分装配/测试）。
   */
  dispatchGate?: SubagentDispatchGate;
}) {
  const { registry, definitions, childRunner } = deps;

  const describeAvailable = () =>
    definitions
      .map((def) => `- ${def.name}（${def.label}）：${def.description}`)
      .join("\n");

  const resolve = (name: string): SubagentDefinition | string => {
    const def = definitions.find((candidate) => candidate.name === name);
    if (def) return def;
    return `未知子代理类型「${name}」。当前 run 可用的子代理：\n${describeAvailable()}`;
  };

  const taskTool = tool(
    async (input, runtime) => {
      const callId =
        runtime?.toolCall?.id ||
        `call_${Math.random().toString(36).slice(2, 10)}`;
      const resolved = resolve(input.subagent_type);
      if (typeof resolved === "string") return resolved;
      // 前台任务也进注册表：目录可见、取消联动（runtime 收尾/取消时 abortAll）
      const controller = new AbortController();
      const registered = registry.register({
        kind: "subagent",
        label: `${resolved.label} · ${input.description}`,
        abort: () => controller.abort(),
        callId,
      });
      if (!registered.ok) return registered.error;
      const { taskId } = registered;

      try {
        const result = await childRunner({
          definition: resolved,
          description: input.description,
          signal: controller.signal,
          callId,
        });
        registry.settle(taskId, {
          status: "completed",
          summary: truncate(result, CHILD_RESULT_MAX_CHARS),
        });
        return truncate(result, CHILD_RESULT_MAX_CHARS);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "unknown");
        registry.settle(taskId, {
          status: controller.signal.aborted ? "canceled" : "failed",
          summary: truncate(message, 2_000),
          nextStep: FAILURE_NEXT_STEP,
        });
        return `子代理「${resolved.label}」执行失败：${message}\n${FAILURE_NEXT_STEP}`;
      }
    },
    {
      name: "task",
      description:
        "派生一个子代理执行子任务并等待其结果（前台）。多个独立子任务请在**同一条消息里多次调用本工具**并行派发。" +
        `当前可用的子代理类型：\n${describeAvailable()}`,
      schema: z.object({
        subagent_type: z.string().min(1).describe("子代理类型名"),
        description: z
          .string()
          .min(1)
          .max(8_000)
          .describe(
            "给子代理的完整任务说明（子代理看不到你的上下文，必须自包含）",
          ),
      }),
    },
  );

  const taskBackgroundTool = tool(
    async (input, runtime) => {
      const callId =
        runtime?.toolCall?.id ||
        `call_${Math.random().toString(36).slice(2, 10)}`;
      const resolved = resolve(input.subagent_type);
      if (typeof resolved === "string") return resolved;
      if (deps.dispatchGate) {
        const verdict = deps.dispatchGate(resolved);
        if (!verdict.allowed) {
          return `子代理「${resolved.label}」未派发：${verdict.reason}`;
        }
      }
      const registered = registry.register({
        kind: "subagent",
        label: `${resolved.label} · ${input.description}`,
        abort: () => controller.abort(),
        callId,
      });
      if (!registered.ok) return registered.error;
      const { taskId } = registered;
      const controller = new AbortController();

      // 后台：不 await。结算写注册表 → 通知中间件在下一轮注入（DEC-15）。
      // promise 必须 catch（脱离 await 的 rejection 无人接会打崩进程）。
      void childRunner({
        definition: resolved,
        description: input.description,
        signal: controller.signal,
        callId,
      }).then(
        (result) => {
          registry.settle(taskId, {
            status: "completed",
            summary: truncate(result, CHILD_RESULT_MAX_CHARS),
          });
        },
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error ?? "unknown");
          registry.settle(taskId, {
            status: controller.signal.aborted ? "canceled" : "failed",
            summary: truncate(message, 2_000),
            nextStep: FAILURE_NEXT_STEP,
          });
        },
      );

      return (
        `已转为后台任务（taskId=${taskId}）。你可以继续做其他工作；` +
        "任务完成后会以系统通知送达，无需轮询。"
      );
    },
    {
      name: "task_background",
      description:
        "把子代理任务放到后台执行并立即返回（不阻塞当前工作）。适合长时间任务" +
        "（批量生成、大范围调研）。任务完成后会自动通知你。可用类型：\n" +
        describeAvailable(),
      schema: z.object({
        subagent_type: z.string().min(1).describe("子代理类型名"),
        description: z
          .string()
          .min(1)
          .max(8_000)
          .describe("给子代理的完整任务说明（必须自包含）"),
      }),
    },
  );

  const taskOutputTool = tool(
    async (input) => {
      if (input.task_id) {
        const task = registry.get(input.task_id);
        if (!task) return `没有 taskId=${input.task_id} 的后台任务。`;
        return JSON.stringify(task, null, 2);
      }
      const all = registry.list();
      if (all.length === 0) return "当前 run 没有派生过后台任务。";
      return JSON.stringify(all, null, 2);
    },
    {
      name: "task_output",
      description:
        "查询后台任务状态与结果：带 task_id 读单个任务（含完成结果全文），不带参数列出本轮全部任务。",
      schema: z.object({
        task_id: z.string().min(1).optional().describe("要查询的后台任务 id"),
      }),
    },
  );

  return { taskTool, taskBackgroundTool, taskOutputTool };
}
