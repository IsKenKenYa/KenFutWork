import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRuntime, runtimeLayout } from "../../desktop/runtimes.js";
import { ProcessSandboxError } from "./types.js";

/** Profile 私有启动资源；不接受模型路径，不另造运行时配置或目录真相。 */
export function resolveProcessRuntime(input: {
  resourceRoot: string;
  env: Record<string, string | undefined>;
  sourceHelperPath?: string;
}) {
  const bundledNode = resolveRuntime("node", {
    env: input.env,
    exeDir: input.resourceRoot,
  });
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
    runtimeReadRoots: bundledNode ? [bundledNode.homeDir] : [dirname(nodePath)],
    windowsBrokerPath:
      nativeCandidates.find((path) => existsSync(path)) ??
      join(dirname(helperPath), "process-broker.exe"),
  };
}
