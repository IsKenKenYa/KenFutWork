import { expect, it } from "vitest";
import { shouldRestartHelperAfterCuaPermissionReturn } from "../src/components/workbench/zcode/lib/cuaPermissionAction.js";

it("授权引导返回后要求重启 Helper，取消或未返回设置时不重启", () => {
  const completed = {
    success: true,
    sessionId: "onboarding-1",
    returnedFromSettings: true,
    restartHelperAfterReturn: true,
  } as const;
  expect(shouldRestartHelperAfterCuaPermissionReturn(completed)).toBe(true);

  for (const result of [
    { ...completed, success: false },
    { ...completed, returnedFromSettings: false },
    { ...completed, sessionId: "" },
    { ...completed, restartHelperAfterReturn: false },
    null,
    undefined,
  ])
    expect(shouldRestartHelperAfterCuaPermissionReturn(result)).toBe(false);
});
