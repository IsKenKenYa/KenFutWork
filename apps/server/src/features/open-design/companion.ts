import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * OpenDesign 伴随容器（规划 §9-3，2026-10-15 拍板：作为「伴随容器」跟 KenFutWork
 * 主程序绑在一起跑）。
 *
 * 生命周期归宿主服务端持有：**装配时 up -d（非阻塞——首次要拉镜像，分钟级）、
 * kernel dispose 时 down（保留数据卷）**。前端地址指向伴随 origin 即托管；
 * 指向外部地址 = 用户自管实例，本模块一行 docker 都不发。
 *
 * 纪律对位 flow 引擎（`features/flow/engine/exec.ts`）：`execFile` 直接传参数数组
 * 不经 shell；失败压成一句可读原因进快照，status 探针据此把「伴随容器怎么了」
 * 如实透给界面（fail loud，不静默）。不复用 flow 的三条路径 Provider 抽象——那是
 * dify 重栈的平台矩阵；伴随是单容器，薄实现就够（拍板依据见规划 §9-3）。
 *
 * 幂等口径：`up -d` / `down` 都可安全重放（持久副作用红线）；失败**不自动重试**，
 * 留给下次主程序启动收敛，中途由 status 透出原因。
 */

/** 伴随容器的固定发布地址（compose 写死，改一处必须两处同改）。 */
export const OPEN_DESIGN_COMPANION_ORIGIN = "http://127.0.0.1:7456";

export type OpenDesignCarrierMode = "managed" | "external" | "none";

/**
 * 承载形态判定（纯函数）：未配地址 = none；指向伴随 origin（loopback + http + 7456）
 * = managed（服务端起停）；其余（https 反代 / 远端主机 / 非常规端口）= external（用户自管）。
 */
export function resolveOpenDesignCarrierMode(
  frontendUrl: string | null | undefined,
): OpenDesignCarrierMode {
  const value = frontendUrl?.trim();
  if (!value) return "none";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "external";
  }
  if (url.protocol !== "http:") return "external";
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  const port = url.port === "" ? "80" : url.port;
  return loopback && port === "7456" ? "managed" : "external";
}

export type OpenDesignCompanionState = "idle" | "starting" | "ready" | "error";

export interface OpenDesignCompanionSnapshot {
  state: OpenDesignCompanionState;
  /** 失败摘要（state=error 时；绝不含密钥）。 */
  error?: string;
}

export interface ComposeRunResult {
  code: number;
  stderr: string;
}

export type ComposeRun = (
  args: readonly string[],
  options: { env?: Record<string, string>; timeoutMs?: number },
) => Promise<ComposeRunResult>;

/** `docker compose …` 的执行器（可注入替身；纪律同 flow exec.ts：参数数组不过 shell）。 */
export function createDockerComposeRun(): ComposeRun {
  return (args, options) =>
    new Promise((resolve) => {
      execFile(
        "docker",
        ["compose", ...args],
        {
          timeout: options.timeoutMs ?? OPEN_DESIGN_COMPOSE_UP_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, ...options.env },
        },
        (error, _stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 127
                : 0;
          resolve({
            code,
            stderr:
              String(stderr ?? "") || (error ? error.message : "") || "无输出",
          });
        },
      );
    });
}

/** 首次 up 要拉镜像：给足时间，但不能让主程序等无限。 */
export const OPEN_DESIGN_COMPOSE_UP_TIMEOUT_MS = 30 * 60_000;
/** down 是交互式收尾：compose 自己会等容器退出，这里只做兜底。 */
export const OPEN_DESIGN_COMPOSE_DOWN_TIMEOUT_MS = 120_000;

export interface OpenDesignCompanionController {
  /** 幂等拉起（up -d）；并发调用共享同一次进行中的启动。 */
  start(): Promise<void>;
  /** 停止（down，保留数据卷）。dispose 钩子调用，失败只 warn 不抛。 */
  stop(): Promise<void>;
  snapshot(): OpenDesignCompanionSnapshot;
}

export function createOpenDesignCompanionController(deps: {
  /** compose 文件绝对路径（源码态=仓库根 `open-design/`，打包态=资源根，见 plugin.ts）。 */
  composeFile: string;
  /** 注入容器的 `OD_API_TOKEN`（= KENFUTWORK_OPEN_DESIGN_EMBED_SECRET，成对值）。 */
  apiToken?: string | undefined;
  run?: ComposeRun | undefined;
}): OpenDesignCompanionController {
  const run = deps.run ?? createDockerComposeRun();
  let state: OpenDesignCompanionSnapshot = { state: "idle" };
  let pending: Promise<void> | undefined;

  const failReason = (code: number, stderr: string): string =>
    `docker compose up 失败（退出码 ${code}）：${firstLine(stderr)}`;

  const start = (): Promise<void> => {
    if (pending) return pending;
    if (state.state === "ready") return Promise.resolve();
    state = { state: "starting" };
    pending = (async () => {
      try {
        if (!existsSync(deps.composeFile)) {
          state = {
            state: "error",
            error: `找不到伴随容器 compose 文件：${deps.composeFile}`,
          };
          return;
        }
        // 恒注入 OD_API_TOKEN（未配密钥 = 空串）：它是 daemon 出站调宿主凭证缝的
        // 成对值；伴随栈入站认证由 compose 固定豁免（只发布宿主环回，真机实证
        // 2026-10-15：0.0.0.0+token 会把 iframe 锁在 Basic Auth 弹窗）。
        const result = await run(["-f", deps.composeFile, "up", "-d"], {
          env: { OD_API_TOKEN: deps.apiToken ?? "" },
        });
        state =
          result.code === 0
            ? { state: "ready" }
            : { state: "error", error: failReason(result.code, result.stderr) };
      } catch (error) {
        state = {
          state: "error",
          error: `docker compose up 异常：${firstLine(error instanceof Error ? error.message : String(error))}`,
        };
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };

  const stop = async (): Promise<void> => {
    // 安装进行中就来了关停：等它落定再 down，不让 up/down 打架
    if (pending) await pending;
    if (!existsSync(deps.composeFile)) {
      // 没有 compose 资源就没有可停的栈（从未具备托管能力）：不动 docker，不误报。
      return;
    }
    try {
      const result = await run(["-f", deps.composeFile, "down"], {
        timeoutMs: OPEN_DESIGN_COMPOSE_DOWN_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        console.warn(
          `[open-design] 伴随容器停止失败（保留数据卷不受影响）：${firstLine(result.stderr)}`,
        );
      }
    } catch (error) {
      console.warn(
        `[open-design] 伴随容器停止异常：${firstLine(error instanceof Error ? error.message : String(error))}`,
      );
    }
    state = { state: "idle" };
  };

  return {
    start,
    stop,
    snapshot: () => (state.error ? { ...state } : { state: state.state }),
  };
}

/** 失败原因只留首行并截断——compose 的报错尾巴（堆栈/换行）对界面是噪声。 */
function firstLine(text: string): string {
  const line = (text ?? "").split(/\r?\n/u)[0]?.trim() ?? "";
  return line.slice(0, 200) || "无输出";
}
