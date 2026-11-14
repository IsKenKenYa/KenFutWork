import { describe, expect, it } from "vitest";
import {
  CUA_HELPER_DEV_APP_NAME,
  resolveComputerUseHelperLocation,
  shouldEagerStartComputerUseHelper,
} from "./helper-location.js";

describe("resolveComputerUseHelperLocation", () => {
  it("开发形态固定安装到数据目录的 cua-helper/dev", () => {
    expect(
      resolveComputerUseHelperLocation({
        env: {},
        platform: "darwin",
        dataDir: "/Users/me/Library/Application Support/com.kenfutwork.desktop",
      }),
    ).toEqual({
      appPath: `/Users/me/Library/Application Support/com.kenfutwork.desktop/cua-helper/dev/${CUA_HELPER_DEV_APP_NAME}`,
      socketPath:
        "/Users/me/Library/Application Support/com.kenfutwork.desktop/cua-helper/dev/h.sock",
      configuration: "dev",
    });
  });

  it("打包壳注入的路径优先，并按名称选择 socket 子目录", () => {
    expect(
      resolveComputerUseHelperLocation({
        env: {
          KENFUTWORK_CUA_HELPER_PATH:
            "/Applications/KenFutWork.app/Contents/Resources/cua-helper/KenFutWork Computer Use.app",
        },
        platform: "darwin",
        dataDir: "/data",
      }),
    ).toEqual({
      appPath:
        "/Applications/KenFutWork.app/Contents/Resources/cua-helper/KenFutWork Computer Use.app",
      socketPath: "/data/cua-helper/production/h.sock",
      configuration: "production",
    });
  });

  it("只有桌面内嵌服务形态随壳启动 Helper", () => {
    expect(
      shouldEagerStartComputerUseHelper({ KENFUTWORK_EMBEDDED_PG: "1" }),
    ).toBe(true);
    expect(shouldEagerStartComputerUseHelper({})).toBe(false);
    expect(
      shouldEagerStartComputerUseHelper({ KENFUTWORK_EMBEDDED_PG: "0" }),
    ).toBe(false);
  });

  it("打包形态从服务端工作目录解析随包 Helper", () => {
    const appPath =
      "/Applications/KenFutWork.app/Contents/Resources/app/cua-helper/KenFutWork Computer Use.app";
    expect(
      resolveComputerUseHelperLocation({
        env: {},
        platform: "darwin",
        dataDir: "/Users/me/Library/Application Support/com.kenfutwork.desktop",
        cwd: "/Applications/KenFutWork.app/Contents/Resources/app",
        exists: (path) => path === appPath,
      }),
    ).toEqual({
      appPath,
      socketPath:
        "/Users/me/Library/Application Support/com.kenfutwork.desktop/cua-helper/production/h.sock",
      configuration: "production",
    });
  });

  it("非 macOS 不返回位置", () => {
    expect(
      resolveComputerUseHelperLocation({
        env: {},
        platform: "win32",
        dataDir: "/data",
      }),
    ).toBeNull();
  });

  it("socket 路径超过 sun_path 上限时直接报错", () => {
    expect(() =>
      resolveComputerUseHelperLocation({
        env: {},
        platform: "darwin",
        dataDir: `/Users/me/${"a".repeat(90)}`,
      }),
    ).toThrow("socket 无法创建");
  });
});
