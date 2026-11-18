import type { FlowEnginePath } from "@kenfutwork/shared";

import { decodeCommandText, type RunCommand } from "../exec.js";

/**
 * Provider B：本机容器承载（《flow 集成方案》§3.5.1）。
 *
 * 只做**探测**：优先 Docker（`docker --version` + 守护进程可达性），退而 Podman。
 * 守护进程不可达与「没装」是两种不同的不可用——前者提示启动运行时，后者提示安装，
 * 混在一起会让用户照错的指引操作。
 *
 * macOS 说明：Colima / OrbStack / Rancher Desktop 都提供 Docker 兼容接口，统一走这条；
 * macOS 没有原生容器（Darwin 内核），不检测「原生」这一档（§3.5.1 平台矩阵写死）。
 */
export async function probeContainerPath(deps: {
  platform: NodeJS.Platform;
  run: RunCommand;
}): Promise<FlowEnginePath> {
  const base = { id: "container" as const, label: "本机容器" };

  const docker = await probeRuntime(deps.run, "docker");
  if (docker.state === "ready") {
    return {
      ...base,
      available: true,
      detail: `Docker ${docker.cliVersion}${docker.serverVersion ? `（守护进程 ${docker.serverVersion}）` : ""}${docker.composeVersion ? `，compose ${docker.composeVersion}` : ""}`,
    };
  }
  if (docker.state === "daemon-down") {
    return {
      ...base,
      available: false,
      reason:
        "已装 Docker CLI 但守护进程不可达：请启动运行时" +
        (deps.platform === "darwin"
          ? "（macOS 推荐 Colima：`brew install colima && colima start`，或启动 Docker Desktop / OrbStack）。"
          : deps.platform === "win32"
            ? "（启动 Docker Desktop 或 Podman Desktop）。"
            : "（`sudo systemctl start docker`）。"),
    };
  }

  const podman = await probeRuntime(deps.run, "podman");
  if (podman.state === "ready") {
    return {
      ...base,
      available: true,
      detail: `Podman ${podman.cliVersion}${podman.serverVersion ? `（${podman.serverVersion}）` : ""}`,
    };
  }
  if (podman.state === "daemon-down") {
    return {
      ...base,
      available: false,
      reason: "已装 Podman 但容器服务不可达：请启动 Podman 机器/服务后重试。",
    };
  }

  return {
    ...base,
    available: false,
    reason:
      deps.platform === "darwin"
        ? "未检测到 Docker / Podman。macOS 需要容器运行时（推荐 Colima：`brew install colima && colima start`）。"
        : deps.platform === "win32"
          ? "未检测到 Docker / Podman（本机容器是「用户已有就复用」的路径；也可选 WSL2 或指向自管地址）。"
          : "未检测到 Docker / Podman：请安装原生 Docker / Podman（Linux 是唯一不需要虚拟机的平台）。",
  };
}

interface RuntimeProbe {
  state: "missing" | "daemon-down" | "ready";
  cliVersion?: string;
  serverVersion?: string;
  composeVersion?: string;
}

async function probeRuntime(
  run: RunCommand,
  binary: "docker" | "podman",
): Promise<RuntimeProbe> {
  const cli = await run(binary, ["--version"]);
  if (cli.code !== 0) return { state: "missing" };
  const cliVersion = parseVersion(decodeCommandText(cli.stdout));

  // 守护进程可达性：`<runtime> info` 能答即就绪（挂住由 run 的超时兜底）。
  const info = await run(binary, ["info", "--format", "{{.ServerVersion}}"]);
  if (info.code !== 0) return { state: "daemon-down", cliVersion };
  const serverVersion = decodeCommandText(info.stdout).replace(/^v/, "");

  let composeVersion: string | undefined;
  if (binary === "docker") {
    const compose = await run("docker", ["compose", "version", "--short"]);
    if (compose.code === 0) {
      composeVersion = decodeCommandText(compose.stdout).replace(/^v/, "");
    }
  }

  return {
    state: "ready",
    cliVersion,
    ...(serverVersion ? { serverVersion } : {}),
    ...(composeVersion ? { composeVersion } : {}),
  };
}

/** `Docker version 27.3.1, build ...` / `podman version 5.2.0` → `27.3.1`。 */
export function parseVersion(text: string): string {
  const match = text.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match?.[1] ?? "unknown";
}
