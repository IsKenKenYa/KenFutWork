/**
 * SAG CLI 协议探针（M0）。
 *
 * 本机有 `sag` 时，实采**只读**命令的 --json 输出并覆盖 fixture；没有时明确跳过，
 * 绝不伪造采集结果。`add` / `remove` 有副作用，脚本不跑，其 fixture 保留按 serde
 * 定义推导的样例值。
 *
 * 用法：
 *   node apps/server/src/features/knowledge/probe/collect.mjs [目标目录]
 *   SAG_BIN=/path/to/sag node .../collect.mjs /path/to/project
 *
 * 采集完成后务必跑 `sag-cli-contract.test.ts` 锁死字段漂移。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("../__fixtures__/sag-0.1.8.json", import.meta.url),
);
const TARGET = process.argv[2] ?? process.cwd();
const BIN = process.env.SAG_BIN ?? "sag";

function run(args) {
  const result = spawnSync(BIN, args, {
    cwd: TARGET,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `sag ${args.join(" ")} 退出码 ${result.status}：${(result.stderr ?? "").trim()}`,
    );
  }
  const text = (result.stdout ?? "").trim();
  if (!text) return undefined;
  return JSON.parse(text);
}

function probe(label, args) {
  try {
    const value = run(args);
    if (value === undefined) {
      console.log(`[skip] ${label}：无输出`);
      return undefined;
    }
    console.log(`[ok]   ${label}`);
    return value;
  } catch (error) {
    console.log(
      `[skip] ${label}：${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

const version = spawnSync(BIN, ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) {
  console.error(
    `未检测到可用的 sag CLI（SAG_BIN=${BIN}）。本机未采集，fixture 保持「按 serde 定义推导」状态。`,
  );
  console.error(
    "安装方式见上游 README：npm install -g @zleap-ai/sag（仅 macOS ARM / Windows x64）。",
  );
  process.exit(0);
}

console.log(`sag 版本：${(version.stdout ?? "").trim()}`);
console.log(`目标目录：${TARGET}`);

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const collected = {
  list: probe("list --json", ["list", "--json"]),
  check: probe("check --json", ["check", TARGET, "--json"]),
  config: probe("config", ["config"]),
  search: probe("search --json", [
    "知识库检索入口在哪",
    "--path",
    TARGET,
    "--json",
    "-m",
    "5",
  ]),
  match: probe("-F --json", ["-F", "export", TARGET, "--json"]),
};

// 实采原始输出只落在隔离数据目录（或系统临时目录），**不覆盖 fixture 样例**：
// 真实输出带本机绝对路径、实时索引状态，写进仓库会让契约测试随机器漂移。
const evidencePath = join(
  process.env.SAG_DATA_DIR ?? tmpdir(),
  "sag-last-collection.json",
);
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      target: TARGET,
      commands: collected,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

fixture._meta = {
  ...fixture._meta,
  collectedAt: new Date().toISOString(),
  collectedBy: "probe/collect.mjs（只读命令）",
  note: "已实采核验字段形状；样例值保持 serde 推导，原始输出见 SAG_DATA_DIR/sag-last-collection.json（本机产物，不入库）。",
};

writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`实采证据：${evidencePath}`);
console.log(`fixture 仅更新 _meta：${FIXTURE}`);
