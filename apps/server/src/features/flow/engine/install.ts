import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  createProcessRunCommand,
  decodeCommandText,
  type RunCommand,
} from "./exec.js";

/**
 * Dify 无头栈的**托管安装状态机**（FORM-11 探测后的「下载 → 确认 → 托管」流程）。
 *
 * 职责：flow 插件启用且承载路径可用时，把 `dify/docker-compose.dify.yml --profile dify`
 * 拉起来（镜像 ~8.3GB 随 up 自动拉取）。安装是**长任务**（拉镜像分钟级）——
 * detached spawn + 日志落文件 + 状态轮询，不占请求连接。
 *
 * 承载目标（`EngineLaunch`）：宿主 docker（默认）或 **WSL2 发行版内 docker**
 * （Windows 优先档，§3.5.1 双 Provider）。选定后**落盘**（`dify-stack.runtime.json`）——
 * 停止/查询必须用同一个目标，否则 `down` 找不到另一侧起的容器。
 *
 * 三个口径（§9.1 已拍板，见《flow插件集成规划》§9.1）：
 *  - 首次安装自动生成密钥（SECRET_KEY / ADMIN_API_KEY）落到数据目录的 env 文件，之后复用；
 *  - 引擎数据在容器卷里（不在主仓数据目录；WSL2 档落 distro 内的命名卷）；
 *  - 停止默认 `down` 保留数据卷，显式选择全删才 `down --volumes`（见 stopEngineStack）；
 *    flow 插件**卸载**走 purge：`down --volumes --rmi all` + 清本地 env/日志/记录——
 *    下次安装重新拉镜像即可（用户口径：卸载就把 dify 那些删掉，代码保留才能二次安装）。
 *
 * 边界：compose 文件与数据目录由调用方解析传入（开发=仓库根 `dify/`，打包=资源根 `dify/`）。
 */

export type EngineInstallState = "idle" | "installing" | "ready" | "error";

export interface EngineInstallSnapshot {
  state: EngineInstallState;
  /** 安装日志尾部（最后 N 行），排障用。 */
  logTail: string[];
  /** 错误摘要（state=error 时）。 */
  error?: string;
  /** startedAt ISO（installing/error 时有）。 */
  startedAt?: string;
}

const LOG_LINES_KEEP = 50;

/** 进程内单例状态（服务重启后按 compose ps 重新探测，不持久化状态本身）。 */
let current: {
  state: EngineInstallState;
  error?: string;
  startedAt?: string;
  logFile?: string;
  child?: ReturnType<typeof spawn>;
} = { state: "idle" };

export function getEngineInstallSnapshot(): EngineInstallSnapshot {
  const logTail = readLogTail(current.logFile);
  const snapshot: EngineInstallSnapshot = {
    state: current.state,
    logTail,
  };
  if (current.error) snapshot.error = current.error;
  if (current.startedAt) snapshot.startedAt = current.startedAt;
  return snapshot;
}

function readLogTail(logFile?: string): string[] {
  if (!logFile || !existsSync(logFile)) return [];
  try {
    const lines = readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-LOG_LINES_KEEP);
  } catch {
    return [];
  }
}

/** 首次安装的密钥文件（数据目录内，gitignore 覆盖；存在即复用）。 */
export function ensureStackEnvFile(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const envFile = join(dataDir, STACK_ENV_FILE);
  if (existsSync(envFile)) return envFile;

  const random = (bytes: number) => randomBytes(bytes).toString("base64url");
  const content = [
    "# Dify 无头栈环境（宿主首次安装时自动生成；删除即下次重新生成——SECRET_KEY 变更会使已有加密数据不可读）",
    `DIFY_SECRET_KEY=${random(32)}`,
    `DIFY_INIT_PASSWORD=${random(9)}`,
    `DIFY_ADMIN_API_KEY=kfw-admin-${random(24)}`,
    "",
  ].join("\n");
  writeFileSync(envFile, content, { mode: 0o600 });
  return envFile;
}

export interface EngineInstallOptions {
  /** docker compose 文件的绝对路径。 */
  composeFile: string;
  /** env 文件目录（数据目录）。 */
  dataDir: string;
  /** 额外注入的环境（如 DIFY_PORT）。 */
  extraEnv?: Record<string, string>;
  /** 承载目标；缺省 host（读落盘记录由调用方完成）。 */
  launch?: EngineLaunch;
}

/** 引擎承载目标（FORM-11 双 Provider）：宿主 docker 或 WSL2 发行版内 docker。 */
export type EngineLaunch =
  | { kind: "host" }
  | { kind: "wsl2"; distro: string };

