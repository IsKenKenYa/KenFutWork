import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { PluginStateLifecycle } from "../plugins/state-lifecycle.js";
import type {
  ManagedStdioProcess,
  ProcessExit,
  ProcessLimits,
  ProcessSandbox,
  ProcessStdioSpawnRequest,
} from "../process-sandbox/types.js";
import { ProcessSandboxError } from "../process-sandbox/types.js";
import {
  type CadGuiCopyPublicationResult,
  createCadGuiCopyPublisher,
} from "./gui-copy-publication.js";
import type {
  CadGuiApplication,
  CadGuiInspectDocumentInput,
} from "./gui-document-contracts.js";
import type { CadGuiCopyDocumentInput } from "./gui-document-copy-contracts.js";
import {
  CadGuiDocumentQueryError,
  type CadGuiDocumentReader,
  createMacosCadGuiDocumentReader,
} from "./gui-document-reader.js";
import type { CadGuiSetPropertiesInput } from "./gui-operation-contracts.js";
import {
  type CadGuiOperationController,
  CadGuiOperationError,
  type CadGuiOperationResult,
  createCadGuiOperationController,
} from "./gui-operation-controller.js";
import {
  type CadGuiOperationStore,
  CadGuiOperationStoreError,
} from "./gui-operation-store.js";
import {
  type CadGuiProbe,
  type CadGuiProbeContext,
  CadGuiProbeError,
  createMacosCadGuiProbe,
} from "./gui-probe.js";
import type { CadGuiUndoOperationInput } from "./gui-undo-contracts.js";
import {
  CadOperationError,
  createCadOperationLifecycle,
} from "./operation-lifecycle.js";
import { createCadPreviewResult } from "./preview.js";
import { FREECAD_RUNNER_SOURCE } from "./runner-source.js";
import { type CadRuntime, detectFreeCadRuntime } from "./runtime.js";
import {
  type CadRequest,
  type CadResult,
  cadResultSchema,
} from "./tool-contracts.js";

export const CAD_BUNDLE_ID = "kenfutwork-cad";
export const CAD_PLUGIN_INSTALLATION_ID = `bundled__${CAD_BUNDLE_ID}`;

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
  readonly pluginLifecycle: PluginStateLifecycle;
  readonly activationEpoch: number;
  readonly activationAvailable: boolean;
  status(context: ToolExecutionContext): Promise<CadToolResult>;
  guiStatus(context: ToolExecutionContext): Promise<CadToolResult>;
  guiDocuments(
    application: CadGuiApplication,
    context: ToolExecutionContext,
  ): Promise<CadToolResult>;
  guiInspectDocument(
    input: CadGuiInspectDocumentInput,
    context: ToolExecutionContext,
  ): Promise<CadToolResult>;
  guiSetProperties(
    input: CadGuiSetPropertiesInput,
    context: ToolExecutionContext,
  ): Promise<CadToolResult>;
  guiCopyDocument(
    input: CadGuiCopyDocumentInput,
    context: ToolExecutionContext,
  ): Promise<CadToolResult>;
  guiUndoOperation(
    input: CadGuiUndoOperationInput,
    context: ToolExecutionContext,
  ): Promise<CadToolResult>;
  guiOperationStatus(
    operationId: string,
    context: ToolExecutionContext,
  ): Promise<CadToolResult>;
  execute(
    request: CadRequest,
    context: ToolExecutionContext,
  ): Promise<CadToolResult>;
  releaseRun(runId: string): Promise<void>;
  dispose(): Promise<void>;
}
export interface CadServiceOptions {
  sandbox: ProcessSandbox;
  gate(): Promise<{ ok: boolean; message?: string }>;
  resolveLimits(
    context: ToolExecutionContext,
  ): Promise<{ limits: ProcessLimits; timeoutMs: number | null }>;
  detectRuntime?: () => Promise<CadRuntime | null>;
  guiProbe?: CadGuiProbe;
  guiDocumentReader?: CadGuiDocumentReader;
  guiOperationController?: CadGuiOperationController;
  guiOperationStore?: CadGuiOperationStore;
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
    error instanceof CadOperationError ||
    error instanceof ProcessSandboxError ||
    error instanceof CadGuiProbeError ||
    error instanceof CadGuiDocumentQueryError ||
    error instanceof CadGuiOperationError ||
    error instanceof CadGuiOperationStoreError
      ? error.code
      : cancelled || (error instanceof Error && error.name === "AbortError")
        ? "cancelled"
        : "cad_failed";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      ...(error instanceof CadGuiOperationError
        ? { operationId: error.operationId, outcome: error.outcome }
        : {}),
      error: {
        code,
        message,
        ...(error instanceof CadGuiDocumentQueryError
          ? {
              requestId: error.requestId,
              ...(error.actionSent !== undefined
                ? { actionSent: error.actionSent }
                : {}),
              observationConfirmed: error.observationConfirmed,
            }
          : {}),
      },
    },
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
        stopError =
          error instanceof CadError && error.code === "stop_unconfirmed"
            ? error
            : new CadError(
                "stop_unconfirmed",
                `CAD 停止未确认：${error instanceof Error ? error.message : String(error)}`,
              );
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
  const processRequest: ProcessStdioSpawnRequest = {
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
  };
  const process = await options.sandbox.spawnStdio(processRequest, { signal });
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

