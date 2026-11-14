import {
  cuaPermissionStatusKey,
  fetchCuaPermissionStatus,
  getCuaPermissionStatusSnapshot,
} from "@zui/lib/cuaPermissionStatusStore.js";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
});

it("状态查询连续失败后结束验证中，未知态仍可进入授权设置", async () => {
  vi.useFakeTimers();
  const getStatus = vi.fn(async () => {
    throw new Error("ABORT_ERR");
  });
  const workspacePath = `/settle-${Math.random()}`;
  const key = cuaPermissionStatusKey(workspacePath);

  fetchCuaPermissionStatus({
    service: { getStatus } as never,
    workspacePath,
  });
  await vi.runAllTimersAsync();
  for (let index = 0; index < 10; index += 1) await Promise.resolve();

  expect(getStatus).toHaveBeenCalledTimes(4);
  expect(getCuaPermissionStatusSnapshot(key)).toEqual({
    status: null,
    fresh: false,
    settled: true,
  });
});
