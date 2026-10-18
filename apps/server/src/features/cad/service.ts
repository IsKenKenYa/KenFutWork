import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type {
  ManagedStdioProcess,
  ProcessExit,
  ProcessLimits,
  ProcessSandbox,
} from "../process-sandbox/types.js";
import { ProcessSandboxError } from "../process-sandbox/types.js";
import {
  type CadGuiProbe,
  CadGuiProbeError,
  createMacosCadGuiProbe,
} from "./gui-probe.js";
import { createCadPreviewResult } from "./preview.js";
import { FREECAD_RUNNER_SOURCE } from "./runner-source.js";
import { type CadRuntime, detectFreeCadRuntime } from "./runtime.js";
import {
  type CadRequest,
  type CadResult,
  cadResultSchema,
} from "./tool-contracts.js";

export const CAD_BUNDLE_ID = "kenfutwork-cad";

export interface CadToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  canonicalOutput?: Record<string, unknown>;
  modelContent?: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source_type: "base64";
        mime_type: "image/png";
        data: string;
      }
  >;
}
export interface CadService {
  status(context: ToolExecutionContext): Promise<CadToolResult>;
  guiStatus(context: ToolExecutionContext): Promise<CadToolResult>;
  execute(
    request: CadRequest,
    context: ToolExecutionContext,
  ): Promise<CadToolResult>;
  releaseRun(runId: string): void;
}
export interface CadServiceOptions {
  sandbox: ProcessSandbox;
  gate(): Promise<{ ok: boolean; message?: string }>;
  resolveLimits(
    context: ToolExecutionContext,
  ): Promise<{ limits: ProcessLimits; timeoutMs: number | null }>;
  detectRuntime?: () => Promise<CadRuntime | null>;
  guiProbe?: CadGuiProbe;
}

class CadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CadError";
  }
}

/** 只认宿主持有的 Task 与代际，不能由路径或模型参数签发执行身份。 */
export function requireCadContext(
  context: ToolExecutionContext,
): ExecutionScopeHandle {
  const handle = context.scopeHandle;
  const work = context.taskWorkContext;
  const actor = context.actor;
  const scope = handle?.describe();
  if (
    !handle ||
    !scope ||
    !actor ||
    !work?.actor ||
    !context.runId ||
    !context.toolCallId ||
    work.ownerKind === "design" ||
    handle.role !== "main" ||
    context.runId !== work.runId ||
    actor.instanceId !== context.instanceId ||
    actor.instanceId !== scope.instanceId ||
    actor.instanceId !== work.actor.instanceId ||
    work.scope.instanceId !== scope.instanceId ||
    work.scope.projectId !== scope.projectId ||
    work.scope.taskId !== scope.taskId ||
    work.scope.generation !== scope.generation ||
    work.branchGeneration !== handle.branchGeneration
  ) {
    throw new CadError(
      "context_required",
      "CAD 操作缺少当前实例的真实 Task 执行上下文。",
    );
  }
  context.signal?.throwIfAborted();
  work.signal?.throwIfAborted();
  return handle;
}

function failure(error: unknown, cancelled = false): CadToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof CadError ||
    error instanceof ProcessSandboxError ||
    error instanceof CadGuiProbeError
      ? error.code
      : cancelled || (error instanceof Error && error.name === "AbortError")
        ? "cancelled"
        : "cad_failed";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code, message } },
  };
}

async function existing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

