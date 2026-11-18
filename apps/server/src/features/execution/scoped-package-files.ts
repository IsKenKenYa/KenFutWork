import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionScopeHandle } from "./scope-service.js";

/** Package discovery skips symlinks and excluded directories before entering them. */
export async function* scopedPackageFiles(
  scope: ExecutionScopeHandle,
  input: string,
  options: { skipDirectories: ReadonlySet<string>; signal?: AbortSignal },
): AsyncGenerator<string> {
  const root = await scope.resolvePath(input, "read");
  const queue = [root];
  let visited = 0;
  let metadataBytes = 0;
  while (queue.length) {
    options.signal?.throwIfAborted();
    const directory = queue.shift();
    if (!directory) break;
    if (++visited > scope.backend.limits.codeSearchMaxResults)
      throw new Error("包扫描目录数量超过工作区预算，请调整治理设置。");
    if ((await scope.resolvePath(directory, "read")) !== directory)
      throw new Error("包目录的真实路径在扫描期间改变。");
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if ((await scope.resolvePath(directory, "read")) !== directory)
      throw new Error("包目录的真实路径在扫描期间改变。");
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (
        entry.name.startsWith(".") ||
        options.skipDirectories.has(entry.name) ||
        entry.isSymbolicLink()
      )
        continue;
      metadataBytes += Buffer.byteLength(entry.name);
      if (metadataBytes > scope.backend.limits.codeSearchMaxBytes)
        throw new Error(
          "包扫描元数据超过工作区预算，请缩小授权目录或调整治理设置。",
        );
      const path = join(directory, entry.name);
      if ((await scope.resolvePath(path, "read")) !== path)
        throw new Error("包路径在扫描期间改变。");
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) yield path;
    }
  }
  await scope.resolvePath(root, "read");
  options.signal?.throwIfAborted();
}
