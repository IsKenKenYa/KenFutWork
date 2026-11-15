import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export function verifyContextInventory() {
  const inventory = JSON.parse(
    readFileSync(
      resolve(root, "packages/context-insights-ui/来源清单.json"),
      "utf8",
    ),
  );
  const targets = new Set();
  for (const record of inventory.records) {
    if (
      targets.has(record.target) ||
      !/^[a-f0-9]{40}$/.test(record.sourceRevision) ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    )
      throw new Error(`上下文组件来源记录无效：${record.target}`);
    const path = resolve(root, record.target);
    if (
      !path.startsWith(root) ||
      (!record.target.startsWith("packages/context-insights-ui/vendor/") &&
        record.target !==
          "apps/web/src/components/workbench/zcode/host/contextInspectionIcons.ts")
    )
      throw new Error(`上下文组件来源路径无效：${record.target}`);
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (hash !== record.currentSha256)
      throw new Error(`上下文组件来源校验失败：${record.target}`);
    if (hash !== record.sha256 && !record.adaptations?.length)
      throw new Error(`上下文组件缺少修改说明：${record.target}`);
    targets.add(record.target);
  }
  return targets;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(
    `已核对 ${verifyContextInventory().size} 个上下文组件来源文件。\n`,
  );
}