async function stageRequest(
  request: CadRequest,
  context: ToolExecutionContext,
) {
  const handle = requireCadContext(context);
  const executionId = randomUUID();
  const workingDirectory = await handle.resolvePath(
    join(".kfw-cad", executionId),
    "write",
  );
  const input = { ...request.input };
  if (input.documentPath)
    input.documentPath = await handle.resolvePath(input.documentPath, "read");
  const extension =
    request.action === "export"
      ? request.input.format
      : request.action === "preview"
        ? "png"
        : "FCStd";
  let outputPath: string | undefined;
  if (request.action !== "describe") {
    outputPath = await handle.resolvePath(
      request.input.outputPath ?? join(workingDirectory, `model.${extension}`),
      "write",
    );
    if (extname(outputPath).toLowerCase() !== `.${extension.toLowerCase()}`) {
      throw new CadError(
        "invalid_output",
        `输出文件扩展名必须为 .${extension}。`,
      );
    }
    if (await existing(outputPath))
      throw new CadError("output_exists", "输出文件已存在，请使用新文件名。");
    await handle.resolvePath(dirname(outputPath), "write");
  }
  const requestPath = join(workingDirectory, "request.json");
  const resultPath = join(workingDirectory, "result.json");
  const scriptPath = join(workingDirectory, "runner.py");
  const nativeOutputPath =
    request.action === "preview"
      ? join(workingDirectory, "projection.svg")
      : outputPath;
  await handle.backend.writeFile({
    path: scriptPath,
    content: FREECAD_RUNNER_SOURCE,
    createOnly: true,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  await handle.backend.writeFile({
    path: requestPath,
    content: JSON.stringify({
      ...request,
      input,
      executionId,
      workingDirectory,
      ...(nativeOutputPath ? { outputPath: nativeOutputPath } : {}),
    }),
    createOnly: true,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  return {
    handle,
    executionId,
    workingDirectory,
    input,
    outputPath,
    nativeOutputPath,
    requestPath,
    resultPath,
    scriptPath,
  };
}

/** Abort 只有在进程范围确认清空后才返回；取消不读取迟到成功结果。 */
async function waitForProcess(
  process: ManagedStdioProcess,
  signal: AbortSignal,
) {
  let stopping: Promise<void> | undefined;
  let stopError: unknown;
  const stop = () => {
    stopping ??= process
      .stop("CAD 操作已取消")
      .then((exit) => {
        if (!exit.rangeEmpty)
          throw new CadError("stop_unconfirmed", "CAD 进程尚未确认停止。");
      })
      .catch((error: unknown) => {
        stopError = error;
      });
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const exit = await process.waitForExit();
    await stopping;
    if (stopError) throw stopError;
    if (!exit.rangeEmpty) {
      stop();
      await stopping;
      if (stopError) throw stopError;
      throw new CadError(
        "stop_unconfirmed",
        "CAD 进程范围尚未清空，不能报告完成。",
      );
    }
    signal.throwIfAborted();
    return exit;
  } catch (error) {
    stop();
    await stopping;
    if (stopError) throw stopError;
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    await stopping;
  }
}

/** Managed pipes 必须有 consumer ACK；私有进程采集负责保留完整日志。 */
async function drainCadProcess(
  process: ManagedStdioProcess,
  signal: AbortSignal,
): Promise<ProcessExit> {
  const disposers: Array<() => void> = [];
  try {
    disposers.push(process.onStdout(() => undefined));
    disposers.push(process.onStderr(() => undefined));
    // 两流先接管，再允许stdin EOF和退出flush，避免未ACK帧阻塞后续输出。
    const waiting = waitForProcess(process, signal);
    void process.endStdin().catch(() => undefined);
    return await waiting;
  } finally {
    for (const dispose of disposers.reverse()) dispose();
  }
}

type StagedCadRequest = Awaited<ReturnType<typeof stageRequest>>;

async function readCadResult(
  staged: StagedCadRequest,
  exit: ProcessExit,
  maxBytes: number,
): Promise<CadResult> {
  await staged.handle.resolvePath(staged.resultPath, "read");
  const metadata = await stat(staged.resultPath).catch(() => null);
  if (!metadata?.isFile())
    throw new CadError(
      "result_missing",
      `FreeCAD 未返回有效执行回执（${exit.reason ?? `退出码 ${exit.exitCode}`}），不能确认成功。`,
    );
  if (metadata.size > maxBytes)
    throw new CadError(
      "result_too_large",
      "FreeCAD 结果超过当前进程输出设置，请把大结果写入 Task 文件并返回路径，或调整设置。",
    );
  let result: CadResult;
  try {
    result = cadResultSchema.parse(
      JSON.parse(await readFile(staged.resultPath, "utf8")),
    );
  } catch {
    throw new CadError(
      "result_invalid",
      "FreeCAD 执行回执不完整或格式错误，不能确认成功。",
    );
  }
  if (result.executionId !== staged.executionId)
    throw new CadError("result_invalid", "FreeCAD 执行回执不属于本次操作。");
  if (!result.success || exit.exitCode !== 0 || exit.stopped)
    throw new CadError(
      "execution_failed",
      result.error ?? exit.reason ?? "FreeCAD 执行失败。",
    );
  if (!result.document || !result.version?.length)
    throw new CadError(
      "result_invalid",
      "FreeCAD 成功回执缺少工程或运行时版本事实。",
    );
  if (staged.nativeOutputPath) {
    if (result.outputPath !== staged.nativeOutputPath)
      throw new CadError(
        "result_invalid",
        "FreeCAD 输出路径与本次请求不一致。",
      );
    const info = await stat(
      await staged.handle.resolvePath(staged.nativeOutputPath, "read"),
    );
    if (!info.isFile() || info.size === 0)
      throw new CadError("output_missing", "FreeCAD 没有生成有效文件。");
  }
  return result;
}

async function executeCadRequest(
  options: CadServiceOptions,
  request: CadRequest,
  context: ToolExecutionContext,
  guard: (context: ToolExecutionContext) => Promise<void>,
): Promise<CadToolResult> {
  const runtime = await (options.detectRuntime ?? detectFreeCadRuntime)();
  if (!runtime)
    throw new CadError(
      "runtime_unavailable",
      "未找到 FreeCAD 命令行程序，请安装 FreeCAD 后重试。",
    );
  const { limits, timeoutMs } = await options.resolveLimits(context);
  const staged = await stageRequest(request, context);
  const signal = AbortSignal.any(
    [context.signal, context.taskWorkContext?.signal].filter(
      (entry): entry is AbortSignal => Boolean(entry),
    ),
  );
  signal.throwIfAborted();
  await guard(context);
  // 审批后的派发点重新验证路径及Task代际，防止目录或授权在等待时改变。
  await staged.handle.resolvePath(staged.workingDirectory, "write");
  if (staged.input.documentPath)
    await staged.handle.resolvePath(staged.input.documentPath, "read");
  if (staged.outputPath)
    await staged.handle.resolvePath(staged.outputPath, "write");
  requireCadContext(context);
  const process = await options.sandbox.spawnStdio({
    scope: staged.handle.describe(),
    agentId: staged.handle.agentId,
    invocationId: `${context.runId}:${context.toolCallId}:${staged.executionId}`,
    argv: {
      executable: runtime.executable,
      args: [
        "--user-cfg",
        join(staged.workingDirectory, "user.cfg"),
        "--system-cfg",
        join(staged.workingDirectory, "system.cfg"),
        staged.scriptPath,
      ],
    },
    cwd: staged.workingDirectory,
    background: false,
    timeoutMs,
    limits,
    runtimeReadRoots: [runtime.runtimeRoot],
    env: {
      ...(request.action === "primitive" ||
      request.action === "python" ||
      request.action === "operations"
        ? { QT_QPA_PLATFORM: "offscreen" }
        : {}),
      KFW_CAD_REQUEST: staged.requestPath,
      KFW_CAD_RESULT: staged.resultPath,
      FREECAD_USER_HOME: staged.workingDirectory,
      FREECAD_USER_DATA: staged.workingDirectory,
      FREECAD_USER_TEMP: staged.workingDirectory,
      XDG_CACHE_HOME: join(staged.workingDirectory, "cache"),
      XDG_CONFIG_HOME: join(staged.workingDirectory, "config"),
      XDG_DATA_HOME: join(staged.workingDirectory, "data"),
      TMPDIR: staged.workingDirectory,
    },
  });
  const exit = await drainCadProcess(process, signal);
  requireCadContext(context);
  const result = await readCadResult(staged, exit, limits.maxOutputBytes);
  requireCadContext(context);
  signal.throwIfAborted();
  if (
    request.action === "preview" &&
    staged.outputPath &&
    staged.nativeOutputPath
  ) {
    const preview = await createCadPreviewResult({
      handle: staged.handle,
      svgPath: staged.nativeOutputPath,
      outputPath: staged.outputPath,
      nativeResult: result,
      signal,
      maxSvgBytes: limits.maxOutputBytes,
    });
    requireCadContext(context);
    return preview;
  }
  return {
    content: [
      {
        type: "text",
        text: result.outputPath
          ? `FreeCAD 已完成，文件：${result.outputPath}`
          : "FreeCAD 工程检查完成。",
      },
    ],
    structuredContent: result,
  };
}

function cadStatus(runtime: CadRuntime | null): CadToolResult {
  return {
    content: [
      {
        type: "text",
        text: runtime
          ? "FreeCAD 后台运行时已找到；具体能力由实际工程执行验证。"
          : "未找到 FreeCAD 命令行程序，请安装 FreeCAD 后重试。",
      },
    ],
    structuredContent: {
      available: Boolean(runtime),
      runtime,
      execution: "task-sandbox",
      currentDocument: false,
      preview: {
        png: true,
        kind: "wireframe",
        tool: "cad_preview",
        guiShadedView: false,
      },
      formats: ["FCStd", "STEP", "STL", "OBJ", "BREP", "SVG", "DXF"],
    },
  };
}

export function createCadService(options: CadServiceOptions): CadService {
  const guiProbe = options.guiProbe ?? createMacosCadGuiProbe();
  const invocations = new Map<
    string,
    { runId: string; fingerprint: string; result: Promise<CadToolResult> }
  >();
  const guard = async (context: ToolExecutionContext) => {
    const handle = requireCadContext(context);
    const gate = await options.gate();
    if (!gate.ok)
      throw new CadError(
        "plugin_disabled",
        gate.message ?? "请先在插件市场安装并启用 CAD 插件。",
      );
    await handle.resolvePath(".", "read");
    requireCadContext(context);
  };
  const onFailure = (error: unknown, context: ToolExecutionContext) =>
    failure(
      error,
      Boolean(
        context.signal?.aborted || context.taskWorkContext?.signal?.aborted,
      ),
    );
  return {
    async status(context) {
      try {
        await guard(context);
        return cadStatus(
          await (options.detectRuntime ?? detectFreeCadRuntime)(),
        );
      } catch (error) {
        return onFailure(error, context);
      }
    },
    async guiStatus(context) {
      try {
        await guard(context);
        const { limits, timeoutMs } = await options.resolveLimits(context);
        await guard(context);
        const signals = [
          context.signal,
          context.taskWorkContext?.signal,
        ].filter((signal): signal is AbortSignal => signal !== undefined);
        const applications = await guiProbe.list({
          signal: AbortSignal.any(signals),
          timeoutMs: Math.min(timeoutMs ?? 10_000, 10_000),
          maxOutputBytes: limits.maxOutputBytes,
        });
        await guard(context);
        return {
          content: [
            {
              type: "text",
              text: applications.length
                ? `发现 ${applications.length} 个运行中的 FreeCAD 应用。`
                : "没有运行中的 FreeCAD 应用。",
            },
          ],
          structuredContent: { applications, currentDocumentControl: false },
        };
      } catch (error) {
        return onFailure(error, context);
      }
    },
    async execute(request, context) {
      try {
        await guard(context);
        const scope = requireCadContext(context).describe();
        const key = JSON.stringify([
          scope.instanceId,
          scope.taskId,
          context.runId,
          context.toolCallId,
        ]);
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(request))
          .digest("hex");
        const previous = invocations.get(key);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new CadError(
              "invocation_conflict",
              "同一次 CAD 调用不能替换参数，请发起新的调用。",
            );
          return await previous.result;
        }
        const result = executeCadRequest(
          options,
          request,
          context,
          guard,
        ).catch((error: unknown) => onFailure(error, context));
        invocations.set(key, {
          runId: context.runId ?? "",
          fingerprint,
          result,
        });
        return await result;
      } catch (error) {
        return onFailure(error, context);
      }
    },
    releaseRun(runId) {
      for (const [key, invocation] of invocations)
        if (invocation.runId === runId) invocations.delete(key);
    },
  };
}
