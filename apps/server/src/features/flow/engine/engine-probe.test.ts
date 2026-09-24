import type { ProviderInstanceResponse } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import {
  createProcessRunCommand,
  decodeCommandText,
  type RunCommand,
} from "./exec.js";
import { probeEnginePaths } from "./probe.js";
import { parseVersion, probeContainerPath } from "./providers/container.js";
import { probeRemotePath } from "./providers/remote.js";
import { parseWslDistros, probeWsl2Path } from "./providers/wsl2.js";

/**
 * 引擎承载路径探测（P6 探测层）的单测。
 *
 * 覆盖三类真实故障面：
 *  ① Windows 的版本 / WSL 安装 / 发行版（含 WSL1-only）四档；
 *  ② 容器运行时的「没装」与「装了但守护进程没起」必须区分（指引不同）；
 *  ③ 平台矩阵的首选与兜底（本地都不可用才轮到「指向自管地址」）。
 */

/** 假命令执行：按 `${file} ${args.join(' ')}` 查表，未命中即「命令不存在」。 */
function fakeRun(
  table: Record<string, { code?: number; stdout?: string; stderr?: string }>,
): RunCommand {
  return async (file, args) => {
    const key = [file, ...args].join(" ");
    const entry = table[key];
    if (!entry)
      return {
        code: 127,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("not found"),
      };
    return {
      code: entry.code ?? 0,
      stdout: Buffer.from(entry.stdout ?? ""),
      stderr: Buffer.from(entry.stderr ?? ""),
    };
  };
}

const WSL_OK = {
  "wsl.exe --status": {
    stdout: "默认版本: 2\n当前计算机配置支持 WSL2。\n内核版本: 5.15.90.1",
  },
  "wsl.exe -l -v": {
    stdout:
      "  NAME      STATE           VERSION\n* Ubuntu    Running         2\n",
  },
};

function difyInstance(overrides: Partial<ProviderInstanceResponse> = {}) {
  return {
    id: "dify-1",
    scope: "system" as const,
    name: "平台 Dify",
    protocol: "dify-engine",
    baseUrl: "http://10.0.0.8:5001",
    hasCredential: true,
    models: [],
    headerKeys: [],
    enabled: true,
    ...overrides,
  } satisfies ProviderInstanceResponse;
}

describe("decodeCommandText（Windows 工具输出解码）", () => {
  it("UTF-16LE 输出（含大量 NUL）按 UTF-16 重解码，不产生乱码", () => {
    const utf16 = Buffer.from("默认版本: 2\nUbuntu  Running  2", "utf16le");
    expect(decodeCommandText(utf16)).toContain("默认版本: 2");
    expect(decodeCommandText(utf16)).toContain("Ubuntu");
  });

  it("UTF-8 输出原样解码，清 BOM", () => {
    expect(decodeCommandText(Buffer.from("\uFEFFDocker version 27.3.1"))).toBe(
      "Docker version 27.3.1",
    );
  });
});

