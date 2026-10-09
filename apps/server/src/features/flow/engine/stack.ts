import type { FlowEngineStackContainer } from "@kenfutwork/shared";

import { createProcessRunCommand, type RunCommand } from "./exec.js";

/**
 * 引擎栈容器清单：`docker compose -f <file> --profile dify ps --format json` 的
 * **运行期事实**（引擎信息页「各种各样的信息」里最实的那一块——容器在不在、健康不健康、
 * 端口映射是什么，全部来自 docker 自己报的，不猜配置文件）。
 *
 * 输出兼容两条口径：compose v2 老版本逐行 NDJSON、新版本单个 JSON 数组；两种都解析。
 * 查询失败（docker 不在/daemon 没起/compose 文件缺失）**不抛**——返回空清单 + 可读原因，
 * 让信息页如实展示「查不到」而不是整页崩。
 */

interface RawPsRow {
  Service?: string;
  Name?: string;
  State?: string;
  Health?: string;
  Publishers?: Array<{
    URL?: string;
    TargetPort?: number;
    PublishedPort?: number;
    Protocol?: string;
  }>;
}

export async function listEngineStackContainers(
  composeFile: string,
  options: { envFile?: string; run?: RunCommand } = {},
): Promise<{ containers: FlowEngineStackContainer[]; error?: string }> {
  const run = options.run ?? createProcessRunCommand({ timeoutMs: 15_000 });
  const result = await run("docker", [
    "compose",
    // 与安装同一口径：compose 文件要求注入密钥变量（缺了就整份文件插值失败），
    // 密钥文件由首次安装生成在数据目录（见 install.ts 的 ensureStackEnvFile）。
    ...(options.envFile ? ["--env-file", options.envFile] : []),
    "-f",
    composeFile,
    "--profile",
    "dify",
    "ps",
    "--format",
    "json",
  ]);
  if (result.code !== 0) {
    return {
      containers: [],
      error: `docker compose ps 失败（退出码 ${result.code}）：${
        result.stderr.toString("utf8").trim() || "无输出"
      }`,
    };
  }
  const text = result.stdout.toString("utf8").trim();
  if (!text) return { containers: [] };

  let rows: RawPsRow[];
  try {
    // 新版本输出单个 JSON 数组；老版本是逐行 NDJSON——先整体解、失败再逐行解。
    const parsed: unknown = JSON.parse(text);
    rows = Array.isArray(parsed) ? (parsed as RawPsRow[]) : [parsed as RawPsRow];
  } catch {
    rows = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed) as RawPsRow);
      } catch {
        // 单行解不出就跳过这一行（不让一行脏数据毁掉整张表）
      }
    }
  }

  const containers = rows
    .map((row): FlowEngineStackContainer => {
      const ports = (row.Publishers ?? [])
        .filter(
          (item) =>
            typeof item.TargetPort === "number" && item.TargetPort > 0,
        )
        .map((item) => {
          const protocol = item.Protocol || "tcp";
          // PublishedPort=0 = 只 expose 未发布到宿主：按 docker ps 自己的口径给
          // `5001/tcp`（而不是编一个 `127.0.0.1:0->…` 的假映射）；发布了的给完整映射。
          if (!item.PublishedPort) {
            return `${item.TargetPort}/${protocol}`;
          }
          const host =
            item.URL && item.URL !== "0.0.0.0" ? item.URL : "127.0.0.1";
          return `${host}:${item.PublishedPort}->${item.TargetPort}/${protocol}`;
        });
      return {
        service: row.Service ?? "(unknown)",
        name: row.Name ?? "(unknown)",
        state: row.State ?? "unknown",
        health: row.Health && row.Health !== "" ? row.Health : null,
        ports: [...new Set(ports)],
      };
    })
    .sort((a, b) => a.service.localeCompare(b.service));

  return { containers };
}
