import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type RuntimeName,
  type RuntimeRoot,
  resolveRuntime,
  runtimeLayout,
} from "../../desktop/runtimes.js";
import { ProcessSandboxError } from "./types.js";

/**
 * 随包运行时里要交给沙箱「可读 + 可执行」的那些。
 *
 * 为什么必须逐个列全：启动期 `runtimePathAdditions` 把它们的 bin 目录前置进 sandbox PATH，
 * 但 PATH 只决定「找得到」，沙箱的读/执行授权决定「能不能跑」。此前这里只给了 Node 的根，
 * 于是 `python` 在沙箱里恒被拒（原《未做需求》#12，已收口）。**git 原先刻意不在列**
 * （理由曾是「优先用宿主的，宿主没有才走 PATH」）——实测在宿主没装 git 或 git 不在系统/用户
 * PATH 的机器上（本机即是），沙箱侧 `spawnCheckpoint` 直接 `error launching git: …`，
 * 检查点时间线 / 每轮自动提交 / worktree / init 整族不可用；随包 `runtime/git` 又拿不到 PATH。
 * 故与其余运行时同列：PATH 给 bin 目录、readRoots 给整棵树（git 要读自己的 lib/libexec）。
 */
const BUNDLED_RUNTIME_NAMES: readonly RuntimeName[] = [
  "node",
  "python",
  "uv",
  "java",
  "git",
];

/** Profile 私有启动资源；不接受模型路径，不另造运行时配置或目录真相。 */
export function resolveProcessRuntime(input: {
  resourceRoot: string;
  env: Record<string, string | undefined>;
  sourceHelperPath?: string;
  /** 检查点 Git 的 bin 目录（`env.gitBinDir`，宿主/随包同源）；宿主 git 时必须配对授权读根。 */
  gitBinDir?: string;
}) {
  const bundledRuntimes = BUNDLED_RUNTIME_NAMES.map((name) =>
    resolveRuntime(name, { env: input.env, exeDir: input.resourceRoot }),
  ).filter((root): root is RuntimeRoot => root !== null);
  // 宿主 git 优先时（`gitBinDir` 指向宿主安装而非随包 runtime/git），PATH 前置已由
  // server.ts 补上，但读/执行授权若不配对，broker 起的 git.exe 会因 DLL/libexec 不可读
  // 死于 0xC0000135（stderr 为空，只报「检查点 Git 执行失败」）——与 environment.ts 的
  // 「PATH 决定找得到，readRoots 决定跑得起来」不变量一致，这里补齐读根。
  // 授权给**安装根**而非 bin 的直接父级：git 运行时还要读安装根下的 etc/gitconfig，
  // 只给 mingw64 子树时会报 `unable to access '…/etc/gitconfig': Permission denied`。
  const bundledGitBin = bundledRuntimes.find(
    (root) => root.name === "git",
  )?.binDir;
  const systemGitReadRoot =
    input.gitBinDir && input.gitBinDir !== bundledGitBin
      ? basename(input.gitBinDir) === "bin"
        ? dirname(dirname(input.gitBinDir))
        : dirname(input.gitBinDir)
      : null;
  const bundledNode =
    bundledRuntimes.find((root) => root.name === "node") ?? null;
  const nodePath = bundledNode
    ? join(bundledNode.binDir, runtimeLayout("node", process.platform).probe)
    : isSea()
      ? null
      : process.execPath;
  if (!nodePath)
    throw new ProcessSandboxError(
      "enforcement_unavailable",
      "发布包缺少独立 Node runtime，不能用 SEA 服务本体启动进程 helper。",
    );
  const packaged = join(
    input.resourceRoot,
    "process-helper",
    "task-helper.mjs",
  );
  let helperPath = packaged;
  if (!existsSync(packaged)) {
    const source =
      input.sourceHelperPath ??
      (import.meta.url?.startsWith("file:")
        ? fileURLToPath(new URL("./task-helper.ts", import.meta.url))
        : null);
    if (isSea() || !source || !existsSync(source))
      throw new ProcessSandboxError(
        "enforcement_unavailable",
        "发布包没有进程 helper 及固定 SRT 运行依赖。",
      );
    helperPath = source;
  }
  const nativeCandidates =
    helperPath === packaged
      ? [join(dirname(packaged), "process-broker.exe")]
      : [
          join(
            dirname(helperPath),
            "native",
            "target",
            "release",
            "kenfutwork-process-broker.exe",
          ),
          join(
            dirname(helperPath),
            "native",
            "target",
            "x86_64-pc-windows-gnu",
            "release",
            "kenfutwork-process-broker.exe",
          ),
          join(
            dirname(helperPath),
            "native",
            "target",
            "x86_64-pc-windows-msvc",
            "release",
            "kenfutwork-process-broker.exe",
          ),
          join(
            dirname(helperPath),
            "native",
            "target",
            "aarch64-pc-windows-msvc",
            "release",
            "kenfutwork-process-broker.exe",
          ),
        ];
  return {
    nodePath,
    helperPath,
    helperExecArgv: helperPath.endsWith(".ts")
      ? [
          "--import",
          pathToFileURL(createRequire(helperPath).resolve("tsx")).href,
        ]
      : [],
    // 沙箱只读授权：随包运行时的**整棵树**（python 要读自己的 Lib/、node 要读 lib/）。
    // 一个都没捆绑时（纯宿主运行时）退化成 helper Node 所在目录，行为与修复前一致。
    runtimeReadRoots: [
      ...new Set([
        ...bundledRuntimes.map((root) => root.homeDir),
        ...(systemGitReadRoot ? [systemGitReadRoot] : []),
        ...(bundledRuntimes.length === 0 ? [dirname(nodePath)] : []),
      ]),
    ],
    // 沙箱 PATH 前置：bin 目录（与上面 readRoots 成对，缺了按名字找不到 python）。
    runtimePathAdditions: bundledRuntimes.length
      ? [...new Set(bundledRuntimes.map((root) => root.binDir))]
      : [],
    windowsBrokerPath:
      nativeCandidates.find((path) => existsSync(path)) ??
      join(dirname(helperPath), "process-broker.exe"),
  };
}
