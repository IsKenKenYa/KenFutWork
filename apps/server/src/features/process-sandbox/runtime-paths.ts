import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
 * 随包运行时里要交给沙箱「可读」的那些。
 *
 * 为什么必须逐个列全：启动期 `runtimePathAdditions` 把 node/python/uv/java 的 bin 目录
 * 前置进了 sandbox PATH，但 PATH 只决定「找得到」，沙箱的读/执行授权决定「能不能跑」。
 * 此前这里只给了 Node 的根，于是 `python` 在沙箱里恒被拒（原《未做需求》#12，已收口：智能体能写
 * Python 却跑不了、Python MCP 服务器也注册不了）。git 不在列——它优先用宿主的，宿主
 * 没有时也走 PATH，且 git 自身不需要读运行时树。
 */
const BUNDLED_RUNTIME_NAMES: readonly RuntimeName[] = [
  "node",
  "python",
  "uv",
  "java",
];

/** Profile 私有启动资源；不接受模型路径，不另造运行时配置或目录真相。 */
export function resolveProcessRuntime(input: {
  resourceRoot: string;
  env: Record<string, string | undefined>;
  sourceHelperPath?: string;
}) {
  const bundledRuntimes = BUNDLED_RUNTIME_NAMES.map((name) =>
    resolveRuntime(name, { env: input.env, exeDir: input.resourceRoot }),
  ).filter((root): root is RuntimeRoot => root !== null);
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
    runtimeReadRoots: bundledRuntimes.length
      ? [...new Set(bundledRuntimes.map((root) => root.homeDir))]
      : [dirname(nodePath)],
    // 沙箱 PATH 前置：bin 目录（与上面 readRoots 成对，缺了按名字找不到 python）。
    runtimePathAdditions: bundledRuntimes.length
      ? [...new Set(bundledRuntimes.map((root) => root.binDir))]
      : [],
    windowsBrokerPath:
      nativeCandidates.find((path) => existsSync(path)) ??
      join(dirname(helperPath), "process-broker.exe"),
  };
}
