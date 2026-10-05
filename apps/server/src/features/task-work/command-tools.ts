import { stat } from "node:fs/promises";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import { createScopedExecute } from "../process-sandbox/consumer.js";
import { readCapturedOutput } from "../process-sandbox/output-capture.js";
import type {
  ManagedProcess,
  ManagedProcessSnapshot,
  ProcessLimits,
  ProcessOutput,
  ProcessSandbox,
} from "../process-sandbox/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import type {
  TaskWorkContext,
  TaskWorkManager,
  TaskWorkOutcome,
  TaskWorkRecord,
} from "./types.js";

const bashSchema = z
  .object({
    command: z.string().min(1),
    description: z.string().optional(),
    cwd: z.string().optional(),
    run_in_background: z.boolean().default(false),
    timeout: z.number().int().positive().nullable().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const outputSchema = z
  .object({
    task_id: z.string().optional(),
    offset: z.number().int().nonnegative().default(0),
    max_bytes: z.number().int().positive().optional(),
  })
  .strict();
const inputSchema = z
  .object({
    task_id: z.string().min(1),
    data: z.string().default(""),
    close: z.boolean().default(false),
  })
  .strict();
const stopSchema = z.object({ task_id: z.string().min(1) }).strict();

type CommandContext = TaskWorkContext & { actor: LocalActor };
function scopeOf(context: ToolExecutionContext): ExecutionScopeHandle {
  if (!context.scopeHandle) throw new Error("命令工具缺少可信 Task 工作域。");
  return context.scopeHandle;
}
function contextOf(context: ToolExecutionContext): CommandContext {
  if (!context.taskWorkContext?.actor || !context.scopeHandle)
    throw new Error("命令工具缺少可信 Task 工作域与运行身份。");
  return {
    ...context.taskWorkContext,
    actor: context.taskWorkContext.actor,
    scope: context.scopeHandle.describe(),
    agentId: context.scopeHandle.agentId,
  };
}
function requireWorkControl(
  context: ToolExecutionContext,
  record: TaskWorkRecord,
): void {
  const scope = scopeOf(context);
  if (scope.role !== "main" && record.agentId !== scope.agentId) {
    throw Object.assign(new Error("子代理只能控制自身派发的后台工作。"), {
      code: "work_control_forbidden",
      statusCode: 403,
    });
  }
}
function outputStats(process: ManagedProcess) {
  const snapshot = process.snapshot();
  return {
    retainedBytes: snapshot.retainedBytes,
    totalBytes: snapshot.totalBytes,
    discardedBytes: snapshot.discardedBytes,
  };
}
function projection(
  output: ProcessOutput,
  process: ManagedProcess,
  previewMaxChars: number,
) {
  const snapshot = process.snapshot();
  const text = output.data.slice(0, previewMaxChars);
  const truncated =
    output.truncated ||
    output.nextOffset < output.retainedBytes ||
    text.length < output.data.length;
  return {
    output: text,
    exitCode: snapshot.exit?.exitCode ?? null,
    state: snapshot.state,
    outputPath: snapshot.outputPath,
    offset: output.offset,
    nextOffset: output.nextOffset,
    retainedBytes: output.retainedBytes,
    totalBytes: output.totalBytes,
    discardedBytes: output.discardedBytes,
    truncated,
    display: {
      kind: "bash_output",
      output: text,
      outputPath: snapshot.outputPath,
      truncated,
    },
  };
}

/** 一个 profile 的控制器跨 Run 持有命令句柄；数据库记录提供重启后的只读输出。 */
export function createTaskCommandTools(deps: {
  manager: TaskWorkManager;
  sandbox: ProcessSandbox;
  settings: SettingsService;
}) {
  const commands = new Map<string, ManagedProcess>();
  const invocations = new Map<
    string,
    {
      context: TaskWorkContext;
      workId: string;
      latest?: ManagedProcessSnapshot;
      flushing?: Promise<void>;
    }
  >();
  const invocationKey = (
    snapshot: Pick<ManagedProcessSnapshot, "ownerTaskId" | "invocationId">,
  ) => JSON.stringify([snapshot.ownerTaskId, snapshot.invocationId]);
  const acceptSnapshot = (snapshot: ManagedProcessSnapshot): Promise<void> => {
    const entry = invocations.get(invocationKey(snapshot));
    if (!entry) return Promise.resolve();
    entry.latest = snapshot;
    if (entry.flushing) return entry.flushing;
    entry.flushing = (async () => {
      while (entry.latest) {
        const current = entry.latest;
        delete entry.latest;
        await deps.manager.recordOutput(
          entry.context,
          entry.workId,
          current.outputPath,
          {
            retainedBytes: current.retainedBytes,
            totalBytes: current.totalBytes,
            discardedBytes: current.discardedBytes,
          },
        );
      }
    })().finally(() => {
      delete entry.flushing;
    });
    return entry.flushing;
  };
  const settingsFor = (context: CommandContext) =>
    deps.settings.getInstanceSettings(context.actor, context.scope.instanceId);
  const limitsFor = (
    settings: Awaited<ReturnType<typeof settingsFor>>,
  ): ProcessLimits => ({
    maxOutputBytes: settings.processMaxOutputBytes,
    previewMaxChars: settings.processPreviewMaxChars,
    yieldMs: settings.processYieldMs,
    killGraceMs: settings.processKillGraceMs,
  });
  const definition = (
    name: string,
    schema: z.ZodType,
    access: ToolDefinition["access"],
    description: string,
    execute: ToolDefinition["execute"],
  ): ToolDefinition => ({
    name,
    scope: "code",
    exposure: "core",
    access,
    description,
    parameters: z.toJSONSchema(schema),
    zodSchema: schema,
    execute,
  });

  const bash = definition(
    "Bash",
    bashSchema,
    "execute",
    "在 Task 授权目录与 OS 沙箱中运行命令。run_in_background=true 显式交给 Task，前台结束后仍可运行并自动通知；timeout 是执行 deadline，后台缺省不设 deadline。",
    async (raw, execCtx) => {
      const input = bashSchema.parse(raw);
      const handle = scopeOf(execCtx);
      const processScope =
        execCtx.approvedExecutionMode === "plan" ||
        execCtx.permissionInvocation?.mode === "plan"
          ? handle.derive("review", handle.agentId)
          : handle;
      const context = { ...contextOf(execCtx), scope: processScope.describe() };
      if (!execCtx.toolCallId)
        throw new Error("命令缺少稳定工具调用身份，不能派发。");
      const settings = await settingsFor(context);
      const invocationId = `${context.runId}/${execCtx.toolCallId}`;
      const execute = createScopedExecute(deps.sandbox, processScope, {
        agentId: context.agentId,
        invocationId,
        limits: limitsFor(settings),
        ...(execCtx.signal && !input.run_in_background
          ? { signal: execCtx.signal }
          : {}),
      });
      const request = {
        command: input.command,
        background: input.run_in_background,
        timeoutMs:
          input.timeout === undefined
            ? input.run_in_background
              ? null
              : settings.executeTimeoutMs
            : input.timeout,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      };
      if (!input.run_in_background) {
        const process = await execute(request);
        await process.waitForExit();
        const output = await process.readOutput({
          offset: 0,
          maxBytes: settings.processMaxOutputBytes,
        });
        const canonicalOutput = projection(
          output,
          process,
          settings.processPreviewMaxChars,
        );
        return {
          modelContent: [
            { type: "text", text: JSON.stringify(canonicalOutput) },
          ],
          canonicalOutput,
        };
      }
      let bind!: (workId: string) => void;
      const dispatched = new Promise<string>((resolve) => {
        bind = resolve;
      });
      let process: ManagedProcess | undefined;
      let starting: Promise<ManagedProcess> | undefined;
      const record = await deps.manager.start(
        context,
        {
          kind: "command",
          label: input.command,
          toolCallId: execCtx.toolCallId,
          parameters: input,
        },
        {
          async run(signal): Promise<TaskWorkOutcome> {
            const workId = await dispatched;
            invocations.set(
              invocationKey({
                ownerTaskId: context.scope.taskId,
                invocationId,
              }),
              { context, workId },
            );
            signal.throwIfAborted();
            starting = execute(request);
            process = await starting;
            commands.set(workId, process);
            try {
              await acceptSnapshot(process.snapshot());
            } catch (error) {
              await process.stop("输出记录持久化失败");
              throw error;
            }
            if (signal.aborted) await process.stop("后台工作已取消");
            const exit = await process.waitForExit();
            const output = await process.readOutput({
              offset: 0,
              maxBytes: settings.processMaxOutputBytes,
            });
            const summary = projection(
              output,
              process,
              settings.processPreviewMaxChars,
            );
            return {
              status: exit.stopped
                ? "canceled"
                : exit.exitCode === 0
                  ? "completed"
                  : "failed",
              summary: JSON.stringify(summary),
              outputRef: process.snapshot().outputPath,
              outputStats: outputStats(process),
            };
          },
          async stop(reason) {
            const current = process ?? (await starting);
            if (current && !(await current.stop(reason)).rangeEmpty)
              throw new Error("后台命令的管理范围尚未确认退出。");
          },
        },
      );
      bind(record.id);
      return {
        taskId: record.id,
        status: record.status,
        message: "后台工作属于当前 Task；完成后自动通知，无需轮询。",
        display: {
          kind: "bash_output",
          output: `后台工作 ${record.id} 已派发；完成后自动通知。`,
          truncated: false,
        },
      };
    },
  );

  const readOutput = async (
    record: TaskWorkRecord,
    offset: number,
    maxBytes: number,
  ) => {
    const process = commands.get(record.id);
    if (process) return process.readOutput({ offset, maxBytes });
    if (record.outputRef && record.outputStats) {
      const retainedBytes =
        record.status === "interrupted"
          ? (await stat(record.outputRef)).size
          : record.outputStats.retainedBytes;
      return readCapturedOutput(
        record.outputRef,
        {
          ...record.outputStats,
          retainedBytes,
          totalBytes: Math.max(retainedBytes, record.outputStats.totalBytes),
        },
        { offset, maxBytes },
        true,
      );
    }
    return null;
  };
  const taskOutput = definition(
    "TaskOutput",
    outputSchema,
    "read",
    "读取当前 Task 的后台工作状态和增量输出。task_id 跨 Run 有效，offset/nextOffset 为字节游标；无 task_id 列出 Task 工作。",
    async (raw, execCtx) => {
      const input = outputSchema.parse(raw);
      const context = contextOf(execCtx);
      if (!input.task_id)
        return (await deps.manager.list(context)).map(
          ({ id, kind, label, status, startedAt, endedAt }) => ({
            taskId: id,
            kind,
            label,
            status,
            startedAt,
            endedAt,
          }),
        );
      const record = await deps.manager.find(context, input.task_id);
      if (!record) throw new Error("后台工作不属于当前 Task 或不存在。");
      const settings = await settingsFor(context);
      // UTF-8 最长四字节是编码常量；工具页限额来自用户的预览治理值。
      const pageBytes = Math.min(
        settings.processMaxOutputBytes,
        settings.processPreviewMaxChars * 4,
      );
      const output = await readOutput(
        record,
        input.offset,
        Math.min(input.max_bytes ?? pageBytes, pageBytes),
      );
      const canonicalOutput = {
        taskId: record.id,
        status: record.status,
        summary: record.summary,
        output,
        outputRef: record.outputRef,
        statisticsComplete: record.status !== "interrupted",
        display: {
          kind: "task_output",
          retrievalStatus:
            output || record.status !== "running" ? "success" : "not_ready",
          taskStatus: record.status,
        },
      };
      const modelText =
        output?.data.slice(0, settings.processPreviewMaxChars) ?? "";
      const modelOutput = output
        ? {
            ...canonicalOutput,
            output: {
              ...output,
              data: modelText,
              nextOffset: output.offset + Buffer.byteLength(modelText),
              modelTruncated: output.data.length > modelText.length,
            },
          }
        : canonicalOutput;
      return {
        modelContent: [{ type: "text", text: JSON.stringify(modelOutput) }],
        canonicalOutput,
      };
    },
  );
  const taskInput = definition(
    "TaskInput",
    inputSchema,
    "execute",
    "向当前 Task 的后台命令写 stdin；close=true 发送 EOF。权限撤销或真实退出后不能再发送。",
    async (raw, execCtx) => {
      const input = inputSchema.parse(raw);
      const context = contextOf(execCtx);
      const record = await deps.manager.find(context, input.task_id);
      if (!record) throw new Error("后台工作不属于当前 Task 或不存在。");
      requireWorkControl(execCtx, record);
      const process =
        record?.status === "running" ? commands.get(record.id) : null;
      if (!process) throw new Error("后台命令已退出或执行句柄不可达。");
      await scopeOf(execCtx).resolvePath(".", "read");
      if (input.data) await process.writeStdin(input.data);
      if (input.close) await process.endStdin();
      return { taskId: input.task_id, inputSent: true, eof: input.close };
    },
  );
  const taskStop = definition(
    "TaskStop",
    stopSchema,
    "read",
    "停止当前 Task 的一项后台工作，等待真实退出确认；不影响其他工作或前台 Run。",
    async (raw, execCtx) => {
      const input = stopSchema.parse(raw);
      const context = contextOf(execCtx);
      const record = await deps.manager.find(context, input.task_id);
      if (!record) throw new Error("后台工作不属于当前 Task 或不存在。");
      requireWorkControl(execCtx, record);
      if (record.status !== "running")
        return {
          taskId: input.task_id,
          stopped: false,
          status: record.status,
          display: {
            kind: "task_stop",
            taskId: input.task_id,
            taskType: record.kind,
            message: "工作此前已结束，没有取消新的执行。",
          },
        };
      await deps.manager.stop(
        context,
        input.task_id,
        "用户或 Agent 停止后台工作",
      );
      return {
        taskId: input.task_id,
        stopped: true,
        display: {
          kind: "task_stop",
          taskId: input.task_id,
          taskType: record.kind,
          message: "已确认执行退出。",
        },
      };
    },
  );
  return {
    tools: [bash, taskOutput, taskInput, taskStop],
    acceptSnapshot,
    forgetTask(_instanceId: string, taskId: string) {
      for (const [id, process] of commands)
        if (process.snapshot().ownerTaskId === taskId) commands.delete(id);
      for (const [key, entry] of invocations)
        if (entry.context.scope.taskId === taskId) invocations.delete(key);
    },
  };
}
