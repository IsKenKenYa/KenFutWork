/**
 * 诊断脚本（不被 CI 调用）：对真实 dsh 插件跑本项目的兼容性门禁。
 *
 * 用途：回答「我们的门禁对实际生态里的 dsh 插件到底判成什么」，
 * 而不是只看我们自己造的夹具。数据源为 skillhub 的 DSH 插件目录（公开免鉴权）。
 *
 * 用法：pnpm --filter @kenfutwork/server exec tsx scripts/verify-dsh-plugins.ts [数量]
 */

import { fetchBundleFiles } from "../src/features/plugins/bundle-source.js";
import { validateBundleFiles } from "../src/features/plugins/compat-validator.js";

interface CatalogPlugin {
  fullName: string;
  repositoryUrl: string;
  description: string;
  categoryKey: string | null;
  installability: string | null;
  headSha: string | null;
}

const CATALOG_URL = "https://api.skillhub.cn/api/v1/plugins?pageSize=30";

async function loadCatalog(limit: number): Promise<CatalogPlugin[]> {
  const response = await fetch(CATALOG_URL);
  if (!response.ok) {
    throw new Error(`skillhub 目录请求失败：${response.status}`);
  }
  const payload = (await response.json()) as { items?: CatalogPlugin[] };
  return (payload.items ?? []).slice(0, limit);
}

async function main(): Promise<void> {
  const limit = Number.parseInt(process.argv[2] ?? "6", 10);
  const catalog = await loadCatalog(limit);
  console.log(`目录取到 ${catalog.length} 个 DSH 插件，逐个跑门禁：\n`);

  let passed = 0;
  let blocked = 0;
  let unreachable = 0;

  for (const plugin of catalog) {
    process.stdout.write(`— ${plugin.fullName} (${plugin.categoryKey}) … `);
    try {
      const { files, origin } = await fetchBundleFiles(plugin.repositoryUrl);
      const report = validateBundleFiles(files, {
        hostNodeMajor: 22,
        allowLifecycleScripts: false,
        fallbackName: plugin.fullName,
      });

      if (report.compatible) {
        passed += 1;
        console.log("可安装");
      } else {
        blocked += 1;
        console.log("拦截");
      }
      console.log(
        `  能力：支持 [${report.supportedCapabilities.join(", ") || "-"}] / 缺 [${report.unsupportedCapabilities.join(", ") || "-"}]`,
      );
      for (const item of report.issues) {
        console.log(
          `  ${item.severity === "blocker" ? "[blocker]" : "[warn]"} ${item.code}：${item.message}`,
        );
        if (item.detail) {
          console.log(
            `      ${item.detail.split("\n").join("\n      ").slice(0, 400)}`,
          );
        }
      }
      console.log(
        `  来源：${origin.label}${origin.headSha ? ` (sha ${origin.headSha.slice(0, 7)})` : ""}`,
      );
    } catch (error) {
      unreachable += 1;
      console.log(
        `无法获取：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log("");
  }

  console.log(
    `汇总：可安装 ${passed} / 拦截 ${blocked} / 不可达 ${unreachable}（共 ${catalog.length}）`,
  );
}

await main();
