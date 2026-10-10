import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMacosAppSeal } from "./macos-signing.mjs";

const repo = join(import.meta.dirname, "..", "..", "..");
const app = join(repo, "KenFutWork.app");
const stateRoot = join(repo, ".kenfutwork-data", "desktop-development");
const stampFile = join(stateRoot, "shell.json");
let web, ownedPid;
let stopping = false;
const launcherLock = join(stateRoot, "launcher.json");
let ownsLauncherLock = false;

export async function acquireLauncherLock(path = launcherLock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid }));
      } finally {
        await file.close();
      }
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await readFile(path, "utf8");
      // 另一个启动器可能刚创建锁文件，尚未写完PID，此时保守地不重复启动。
      if (!previous.trim()) return false;
      const pid = JSON.parse(previous).pid;
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("开发启动器锁无效，请核对后重试。");
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      if ((await readFile(path, "utf8")) === previous) await rm(path);
    }
  }
  throw new Error("无法取得开发启动器锁。");
}

function stop() {
  stopping = true;
  web?.kill("SIGTERM");
  if (ownedPid && appPid() === ownedPid)
    process.kill(Number(ownedPid), "SIGTERM");
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: repo,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) throw new Error(`桌面命令失败：${program}`);
  return result;
}

async function shellHash() {
  const hash = createHash("sha256");
  const walk = async (path) => {
    for (const item of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = join(path, item.name);
      if (item.isDirectory()) await walk(file);
      else {
        hash.update(file);
        hash.update(await readFile(file));
      }
    }
  };
  for (const folder of ["src", "permissions", "capabilities"])
    await walk(join(repo, "apps/desktop/src-tauri", folder));
  for (const file of [
    "build.rs",
    "Cargo.toml",
    "Cargo.lock",
    "tauri.conf.json",
    "tauri.macos.conf.json",
  ])
    hash.update(await readFile(join(repo, "apps/desktop/src-tauri", file)));
  hash.update(await readFile(join(repo, "apps/desktop/splash.html")));
  return hash.digest("hex");
}

function appPid() {
  const result = spawnSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("无法确认固定应用是否正在运行。");
  const executable = join(app, "Contents/MacOS/kenfutwork-desktop");
  return result.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/u))
    .find((row) => row?.[2] === executable)?.[1];
}

export function isSourceDevelopmentLaunch(environment) {
  return (
    /(?:^|\s)KENFUTWORK_DESKTOP_WEB_URL=http:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\s|$)/u.test(
      environment,
    ) && /(?:^|\s)KENFUTWORK_SERVER_PORT=\d+(?:\s|$)/u.test(environment)
  );
}