const guiUndoRejections: Record<string, string> = {
  stale_target: "原修改后文档状态已变化，本次撤销未执行。",
  source_snapshot_changed: "原修改后文档状态已变化，本次撤销未执行。",
  source_state_changed: "原修改后文档状态已变化，本次撤销未执行。",
  history_changed: "撤销历史已变化，本次撤销未执行。",
  value_changed: "相关属性已变化，本次撤销未执行。",
  expression_changed: "相关表达式已变化，本次撤销未执行。",
  property_changed: "相关属性已变化，本次撤销未执行。",
  document_busy: "文档仍在编辑或事务未结束，请完成后再撤销。",
  incoming_external_reference:
    "其它工程引用了此文档，请先在 FreeCAD 检查关联。",
  unsupported_external_reference: "无法确认跨文档关联，本次撤销未执行。",
  cancelled: "本次撤销已取消，未执行原生撤销。",
  operation_expired: "撤销请求已过期，请查询原操作状态。",
};

function guiOperationResult(
  result: CadGuiOperationResult,
  statusOnly = false,
): CadToolResult {
  const messages = {
    copied: "已生成 FreeCAD 副本，尚未发布到 Task。",
    committed: "已修改当前 FreeCAD 文档，尚未保存。",
    undone: "已撤销该次修改，尚未保存。",
    no_op: "属性值无需修改。",
    rejected: "本次操作未执行，请重新读取文档并检查。",
    partial:
      "本次操作未完整完成，可能保留部分影响。请查询操作状态并检查 FreeCAD，勿直接重复执行。",
    unknown: "操作结果尚未确认。请用同一操作编号查询状态，勿换编号重试。",
    prepared: "操作已准备，尚未派发。",
    cancelled: "操作在派发前已取消。",
  };
  const undoRejection =
    result.receipt?.protocol === "kfw-cad-gui-undo/1" &&
    result.outcome === "rejected" &&
    result.reason &&
    Object.hasOwn(guiUndoRejections, result.reason)
      ? guiUndoRejections[result.reason]
      : undefined;
  return {
    ...(!statusOnly &&
    !["committed", "no_op", "undone"].includes(result.outcome)
      ? { isError: true }
      : {}),
    content: [
      { type: "text", text: undoRejection ?? messages[result.outcome] },
    ],
    structuredContent: { ...result },
  };
}

function guiCopyResult(
  native: CadGuiOperationResult,
  publication: CadGuiCopyPublicationResult,
  statusOnly = false,
): CadToolResult {
  const published = publication.outcome === "published";
  const outcome =
    publication.outcome === "not_published" ? "copied" : publication.outcome;
  const text = published
    ? `已发布 FreeCAD 副本：${publication.outputPath}`
    : publication.outcome === "unknown"
      ? "副本发布结果尚未确认，请查询同一操作编号，勿换编号盲重试。"
      : "已生成 FreeCAD 副本，尚未发布到 Task。请检查目标目录和原操作状态。";
  const canonicalOutput = published
    ? {
        type: "cad-document-copy",
        operationId: native.operationId,
        outputPath: publication.outputPath,
        filePath: publication.outputPath,
        mimeType: "application/x-freecad",
        sizeBytes: publication.sizeBytes,
        sha256: publication.sha256,
        version: publication.version,
      }
    : undefined;
  return {
    ...(!published && !statusOnly ? { isError: true } : {}),
    content: [{ type: "text", text }],
    structuredContent: {
      ...native,
      ...publication,
      nativeOutcome: native.outcome,
      outcome,
      publicationOutcome: publication.outcome,
    },
    ...(canonicalOutput ? { canonicalOutput } : {}),
  };
}