describe("probeWsl2Path（Provider A）", () => {
  it("非 Windows → 不可用，原因指向另外两条路径", async () => {
    const path = await probeWsl2Path({
      platform: "darwin",
      release: "23.6.0",
      run: fakeRun({}),
    });
    expect(path).toMatchObject({ id: "wsl2", available: false });
    expect(path.reason).toContain("仅 Windows");
  });

  it("Windows 版本过低（build < 19041）→ 不可用，点名版本要求", async () => {
    const path = await probeWsl2Path({
      platform: "win32",
      release: "10.0.17763",
      run: fakeRun(WSL_OK),
    });
    expect(path.available).toBe(false);
    expect(path.reason).toContain("19041");
  });

  it("WSL 未安装（--status 非零退出）→ 不可用，指引 wsl --install 并带系统提示", async () => {
    const path = await probeWsl2Path({
      platform: "win32",
      release: "10.0.26200",
      run: fakeRun({
        "wsl.exe --status": { code: 1, stderr: "WSL 内核文件不存在" },
      }),
    });
    expect(path.available).toBe(false);
    expect(path.reason).toContain("wsl --install");
    expect(path.reason).toContain("WSL 内核文件不存在");
  });

  it("WSL2 可用但无发行版 → 不可用，指引安装发行版", async () => {
    const path = await probeWsl2Path({
      platform: "win32",
      release: "10.0.26200",
      run: fakeRun({
        "wsl.exe --status": WSL_OK["wsl.exe --status"],
        "wsl.exe -l -v": { stdout: "  NAME      STATE           VERSION\n" },
      }),
    });
    expect(path.available).toBe(false);
    expect(path.reason).toContain("wsl --install -d");
  });

  it("只有 WSL1 发行版 → 不可用，指引切默认版本", async () => {
    const path = await probeWsl2Path({
      platform: "win32",
      release: "10.0.26200",
      run: fakeRun({
        "wsl.exe --status": WSL_OK["wsl.exe --status"],
        "wsl.exe -l -v": {
          stdout:
            "  NAME      STATE           VERSION\n* Ubuntu    Stopped         1\n",
        },
      }),
    });
    expect(path.available).toBe(false);
    expect(path.reason).toContain("WSL1");
    expect(path.reason).toContain("--set-default-version 2");
  });

  it("WSL2 发行版就绪 → 可用，detail 带发行版名与状态", async () => {
    const path = await probeWsl2Path({
      platform: "win32",
      release: "10.0.26200",
      run: fakeRun(WSL_OK),
    });
    expect(path.available).toBe(true);
    expect(path.detail).toContain("Ubuntu");
  });

  it("只有 Docker Desktop 的内部发行版 → 不可用（真机实测踩到：那是 Docker 自管的，不是通用发行版）", async () => {
    const path = await probeWsl2Path({
      platform: "win32",
      release: "10.0.26200",
      run: fakeRun({
        "wsl.exe --status": WSL_OK["wsl.exe --status"],
        "wsl.exe -l -v": {
          stdout:
            "  NAME                 STATE           VERSION\n* docker-desktop       Stopped         2\n  docker-desktop-data  Stopped         2\n",
        },
      }),
    });
    expect(path.available).toBe(false);
    expect(path.reason).toContain("Docker Desktop 的内部发行版");
    expect(path.reason).toContain("wsl --install -d");
  });

  it("内部发行版与通用发行版并存 → 通用发行版可用（不被内部发行版干扰）", async () => {
    const path = await probeWsl2Path({
      platform: "win32",
      release: "10.0.26200",
      run: fakeRun({
        "wsl.exe --status": WSL_OK["wsl.exe --status"],
        "wsl.exe -l -v": {
          stdout:
            "  NAME              STATE           VERSION\n* docker-desktop    Stopped         2\n  Ubuntu            Running         2\n",
        },
      }),
    });
    expect(path.available).toBe(true);
    expect(path.detail).toContain("Ubuntu");
  });

  it("parseWslDistros：跳表头、容忍 * 前缀与多空格", () => {
    expect(
      parseWslDistros(
        "  NAME      STATE           VERSION\n* Ubuntu    Running         2\n  Debian    Stopped         1\n",
      ),
    ).toEqual([
      { name: "Ubuntu", state: "Running", version: 2 },
      { name: "Debian", state: "Stopped", version: 1 },
    ]);
  });
});

describe("probeContainerPath（Provider B）", () => {
  it("Docker 就绪（含 compose）→ 可用，detail 带版本", async () => {
    const path = await probeContainerPath({
      platform: "linux",
      run: fakeRun({
        "docker --version": { stdout: "Docker version 27.3.1, build ce12230" },
        "docker info --format {{.ServerVersion}}": { stdout: "27.3.1\n" },
        "docker compose version --short": { stdout: "v2.30.3\n" },
      }),
    });
    expect(path.available).toBe(true);
    expect(path.detail).toContain("27.3.1");
    expect(path.detail).toContain("2.30.3");
  });

  it("装了 Docker CLI 但守护进程不可达 → 不可用，指引启动运行时（三平台文案各异）", async () => {
    const table = {
      "docker --version": { stdout: "Docker version 27.3.1, build ce12230" },
      "docker info --format {{.ServerVersion}}": {
        code: 1,
        stderr: "Cannot connect to the Docker daemon",
      },
      "podman --version": { code: 127 },
    };
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const path = await probeContainerPath({ platform, run: fakeRun(table) });
      expect(path.available).toBe(false);
      expect(path.reason).toContain("守护进程不可达");
    }
    expect(
      (await probeContainerPath({ platform: "darwin", run: fakeRun(table) }))
        .reason,
    ).toContain("Colima");
  });

  it("Docker 缺席时回落 Podman；都没有 → 不可用且按平台给安装指引", async () => {
    const podman = await probeContainerPath({
      platform: "linux",
      run: fakeRun({
        "docker --version": { code: 127 },
        "podman --version": { stdout: "podman version 5.2.0" },
        "podman info --format {{.ServerVersion}}": { code: 1 },
      }),
    });
    expect(podman.available).toBe(false);
    expect(podman.reason).toContain("Podman");

    const none = await probeContainerPath({
      platform: "win32",
      run: fakeRun({}),
    });
    expect(none.available).toBe(false);
    expect(none.reason).toContain("未检测到 Docker / Podman");
  });

  it("Podman 就绪 → 可用", async () => {
    const path = await probeContainerPath({
      platform: "linux",
      run: fakeRun({
        "docker --version": { code: 127 },
        "podman --version": { stdout: "podman version 5.2.0" },
        "podman info --format {{.ServerVersion}}": { stdout: "5.2.0\n" },
      }),
    });
    expect(path.available).toBe(true);
    expect(path.detail).toContain("Podman 5.2.0");
  });

  it("parseVersion：从 `Docker version x.y.z, build …` 取版本号", () => {
    expect(parseVersion("Docker version 27.3.1, build ce12230")).toBe("27.3.1");
    expect(parseVersion("podman version 5.2.0")).toBe("5.2.0");
    expect(parseVersion("什么也没有")).toBe("unknown");
  });
});

