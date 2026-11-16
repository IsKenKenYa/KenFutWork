import {
  BROWSER_OPEN_TARGET_KEY,
  browserOpenTargetError,
  readBrowserOpenTarget,
  writeBrowserOpenTarget,
} from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";

afterEach(() => window.localStorage.clear());

it("默认值及无效旧值使用内置浏览器，保存后读取同一设置", () => {
  window.localStorage.removeItem(BROWSER_OPEN_TARGET_KEY);
  expect(readBrowserOpenTarget(window.localStorage)).toBe("panel");
  for (const value of ["", "unknown", "SYSTEM"]) {
    window.localStorage.setItem(BROWSER_OPEN_TARGET_KEY, value);
    expect(readBrowserOpenTarget(window.localStorage)).toBe("panel");
  }
  for (const value of ["system", "panel", "system"] as const) {
    writeBrowserOpenTarget(window.localStorage, value);
    expect(window.localStorage.getItem(BROWSER_OPEN_TARGET_KEY)).toBe(value);
    expect(readBrowserOpenTarget(window.localStorage)).toBe(value);
  }
});

it("未知存储错误给出检查建议且不展示异常正文", () => {
  const error = new Error("private storage diagnostic");
  expect(browserOpenTargetError(error, "read")).toBe(
    "浏览器选择读取失败，请检查本地存储后重试。",
  );
  expect(browserOpenTargetError(error, "save")).toBe(
    "浏览器选择未保存，请检查本地存储后重试。",
  );
});