export function createCadService(options: CadServiceOptions): CadService {
  const guiProbe = options.guiProbe ?? createMacosCadGuiProbe();
  const guiDocumentReader =
    options.guiDocumentReader ??
    createMacosCadGuiDocumentReader({ probe: guiProbe });
  const guiOperations =
    options.guiOperationController ??
    (options.guiOperationStore
      ? createCadGuiOperationController({
          store: options.guiOperationStore,
          probe: guiProbe,
        })
      : null);
  const guiCopyPublisher = options.guiOperationStore
    ? createCadGuiCopyPublisher({ store: options.guiOperationStore })
    : null;
  const invocations = new Map<
    string,
    {
      runId: string;
      epoch: number;
      fingerprint: string;
      result: Promise<CadToolResult>;
    }
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
  const lifecycle = createCadOperationLifecycle({
    bundleName: CAD_BUNDLE_ID,
    installationId: CAD_PLUGIN_INSTALLATION_ID,
    failure: onFailure,
    async cancelPersistedOperations(runId) {
      await options.guiOperationStore?.cancelPending(
        runId === undefined ? undefined : { runId },
      );
    },
  });
  const invoke = (
    payload:
      | CadRequest
      | { action: "gui-documents"; application: CadGuiApplication }
      | { action: "gui-inspect"; input: CadGuiInspectDocumentInput }
      | { action: "gui-set-properties"; input: CadGuiSetPropertiesInput }
      | { action: "gui-copy-document"; input: CadGuiCopyDocumentInput }
      | { action: "gui-undo-operation"; input: CadGuiUndoOperationInput },
    context: ToolExecutionContext,
    operation: (
      context: ToolExecutionContext,
      guard: (context: ToolExecutionContext) => Promise<void>,
    ) => Promise<CadToolResult>,
  ): Promise<CadToolResult> => {
    return lifecycle.run(context, async (context, epoch, assertActive) => {
      const activeGuard = async (current: ToolExecutionContext) => {
        assertActive();
        await guard(current);
        assertActive();
      };
      try {
        await activeGuard(context);
        const scope = requireCadContext(context).describe();
        const key = JSON.stringify([
          scope.instanceId,
          scope.taskId,
          context.runId,
          context.toolCallId,
        ]);
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(payload))
          .digest("hex");
        const previous = invocations.get(key);
        if (previous) {
          if (previous.epoch !== epoch)
            throw new CadError(
              "invocation_revoked",
              "CAD 插件已重新装载，这次旧调用不能重放，请发起新的调用。",
            );
          if (previous.fingerprint !== fingerprint)
            throw new CadError(
              "invocation_conflict",
              "同一次 CAD 调用不能替换参数，请发起新的调用。",
            );
          return await previous.result;
        }
        const result = operation(context, activeGuard).catch((error: unknown) =>
          onFailure(error, context),
        );
        invocations.set(key, {
          runId: context.runId ?? "",
          epoch,
          fingerprint,
          result,
        });
        return await result;
      } catch (error) {
        return onFailure(error, context);
      }
    });
  };
  const readGui = async <T extends object>(
    context: ToolExecutionContext,
    activeGuard: (context: ToolExecutionContext) => Promise<void>,
    read: (context: CadGuiProbeContext) => Promise<T>,
    summary: (snapshot: T) => string,
  ): Promise<CadToolResult> => {
    await activeGuard(context);
    if (requireCadContext(context).describe().sandboxMode === "read-only")
      throw new CadError(
        "forbidden",
        "当前 Task 仅允许读取，不能向 FreeCAD 加载宏。",
      );
    const { limits, timeoutMs } = await options.resolveLimits(context);
    await activeGuard(context);
    const signal = AbortSignal.any(
      [context.signal, context.taskWorkContext?.signal].filter(
        (entry): entry is AbortSignal => entry !== undefined,
      ),
    );
    const snapshot = await read({
      signal,
      timeoutMs: Math.min(timeoutMs ?? 10_000, 10_000),
      maxOutputBytes: limits.maxOutputBytes,
    });
    await activeGuard(context);
    return {
      content: [{ type: "text", text: summary(snapshot) }],
      structuredContent: {
        ...snapshot,
        currentDocumentControl: Boolean(guiOperations),
      },
    };
  };
  const guiActionContext = async (
    context: ToolExecutionContext,
    activeGuard: (context: ToolExecutionContext) => Promise<void>,
  ) => {
    await activeGuard(context);
    const handle = requireCadContext(context);
    const scope = handle.describe();
    if (scope.sandboxMode === "read-only")
      throw new CadError(
        "forbidden",
        "当前 Task 仅允许读取，不能执行 FreeCAD 操作。",
      );
    if (!guiOperations)
      throw new CadError(
        "operation_storage_unavailable",
        "CAD 操作存储尚未就绪，请重新启动应用后重试。",
      );
    const { limits, timeoutMs } = await options.resolveLimits(context);
    await activeGuard(context);
    const signal = AbortSignal.any(
      [context.signal, context.taskWorkContext?.signal].filter(
        (value): value is AbortSignal => value !== undefined,
      ),
    );
    return {
      handle,
      controller: guiOperations,
      binding: {
        instanceId: scope.instanceId,
        projectId: scope.projectId,
        taskId: scope.taskId,
        scopeGeneration: scope.generation,
        branchGeneration: handle.branchGeneration,
        runId: context.runId ?? "",
        toolCallId: context.toolCallId ?? "",
      },
      probeContext: {
        signal,
        timeoutMs: timeoutMs ?? 60_000,
        maxOutputBytes: limits.maxOutputBytes,
      },
      guard: () => activeGuard(context),
    };
  };
  const guiFailure = (
    error: unknown,
    context: ToolExecutionContext,
    operationId: string,
    possible: boolean,
  ) => {
    const result = onFailure(error, context);
    return {
      ...result,
      structuredContent: {
        ...result.structuredContent,
        operationId,
        outcome: possible ? "unknown" : "rejected",
      },
    };
  };
  const identifyFailure = (
    result: CadToolResult,
    operationId: string,
  ): CadToolResult =>
    result.isError && !result.structuredContent.operationId
      ? {
          ...result,
          structuredContent: {
            ...result.structuredContent,
            operationId,
            outcome: "unknown",
          },
        }
      : result;
  const invokeGuiEdit = (
    payload:
      | { action: "gui-set-properties"; input: CadGuiSetPropertiesInput }
      | { action: "gui-undo-operation"; input: CadGuiUndoOperationInput },
    context: ToolExecutionContext,
  ) => {
    const target = structuredClone(payload);
    return invoke(target, context, async (context, activeGuard) => {
      let possible = false;
      try {
        const action = await guiActionContext(context, activeGuard);
        const dispatch =
          target.action === "gui-set-properties"
            ? action.controller.execute.bind(action.controller, target.input)
            : action.controller.undoOperation.bind(
                action.controller,
                target.input,
              );
        possible = true;
        const result = await dispatch(
          action.binding,
          action.probeContext,
          action.guard,
        );
        await action.guard();
        return guiOperationResult(result);
      } catch (error) {
        return guiFailure(error, context, target.input.operationId, possible);
      }
    }).then((result) => identifyFailure(result, target.input.operationId));
  };
  return {
    pluginLifecycle: lifecycle.plugin,
    get activationEpoch() {
      return lifecycle.epoch();
    },
    get activationAvailable() {
      return lifecycle.available();
    },
    status(context) {
      return lifecycle.run(context, async (context) => {
        await guard(context);
        return cadStatus(
          await (options.detectRuntime ?? detectFreeCadRuntime)(),
        );
      });
    },
    guiStatus(context) {
      return lifecycle.run(context, async (context) => {
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
          structuredContent: {
            applications,
            currentDocumentControl: Boolean(guiOperations),
          },
        };
      });
    },
    guiDocuments(application, context) {
      const target = structuredClone(application);
      return invoke(
        { action: "gui-documents", application: target },
        context,
        (context, activeGuard) =>
          readGui(
            context,
            activeGuard,
            (queryContext) => guiDocumentReader.read(target, queryContext),
            (snapshot) => `已查询 ${snapshot.documents.length} 个打开的文档。`,
          ),
      );
    },
    guiInspectDocument(input, context) {
      const target = structuredClone(input);
      return invoke(
        { action: "gui-inspect", input: target },
        context,
        (context, activeGuard) =>
          readGui(
            context,
            activeGuard,
            (queryContext) => guiDocumentReader.inspect(target, queryContext),
            (snapshot) => `已读取 ${snapshot.objects.length} 个对象。`,
          ),
      );
    },
    guiSetProperties(input, context) {
      return invokeGuiEdit({ action: "gui-set-properties", input }, context);
    },
    guiUndoOperation(input, context) {
      return invokeGuiEdit({ action: "gui-undo-operation", input }, context);
    },
    guiCopyDocument(input, context) {
      const target = structuredClone(input);
      return invoke(
        { action: "gui-copy-document", input: target },
        context,
        async (context, activeGuard) => {
          let possible = false;
          try {
            const action = await guiActionContext(context, activeGuard);
            if (!guiCopyPublisher || !options.guiOperationStore)
              throw new CadError(
                "operation_storage_unavailable",
                "CAD 副本存储尚未就绪，请重新启动应用后重试。",
              );
            const outputPath = await action.handle.resolvePath(
              target.outputPath ??
                `.kfw-cad/gui-snapshots/${target.operationId}.FCStd`,
              "write",
            );
            await action.guard();
            const previous = await options.guiOperationStore.lookup({
              instanceId: action.binding.instanceId,
              taskId: action.binding.taskId,
              operationId: target.operationId,
            });
            if (!previous && (await existing(outputPath)))
              throw new CadError(
                "output_exists",
                "目标文件已存在，请使用新的文件名。",
              );
            possible = true;
            const native = await action.controller.copyDocument(
              { ...target, outputPath },
              action.binding,
              action.probeContext,
              action.guard,
            );
            await action.guard();
            const record = await options.guiOperationStore.lookup({
              instanceId: action.binding.instanceId,
              taskId: action.binding.taskId,
              operationId: target.operationId,
            });
            if (!record)
              throw new CadError(
                "operation_record_missing",
                "CAD 副本记录缺失，请检查原操作状态。",
              );
            const publication = await guiCopyPublisher.status(record);
            if (publication.outcome !== "not_published")
              return guiCopyResult(native, publication);
            if (native.outcome !== "copied") return guiOperationResult(native);
            const published = await guiCopyPublisher.publish(
              record,
              action.handle,
              action.probeContext.signal,
              action.guard,
            );
            await action.guard();
            return guiCopyResult(native, published);
          } catch (error) {
            return guiFailure(error, context, target.operationId, possible);
          }
        },
      ).then((result) => identifyFailure(result, target.operationId));
    },
    guiOperationStatus(operationId, context) {
      return lifecycle.run(context, async (context) => {
        await guard(context);
        if (!guiOperations)
          throw new CadError(
            "operation_storage_unavailable",
            "CAD 操作存储尚未就绪，请重新启动应用后重试。",
          );
        const scope = requireCadContext(context).describe();
        const result = await guiOperations.status({
          instanceId: scope.instanceId,
          taskId: scope.taskId,
          operationId,
        });
        await guard(context);
        if (options.guiOperationStore && guiCopyPublisher) {
          const record = await options.guiOperationStore.lookup({
            instanceId: scope.instanceId,
            taskId: scope.taskId,
            operationId,
          });
          if (
            record?.payload &&
            typeof record.payload === "object" &&
            "operation" in record.payload &&
            record.payload.operation === "save-copy"
          ) {
            const publication = await guiCopyPublisher.status(record);
            await guard(context);
            if (
              result.outcome === "copied" ||
              publication.outcome !== "not_published"
            )
              return guiCopyResult(result, publication, true);
          }
        }
        return guiOperationResult(result, true);
      });
    },
    execute(request, context) {
      return invoke(request, context, (context, guard) =>
        executeCadRequest(options, request, context, guard),
      );
    },
    async releaseRun(runId) {
      await lifecycle.closeRun(runId);
      for (const [key, invocation] of invocations)
        if (invocation.runId === runId) invocations.delete(key);
    },
    dispose: () => lifecycle.dispose(),
  };
}
