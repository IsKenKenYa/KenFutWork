import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  hasSystemGit,
  prependRuntimePath,
  resolveRuntime,
  resolveRuntimes,
  runtimeEnvAdditions,
} from "./runtimes.js";

/**
 * 回归背景：桌面包是 Node SEA 单 exe，agent 的 execute 跑在宿主机上——用户机器
 * 没装 Node/Python/JDK 时相关任务全不可用。用户要求把三者随包分发，这里锁
 * 「运行时目录怎么找」与「PATH 怎么注入」。
 */
function fakeFs(present: string[]) {
  return (path: string) => present.includes(path);
}

describe("运行时目录解析", () => {
  it("发布包布局：<exeDir>/runtime/<node|python|uv|jdk>/… 命中即可用", () => {
    const app = join("C:", "app");
    const present = [
      join(app, "runtime", "node", "node.exe"),
      join(app, "runtime", "python", "python.exe"),
      join(app, "runtime", "uv", "uvx.exe"),
      join(app, "runtime", "jdk", "bin", "java.exe"),
    ];
    const resolved = resolveRuntimes({
      env: {},
      exeDir: app,
      exists: fakeFs(present),
    });
    expect(resolved.bundled).toEqual(["node", "python", "uv", "java"]);
    expect(resolved.pathAdditions).toEqual([
      join(app, "runtime", "node"),
      join(app, "runtime", "python"),
      join(app, "runtime", "uv"),
      join(app, "runtime", "jdk", "bin"),
    ]);
    // JDK 的 JAVA_HOME 指向运行时根（不是 bin）
    expect(resolved.javaHome).toBe(join(app, "runtime", "jdk"));
  });

  it("未捆绑：返回 null 且不抛错（宿主自带运行时仍可用，属增强项）", () => {
    const resolved = resolveRuntimes({
      env: {},
      exeDir: "C:/app",
      exists: () => false,
    });
    expect(resolved.roots).toEqual([]);
    expect(resolved.bundled).toEqual([]);
    expect(resolved.javaHome).toBeUndefined();
    expect(
      resolveRuntime("python", {
        env: {},
        exeDir: "C:/app",
        exists: () => false,
      }),
    ).toBeNull();
  });

  it("部分捆绑：缺失的运行时既不进 PATH 也不报错", () => {
    const app = join("C:", "app");
    const resolved = resolveRuntimes({
      env: {},
      exeDir: app,
      exists: fakeFs([join(app, "runtime", "node", "node.exe")]),
    });
    expect(resolved.bundled).toEqual(["node"]);
    expect(resolved.pathAdditions).toEqual([join(app, "runtime", "node")]);
    expect(resolved.javaHome).toBeUndefined();
  });

  it("显式环境变量优先于包内目录", () => {
    const portable = join("D:", "portable-node");
    const app = join("C:", "app");
    const root = resolveRuntime("node", {
      env: { KENFUTWORK_NODE_BIN_DIR: portable },
      exeDir: app,
      exists: fakeFs([
        join(portable, "node.exe"),
        join(app, "runtime", "node", "node.exe"),
      ]),
    });
    expect(root?.binDir).toBe(portable);
    expect(root?.homeDir).toBe(portable);
  });

  it("显式环境变量指向错误目录：fail loud（不静默回落宿主运行时）", () => {
    expect(() =>
      resolveRuntime("java", {
        env: { KENFUTWORK_JAVA_BIN_DIR: join("D:", "empty") },
        exeDir: "C:/app",
        exists: () => false,
      }),
    ).toThrow(/KENFUTWORK_JAVA_BIN_DIR/);
  });

  it("JAVA_HOME 推导：bin 目录覆盖式显式配置时回到运行时根", () => {
    const jdkBin = join("D:", "jdk-21", "bin");
    const root = resolveRuntime("java", {
      env: { KENFUTWORK_JAVA_BIN_DIR: jdkBin },
      exeDir: join("C:", "app"),
      exists: fakeFs([join(jdkBin, "java.exe")]),
    });
    expect(root?.binDir).toBe(jdkBin);
    expect(root?.homeDir).toBe(join("D:", "jdk-21"));
  });
});

describe("PATH 注入", () => {
  it("前置且去重；空 PATH 也能工作", () => {
    expect(
      prependRuntimePath("C:/Windows;C:/tools", ["C:/app/runtime/node"]),
    ).toBe("C:/app/runtime/node;C:/Windows;C:/tools");

    // 已在 PATH 中则不重复添加
    expect(
      prependRuntimePath("C:/app/runtime/node;C:/Windows", [
        "C:/app/runtime/node",
      ]),
    ).toBe("C:/app/runtime/node;C:/Windows");

    expect(prependRuntimePath(undefined, ["A"])).toBe("A");
    expect(prependRuntimePath("", ["A", "B"])).toBe("A;B");
  });
});

