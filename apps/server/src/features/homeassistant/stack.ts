import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveExecutable } from "../../utils/resolve-executable.js";
import {
  createProcessRunCommand,
  type RunCommand,
} from "../flow/engine/exec.js";

/**
 * Home Assistant **自带实例**的供给层（用户口径 2026-11-06：「不应该让用户手动配置」）。
 *
 * 为什么要它：`specs/ha-zero-config.md` 原先写死「不由产品自带或拉起 HA 实例」，
 * 于是「装上即用」的最后一公里仍归用户——删掉容器后没有任何东西把它建回来，插件
 * 只能如实报「HA 地址不可达」（本机实测：docker 0 容器，`auto-init` 因库里还留着
 * 旧配置而谎报 ok）。这条约束已按用户口径反转，反转记录见该 spec 与《日志》。
 *
 * 三条边界都不越：
 * - **只在桌面形态**拉起（服务端与用户同机）；自托管 / Web 的 HA 仍归用户自己管，
 *   在别人的服务器上弹容器不是本机接入的语义；
 * - **8123 上已有 HA 应答就不新建**：用户自建的实例优先，绝不抢、绝不并排建第二台；
 * - 容器名与配置目录都在应用数据目录下，卸载按 flow 引擎栈同一口径清理。
 *
 * 面板内嵌要求 `use_x_frame_options: false`，免登录签令牌要求 `trusted_networks`
 * 覆盖回环与 docker 网桥段（历史踩坑：来源 IP 是 `172.17.0.1` 而不是 127.0.0.1）。
 * 这两项写进我们自己的配置目录，用户改过的 `configuration.yaml` 不覆盖。
 */

/** 官方镜像（Apache-2.0，容器内自带依赖，不由我们分发）。 */
export const HA_IMAGE = "ghcr.io/home-assistant/home-assistant:stable";
/** 我们托管的容器名：判据靠它，卸载也按它找。 */
export const HA_CONTAINER_NAME = "kenfutwork-ha";
/**
 * 与 `plugins/ha/lib/auto-init.js` 的 `HA_LOOPBACK_BASE_URL` 同值。
 * 插件 bundle 独立分发、不能 import 服务端模块，所以两处各自声明；
 * `stack.test.ts` 钉住端口映射，改一处必得同步另一处。
 */
export const HA_HOST_PORT = 8123;
/** 配置目录（在应用数据目录下，随实例走）。 */
export const HA_CONFIG_DIR_NAME = "homeassistant";

export interface HaProvisionPlanInput {
  /** 桌面形态（服务端与用户同机）：非桌面一律不动用户的机器。 */
  desktop: boolean;
  /** 本机有可用的容器运行时（docker 守护进程可达）。 */
  carrierAvailable: boolean;
  /** 我们托管的容器已存在（任何状态，含 Exited）：幂等，不重复拉起。 */
  managedContainerPresent: boolean;
  /** 8123 上已有 HA 应答（用户自建实例优先）。 */
  haAlreadyAnswering: boolean;
}

/**
 * 自动拉起判据：四条都过才动用户的机器。
 *
 * 顺序是刻意的两条：
 * - 「我们的托管容器」排在「8123 有人应答」前面——否则重启后日志会把**自己**拉起的
 *   容器说成「沿用用户自建实例」（本机实测踩过），用户照着这句话去查自己那台 HA 就白找了；
 * - 「有人应答」排在「运行时可用」前面——用户自建实例绝不会被我们的 docker 状态顶掉。
 */
export function planHaAutoProvision(
  input: HaProvisionPlanInput,
): { action: "provision" } | { action: "skip"; reason: string } {
  if (!input.desktop) {
    return { action: "skip", reason: "非桌面形态：不在别人的服务器上建实例" };
  }
  if (input.managedContainerPresent) {
    return { action: "skip", reason: "托管容器已在（含已停止），不重复拉起" };
  }
  if (input.haAlreadyAnswering) {
    return {
      action: "skip",
      reason: "8123 上已有 HA 在应答（本产品托管之外的实例），沿用不新建",
    };
  }
  if (!input.carrierAvailable) {
    return {
      action: "skip",
      reason: "本机没有可用的容器运行时（启动 Docker Desktop / Podman 后重试）",
    };
  }
  return { action: "provision" };
}

/** 首次拉起写入的配置：面板内嵌 + 免登录签令牌两项前置条件。 */
export function haConfigurationYaml(): string {
  return [
    "# KenFutWork 自带 Home Assistant 实例的配置。",
    "# use_x_frame_options=false：智能家居面板以 iframe 内嵌 HA 原生界面，",
    "# 默认 DENY 会让面板空白（真机踩过）。",
    "http:",
    "  use_x_frame_options: false",
    "  trusted_networks:",
    "    - 127.0.0.1",
    "    - ::1",
    "    # 宿主服务端经 docker 网桥访问时来源 IP 是网桥段，不是回环（历史踩坑）。",
    "    - 172.16.0.0/12",
    "    - 192.168.0.0/16",
    "",
  ].join("\n");
}

/**
 * 准备配置目录并返回宿主侧路径。
 * 已有 `configuration.yaml` 一律不动——那是用户改过的文件。
 */
