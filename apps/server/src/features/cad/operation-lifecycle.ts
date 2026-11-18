import type { ToolExecutionContext } from "../../kernel/types.js";
import type { PluginStateLifecycle } from "../plugins/state-lifecycle.js";
import type { CadToolResult } from "./service.js";

export class CadOperationError extends Error {
  constructor(
    readonly code: "plugin_disabled" | "stop_unconfirmed" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "CadOperationError";
  }
}

interface ActiveOperation {
  runId: string;
  controller: AbortController;
  done: Promise<CadToolResult>;
  confirmStopped: (() => Promise<void>) | undefined;
}

/** CAD 安装代际及在途操作；只取消自己发起的工作，不接管外部应用进程。 */
export function createCadOperationLifecycle(options: {
  bundleName: string;
  installationId: string;
  failure(error: unknown, context: ToolExecutionContext): CadToolResult;
  cancelPersistedOperations?(runId?: string): Promise<void>;
  confirmPersistedOperationsStopped?(runId?: string): Promise<void>;
}) {
  const active = new Set<ActiveOperation>();
  const closingRuns = new Map<string, Promise<void>>();
  const failedReconciliations = new Set<string | undefined>();
  let epoch = 0;
  let blocked = true;
  let disposed = false;

  async function cancelAndJoin(operations: ActiveOperation[]) {
    for (const operation of operations) operation.controller.abort();
    const results = await Promise.all(
      operations.map(async (operation) => ({
        operation,
        result: await operation.done,
      })),
    );
    const confirmations = await Promise.allSettled(
      results.map(async ({ operation, result }) => {
        if (
          (result.structuredContent.error as { code?: unknown } | undefined)
            ?.code !== "stop_unconfirmed"
        )
          return;
        if (!operation.confirmStopped)
          throw new CadOperationError(
            "stop_unconfirmed",
            result.content.map((entry) => entry.text).join("\n"),
          );
        // 只允许本次操作冻结的可信证明消解旧错误；全局扫描不能替代它。
        await operation.confirmStopped();
        active.delete(operation);
      }),
    );
    const rejected = confirmations.find(
      (result) => result.status === "rejected",
    );
    if (rejected?.status === "rejected") throw rejected.reason;
  }

  async function cancelAndReconcile(
    operations: ActiveOperation[],
    runId?: string,
  ) {
    // 在途取消和旧持久记录都须尝试，不能因一处失败遗漏另一处。
    const results = await Promise.allSettled([
      cancelAndJoin(operations),
      Promise.resolve().then(() => options.cancelPersistedOperations?.(runId)),
    ]);
    // 原生调用可能在Node取消回调结束后仍写文件；须在清理后读可信持久完成点。
    const confirmation = await Promise.allSettled([
      Promise.resolve().then(() =>
        options.confirmPersistedOperationsStopped?.(runId),
      ),
    ]);
    results.push(...confirmation);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) {
      failedReconciliations.add(runId);
      throw rejected.reason;
    }
    if (runId === undefined) failedReconciliations.clear();
    else failedReconciliations.delete(runId);
  }

  const plugin: PluginStateLifecycle = {
    async onStateRevoking(event) {
      if (
        event.previous.id !== options.installationId ||
        event.previous.name !== options.bundleName
      )
        return;
      blocked = true;
      epoch++;
      await cancelAndReconcile([...active]);
    },
    afterStateChanged(event) {
      if (
        event.previous?.id !== options.installationId &&
        event.current?.id !== options.installationId
      )
        return;
      epoch++;
      const activated =
        ["install", "enable", "restore", "replace"].includes(event.reason) &&
        event.current?.id === options.installationId &&
        event.current.name === options.bundleName &&
        event.current.enabled;
      blocked =
        !activated ||
        active.size > 0 ||
        disposed ||
        failedReconciliations.size > 0;
    },
  };

  return {
    plugin,
    epoch: () => epoch,
    available: () => !blocked && !disposed,
    run(
      context: ToolExecutionContext,
      execute: (
        activeContext: ToolExecutionContext,
        activationEpoch: number,
        assertActive: () => void,
      ) => Promise<CadToolResult>,
      confirmStopped?: () => Promise<void>,
    ): Promise<CadToolResult> {
      const activationEpoch = epoch;
      const controller = new AbortController();
      const signal = AbortSignal.any(
        [
          controller.signal,
          context.signal,
          context.taskWorkContext?.signal,
        ].filter((value): value is AbortSignal => value !== undefined),
      );
      const activeContext = { ...context, signal };
      const assertActive = () => {
        if (
          disposed ||
          closingRuns.has(context.runId ?? "") ||
          failedReconciliations.has(context.runId)
        )
          throw new CadOperationError("cancelled", "CAD 操作正在关闭。");
        if (blocked || epoch !== activationEpoch)
          throw new CadOperationError(
            "plugin_disabled",
            "CAD 插件已停用或重新装载，请发起新的操作。",
          );
        signal.throwIfAborted();
      };
      const operation: ActiveOperation = {
        runId: context.runId ?? "",
        controller,
        confirmStopped,
        done: Promise.resolve()
          .then(async () => {
            assertActive();
            const result = await execute(
              activeContext,
              activationEpoch,
              assertActive,
            );
            if (result.isError) return result;
            assertActive();
            return result;
          })
          .catch((error: unknown) => options.failure(error, activeContext)),
      };
      active.add(operation);
      void operation.done.then((result) => {
        if (
          (result.structuredContent.error as { code?: unknown } | undefined)
            ?.code !== "stop_unconfirmed"
        )
          active.delete(operation);
      });
      return operation.done;
    },
    closeRun(runId: string): Promise<void> {
      const existing = closingRuns.get(runId);
      if (existing) return existing;
      const closing = cancelAndReconcile(
        [...active].filter((operation) => operation.runId === runId),
        runId,
      ).finally(() => closingRuns.delete(runId));
      closingRuns.set(runId, closing);
      return closing;
    },
    async dispose() {
      disposed = true;
      epoch++;
      await cancelAndReconcile([...active]);
    },
  };
}
