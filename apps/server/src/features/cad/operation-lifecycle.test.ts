import { describe, expect, it, vi } from "vitest";
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

function fixture() {
  const lifecycle = createCadOperationLifecycle({
    bundleName: plugin.name,
    installationId: plugin.id,
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
