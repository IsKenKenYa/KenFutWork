import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";

/**
 * dev 服务端的**单实例锁**（§三十一：长开发堆出 17 个空转实例）。
 *
 * 病因：`node --watch` 的子进程绑不上端口会退出，但 **watcher 父进程还活着**——
 * 文件一变就再试一遍，堆成 N 份「起不来也没死」的实例（实测堆到 17 个）。
 * 处置：起 watcher **之前**先探端口（连接探测 + bind 兜底，与子进程 `listen` 同一口径），
 * 起不来就直接退出并说清是哪种：
 * - 本项目的服务端（`/api/health` 认 `service: "kenfutwork-server"`）→ 已有实例在跑，不重复起；
 * - 别的程序 → 换端口（`KENFUTWORK_SERVER_PORT`）；
 * - 系统不让绑（Windows 的 Hyper-V/WSL 动态保留段回 `EACCES`）→ 如实说明并让换段外端口。
 *
 * 只在 `dev:server` 入口生效：`node --watch` 的**重启**不经过这里（同一个实例重新绑定，
 * 此时旧子进程已退出、端口已释放），所以在跑的服务端改代码重启不受影响。
 *
 * 端口/主机口径与 `config/env.ts` 一致：`KENFUTWORK_SERVER_PORT ?? PORT ?? 3001`、`HOST ?? 127.0.0.1`，
 * 其中端口串带上旧前缀兜底（`LOOMIC_SERVER_PORT`——`env.ts` 的 `withLegacyEnvNames` 会映射旧名，
 * 现存的 `.env.local` 正是用旧名写的；探针不映射就会探错端口）。
 */
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const PORT = Number(
  process.env.KENFUTWORK_SERVER_PORT ??
    process.env.LOOMIC_SERVER_PORT ??
    process.env.PORT ??
    3001,
);

/**
 * 端口上有没有人在听（**连接探测**）。
 *
 * 为什么不用「试着 bind 一次」：Windows 上 Node 的 TCP 设了 `SO_REUSEADDR`，
 * 别人听着 `0.0.0.0:3999` 时**仍能**把 `127.0.0.1:3999` 绑成功（实测），
 * bind 探测会漏判、放第二个实例进来。连接探测没有这个坑。
 */
function hasListener(port, host) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 兜底：没人应答时真 bind 一次，拿到失败原因（错误码）。 */
function probeBind(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error) => resolve(error));
    probe.once("listening", () => {
      probe.close(() => resolve(null));
    });
    probe.listen(port, host);
  });
}

/**
 * 端口状态：
 * - `free`：没人听、能绑；
 * - `occupied`：有人在听（或 `EADDRINUSE`，被别的形态占着）；
 * - `blocked`：**系统不让绑**——Windows 上 Hyper-V/WSL 会保留动态端口段，命中的端口
 *   `listen` 回 `EACCES`（实测：Docker 在跑时 3053–3152 被保留，3100/3101 直接绑不上，
 *   但没有任何程序在听）。
 */
async function inspectPort(port, host) {
  if (await hasListener(port, host)) return { state: "occupied" };
  const bindError = await probeBind(port, host);
  if (!bindError) return { state: "free" };
  if (bindError.code === "EADDRINUSE") return { state: "occupied" };
  return {
    state: "blocked",
    code: String(bindError.code ?? bindError.message),
  };
}

/** 占端口的是不是本项目的服务端：`/api/health` 的 `service` 认名字。 */
async function holderIsOurServer(port, host) {
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.service === "kenfutwork-server";
  } catch {
    return false;
  }
}

const status = await inspectPort(PORT, HOST);
if (status.state === "blocked") {
  console.error(
    `[dev] 系统不允许绑定 ${HOST}:${PORT}（${status.code}）——Windows 上常是 Hyper-V/WSL 的` +
      "动态保留端口段。",
  );
  console.error(
    "[dev] 查保留段：`netsh int ipv4 show excludedportrange protocol=tcp`；换一个段外端口：KENFUTWORK_SERVER_PORT=3901。",
  );
  process.exit(1);
}
if (status.state === "occupied") {
  const ours = await holderIsOurServer(PORT, HOST);
  if (ours) {
    console.error(
      `[dev] 端口 ${HOST}:${PORT} 上已经有一个本项目的服务端在跑——不重复起第二个实例。`,
    );
    console.error(
      "[dev] 要重启就先停掉旧进程；要换端口就设 KENFUTWORK_SERVER_PORT（如 3901）。",
    );
  } else {
    console.error(
      `[dev] 端口 ${HOST}:${PORT} 被别的程序占着（/api/health 没有回应），dev 服务端起不来。`,
    );
    console.error(
      "[dev] 换端口（KENFUTWORK_SERVER_PORT=3901）或先让出这个端口。",
    );
  }
  process.exit(1);
}

console.log(`[dev] 单实例锁：${HOST}:${PORT} 空闲，启动 dev 服务端`);

// .env.local 由本脚本的 `--env-file` 载入（环境变量优先于文件，与 node 的语义一致），
// 子进程（watcher 与它拉起的 server 子进程）直接继承，无需重复传参。
const child = spawn(
  process.execPath,
  ["--watch", "--import", "tsx", "./src/server.ts"],
  { stdio: "inherit" },
);
// Ctrl-C / SIGTERM 让子进程（watcher）先收尾，本进程等它退出后再走——
// 避免「父进程先死、watcher 留成孤儿」。
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