describe("probeRemotePath（Provider C）", () => {
  it("平台池有启用的 dify-engine 实例 → 可用，detail 带来源", async () => {
    const path = await probeRemotePath({
      listSystemInstances: async () => [difyInstance()],
    });
    expect(path.available).toBe(true);
    expect(path.detail).toContain("平台 Dify");
  });

  it("未配置 / 只有禁用的实例 / 查询抛错 → 不可用，指路管理后台", async () => {
    for (const deps of [
      { listSystemInstances: async () => [] },
      { listSystemInstances: async () => [difyInstance({ enabled: false })] },
      {
        listSystemInstances: async () => {
          throw new Error("db down");
        },
      },
    ]) {
      const path = await probeRemotePath(deps);
      expect(path.available).toBe(false);
      expect(path.reason).toContain("管理后台");
    }
  });
});

describe("probeEnginePaths（平台矩阵聚合）", () => {
  const readyDocker = {
    "docker --version": { stdout: "Docker version 27.3.1" },
    "docker info --format {{.ServerVersion}}": { stdout: "27.3.1" },
    "docker compose version --short": { stdout: "v2.30.3" },
  };

  it("Windows：WSL2 与容器都可用 → 推荐 WSL2（免 Docker Desktop 授权约束）", async () => {
    const run = fakeRun({ ...WSL_OK, ...readyDocker });
    const report = await probeEnginePaths({
      platform: "win32",
      release: "10.0.26200",
      run,
      listSystemInstances: async () => [],
    });
    expect(report.recommended).toBe("wsl2");
    expect(report.paths.map((p) => p.id)).toEqual([
      "wsl2",
      "container",
      "remote",
    ]);
  });

  it("Windows：WSL2 不可用但容器可用 → 推荐容器（不因首选缺席而空推荐）", async () => {
    const report = await probeEnginePaths({
      platform: "win32",
      release: "10.0.26200",
      run: fakeRun(readyDocker),
      listSystemInstances: async () => [],
    });
    expect(report.recommended).toBe("container");
  });

  it("Linux：只看容器；本地不可用但配了自管地址 → 兜底推荐 remote", async () => {
    const report = await probeEnginePaths({
      platform: "linux",
      release: "6.8.0",
      run: fakeRun({}),
      listSystemInstances: async () => [difyInstance()],
    });
    expect(report.recommended).toBe("remote");
    const container = report.paths.find((p) => p.id === "container");
    expect(container?.available).toBe(false);
  });

  it("全不可用 → recommended 为 null（界面据此引导安装，不放空推荐）", async () => {
    const report = await probeEnginePaths({
      platform: "darwin",
      release: "23.6.0",
      run: fakeRun({}),
      listSystemInstances: async () => [],
    });
    expect(report.recommended).toBeNull();
    expect(report.paths.every((path) => !path.available)).toBe(true);
  });
});

describe("createProcessRunCommand（真实执行器）", () => {
  it("命令不存在 → 非零码 + stderr 带原因（不抛异常，探测据此给可读原因）", async () => {
    const run = createProcessRunCommand({ timeoutMs: 3000 });
    const result = await run("kenfutwork-definitely-missing-binary", [
      "--version",
    ]);
    expect(result.code).not.toBe(0);
    expect(decodeCommandText(result.stderr).length).toBeGreaterThan(0);
  });
});