/** 承载记录文件名（数据目录内）：安装时写，停止/查询读。 */
export const STACK_RUNTIME_FILE = "dify-stack.runtime.json";

/** 安装日志文件名（数据目录内）。 */
export const STACK_LOG_FILE = "dify-stack-install.log";

/** 密钥 env 文件名（数据目录内）。 */
export const STACK_ENV_FILE = "dify-stack.env";

/**
 * Windows 路径 → WSL 内路径（`C:\a\b` → `/mnt/c/a/b`）。
 * 非盘符路径（已是 POSIX / UNC）原样返回——UNC 不受支持，交给命令自己报错。
 */
export function toWslPath(winPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!match) return winPath;
  const [, drive, rest] = match;
  return `/mnt/${(drive ?? "").toLowerCase()}/${(rest ?? "").replace(/\\/g, "/")}`;
}

/**
 * compose 命令（含承载目标）：host → `docker compose …`；
 * wsl2 → `wsl.exe -d <distro> -- docker compose …`（compose/env 路径换成 /mnt/…）。
 */
export function composeCommand(
  options: Pick<EngineInstallOptions, "composeFile" | "launch"> & {
    /** 存在才带上 `--env-file`（只读查询路径不创建它）。 */
    envFile?: string | undefined;
  },
  args: string[],
): { command: string; args: string[] } {
  const launch = options.launch ?? { kind: "host" };
  const inWsl = launch.kind === "wsl2";
  const envFile =
    options.envFile === undefined
      ? undefined
      : inWsl
        ? toWslPath(options.envFile)
        : options.envFile;
  const composeFile = inWsl ? toWslPath(options.composeFile) : options.composeFile;
  const composeArgs = [
    "compose",
    ...(envFile === undefined ? [] : ["--env-file", envFile]),
    "-f",
    composeFile,
    ...args,
  ];
  if (launch.kind === "wsl2") {
    return {
      command: "wsl.exe",
      args: ["-d", launch.distro, "--", "docker", ...composeArgs],
    };
  }
  return { command: "docker", args: composeArgs };
}

/** 写承载记录（安装时调用；下次停止/查询按它执行）。 */
export function writeStackRuntime(dataDir: string, launch: EngineLaunch): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, STACK_RUNTIME_FILE),
    `${JSON.stringify(launch, null, 2)}\n`,
  );
}

/** 读承载记录；无记录/坏文件一律回落 `host`（fail-safe，不猜）。 */
export function readStackRuntime(dataDir: string): EngineLaunch {
  try {
    const raw = JSON.parse(
      readFileSync(join(dataDir, STACK_RUNTIME_FILE), "utf8"),
    ) as unknown;
    if (raw && typeof raw === "object") {
      const kind = (raw as { kind?: unknown }).kind;
      if (kind === "host") return { kind: "host" };
      if (kind === "wsl2") {
        const distro = (raw as { distro?: unknown }).distro;
        if (typeof distro === "string" && distro.trim()) {
          return { kind: "wsl2", distro: distro.trim() };
        }
      }
    }
  } catch {
    // 没有记录（从未安装）/ JSON 坏了：都按宿主 docker 处理
  }
  return { kind: "host" };
}

/**
 * 启动安装（幂等）：已在安装中 → 409 由调用方处理；本函数只在 idle/error 时拉起。
 * detached spawn：node 重启不杀安装进程，但状态归零——重启后按 compose ps 重新探测（后续增量）。
 */
export function startEngineInstall(
  options: EngineInstallOptions,
  /** spawn 可注入（测试断言命令构造与承载记录落盘；生产不传）。 */
  deps: { spawn?: typeof spawn } = {},
): {
  started: boolean;
  snapshot: EngineInstallSnapshot;
} {
  if (current.state === "installing") {
    return { started: false, snapshot: getEngineInstallSnapshot() };
  }

  if (!existsSync(options.composeFile)) {
    current = {
      state: "error",
      error: `找不到 compose 文件：${options.composeFile}`,
    };
    return { started: false, snapshot: getEngineInstallSnapshot() };
  }

  const envFile = ensureStackEnvFile(options.dataDir);
  const logFile = join(options.dataDir, STACK_LOG_FILE);
  // 承载目标落盘：停止/查询必须用同一个目标（否则 down 找不到另一侧起的容器）
  writeStackRuntime(options.dataDir, options.launch ?? { kind: "host" });
  current = {
    state: "installing",
    startedAt: new Date().toISOString(),
    logFile,
  };

  const command = composeCommand(
    { ...options, envFile },
    ["--profile", "dify", "up", "-d"],
  );
  const child = (deps.spawn ?? spawn)(command.command, command.args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.extraEnv },
    windowsHide: true,
  });
  current.child = child;

  const append = (chunk: Buffer | string): void => {
    try {
      writeFileSync(logFile, String(chunk), { flag: "a" });
    } catch {
      // 日志写失败不影响安装本身
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (error) => {
    current.state = "error";
    current.error = error.message;
  });
  child.on("close", (code) => {
    if (current.state !== "installing") return;
    current.state = code === 0 ? "ready" : "error";
    if (code !== 0) current.error = `docker compose 退出码 ${code}（详见日志）`;
  });

  return { started: true, snapshot: getEngineInstallSnapshot() };
}

