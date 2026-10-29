import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 内置（随仓库分发）的 web 编辑器站点：启动时落位到实例数据目录。
 *
 * 为什么单独一条路径：ArtCraft 系列是从上游 release 下载的扩展包；EDA 是我们自建的
 * web 编辑器（KiCad 没有 web 构建），没有可锚定的上游产物，也不该让用户去点下载。
 * 它和下载来的包共用同一个落位目录与静态托管，所以 `installed` 的判定方式不变。
 *
 * 幂等：按目录内容哈希写落位标记，内容没变就不动（避免每次启动重写把正在用的文件
 * 换掉）；变了整体替换（staging + rename，不留半截站点）。
 */

const MARKER = ".kenfutwork-builtin.json";

/** 随仓库分发的编辑器 id；注册表里这些条目的 `pinned` 为 null。 */
export const BUILTIN_EDITOR_IDS = ["kicad"] as const;
export type BuiltinEditorId = (typeof BUILTIN_EDITOR_IDS)[number];

/** 内置站点源目录（`apps/server/assets/work-editors`，源码与构建产物都是这个相对位置）。 */
export function builtinEditorsRoot(): string {
  return fileURLToPath(new URL("../../../assets/work-editors/", import.meta.url));
}

function hashTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string, rel: string): void => {
    const entries = readdirSync(current).sort();
    for (const name of entries) {
      const full = join(current, name);
      const child = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) {
        walk(full, child);
        continue;
      }
      hash.update(child);
      hash.update("\0");
      hash.update(readFileSync(full));
      hash.update("\0");
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

/**
 * 落位全部内置编辑器。返回实际写入的 id（内容未变的不返回）。
 * 源目录缺失（裁剪过的产物）就跳过——不静默删掉用户已有的落位目录。
 */
export function ensureBuiltinEditors(editorsDir: string): BuiltinEditorId[] {
  const root = builtinEditorsRoot();
  const written: BuiltinEditorId[] = [];
  for (const id of BUILTIN_EDITOR_IDS) {
    const source = join(root, id);
    if (!existsSync(source)) continue;
    const target = join(editorsDir, id);
    const digest = hashTree(source);
    const markerPath = join(target, MARKER);
    if (existsSync(markerPath)) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { hash?: string };
        if (marker.hash === digest) continue;
      } catch {
        // 标记坏了就当没落位，重写一遍。
      }
    }
    mkdirSync(editorsDir, { recursive: true });
    const staging = `${target}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(source, staging, { recursive: true });
    writeFileSync(
      join(staging, MARKER),
      `${JSON.stringify({ id, kind: "kenfutwork-builtin", hash: digest }, null, 2)}\n`,
    );
    rmSync(target, { recursive: true, force: true });
    cpSync(staging, target, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    written.push(id);
  }
  return written;
}

/** EDA 原理图文档路径（实例数据目录；编辑器与 agent 读写同一份）。 */
export function workEdaDocumentPath(dataDir: string): string {
  return join(dataDir, "work", "eda", "schematic.kicad_sch");
}

/** 写原理图文档（先建目录，再整体替换，不留半截文件）。 */
export async function writeWorkEdaDocument(dataDir: string, text: string): Promise<void> {
  const target = workEdaDocumentPath(dataDir);
  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.staging-${process.pid}`;
  await writeFile(staging, text, "utf8");
  await rename(staging, target);
}
