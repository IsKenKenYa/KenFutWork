import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveDataLocationPointerFile,
  resolveDesktopConfigDir,
  resolveDesktopDataDir,
  resolveDesktopPaths,
} from "./paths.js";

// Windows 上 path.join 产出反斜杠，断言一律用 join 构造（避免平台差异假失败）
const winLocal = join("C:/Users/x", "AppData", "Roaming");
const winApp = join(winLocal, "com.kenfutwork.desktop", "data");

describe("桌面数据目录解析（FORM-2）", () => {
  it("KENFUTWORK_DATA_DIR 显式覆盖优先于平台惯例", () => {
    expect(
      resolveDesktopDataDir({
        env: {
          KENFUTWORK_DATA_DIR: "D:/custom/data",
          APPDATA: winLocal,
        },
        home: "C:/Users/x",
        platform: "win32",
      }),
    ).toBe("D:/custom/data");
  });

  it("Windows 与Tauri同走APPDATA/com.kenfutwork.desktop/data", () => {
    expect(
      resolveDesktopDataDir({
        env: { APPDATA: winLocal },
        home: "C:/Users/x",
        platform: "win32",
      }),
    ).toBe(winApp);
  });

  it("Windows 缺APPDATA时回退home/AppData/Roaming", () => {
    expect(
      resolveDesktopDataDir({ env: {}, home: "C:/Users/x", platform: "win32" }),
    ).toBe(winApp);
  });

  it("macOS 与 Linux 走各自惯例目录（XDG_DATA_HOME 可覆盖）", () => {
    expect(
      resolveDesktopDataDir({ env: {}, home: "/Users/x", platform: "darwin" }),
    ).toBe(
      join(
        "/Users/x",
        "Library",
        "Application Support",
        "com.kenfutwork.desktop",
        "data",
      ),
    );

    expect(
      resolveDesktopDataDir({
        env: { XDG_DATA_HOME: "/xdg" },
        home: "/home/x",
        platform: "linux",
      }),
    ).toBe(join("/xdg", "com.kenfutwork.desktop", "data"));

    expect(
      resolveDesktopDataDir({ env: {}, home: "/home/x", platform: "linux" }),
    ).toBe(
      join("/home/x", ".local", "share", "com.kenfutwork.desktop", "data"),
    );
  });

  it("空串覆盖不生效（`KENFUTWORK_DATA_DIR=` 等同于未设置）", () => {
    expect(
      resolveDesktopDataDir({
        env: { KENFUTWORK_DATA_DIR: "   ", APPDATA: "C:/L" },
        home: "C:/Users/x",
        platform: "win32",
      }),
    ).toBe(join("C:/L", "com.kenfutwork.desktop", "data"));
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
      credentialSecretFile: join("D:/", "data", "credential-secret"),
      checkpointDir: join("D:/", "data", "checkpoints"),
      sandboxDir: join("D:/", "data", "sandbox"),
      credentialsDir: join("D:/", "data", "credentials"),
      agentFilesDir: join("D:/", "data", "sandbox", "agent-files"),
      indexDir: join("D:/", "data", "index"),
      browserDir: join("D:/", "data", "browser"),
    });
    // 口令文件与集群目录分离：集群目录会被 pg 自己写满，凭据不该混在里面
    expect(paths.pgPasswordFile.startsWith(paths.pgDataDir + sep)).toBe(false);
  });

  it("自定义位置由外部系统配置指针读取，env覆盖优先；损坏配置拒绝启动", () => {
    const input = { env: {}, home: "/Users/x", platform: "darwin" as const };
    expect(resolveDataLocationPointerFile(input)).toBe(
      join(resolveDesktopConfigDir(input), "data-location.json"),
    );
    expect(
      resolveDesktopDataDir({
        ...input,
        readPointer: () => JSON.stringify({ dataDir: "/external/data" }),
      }),
    ).toBe("/external/data");
    expect(
      resolveDesktopDataDir({
        ...input,
        env: { KENFUTWORK_DATA_DIR: "/override" },
        readPointer: () => {
          throw new Error("不应读取");
        },
      }),
    ).toBe("/override");
    expect(() =>
      resolveDesktopDataDir({
        ...input,
        readPointer: () => JSON.stringify({ dataDir: "relative" }),
      }),
    ).toThrow("绝对路径");
    expect(
      resolveDataLocationPointerFile(input).startsWith(
        resolveDesktopDataDir(input) + sep,
      ),
    ).toBe(false);
  });

  it.each(["D:\\custom\\data", "\\\\host\\share\\data"])(
    "Windows绝对目录%s在指针和env采用相同规则，不依赖运行测试的操作系统",
    (dataDir) => {
      const input = { env: {}, platform: "win32" as const, home: "C:/Users/x" };
      expect(
        resolveDesktopDataDir({
          ...input,
          readPointer: () => JSON.stringify({ dataDir }),
        }),
      ).toBe(dataDir);
      expect(
        resolveDesktopDataDir({
          ...input,
          env: { KENFUTWORK_DATA_DIR: dataDir },
        }),
      ).toBe(dataDir);
    },
  );

  it.each(["relative", "C:relative", ""])(
    "相对或空的显式目录%s不能成为数据或配置根",
    (value) => {
      for (const platform of ["darwin", "win32"] as const) {
        if (value)
          expect(() =>
            resolveDesktopDataDir({
              env: { KENFUTWORK_DATA_DIR: value },
              platform,
            }),
          ).toThrow("绝对路径");
        if (value)
          expect(() =>
            resolveDesktopConfigDir({
              env: { KENFUTWORK_CONFIG_DIR: value },
              platform,
            }),
          ).toThrow("绝对路径");
        expect(() =>
          resolveDesktopDataDir({
            env: {},
            platform,
            readPointer: () => JSON.stringify({ dataDir: value }),
          }),
        ).toThrow("绝对路径");
      }
    },
  );

  it("真实系统配置文件可定位已移动的数据，损坏内容保留并拒绝静默回退", () => {
    const configDir = mkdtempSync(join(tmpdir(), "kfw-data-pointer-"));
    const input = {
      env: { KENFUTWORK_CONFIG_DIR: configDir },
      platform: "darwin" as const,
      home: "/fixture-home",
    };
    const pointer = resolveDataLocationPointerFile(input);
    try {
      writeFileSync(pointer, JSON.stringify({ dataDir: "/moved/data" }));
      expect(resolveDesktopDataDir(input)).toBe("/moved/data");
      for (const bad of [
        "not-json",
        "null",
        "{}",
        JSON.stringify({ dataDir: 42 }),
      ]) {
        writeFileSync(pointer, bad);
        expect(() => resolveDesktopDataDir(input)).toThrow();
        expect(readFileSync(pointer, "utf8")).toBe(bad);
      }
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