export function ensureHaConfigDir(dataDir: string): string {
  const configDir = join(dataDir, HA_CONFIG_DIR_NAME);
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, "configuration.yaml");
  if (!existsSync(file)) writeFileSync(file, haConfigurationYaml(), "utf8");
  return configDir;
}

/**
 * 8123 上是不是已经有 HA 在应答。
 *
 * **任何 HTTP 应答都算**，不看状态码：未授权的 HA 对 `GET /api/` 回 401（本机新容器
 * 实测如此，`specs/ha-zero-config.md` 验收标准第 2 条也把 `/api/` 401 当作「已存在 HA」
 * 的签名），按 2xx 判会把用户自建实例读成「没人」，接着去抢同一个端口。
 * 连接失败 / 超时才算没有。
 */
export async function isHomeAssistantAnswering(
  deps: {
    fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
    port?: number;
  } = {},
): Promise<boolean> {
  const call =
    deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  try {
    await call(`http://127.0.0.1:${deps.port ?? HA_HOST_PORT}/api/`, {
      method: "GET",
      // 一次性局部常量：探活预算，不是治理值（探不到就按「没有 HA」处理）。
      signal: AbortSignal.timeout(3_000),
    });
    return true;
  } catch {
    return false;
  }
}

/** 我们托管的容器是否已存在（`docker ps -a` 按名字过滤，含 Exited）。 */
export async function hasManagedHaContainer(run: RunCommand): Promise<boolean> {
  const result = await run("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^/${HA_CONTAINER_NAME}$`,
    "--format",
    "{{.Names}}",
  ]);
  return result.code === 0 && result.stdout.toString("utf8").trim() !== "";
}

/** 本机有没有可用的容器运行时（docker 守护进程可达）。 */
export async function hasContainerRuntime(run: RunCommand): Promise<boolean> {
  const result = await run("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  return result.code === 0;
}

/** `docker run` 的参数（导出给测试逐字钉住：端口只绑回环、重启策略、配置挂载）。 */
export function haRunArguments(configDir: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    HA_CONTAINER_NAME,
    // 机器重启后自己回来：装上即用不是一次性的。
    "--restart",
    "unless-stopped",
    // 只绑 127.0.0.1：HA 不暴露到局域网（本期局域网配对未交付）。
    "-p",
    `127.0.0.1:${HA_HOST_PORT}:${HA_HOST_PORT}`,
    "-v",
    `${configDir}:/config`,
    HA_IMAGE,
  ];
}

/**
 * 默认执行器：先把 `docker` 解析成**绝对路径**再交给 `execFile`。
 *
 * 与目录选择器同一条坑：桌面壳可能从 PATH 已被第三方安装器整键覆盖的父进程继承环境，
 * 裸名 `docker` 当场找不到（本机 2026-09-19 真发生过）。解析不到就原样交下去，
 * 让失败以「命令不存在」的形态如实进原因，而不是在这里猜一个。
 */
function createDockerRunCommand(): RunCommand {
  const base = createProcessRunCommand({ timeoutMs: 60_000 });
  const docker = resolveExecutable(["docker"], dockerExtraPaths());
  return (file, args) =>
    base(docker && file === "docker" ? docker : file, args);
}

/** PATH 之外的 Docker 常规位置（按平台给，解析不到不报错）。 */
function dockerExtraPaths(): string[] {
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    return [join(programFiles, "Docker", "Docker", "resources", "bin")];
  }
  if (process.platform === "darwin") {
    return ["/usr/local/bin", "/opt/homebrew/bin"];
  }
  return ["/usr/bin", "/usr/local/bin"];
}

export interface HaProvisionResult {
  action: "provisioned" | "skipped" | "failed";
  reason?: string;
  /** 实际执行的命令（失败时给排查用，成功时给日志一行）。 */
  command?: string;
}

/**
 * 拉起自带实例：探运行期事实 → 判据 → 写配置目录 → `docker run`。
 *
 * 不抛错：这条走的是启动期后台任务，抛出去只会污染装配日志；结果以可读原因
 * 返回，由调用方决定记 info 还是 warn。
 */
export async function provisionHomeAssistant(deps: {
  dataDir: string;
  desktop: boolean;
  run?: RunCommand;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): Promise<HaProvisionResult> {
  const run = deps.run ?? createDockerRunCommand();
  const [answering, containerPresent, carrierAvailable] = await Promise.all([
    isHomeAssistantAnswering({
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    hasManagedHaContainer(run),
    hasContainerRuntime(run),
  ]);
  const plan = planHaAutoProvision({
    desktop: deps.desktop,
    carrierAvailable,
    managedContainerPresent: containerPresent,
    haAlreadyAnswering: answering,
  });
  if (plan.action === "skip") return { action: "skipped", reason: plan.reason };

  const configDir = ensureHaConfigDir(deps.dataDir);
  const args = haRunArguments(configDir);
  const result = await run("docker", args);
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    return {
      action: "failed",
      reason: `拉起 Home Assistant 容器失败（退出码 ${result.code}）${
        detail ? `：${detail.slice(0, 300)}` : "。"
      }`,
      command: `docker ${args.join(" ")}`,
    };
  }
  return {
    action: "provisioned",
    reason: `容器 ${HA_CONTAINER_NAME} 已拉起（配置目录 ${configDir}）`,
  };
}
