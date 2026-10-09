import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createProcessRunCommand,
  decodeCommandText,
  type RunCommand,
} from "./exec.js";

/**
 * Dify 无头栈的**托管安装状态机**（FORM-11 探测后的「下载 → 确认 → 托管」流程）。
 *
 * 职责：flow 插件启用且 Docker 可用时，把 `docker-compose.dify.yml --profile dify`
 * 拉起来（镜像 ~8.3GB 随 up 自动拉取）。安装是**长任务**（拉镜像分钟级）——
 * detached spawn + 日志落文件 + 状态轮询，不占请求连接。
 *
 * 三个口径（§9.1 已拍板，见《flow插件集成规划》§9.1）：
 *  - 首次安装自动生成密钥（SECRET_KEY / ADMIN_API_KEY）落到数据目录的 env 文件，之后复用；
 *  - 引擎数据在容器卷里（不在主仓数据目录）；
 *  - 停止/卸载：默认 `down` 保留数据卷，显式选择全删才 `down --volumes`（见 stopEngineStack）。
 *
 * 边界：compose 文件与数据目录由调用方解析传入（开发=仓库根，桌面=资源目录，后者待接）。
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
  const envFile = join(dataDir, "dify-stack.env");
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
}

/**
 * 启动安装（幂等）：已在安装中 → 409 由调用方处理；本函数只在 idle/error 时拉起。
 * detached spawn：node 重启不杀安装进程，但状态归零——重启后按 compose ps 重新探测（后续增量）。
 */
export function startEngineInstall(options: EngineInstallOptions): {
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
  const logFile = join(options.dataDir, "dify-stack-install.log");
  current = {
    state: "installing",
    startedAt: new Date().toISOString(),
    logFile,
  };

  const child = spawn(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "-f",
      options.composeFile,
      "--profile",
      "dify",
      "up",
      "-d",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.extraEnv },
      windowsHide: true,
    },
  );
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

/**
 * 停止引擎栈（FORM-11 生命周期）：`docker compose down`；`deleteData` 时追加
 * `--volumes`（全删容器卷，含 Dify 库与文件——**显式选择才动数据**，§9.1③）。
 * 安装中先取消：`up` 还在跑时 `down` 会互相打架。
 */
export async function stopEngineStack(
  options: EngineInstallOptions & { deleteData?: boolean },
  deps: { run?: RunCommand } = {},
): Promise<EngineStopResult> {
  if (current.state === "installing") cancelEngineInstall();
  // 停止是交互式操作（用户点了按钮）：超时只作兜底，给 compose 收尾留足时间。
  const run = deps.run ?? createProcessRunCommand({ timeoutMs: 120_000 });
  const envFile = ensureStackEnvFile(options.dataDir);
  const result = await run("docker", [
    "compose",
    "--env-file",
    envFile,
    "-f",
    options.composeFile,
    "--profile",
    "dify",
    "down",
    ...(options.deleteData ? ["--volumes"] : []),
  ]);
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
