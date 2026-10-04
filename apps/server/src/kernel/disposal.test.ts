import { expect, it } from "vitest";
import { composePlugins } from "./compose.js";

it("插件卸载按LIFO等待真实异步资源，失败保留该资源以便重试且重复关闭共用承诺", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  let attempts = 0;
  const kernel = composePlugins({ agentBackendMode: "state", agentModel: "test", port: 0, version: "test", webOrigin: "http://localhost" }, [{
    name: "external-resource", inject: [], apply(ctx) {
      ctx.effect(() => () => { order.push("older"); });
      ctx.effect(() => async () => {
        order.push("stop"); await gate;
        if (++attempts === 1) throw new Error("range_not_empty");
        order.push("empty");
      });
    },
  }]);
  let settled = false;
  const first = Promise.resolve(kernel.dispose()).then(() => { settled = true; }, (error) => { throw error; });
  // 先观察拒绝，再打开外部资源，避免未观察的异步失败。
  const result = Promise.allSettled([first]);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(order).toEqual(["stop"]);
  release();
  expect((await result)[0]).toMatchObject({ status: "rejected", reason: new Error("range_not_empty") });
  expect(order).toEqual(["stop"]);
  await kernel.dispose();
  await kernel.dispose();
  expect(order).toEqual(["stop", "stop", "empty", "older"]);
});
