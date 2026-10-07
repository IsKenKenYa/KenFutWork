import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { executionEnvironment } from "./environment.js";
import type { ProcessSpawnRequest } from "./types.js";
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
  internalWriteRoots?: readonly string[];
}): Promise<NativeLaunch> {
  const scope = input.request.scope;
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
  const home = join(input.temporaryDirectory, "home");
  env.HOME ??= home;
  env.USERPROFILE ??= home;
  env.APPDATA ??= join(home, "AppData", "Roaming");
  env.LOCALAPPDATA ??= join(home, "AppData", "Local");
  env.TEMP = input.temporaryDirectory;
  env.TMP = input.temporaryDirectory;
  return {
    processId: input.processId,
    taskId: scope.taskId,
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
