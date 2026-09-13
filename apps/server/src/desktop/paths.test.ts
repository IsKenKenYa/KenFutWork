import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopDataDir, resolveDesktopPaths } from "./paths.js";

// Windows 上 path.join 产出反斜杠，断言一律用 join 构造（避免平台差异假失败）
const winLocal = join("C:/Users/x", "AppData", "Local");
const winApp = join(winLocal, "KenFutWork", "data");

describe("桌面数据目录解析（FORM-2）", () => {
  it("LOOMIC_DATA_DIR 显式覆盖优先于平台惯例", () => {
    expect(
      resolveDesktopDataDir({
        env: {
          LOOMIC_DATA_DIR: "D:/custom/data",
          LOCALAPPDATA: winLocal,
        },
        home: "C:/Users/x",
        platform: "win32",
      }),
    ).toBe("D:/custom/data");
  });

  it("Windows 落 %LOCALAPPDATA%\\KenFutWork\\data（cwd 不可信：桌面 exe 从任意目录启动）", () => {
    expect(
      resolveDesktopDataDir({
        env: { LOCALAPPDATA: winLocal },
        home: "C:/Users/x",
        platform: "win32",
      }),
    ).toBe(winApp);
  });

  it("Windows 缺 LOCALAPPDATA 时回退 home/AppData/Local", () => {
    expect(
      resolveDesktopDataDir({ env: {}, home: "C:/Users/x", platform: "win32" }),
    ).toBe(winApp);
  });

  it("macOS 与 Linux 走各自惯例目录（XDG_DATA_HOME 可覆盖）", () => {
    expect(
      resolveDesktopDataDir({ env: {}, home: "/Users/x", platform: "darwin" }),
    ).toBe(join("/Users/x", "Library", "Application Support", "KenFutWork"));

    expect(
      resolveDesktopDataDir({
        env: { XDG_DATA_HOME: "/xdg" },
        home: "/home/x",
        platform: "linux",
      }),
    ).toBe(join("/xdg", "KenFutWork"));

    expect(
      resolveDesktopDataDir({ env: {}, home: "/home/x", platform: "linux" }),
    ).toBe(join("/home/x", ".local", "share", "KenFutWork"));
  });

  it("空串覆盖不生效（`LOOMIC_DATA_DIR=` 等同于未设置）", () => {
    expect(
      resolveDesktopDataDir({
        env: { LOOMIC_DATA_DIR: "   ", LOCALAPPDATA: "C:/L" },
        home: "C:/Users/x",
        platform: "win32",
      }),
    ).toBe(join("C:/L", "KenFutWork", "data"));
  });

  it("派生子路径全部落在数据目录内（blob/集群/日志/口令/插件）", () => {
    const paths = resolveDesktopPaths(join("D:/", "data"));
    expect(paths).toEqual({
      dataDir: join("D:/", "data"),
      blobDir: join("D:/", "data", "blobs"),
      pgDataDir: join("D:/", "data", "postgres"),
      pgLogFile: join("D:/", "data", "logs", "postgres.log"),
      pgPasswordFile: join("D:/", "data", "postgres-password"),
      pluginsDir: join("D:/", "data", "plugins"),
    });
    // 口令文件与集群目录分离：集群目录会被 pg 自己写满，凭据不该混在里面
    expect(paths.pgPasswordFile.startsWith(paths.pgDataDir + sep)).toBe(false);
  });
});
