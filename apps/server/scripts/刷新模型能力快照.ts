/**
 * 刷新 models.dev 能力快照（非 CI 脚本，docs/future/05 §4/§11）。
 *
 * 用法（仓库根或 apps/server 下）：
 *   pnpm --filter @kenfutwork/server exec tsx scripts/刷新模型能力快照.ts
 *   pnpm --filter @kenfutwork/server exec tsx scripts/刷新模型能力快照.ts --from /path/to/api.json
 *
 * 流程：拉取（或读取本地文件）→ 白名单裁剪 + camelCase 投影 → zod 自检 → 写盘。
 * 上游不可达时传 --from 指向本地缓存文件即可离线刷新。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildModelsDevSnapshot,
  modelsDevSnapshotSchema,
  renderSnapshotModule,
} from "../src/features/model-providers/models-dev-snapshot.js";

const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const from = argValue("--from") ?? "https://models.dev/api.json";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const out = resolve(
  scriptDir,
  argValue("--out") ?? "../src/features/model-providers/models-dev.snapshot.ts",
);

async function loadRaw(): Promise<unknown> {
  if (/^https?:\/\//.test(from)) {
    const response = await fetch(from);
    if (!response.ok) {
      throw new Error(`拉取 ${from} 失败：HTTP ${response.status}`);
    }
    return await response.json();
  }
  return JSON.parse(readFileSync(resolve(process.cwd(), from), "utf8"));
}

try {
  const raw = await loadRaw();
  const { snapshot, stats } = buildModelsDevSnapshot(raw);
  modelsDevSnapshotSchema.parse(snapshot);
  writeFileSync(out, renderSnapshotModule(snapshot), "utf8");
  console.log(`快照已写入 ${out}`);
  console.log(
    `providers：保留 ${stats.providersKept}（白名单外/缺席跳过，原始数据 ${stats.providersKept + stats.providersDropped} 个）；models：${stats.modelsKept} 个；体积：${(stats.bytes / 1024).toFixed(0)} KB（目标 < 500 KB）`,
  );
} catch (error) {
  console.error(
    `刷新失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
