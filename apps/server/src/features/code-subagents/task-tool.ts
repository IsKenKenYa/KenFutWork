import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type {
  TaskWorkContext,
  TaskWorkManager,
  TaskWorkRecord,
} from "../task-work/types.js";
import type { RunUsageSummary } from "../usage/usage-service.js";
import type { CodeChildRequest, CodeChildResult } from "./types.js";

/** 子代理用量查询失败只影响展示，不影响 Task 结果本身（计量是旁路）。 */
async function readChildUsage(
  lookup:
    | ((
        context: TaskWorkContext,
        childRunId: string,
      ) => Promise<RunUsageSummary | null>)
    | undefined,
  context: TaskWorkContext,
  childRunId: string | undefined,
): Promise<RunUsageSummary | null> {
  if (!lookup || !childRunId) return null;
  try {
    return await lookup(context, childRunId);
  } catch (error) {
    console.warn(
      "[code-subagents] 子代理用量查询失败：",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

const schema = z
  .object({
    subagent_type: z.enum(["explore", "review", "worker"]),
    description: z.string().trim().min(1),
    ownership: z.array(z.string().trim().min(1)).min(1),
    completion_criteria: z.string().trim().min(1),
    run_in_background: z.boolean().default(false),
  })
  .strict();

/** stable dispatch UUID; replay never allocates a different child session. */
export function childSessionId(
  context: TaskWorkContext,
  toolCallId: string,
): string {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        context.scope.instanceId,
        context.scope.taskId,
        context.agentId,
        context.runId,
        toolCallId,
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function waitForWork(
  manager: TaskWorkManager,
  context: TaskWorkContext,
  id: string,
): Promise<TaskWorkRecord> {
  let finish!: (record: TaskWorkRecord) => void;
  const terminal = new Promise<TaskWorkRecord>((resolve) => {
    finish = resolve;
  });
  const off = manager.onChanged(async (record) => {
    if (record.id === id && record.status !== "running") finish(record);
  });
  try {
    const current = await manager.find(context, id);
    if (!current) throw new Error("子任务记录已不可用。");
    return current.status === "running" ? await terminal : current;
  } finally {
    off();
  }
}

export function createCodeSubagentTool(deps: {
  manager: TaskWorkManager;
  runChild(
    request: CodeChildRequest,
    signal: AbortSignal,
  ): Promise<CodeChildResult>;
  limitsFor(
    context: TaskWorkContext,
  ): Promise<{ maxDepth: number; previewMaxChars: number }>;
  /** 前台 Task 完成后按 childRunId 归因用量；缺省时结果不含 usage。 */
  usageFor?(
    context: TaskWorkContext,
    childRunId: string,
  ): Promise<RunUsageSummary | null>;
}): ToolDefinition {
  return {
    name: "Task",
    scope: "shared",
    exposure: "core",
    access: "read",
    zodSchema: schema,
    parameters: z.toJSONSchema(schema),
    description:
      "派发独立子会话，复用同一Harness。explore/review只读，worker声明ownership并继承父权限上限；提供完成标准。run_in_background=true属于当前Task并自动通知，不因父Run结束而停止。",
    async execute(raw, execution: ToolExecutionContext) {
      const input = schema.parse(raw);
      const parent = execution.taskWorkContext;
      const handle = execution.scopeHandle;
      if (
        !parent?.actor ||
        !handle ||
        !execution.codeApproval ||
        !execution.toolCallId ||
        !execution.sessionId ||
        !execution.modelSpecifier
      )
        throw new Error("子任务缺少可信父会话、模型、权限或派发身份。");
      await handle.resolvePath(".", "read");
      const context = {
        ...parent,
        scope: handle.describe(),
        agentId: handle.agentId,
      };
      const limits = await deps.limitsFor(context);
      const depth = execution.delegationDepth ?? 0;
      if (depth >= limits.maxDepth)
        throw new Error("子任务派生深度达到当前工作区配置上限。");
      if (
        input.subagent_type === "worker" &&
        (execution.approvedExecutionMode === "plan" ||
          execution.permissionInvocation?.mode === "plan" ||
          context.scope.sandboxMode === "read-only" ||
          handle.role === "explore" ||
          handle.role === "review")
      )
        throw new Error("只读父作用域不能派发可写worker。");
      for (const path of input.ownership)
        await handle.resolvePath(
          path,
          input.subagent_type === "worker" ? "write" : "read",
        );
      const request: CodeChildRequest = {
        ...(execution.goalId ? { goalId: execution.goalId } : {}),
        ...(execution.frozenContributions
          ? {
              frozenContributions: structuredClone(
                execution.frozenContributions,
              ),
            }
          : {}),
        ...(execution.workContext
          ? { workContext: structuredClone(execution.workContext) }
          : {}),
        childSessionId: childSessionId(context, execution.toolCallId),
        approvalCeiling:
          handle.role === "main"
            ? (execution.approvedExecutionMode ??
              execution.codeApproval.ceiling)
            : execution.codeApproval.ceiling,
        actor: parent.actor,
        scope: handle,
        model: execution.modelSpecifier,
        parentSessionId: execution.sessionId,
        parentRunId: context.runId,
        toolCallId: execution.toolCallId,
        branchGeneration: context.branchGeneration,
        delegationDepth: depth,
        role: input.subagent_type,
        description: input.description,
        ownership: input.ownership,
        completionCriteria: input.completion_criteria,
        detached: input.run_in_background,
      };
      const controller = new AbortController();
      let running: Promise<CodeChildResult> | undefined;
      let childResult: CodeChildResult | undefined;
      const record = await deps.manager.start(
        context,
        {
          kind: "subagent",
          detached: input.run_in_background,
          label: input.description,
          toolCallId: execution.toolCallId,
          childSessionId: request.childSessionId,
          parameters: input,
        },
        {
          async run(signal) {
            const signals = [signal, controller.signal];
            if (!input.run_in_background && execution.signal)
              signals.push(execution.signal);
            running = deps.runChild(request, AbortSignal.any(signals));
            const result = await running;
            childResult = result;
            return {
              status: result.status,
              summary: result.summary.slice(0, limits.previewMaxChars),
              outputRef: result.outputRef,
              outputStats: result.outputStats,
            };
          },
          async stop(reason) {
            controller.abort(reason);
            await running;
          },
        },
      );
      if (input.run_in_background)
        return {
          taskId: record.id,
          childSessionId: request.childSessionId,
          status: record.status,
          message:
            "子任务属于当前Task，完成后自动通知；TaskOutput可读取完整结果。",
        };
      const terminal = await waitForWork(deps.manager, context, record.id);
      const usage = await readChildUsage(
        deps.usageFor,
        context,
        childResult?.childRunId,
      );
      return {
        taskId: terminal.id,
        childSessionId: terminal.childSessionId,
        status: terminal.status,
        summary: terminal.summary,
        outputPath: terminal.outputRef,
        outputStats: terminal.outputStats,
        ...(usage ? { usage } : {}),
      };
    },
  };
}
