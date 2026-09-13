/**
 * 一次性数据导入：把首页示例/发现库的**素材二进制**从迁移前的云存储拉进本地 blob 目录。
 *
 * 背景（为什么需要它）：M2.1 把种子表里的绝对云 URL **本地化成相对对象引用**
 * （`project-assets/home-seeds/...`），但**二进制本身**从来没有落到本地（旧 Supabase
 * Storage 容器里也没有）——于是接线后的示例库能读出 36 条内容、图片却全是 404。
 * 本脚本按库里实际引用的对象集合，从迁移前记录的云端 origin 逐个下载，写成与
 * `local-fs` Provider 一致的布局（`<blobDir>/<bucket>/<objectPath>`）。
 *
 * 用法：
 *   pnpm --filter @loomic/server exec node --env-file=../../.env.local --import tsx \
 *     scripts/import-home-seeds.ts [--dry-run]
 *
 * 幂等：目标文件已存在且大小 > 0 时跳过；单个对象失败只记警告（不中断整批）。
 * 可重跑；`LOOMIC_SEED_SOURCE_BASE` 可覆盖来源 origin。
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Client } from "pg";

import { loadServerEnv } from "../src/config/env.js";

/** 迁移 `20260330000001_home_seeds_to_supabase_storage.sql` 记录的迁移前 origin。 */
const DEFAULT_SOURCE_BASE =
  "https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public";

type Row = Record<string, unknown>;

/**
 * 递归收集行内所有「对象引用」字符串。
 *
 * 形如 `project-assets/home-seeds/...`（bucket/对象路径）。必须递归——`input_mentions`
 * 是**对象数组**（`[{ name, type, imgSrc }]`），只扫一层会漏掉图标/输入图（实测漏了后
 * 页面上一半卡片图 404）。
 */
function collectRefs(rows: Row[]): string[] {
  const refs = new Set<string>();

  const walk = (value: unknown) => {
    if (typeof value === "string") {
      // 只收种子对象引用（排除标题/提示词等普通文本）
      if (/^[a-z0-9-]+\/home-seeds\/.+/.test(value)) {
        refs.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) {
        walk(item);
      }
    }
  };

  for (const row of rows) {
    walk(row);
  }
  return [...refs];
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const env = loadServerEnv();
  const blobDir = env.blobDir;
  if (!blobDir) {
    console.error("缺少 LOOMIC_BLOB_DIR（本地对象根目录）。");
    process.exit(1);
  }
  if (!env.databaseUrl) {
    console.error("缺少 LOOMIC_DATABASE_URL / DATABASE_URL。");
    process.exit(1);
  }

  const sourceBase = process.env.LOOMIC_SEED_SOURCE_BASE ?? DEFAULT_SOURCE_BASE;
  const client = new Client({ connectionString: env.databaseUrl });
  await client.connect();

  try {
    const { rows } = await client.query(
      `select image_urls, input_mentions from public.home_example_examples
        union all
       select array[cover_image_url, author_avatar_url], null
         from public.home_discovery_cases`,
    );

    const refs = collectRefs(rows as Row[]);
    console.log(`引用对象：${refs.length} 个；目标目录：${blobDir}`);

    let downloaded = 0;
    let skipped = 0;
    const failed: string[] = [];

    for (const ref of refs) {
      const target = join(blobDir, ...ref.split("/"));
      try {
        const existing = await stat(target).catch(() => null);
        if (existing && existing.size > 0) {
          skipped += 1;
          continue;
        }
        if (dryRun) {
          console.log(`[dry-run] 将下载 ${ref}`);
          continue;
        }

        const response = await fetch(`${sourceBase}/${ref}`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          failed.push(`${ref} (HTTP ${response.status})`);
          continue;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength === 0) {
          failed.push(`${ref} (空响应)`);
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        downloaded += 1;
      } catch (error) {
        failed.push(
          `${ref} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

    console.log(
      `完成：下载 ${downloaded}，跳过（已存在）${skipped}，失败 ${failed.length}`,
    );
    for (const item of failed.slice(0, 20)) {
      console.warn(`  ✗ ${item}`);
    }
    if (failed.length > 20) {
      console.warn(`  …另有 ${failed.length - 20} 条失败`);
    }
    process.exitCode = failed.length > 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

void main();
