import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { accountEnvironment } from "./account-command.js";
import { executionEnvironment, prependExecutionPath } from "./environment.js";
import type { SandboxProcessRequest as ProcessSpawnRequest } from "./types.js";
import type { NativeLaunch } from "./windows-broker.js";
import { windowsCommand } from "./windows-broker.js";

export async function windowsLaunch(input: {
  request: ProcessSpawnRequest;
  processId: string;
  cwd: string;
  privateDirectory: string;
  temporaryDirectory: string;
  brokerPath: string;
  runtimeReadRoots?: readonly string[];
  runtimePathAdditions?: readonly string[];
  internalWriteRoots?: readonly string[];
  accountHome?: string;
}): Promise<NativeLaunch> {
  const scope = input.request.scope;
  if (scope.sandboxMode === "danger-full-access")
    return {
      unrestricted: true,
      processId: input.processId,
      taskId: scope.taskId,
      generation: scope.generation,
      command: windowsCommand(input.request),
      cwd: input.cwd,
      env: accountEnvironment(
        input.request,
        input.accountHome ?? homedir(),
        input.runtimePathAdditions,
      ),
      readRoots: [],
      writeRoots: [],
      denyRoots: [],
      yieldMs: input.request.limits.yieldMs,
      killGraceMs: input.request.limits.killGraceMs,
      liveStreams: input.request.stdio !== undefined,
      pty: input.request.pty ?? null,
      chunkBytes: Math.min(
        input.request.limits.maxOutputBytes,
        input.request.limits.previewMaxChars,
      ),
    };
  const root = await realpath(scope.rootDirectory);
  const extra = await Promise.all(
    scope.additionalDirectories.map(async (directory) => ({
      ...directory,
      path: await realpath(directory.path),
    })),
  );
  const readwrite =
    scope.sandboxMode === "read-only"
      ? []
      : [
          root,
          ...extra
            .filter((directory) => directory.access === "read-write")
            .map((directory) => directory.path),
        ];
  const runtime = [
    process.env.SystemRoot,
    process.env.WINDIR,
    // 系统盘根：cmd 的 `dir` 会取卷信息/枚举 `..`，没有盘根授权时整条 `dir` 直接
    // 报 `Access is denied.`（真机实测：同一写档作用域下 `cd`/`type`/node 的
    // `readdirSync` 全部正常，只有 cmd `dir` 被拒）。只读授权，不扩大写域。
    process.env.SystemDrive ? `${process.env.SystemDrive}\\` : undefined,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    dirname(process.execPath),
    dirname(input.brokerPath),
    ...(input.runtimeReadRoots ?? []),
  ].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
  const existingRuntime: string[] = [];
  for (const path of new Set(runtime)) {
    try {
      if ((await stat(path)).isDirectory())
        existingRuntime.push(await realpath(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const env = executionEnvironment(process.env, input.request.env);
  // 随包运行时 bin 目录前置进 PATH：宿主机没装 python/node 也能按名字跑。
  // 与下面的 readRoots 成对——只给 readRoots 时命令名解析不到（原《未做需求》#12，已收口）。
  prependExecutionPath(env, input.runtimePathAdditions);
  const home = join(input.temporaryDirectory, "home");
  env.HOME ??= home;
  env.USERPROFILE ??= home;
  env.APPDATA ??= join(home, "AppData", "Roaming");
  env.LOCALAPPDATA ??= join(home, "AppData", "Local");
  env.TEMP = input.temporaryDirectory;
  env.TMP = input.temporaryDirectory;
  return {
    processId: input.processId,
    ...("kind" in scope
      ? {
          projectOwner: {
            kind: scope.kind,
            leaseId: scope.leaseId,
            instanceId: scope.instanceId,
            projectId: scope.projectId,
            connectionId: scope.connectionId,
            revision: scope.revision,
          },
        }
      : { taskId: scope.taskId }),
    generation: scope.generation,
    command: windowsCommand(input.request),
    cwd: input.cwd,
    env,
    readRoots: [
      ...new Set([
        root,
        ...extra.map((directory) => directory.path),
        ...existingRuntime,
      ]),
    ].filter((path) => !readwrite.includes(path)),
    writeRoots: [
      ...new Set([
        ...readwrite,
        input.temporaryDirectory,
        ...(input.internalWriteRoots ?? []),
      ]),
    ],
    denyRoots: [input.privateDirectory],
    yieldMs: input.request.limits.yieldMs,
    killGraceMs: input.request.limits.killGraceMs,
    liveStreams: input.request.stdio !== undefined,
    pty: input.request.pty ?? null,
    chunkBytes: Math.min(
      input.request.limits.maxOutputBytes,
      input.request.limits.previewMaxChars,
    ),
  };
}
