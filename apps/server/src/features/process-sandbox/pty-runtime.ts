import { chmod, copyFile, cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type * as NodePty from "node-pty";
import { preparePtySessionInspector } from "./pty-native-runtime.js";
import { patchTaskPtyTail } from "./pty-native-tail.js";
import type { ProcessLimits } from "./types.js";
import { ProcessSandboxError } from "./types.js";

/** pnpm/native assets 的 mode 不作为执行事实；只修 Task 私有副本，不改共享依赖。 */
export async function loadTaskPtyRuntime(
  privateDirectory: string,
  limits: ProcessLimits,
): Promise<{ module: typeof NodePty; inspector?: string }> {
  const require = createRequire(import.meta.url);
  const source = dirname(dirname(require.resolve("node-pty")));
  const target = join(privateDirectory, "pty-runtime", "node-pty");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(join(source, "lib"), join(target, "lib"), { recursive: true });
  await copyFile(join(source, "package.json"), join(target, "package.json"));
  await copyFile(join(source, "LICENSE"), join(target, "LICENSE"));
  let copied = false;
  for (const relative of [
    "build/Release",
    "build/Debug",
    `prebuilds/${process.platform}-${process.arch}`,
  ]) {
    const from = join(source, relative);
    try {
      // 原包 loader 的搜索顺序；native module 缺失才换下一个位置。
      require(join(from, "pty.node"));
    } catch {
      continue;
    }
    const destination = join(target, relative);
    await cp(from, destination, { recursive: true });
    if (process.platform === "darwin")
      await chmod(join(destination, "spawn-helper"), 0o755);
    copied = true;
    break;
  }
  if (!copied)
    throw new ProcessSandboxError(
      "enforcement_unavailable",
      "node-pty 缺少可加载的 Unix native module。",
    );
  await patchTaskPtyTail(target);
  return {
    module: require(target) as typeof NodePty,
    ...(process.platform === "darwin"
      ? {
          inspector: await preparePtySessionInspector(privateDirectory, limits),
        }
      : {}),
  };
}