describe("sandbox env 片段", () => {
  /**
   * 回归背景（实测）：Windows 上 `uv venv --python python` 在只给运行时 PATH 时
   * 报「No interpreter found」——uv / npx 这类工具自己扫 PATH，靠 PATHEXT 把
   * `python` 匹配到 `python.exe`。sandbox env 不带 PATHEXT 时，随包 Python 形同不存在。
   */
  it("Windows：PATH 前置 + JAVA_HOME + PATHEXT 透传", () => {
    const env = runtimeEnvAdditions({
      runtimePathAdditions: ["D:/app/runtime/python", "D:/app/runtime/jdk/bin"],
      javaHome: "D:/app/runtime/jdk",
      platform: "win32",
      basePath: "C:/Windows",
      pathext: ".COM;.EXE;.BAT",
    });
    expect(env.PATH).toBe(
      "D:/app/runtime/python;D:/app/runtime/jdk/bin;C:/Windows",
    );
    expect(env.JAVA_HOME).toBe("D:/app/runtime/jdk");
    expect(env.PATHEXT).toBe(".COM;.EXE;.BAT");
  });

  it("POSIX：分隔符为冒号，且不注入 PATHEXT", () => {
    const env = runtimeEnvAdditions({
      runtimePathAdditions: ["/opt/rt/python"],
      platform: "linux",
      basePath: "/usr/bin",
      pathext: ".COM;.EXE",
    });
    expect(env.PATH).toBe("/opt/rt/python:/usr/bin");
    expect(env.PATHEXT).toBeUndefined();
    expect(env.JAVA_HOME).toBeUndefined();
  });

  it("未捆绑运行时：PATH 原样返回，不产生空条目", () => {
    const env = runtimeEnvAdditions({
      platform: "win32",
      basePath: "C:/Windows",
      pathext: ".EXE",
    });
    expect(env.PATH).toBe("C:/Windows");
  });
});

/**
 * Git 的解析口径与其余运行时**相反**：用户要求 git 优先用宿主自带的，打包的只作兜底
 * （python/node/jdk 才是随包优先）。这里锁住这个优先级，避免「打包目录一前置就把本地
 * git 顶掉」。
 */
describe("git 运行时的优先级（本地优先，打包兜底；Windows 桌面场景）", () => {
  // 这些用例的 PATH/可执行体都是 Windows 形态：统一把平台 mock 成 win32
  const realPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  afterAll(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
  });
  const app = join("C:", "app");
  const bundledGit = join(app, "runtime", "git", "cmd", "git.exe");

  it("宿主 PATH 里有 git.exe → 不注入打包 git", () => {
    expect(
      hasSystemGit({
        path: ["C:/Windows", "C:/Program Files/Git/cmd"].join(";"),
        exists: fakeFs([join("C:/Program Files/Git/cmd", "git.exe")]),
      }),
    ).toBe(true);

    const resolved = resolveRuntimes({
      env: {},
      exeDir: app,
      exists: fakeFs([bundledGit, join("C:/Program Files/Git/cmd", "git.exe")]),
      systemPath: "C:/Program Files/Git/cmd",
    });
    expect(resolved.bundled).not.toContain("git");
    expect(resolved.pathAdditions).not.toContain(
      join(app, "runtime", "git", "cmd"),
    );
  });

  it("宿主没有 git → 注入打包 git（cmd/ 布局）", () => {
    const resolved = resolveRuntimes({
      env: {},
      exeDir: app,
      exists: fakeFs([bundledGit]),
      systemPath: "C:/Windows;C:/Windows/System32",
    });
    expect(resolved.bundled).toContain("git");
    expect(resolved.pathAdditions).toContain(
      join(app, "runtime", "git", "cmd"),
    );
  });

  it("显式 KENFUTWORK_GIT_BIN_DIR 时不受「本地有 git」影响（显式覆盖优先）", () => {
    const explicit = join("D:", "portable-git");
    const resolved = resolveRuntimes({
      env: { KENFUTWORK_GIT_BIN_DIR: explicit },
      exeDir: app,
      exists: fakeFs([join(explicit, "git.exe")]),
      systemPath: "C:/Program Files/Git/cmd",
    });
    expect(resolved.bundled).toContain("git");
    expect(resolved.pathAdditions).toContain(explicit);
  });

  it("hasSystemGit 的边界：空 PATH / 空段 / 只认可执行体", () => {
    expect(hasSystemGit({ path: undefined, exists: () => true })).toBe(false);
    expect(hasSystemGit({ path: "", exists: () => true })).toBe(false);
    // 空段（连续分隔符）不该被当成根目录去命中
    expect(hasSystemGit({ path: ";;", exists: () => true })).toBe(false);
    // 目录存在但里面没有 git.exe → 仍算没有
    expect(hasSystemGit({ path: "C:/Git", exists: fakeFs([]) })).toBe(false);
    // 只认「该目录下有 git.exe」，不认同名的目录
    expect(
      hasSystemGit({
        path: "C:/Git",
        exists: fakeFs([join("C:/Git", "git.exe")]),
      }),
    ).toBe(true);
  });
});

describe("hasSystemGit 平台探测（回归：POSIX 不能用 Windows 参数）", () => {
  it("POSIX：PATH 用 `:` 分隔、可执行体是 git（不再写死 git.exe 与 `;`）", () => {
    const posixPath = "/usr/bin:/opt/homebrew/bin:/usr/local/bin";
    expect(
      hasSystemGit({
        path: posixPath,
        separator: ":",
        executable: "git",
        exists: (p) => p === "/opt/homebrew/bin/git",
      }),
    ).toBe(true);
    // 平台默认值：POSIX 上不传 separator/executable 也应探测成功
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(
        hasSystemGit({
          path: posixPath,
          exists: (p) => p === "/opt/homebrew/bin/git",
        }),
      ).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
    }
  });

  it("Windows：PATH 用 `;` 分隔、可执行体是 git.exe（行为不变）", () => {
    const winPath = "C:\\Windows;C:\\tools\\git\\cmd";
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    // exists 收到的路径分隔符形态随 join 的平台而变：比较前统一成正斜杠
    const norm = (p: string) => p.replaceAll("\\", "/");
    try {
      expect(
        hasSystemGit({
          path: winPath,
          exists: (p) => norm(p) === "C:/tools/git/cmd/git.exe",
        }),
      ).toBe(true);
      expect(hasSystemGit({ path: winPath, exists: () => false })).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
    }
  });
});