/**
 * 取消进行中的安装（协作式）：终止 `up` 子进程；已拉取的镜像层保留（可重放），
 * 半创建的容器由停止（`stopEngineStack`）清理——取消本身不假装栈已不存在。
 */
export function cancelEngineInstall(): EngineInstallSnapshot {
  if (current.state !== "installing") return getEngineInstallSnapshot();
  current.child?.kill();
  current = { state: "idle" };
  return getEngineInstallSnapshot();
}

export interface EngineStopResult {
  ok: boolean;
  /** 失败时的可读原因（命令退出码 + stderr 摘要）。 */
  error?: string;
}

/** flow 引擎托管的宿主侧服务（ctx key `flowEngine`）：插件卸载时的引擎清理钩子。 */
export interface FlowEngineHostService {
  /**
   * 插件卸载钩子：仅对 flow 产品插件（`kenfutwork-flow`）执行引擎 purge
   * （删容器/卷/镜像 + 本地 env/日志/记录），其余插件返回 ok 且不动引擎。
   */
  purgeForPlugin(pluginId: string): Promise<EngineStopResult>;
}

/**
 * 停止引擎栈（FORM-11 生命周期）：`docker compose down`；`deleteData` 时追加
 * `--volumes`（全删容器卷，含 Dify 库与文件——**显式选择才动数据**，§9.1③）。
 * 安装中先取消：`up` 还在跑时 `down` 会互相打架。
 */
export async function stopEngineStack(
  options: EngineInstallOptions & {
    deleteData?: boolean;
    /** 连镜像一起删（`--rmi all`；卸载 purge 用，普通停止不动镜像）。 */
    purgeImages?: boolean;
  },
  deps: { run?: RunCommand } = {},
): Promise<EngineStopResult> {
  if (current.state === "installing") cancelEngineInstall();
  // 停止是交互式操作（用户点了按钮）：超时只作兜底，给 compose 收尾留足时间。
  const run = deps.run ?? createProcessRunCommand({ timeoutMs: 120_000 });
  const envFile = ensureStackEnvFile(options.dataDir);
  const command = composeCommand(
    { ...options, envFile },
    [
      "--profile",
      "dify",
      "down",
      ...(options.deleteData ? ["--volumes"] : []),
      ...(options.purgeImages ? ["--rmi", "all"] : []),
    ],
  );
  const result = await run(command.command, command.args);
  if (result.code !== 0) {
    const detail = decodeCommandText(result.stderr).split("\n")[0]?.trim();
    return {
      ok: false,
      error:
        `docker compose down 失败（退出码 ${result.code}）` +
        (detail ? `：${detail.slice(0, 200)}` : ""),
    };
  }
  current = { state: "idle" };
  return { ok: true };
}

/**
 * 卸载清理（flow 插件卸载专用，用户口径）：
 * **删引擎本体**——`down --volumes --rmi all`（容器 + 卷 + 镜像，下次安装重新下载）
 * + 清本地 env / 安装日志 / 承载记录；**不碰插件代码**（`plugins/flow` 与 compose 资源
 * 留在原处，才能二次安装）。
 */
export async function purgeEngineStack(
  options: EngineInstallOptions,
  deps: { run?: RunCommand } = {},
): Promise<EngineStopResult> {
  // 从未安装（没有密钥 env、也没有承载记录）或 compose 资源缺失：没有可清的引擎，
  // 直接成功——不让「卸载一个从没装过引擎的插件」被 docker 的报错卡住。
  const everInstalled =
    existsSync(join(options.dataDir, STACK_ENV_FILE)) ||
    existsSync(join(options.dataDir, STACK_RUNTIME_FILE));
  if (everInstalled && existsSync(options.composeFile)) {
    const result = await stopEngineStack(
      { ...options, deleteData: true, purgeImages: true },
      deps,
    );
    if (!result.ok) return result;
  }
  for (const name of [STACK_ENV_FILE, STACK_LOG_FILE, STACK_RUNTIME_FILE]) {
    rmSync(join(options.dataDir, name), { force: true });
  }
  return { ok: true };
}
