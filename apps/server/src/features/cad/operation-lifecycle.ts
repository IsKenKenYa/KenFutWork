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
}

/** CAD 安装代际及在途操作；只取消自己发起的工作，不接管外部应用进程。 */
export function createCadOperationLifecycle(options: {
  bundleName: string;
  installationId: string;
  failure(error: unknown, context: ToolExecutionContext): CadToolResult;
}) {
  const active = new Set<ActiveOperation>();
  const closingRuns = new Map<string, Promise<void>>();
  let epoch = 0;
  let blocked = true;
  let disposed = false;

  async function cancelAndJoin(operations: ActiveOperation[]) {
    for (const operation of operations) operation.controller.abort();
    const results = await Promise.all(
      operations.map((operation) => operation.done),
    );
    const unconfirmed = results.find(
      (result) =>
        (result.structuredContent.error as { code?: unknown } | undefined)
          ?.code === "stop_unconfirmed",
    );
    if (unconfirmed)
      throw new CadOperationError(
        "stop_unconfirmed",
        unconfirmed.content.map((entry) => entry.text).join("\n"),
      );
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
      await cancelAndJoin([...active]);
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
      blocked = !activated || active.size > 0 || disposed;
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
        if (disposed || closingRuns.has(context.runId ?? ""))
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
      const closing = cancelAndJoin(
        [...active].filter((operation) => operation.runId === runId),
      ).finally(() => closingRuns.delete(runId));
      closingRuns.set(runId, closing);
      return closing;
    },
    async dispose() {
      disposed = true;
      epoch++;
      await cancelAndJoin([...active]);
    },
  };
}
