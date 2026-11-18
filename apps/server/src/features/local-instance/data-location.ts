import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

type Entry = {
  path: string;
  kind: "file" | "directory" | "symlink";
  content: string;
};

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function manifest(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const stat = await lstat(path);
      const entryPath = relative(root, path);
      if (stat.isDirectory()) {
        entries.push({ path: entryPath, kind: "directory", content: "" });
        await walk(path);
      } else if (stat.isFile()) {
        entries.push({
          path: entryPath,
          kind: "file",
          content: await fileHash(path),
        });
      } else if (stat.isSymbolicLink()) {
        const { readlink } = await import("node:fs/promises");
        entries.push({
          path: entryPath,
          kind: "symlink",
          content: await readlink(path),
        });
      } else {
        throw new Error(
          `数据目录含不能备份的运行时文件：${entryPath}，请确认全部服务已停止。`,
        );
      }
    }
  };
  await walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** 指针必须留在系统配置目录；不允许将它卷入源目录或目标目录。 */
export async function validateDataLocationMove(input: {
  source: string;
  target: string;
  pointerFile: string;
}): Promise<{ source: string; target: string; pointerFile: string }> {
  if (![input.source, input.target, input.pointerFile].every(isAbsolute)) {
    throw new Error("数据目录与配置指针必须使用绝对路径。");
  }
  const source = await realpath(input.source);
  const target = resolve(input.target);
  const pointerFile = resolve(input.pointerFile);
  if (contains(source, target) || contains(target, source)) {
    throw new Error("目标数据目录不能与当前目录相同，也不能互相包含。");
  }
  if (contains(source, pointerFile) || contains(target, pointerFile)) {
    throw new Error("配置指针必须位于应用数据目录之外。");
  }
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || (await readdir(target)).length !== 0) {
      throw new Error("目标数据目录必须不存在或为空目录，不会合并现有文件。");
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  // 解析最近的已有父目录，拒绝经符号链接重新进入源数据目录。
  let parent = dirname(target);
  let suffix = basename(target);
  while (true) {
    try {
      const canonicalTarget = join(await realpath(parent), suffix);
      if (
        contains(source, canonicalTarget) ||
        contains(canonicalTarget, source)
      ) {
        throw new Error("目标目录经符号链接指向当前数据目录，不能移动。");
      }
      return { source, target: canonicalTarget, pointerFile };
    } catch (error) {
      if (!missing(error)) throw error;
      suffix = join(basename(parent), suffix);
      parent = dirname(parent);
    }
  }
}

async function assertStopped(source: string): Promise<void> {
  try {
    await lstat(join(source, "postgres", "postmaster.pid"));
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  throw new Error(
    "数据库尚未正常停止，不能复制数据目录。请先停止应用和数据库。",
  );
}

/** 原子替换单个配置文件；应用数据本身不删除、不覆盖。 */
export async function writeDataLocationPointer(
  pointerFile: string,
  dataDir: string,
): Promise<void> {
  await mkdir(dirname(pointerFile), { recursive: true, mode: 0o700 });
  const temporary = `${pointerFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ dataDir })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, pointerFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 仅在宿主关闭API/worker/PG后由离线命令调用。失败不切换指针，原目录永久保留。 */
export async function moveDataLocation(input: {
  source: string;
  target: string;
  pointerFile: string;
  /** 注入用于真实复制失败与内容损坏的回归验证。 */
  copy?: (source: string, destination: string) => Promise<void>;
}): Promise<{ dataDir: string; files: number }> {
  const plan = await validateDataLocationMove(input);
  await assertStopped(plan.source);
  const before = await manifest(plan.source);
  await mkdir(dirname(plan.target), { recursive: true });
  const staging = join(
    dirname(plan.target),
    `.${basename(plan.target)}-${randomUUID()}.moving`,
  );
  let published = false;
  try {
    await (
      input.copy ??
      ((source, destination) =>
        cp(source, destination, {
          recursive: true,
          errorOnExist: true,
          force: false,
          dereference: false,
          verbatimSymlinks: true,
        }))
    )(plan.source, staging);
    const [after, copied] = await Promise.all([
      manifest(plan.source),
      manifest(staging),
    ]);
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(before) !== JSON.stringify(copied)
    ) {
      throw new Error("数据目录复制校验失败，原目录与原配置均保留。");
    }
    await assertStopped(plan.source);
    try {
      await rmdir(plan.target);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await rename(staging, plan.target);
    published = true;
    await chmod(plan.target, (await lstat(plan.source)).mode & 0o777);
    await writeDataLocationPointer(plan.pointerFile, plan.target);
    return {
      dataDir: plan.target,
      files: before.filter((entry) => entry.kind === "file").length,
    };
  } finally {
    // 发布后若写指针失败，保留已校验副本供排障；指针仍指向源目录。
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

/** 启动失败时宿主回滚精确的旧指针，不要求它此前就存在。 */
export async function restoreDataLocationPointer(
  pointerFile: string,
  previous: string | null,
): Promise<void> {
  if (previous === null) {
    await rm(pointerFile, { force: true });
    return;
  }
  const parsed: unknown = JSON.parse(previous);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("dataDir" in parsed) ||
    typeof parsed.dataDir !== "string" ||
    !isAbsolute(parsed.dataDir)
  ) {
    throw new Error("原数据目录配置格式无效，拒绝写入回滚指针。");
  }
  await writeDataLocationPointer(pointerFile, parsed.dataDir);
}

export async function runDataLocationCommand(
  args: readonly string[],
): Promise<boolean> {
  const mode = args[0];
  if (mode !== "--move-data-location" && mode !== "--rollback-data-location")
    return false;
  const payload: unknown = JSON.parse(args[1] ?? "null");
  if (
    !payload ||
    typeof payload !== "object" ||
    !("pointerFile" in payload) ||
    typeof payload.pointerFile !== "string"
  ) {
    throw new Error("离线数据目录命令参数无效。");
  }
  if (mode === "--rollback-data-location") {
    if (
      !("previous" in payload) ||
      (payload.previous !== null && typeof payload.previous !== "string")
    )
      throw new Error("回滚命令缺少原配置。");
    await restoreDataLocationPointer(payload.pointerFile, payload.previous);
  } else {
    if (
      !("source" in payload) ||
      !("target" in payload) ||
      typeof payload.source !== "string" ||
      typeof payload.target !== "string"
    )
      throw new Error("移动命令缺少源目录与目标目录。");
    console.log(
      JSON.stringify(
        await moveDataLocation({
          source: payload.source,
          target: payload.target,
          pointerFile: payload.pointerFile,
        }),
      ),
    );
  }
  return true;
}
