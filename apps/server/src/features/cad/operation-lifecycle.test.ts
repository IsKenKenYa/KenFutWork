import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { PluginStateRevokingEvent } from "../plugins/state-lifecycle.js";
import {
  CadOperationError,
  createCadOperationLifecycle,
} from "./operation-lifecycle.js";
import type { CadToolResult } from "./service.js";

const plugin = {
  id: "bundled__kenfutwork-cad",
  name: "kenfutwork-cad",
  enabled: true,
};
const event = {
  reason: "disable",
  previous: plugin,
  current: null,
} as PluginStateRevokingEvent;
const ok: CadToolResult = { content: [], structuredContent: { success: true } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  options: { confirmPersistedOperationsStopped?(): Promise<void> } = {},
) {
  const lifecycle = createCadOperationLifecycle({
    bundleName: plugin.name,
    installationId: plugin.id,
    ...options,
    failure(error) {
      return {
        isError: true,
        content: [{ type: "text", text: String(error) }],
        structuredContent: {
          error: {
            code: error instanceof CadOperationError ? error.code : "cancelled",
          },
        },
      };
    },
  });
  lifecycle.plugin.afterStateChanged?.({
    reason: "install",
    previous: null,
    current: event.previous,
  });
  return lifecycle;
}

describe("CAD 安装代际与在途收尾", () => {
  it("停用后不恢复准入，同名本地安装不能解除官方插件屏障", async () => {
    const f = fixture();
    await f.plugin.onStateRevoking?.(event);
    f.plugin.afterStateChanged?.({
      reason: "disable",
      previous: event.previous,
      current: { ...event.previous, enabled: false },
    });
    expect(f.available()).toBe(false);
    const epoch = f.epoch();
    f.plugin.afterStateChanged?.({
      reason: "enable",
      previous: null,
      current: {
        ...event.previous,
        id: "local__kenfutwork-cad",
        enabled: true,
      },
    });
    expect(f.epoch()).toBe(epoch);
    expect(f.available()).toBe(false);
    const run = vi.fn(async () => ok);
    expect((await f.run({}, run)).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("同步禁止新操作并取消在途信号，真正完成前不结束停用", async () => {
    const f = fixture();
    const entered = deferred<AbortSignal | undefined>();
    const finished = deferred<CadToolResult>();
    const pending = f.run({ runId: "old" }, async (context) => {
      entered.resolve(context.signal);
      return finished.promise;
    });
    const signal = await entered.promise;
    let revoked = false;
    const stopping = Promise.resolve(f.plugin.onStateRevoking?.(event)).then(
      () => {
        revoked = true;
      },
    );
    expect(signal?.aborted).toBe(true);
    const next = vi.fn(async () => ok);
    expect((await f.run({ runId: "new" }, next)).isError).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(revoked).toBe(false);
    finished.resolve(ok);
    expect((await pending).isError).toBe(true);
    await stopping;
    expect(revoked).toBe(true);
  });

  it("同一安装重新启用不复活旧执行，只有新调用获得新代际", async () => {
    const f = fixture();
    const seen: number[] = [];
    await f.run({}, async (_context, epoch) => {
      seen.push(epoch);
      return ok;
    });
    await f.plugin.onStateRevoking?.(event);
    f.plugin.afterStateChanged?.({
      reason: "enable",
      previous: event.previous,
      current: event.previous,
    });
    await f.run({}, async (_context, epoch) => {
      seen.push(epoch);
      return ok;
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0] ?? -1);
  });

  it("停止未确认不能被安装代际错误覆盖，也不能宣称停用已收尾", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const finished = deferred<CadToolResult>();
    const pending = f.run({}, async () => {
      entered.resolve();
      return finished.promise;
    });
    await entered.promise;
    const stopping = Promise.resolve(f.plugin.onStateRevoking?.(event));
    const rejected = expect(stopping).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
    finished.resolve({
      isError: true,
      content: [{ type: "text", text: "range not confirmed" }],
      structuredContent: { error: { code: "stop_unconfirmed" } },
    });
    expect(await pending).toMatchObject({
      structuredContent: { error: { code: "stop_unconfirmed" } },
    });
    await rejected;
    f.plugin.afterStateChanged?.({
      reason: "enable",
      previous: event.previous,
      current: event.previous,
    });
    expect(f.available()).toBe(false);
    await expect(f.dispose()).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
  });

  it("全局持久确认成功不能洗掉没有独立结束证明的后台操作", async () => {
    const confirmPersisted = vi.fn(async () => {});
    const f = fixture({
      confirmPersistedOperationsStopped: confirmPersisted,
    });
    const execute = vi.fn(
      async (): Promise<CadToolResult> => ({
        isError: true,
        content: [{ type: "text", text: "后台进程尚未确认退出" }],
        structuredContent: { error: { code: "stop_unconfirmed" } },
      }),
    );
    await f.run({ runId: "backend" }, execute);

    await expect(f.closeRun("backend")).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
    await expect(f.closeRun("backend")).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
    expect(confirmPersisted).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["run", "uninstall", "dispose"] as const)(
    "%s仅在同一GUI操作可信结束后解除旧失败，不重执行原操作",
    async (kind) => {
      const f = fixture();
      let proof: "missing" | "pending" | "finished" = "missing";
      const confirmStopped = vi.fn(async () => {
        if (proof !== "finished")
          throw new CadOperationError(
            "stop_unconfirmed",
            proof === "missing" ? "原操作记录不存在" : "写入结束尚未确认",
          );
      });
      const execute = vi.fn(
        async (): Promise<CadToolResult> => ({
          isError: true,
          content: [{ type: "text", text: "取消请求暂时无法落盘" }],
          structuredContent: { error: { code: "stop_unconfirmed" } },
        }),
      );
      await f.run({ runId: "gui-save" }, execute, confirmStopped);
      const stop = () =>
        kind === "run"
          ? f.closeRun("gui-save")
          : kind === "dispose"
            ? f.dispose()
            : Promise.resolve(f.plugin.onStateRevoking?.(event));

      await expect(stop()).rejects.toMatchObject({ code: "stop_unconfirmed" });
      proof = "pending";
      await expect(stop()).rejects.toMatchObject({ code: "stop_unconfirmed" });
      proof = "finished";
      await expect(stop()).resolves.toBeUndefined();
      await expect(stop()).resolves.toBeUndefined();
      expect(confirmStopped).toHaveBeenCalledTimes(3);
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it("多操作停止先取消全部信号并等待全部收尾，独立证明不提前释放其它操作", async () => {
    const f = fixture();
    const stickySignal = deferred<AbortSignal | undefined>();
    const runningSignal = deferred<AbortSignal | undefined>();
    const finished = deferred<CadToolResult>();
    const confirmStopped = vi.fn(async () => {});
    const execute = vi.fn(
      async (context: ToolExecutionContext): Promise<CadToolResult> => {
        stickySignal.resolve(context.signal);
        return {
          isError: true,
          content: [{ type: "text", text: "先前取消失败" }],
          structuredContent: { error: { code: "stop_unconfirmed" } },
        };
      },
    );
    await f.run({ runId: "saved" }, execute, confirmStopped);
    const pending = f.run({ runId: "still-running" }, async (context) => {
      runningSignal.resolve(context.signal);
      return finished.promise;
    });
    const firstSignal = await stickySignal.promise;
    const secondSignal = await runningSignal.promise;
    let stopped = false;
    const stopping = Promise.resolve(f.plugin.onStateRevoking?.(event)).then(
      () => {
        stopped = true;
      },
    );
    const outcome = Promise.allSettled([stopping]);
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(confirmStopped).not.toHaveBeenCalled();

    finished.resolve(ok);
    expect((await pending).isError).toBe(true);
    expect(await outcome).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(stopped).toBe(true);
    expect(confirmStopped).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("Run 关闭只取消自己的调用，关闭服务后所有新调用均拒绝", async () => {
    const f = fixture();
    const entered = deferred<AbortSignal | undefined>();
    const done = deferred<CadToolResult>();
    const pending = f.run({ runId: "first" }, async (context) => {
      entered.resolve(context.signal);
      return done.promise;
    });
    const signal = await entered.promise;
    await f.closeRun("other");
    expect(signal?.aborted).toBe(false);
    const closing = f.closeRun("first");
    expect(signal?.aborted).toBe(true);
    done.resolve(ok);
    await pending;
    await closing;
    expect(await f.run({ runId: "new" }, async () => ok)).toEqual(ok);
    await f.dispose();
    expect((await f.run({}, async () => ok)).isError).toBe(true);
  });
});
