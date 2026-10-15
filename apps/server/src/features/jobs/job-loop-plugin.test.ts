import { beforeEach, expect, it, vi } from "vitest";
import { loadServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { ServiceMap } from "../../kernel/types.js";
import { createJobLoopPlugin } from "./job-loop-plugin.js";

const { start, shutdown, count } = vi.hoisted(() => ({
  start: vi.fn(),
  shutdown: vi.fn(async () => {}),
  count: vi.fn(() => 2),
}));
vi.mock("./job-loop.js", () => ({ startJobLoop: start }));
beforeEach(() => {
  start.mockReset();
  shutdown.mockClear();
  count.mockClear();
  start.mockReturnValue({ shutdown, inFlightCount: count });
});

it("JobLoop使用同内核依赖只启动一次，get返回原handle，disposer关闭同一loop", async () => {
  const dependencies = {
    assetWriter: {},
    uploads: {},
    blob: {},
    jobs: {},
    modelProviders: {},
    queue: {},
    usage: {},
    projectFiles: {},
    generationTargets: {},
  } as unknown as Partial<ServiceMap>;
  const env = loadServerEnv({}, {});
  const kernel = composePlugins(
    env,
    [createJobLoopPlugin({ enabled: () => true, tag: "[fixture-worker]" })],
    { overrides: dependencies },
  );
  const loop = kernel.get("jobLoop");
  expect(kernel.get("jobLoop")).toBe(loop);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith(
    {
      env,
      assetWriter: dependencies.assetWriter,
      uploads: dependencies.uploads,
      blob: dependencies.blob,
      jobService: dependencies.jobs,
      modelProviders: dependencies.modelProviders,
      queue: dependencies.queue,
      usageService: dependencies.usage,
      projectFiles: dependencies.projectFiles,
      generationTargets: dependencies.generationTargets,
    },
    { tag: "[fixture-worker]" },
  );
  expect(loop.inFlightCount()).toBe(2);
  await kernel.dispose();
  await kernel.dispose();
  expect(shutdown).toHaveBeenCalledTimes(1);
});
it("显式disabled不注册或启动假循环，关闭也不触发factory", async () => {
  const kernel = composePlugins(loadServerEnv({}, {}), [
    createJobLoopPlugin({ enabled: () => false }),
  ]);
  expect(kernel.tryGet("jobLoop")).toBeUndefined();
  await kernel.dispose();
  expect(start).not.toHaveBeenCalled();
  expect(shutdown).not.toHaveBeenCalled();
});