function sourceDevelopmentApp(pid) {
  // 仅判断非敏感启动标志；ps结果留在内存，不输出完整环境。
  const result = spawnSync("ps", ["eww", "-p", pid, "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("无法确认固定应用的启动方式。");
  return isSourceDevelopmentLaunch(result.stdout);
}

async function closeApp(pid) {
  if (appPid() !== pid) return;
  process.kill(Number(pid), "SIGTERM");
  const deadline = Date.now() + 20_000;
  while (appPid() === pid && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (appPid() === pid) throw new Error("固定应用未能退出，请关闭后重试。");
}

async function openSourceApp(values) {
  command("open", [
    "-n",
    app,
    ...Object.entries(values).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
  ]);
  const deadline = Date.now() + 15_000;
  while (!stopping && Date.now() < deadline) {
    const pid = appPid();
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!stopping) throw new Error("固定应用未能启动。");
}

async function followSystemReopens(values) {
  let closedAt;
  while (!stopping) {
    const pid = appPid();
    if (pid === ownedPid) closedAt = undefined;
    else if (pid) {
      // macOS隐私设置的重开不保留open --env；保持原数据/端口与Web进程。
      console.log("检测到系统重开，恢复源码启动配置。");
      if (!sourceDevelopmentApp(pid)) {
        await closeApp(pid);
        if (stopping) return;
        ownedPid = await openSourceApp(values);
      } else ownedPid = pid;
      closedAt = undefined;
    } else {
      closedAt ??= Date.now();
      if (Date.now() - closedAt >= 5_000) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function prepareApp() {
  await mkdir(stateRoot, { recursive: true });
  const hash = await shellHash();
  let previous;
  try {
    previous = JSON.parse(await readFile(stampFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    previous?.hash === hash &&
    (await stat(app).then(
      () => true,
      () => false,
    ))
  ) {
    ensureMacosAppSeal(app);
    return;
  }
  if (appPid()) throw new Error("请先关闭 KenFutWork，再更新开发壳。");
  const ui = join(stateRoot, "ui");
  await mkdir(ui, { recursive: true });
  await cp(join(repo, "apps/desktop/splash.html"), join(ui, "_splash.html"));
  command("pnpm", [
    "--filter",
    "@kenfutwork/desktop",
    "exec",
    "tauri",
    "build",
    "--debug",
    "--bundles",
    "app",
    "--config",
    JSON.stringify({
      build: { devUrl: null, frontendDist: ui },
      bundle: { resources: [] },
    }),
  ]);
  const built = join(
    repo,
    "apps/desktop/src-tauri/target/debug/bundle/macos/KenFutWork.app",
  );
  ensureMacosAppSeal(built);
  const staging = join(stateRoot, "staging.app"),
    backup = join(stateRoot, "previous.app");
  await rm(staging, { recursive: true, force: true });
  await cp(built, staging, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  command("codesign", ["--verify", "--deep", "--strict", staging]);
  await rm(backup, { recursive: true, force: true });
  const exists = await stat(app).then(
    () => true,
    () => false,
  );
  if (exists) await rename(app, backup);
  try {
    await rename(staging, app);
  } catch (error) {
    if (exists) await rename(backup, app);
    throw error;
  }
  await writeFile(
    stampFile,
    JSON.stringify({ hash, app, mode: "source-development" }),
  );
  await rm(backup, { recursive: true, force: true });
  console.log("固定开发壳已更新：KenFutWork.app");
}

export async function freePort(preferred, start) {
  for (const port of [
    preferred,
    ...Array.from({ length: 20 }, (_, index) => start + index),
  ]) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("没有可用的本机开发端口。");
}

async function run() {
  try {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    if (process.platform !== "darwin") throw new Error("该入口只用于 macOS。");
    if (!process.argv.includes("--prepare-only")) {
      await mkdir(stateRoot, { recursive: true });
      if (!(await acquireLauncherLock())) {
        console.log("开发入口已在运行。");
        if (appPid()) command("open", [app]);
        return;
      }
      ownsLauncherLock = true;
    }
    await prepareApp();
    if (process.argv.includes("--prepare-only")) return;
    const existing = appPid();
    if (existing) {
      if (sourceDevelopmentApp(existing)) {
        command("open", [app]);
        return;
      }
      console.log("固定应用缺少源码启动配置，恢复开发入口。");
      await closeApp(existing);
    }
    command("pnpm", ["--filter", "@kenfutwork/shared", "build"]);
    command("pnpm", ["--filter", "@kenfutwork/voice-ui", "build"]);
    command("pnpm", ["--filter", "@zcode/ui", "build"]);
    const apiPort = await freePort(3301, 3301),
      webPort = await freePort(3400, 3400);
    const webUrl = `http://127.0.0.1:${webPort}`;
    web = spawn(
      join(repo, "apps/web/node_modules/.bin/next"),
      ["dev", "--hostname", "127.0.0.1", "-p", String(webPort)],
      {
        cwd: join(repo, "apps/web"),
        stdio: "inherit",
        env: {
          ...process.env,
          NEXT_PUBLIC_SERVER_BASE_URL: `http://127.0.0.1:${apiPort}`,
        },
      },
    );
    const deadline = Date.now() + 90_000;
    while (!stopping && Date.now() < deadline) {
      if (web.exitCode !== null) throw new Error("源码 Web 未能启动。");
      if (
        spawnSync(
          "curl",
          ["--noproxy", "*", "-sf", "--max-time", "3", webUrl],
          {
            stdio: "ignore",
          },
        ).status === 0
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (Date.now() >= deadline) throw new Error("源码 Web 启动超时。");
    if (stopping) return;
    console.log(`启动固定应用：${app}（API ${apiPort}，Web ${webPort}）`);
    const values = {
      KENFUTWORK_DESKTOP_SERVER_CWD: repo,
      KENFUTWORK_SERVER_PORT: String(apiPort),
      KENFUTWORK_WEB_ORIGIN: webUrl,
      KENFUTWORK_DESKTOP_WEB_URL: webUrl,
    };
    if (process.env.KENFUTWORK_DATA_DIR)
      values.KENFUTWORK_DATA_DIR = process.env.KENFUTWORK_DATA_DIR;
    if (process.env.KENFUTWORK_CONFIG_DIR)
      values.KENFUTWORK_CONFIG_DIR = process.env.KENFUTWORK_CONFIG_DIR;
    ownedPid = await openSourceApp(values);
    if (stopping) return;
    if (!ownedPid) throw new Error("固定应用未能启动。");
    await followSystemReopens(values);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    stop();
    if (web) {
      web.kill("SIGTERM");
      await new Promise((resolve) => {
        if (web.exitCode !== null) resolve();
        else web.once("exit", resolve);
      });
    }
    if (ownsLauncherLock) await rm(launcherLock, { force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await run();
