import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { ProcessSandboxError } from "./types.js";

export function pathWithin(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return (
    remainder === "" ||
    (remainder !== ".." &&
      !remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(remainder))
  );
}

export async function commandDirectory(
  scope: CodeExecutionScope,
  requested?: string,
): Promise<string> {
  const path = await realpath(resolve(scope.rootDirectory, requested ?? "."));
  const roots = [
    scope.rootDirectory,
    ...scope.additionalDirectories.map((directory) => directory.path),
  ];
  const canonical = await Promise.all(roots.map((root) => realpath(root)));
  if (!canonical.some((root) => pathWithin(path, root))) {
    throw new ProcessSandboxError(
      "invalid_process_request",
      "命令 cwd 不在 Task 的授权目录中。",
    );
  }
  return path;
}

/** 平台启动器/动态库的固定读取基线；项目目录授权仍来自 scope。 */
export function unixRuntimeReadRoots(extra: readonly string[] = []): string[] {
  const packageEntry = createRequire(import.meta.url).resolve(
    "@anthropic-ai/sandbox-runtime",
  );
  return [
    ...new Set([
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/dev",
      "/proc",
      "/run",
      "/etc",
      "/private/etc",
      "/System",
      "/Library",
      // Darwin 的 /bin/sh 经此系统 selector 解析；只允许系统 selector，不放开 /var。
      "/var/select",
      "/private/var/select",
      dirname(process.execPath),
      dirname(dirname(packageEntry)),
      ...extra,
    ]),
  ];
}

/** 同一 inode 的 Darwin 系统别名；只派生获准子目录，不授予别名的整个父树。 */
function directorySpellings(path: string): string[] {
  if (process.platform !== "darwin") return [path];
  for (const prefix of ["/var", "/tmp", "/etc"]) {
    const canonical = `/private${prefix}`;
    if (pathWithin(path, canonical))
      return [path, path.replace(canonical, prefix)];
    if (pathWithin(path, prefix)) return [path, `/private${path}`];
  }
  return [path];
}

export async function unixPolicy(input: {
  scope: CodeExecutionScope;
  temporaryDirectory: string;
  privateDirectory: string;
  runtimeReadRoots?: readonly string[];
  network: {
    allowedDomains: readonly string[];
    deniedDomains: readonly string[];
  };
  internalWriteRoots?: readonly string[];
}): Promise<SandboxRuntimeConfig> {
  const root = await realpath(input.scope.rootDirectory);
  const additional = await Promise.all(
    input.scope.additionalDirectories.map(async (directory) => ({
      ...directory,
      path: await realpath(directory.path),
    })),
  );
  const writable =
    input.scope.sandboxMode === "read-only"
      ? []
      : [
          root,
          ...additional
            .filter((directory) => directory.access === "read-write")
            .map((directory) => directory.path),
        ];
  const readOnly = additional
    .filter((directory) => directory.access === "read-only")
    .map((directory) => directory.path);
  const temporaryDirectory = await realpath(input.temporaryDirectory);
  const privateDirectory = await realpath(input.privateDirectory);
  return {
    network: {
      allowedDomains: [...input.network.allowedDomains],
      deniedDomains: [...input.network.deniedDomains],
      strictAllowlist: true,
    },
    filesystem: {
      denyRead: ["/", ...directorySpellings(privateDirectory)],
      allowRead: [
        root,
        ...additional.map((directory) => directory.path),
        temporaryDirectory,
        ...(input.internalWriteRoots ?? []),
        ...unixRuntimeReadRoots(input.runtimeReadRoots),
      ].flatMap(directorySpellings),
      allowWrite: [
        ...writable,
        temporaryDirectory,
        ...(input.internalWriteRoots ?? []),
      ].flatMap(directorySpellings),
      denyWrite: [
        privateDirectory,
        "/tmp/claude",
        "/private/tmp/claude",
        ...readOnly,
      ].flatMap(directorySpellings),
      allowGitConfig: true,
    },
    allowAppleEvents: false,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
  };
}
