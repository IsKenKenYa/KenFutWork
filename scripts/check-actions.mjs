/**
 * GitHub Actions 工作流的静态护栏，专拦「显示绿色但没干活」这一类失败。
 *
 * 为什么要有它（本轮实测撞了三次，全都是静默的）：
 *   - job 级 `if` 与 workflow 级 `concurrency` **拿不到 `matrix` 上下文**：表达式不报错，
 *     只是取到空值。后果是「选了 macos 时整个 job 被跳过」「四种语言的扫描互相取消」——
 *     Actions UI 上一片绿，一个包、一条告警都不产。
 *   - 被调用的复用工作流**只能收窄权限**：顶层写 `permissions: contents: read`，会把调用方
 *     为 rc 通道授予的 `write` 压回 read，`gh release create` 必然 403。
 *   - `pnpm dev` / `pnpm desktop` 在 CI 里必死：脚本写死 `--env-file=../../.env.local`，
 *     文件不存在 node 直接报错退出；且 dev 是 persistent 任务，会挂到超时。
 *
 * 规则：
 *   A1 job 级 `if:` 不得引用 `matrix.`
 *   A2 workflow 级 `concurrency.group` 不得引用 `matrix.`
 *   A3 `on: workflow_call` 的工作流不得写顶层 `permissions:`
 *   A4 不得在 run 里调用 `pnpm dev` / `pnpm desktop`
 *   A5 `permissions` 的取值不得是表达式，且只能是 read / write / none
 *      （本轮实测：写 `${{ ... && 'write' || 'read' }}` 会让整个文件解析失败——工作流名退化成
 *       文件路径、0 秒失败、连日志都没有，非查 API 看不出问题在哪）
 *   A6 有 `run:` 步骤的 job 至少要有一处显式 `shell:`（job 级 `defaults.run.shell` 最佳）
 *      隐式默认 shell 已咬过两次：Windows runner 是 PowerShell、容器 job 是 dash，
 *      两者都不认 `set -o pipefail`。口径是「整个 job 一个 shell 都没显式写」才报，
 *      逐步声明也算通过（不追求统计每个步骤都覆盖到）。
 *
 * 双入口：`pnpm test:actions` 直接跑；`tests/workspace.test.mjs` 导入 checkActions 挂门禁，
 * 并用夹具验「正例通过 / 每条负例各自被拦」——一个永远 PASS 的检查等于没有检查。
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** 去掉整行注释，避免把说明文字当成配置读进来。 */
function stripComment(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("#") ? "" : line;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** permissions 里可能出现的权限作用域名。 */
const SCOPE_KEYS = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "pages",
  "pull-requests",
  "security-events",
  "statuses",
]);

/** 读出一个工作流文件的结构信号：顶层键、job 级 if、concurrency.group、permissions 取值、workflow_call。 */
function inspectWorkflow(text) {
  const signals = {
    topLevelKeys: new Set(),
    hasWorkflowCall: false,
    jobIfs: [],
    concurrencyGroups: [],
    permissionLines: [],
    runBlobs: [],
    jobStats: new Map(),
  };
  let inOn = false;
  let inJobs = false;
  let inConcurrency = false;
  let currentJob = null;
  let currentStepRun = null;

  for (const raw of text.split("\n")) {
    const line = stripComment(raw);
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    const trimmed = line.trim();

    // `on:` 与 `run:` 是多行块，需要按缩进判断块的结束。
    if (indent === 0 && !trimmed.endsWith(":")) inOn = false;
    if (indent === 0) {
      const key = trimmed.split(":")[0];
      signals.topLevelKeys.add(key);
      inOn = key === "on";
      inJobs = key === "jobs";
      inConcurrency = key === "concurrency";
      currentJob = null;
      currentStepRun = null;
      continue;
    }
    // permissions 的作用域行：值必须是 read / write / none，且不许是表达式。
    const permissionMatch = /^([a-z-]+):\s*(.+)$/.exec(trimmed);
    if (permissionMatch && SCOPE_KEYS.has(permissionMatch[1])) {
      signals.permissionLines.push({
        scope: permissionMatch[1],
        value: permissionMatch[2].trim(),
      });
    }
    if (inOn && indent >= 2 && trimmed.startsWith("workflow_call")) {
      signals.hasWorkflowCall = true;
    }
    if (inConcurrency && indent === 2 && trimmed.startsWith("group:")) {
      signals.concurrencyGroups.push(trimmed.slice("group:".length).trim());
    }
    if (inJobs) {
      if (indent === 2 && trimmed.endsWith(":")) {
        currentJob = trimmed.slice(0, -1).trim();
        continue;
      }
      if (indent === 4 && trimmed.startsWith("if:")) {
        signals.jobIfs.push({
          job: currentJob,
          value: trimmed.slice("if:".length).trim(),
        });
      }
      // 统计该 job 的 run 步骤数与显式 shell 声明数（A6 用）。
      const key = currentJob ?? "(未命名 job)";
      const stats = signals.jobStats.get(key) ?? { runs: 0, shells: 0 };
      if (/^(-\s+)?run:/.test(trimmed)) stats.runs += 1;
      if (/^(-\s+)?shell:\s*\S/.test(trimmed)) stats.shells += 1;
      signals.jobStats.set(key, stats);
    }
    // run 块：`run: |` 之后的所有内容按缩进归入同一段。
    if (currentStepRun !== null && indent >= currentStepRun) {
      signals.runBlobs.push(trimmed);
      continue;
    }
    currentStepRun = null;
    const runMatch = /^(-\s+)?run:\s*(.*)$/.exec(trimmed);
    if (runMatch) {
      const value = runMatch[2].trim();
      if (value) signals.runBlobs.push(value);
      if (value === "|" || value === ">-" || value === ">" || value === "|-") {
        currentStepRun = indent + 2;
      }
    }
  }
  return signals;
}

export function checkActions({ rootDir }) {
  const errors = [];
  const workflowDir = join(rootDir, ".github", "workflows");
  if (!statSyncExists(workflowDir)) return { errors, files: [] };

  const files = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();

  for (const name of files) {
    const rel = relative(rootDir, join(workflowDir, name)).replaceAll(
      "\\",
      "/",
    );
    const signals = inspectWorkflow(
      readFileSync(join(workflowDir, name), "utf8"),
    );

    for (const entry of signals.jobIfs) {
      if (entry.value.includes("matrix.")) {
        errors.push(
          `${rel}: job「${entry.job}」的 \`if\` 引用了 matrix——job 级拿不到 matrix 上下文，表达式取空值会让整个 job 被静默跳过（平台过滤请放到用 inputs 表达的调用方）`,
        );
      }
    }
    for (const group of signals.concurrencyGroups) {
      if (group.includes("matrix.")) {
        errors.push(
          `${rel}: \`concurrency.group\` 引用了 matrix——workflow 级拿不到 matrix，取空值会让各矩阵分支互相取消`,
        );
      }
    }
    if (signals.hasWorkflowCall && signals.topLevelKeys.has("permissions")) {
      errors.push(
        `${rel}: 复用工作流写了顶层 \`permissions\`——被调方只能收窄，调用方授予的 write 会被压回 read，建 Release 会 403；权限交给调用方的 job 级 permissions`,
      );
    }
    for (const blob of signals.runBlobs) {
      const bad = /pnpm (?:--filter \S+ )?(dev|desktop)\b/.exec(blob);
      if (bad) {
        errors.push(
          `${rel}: run 里调了 \`pnpm ${bad[1]}\`——dev/desktop 写死 --env-file=../../.env.local，CI 里必失败（且 dev 是 persistent 任务）`,
        );
      }
      // A7：Actions 给 run 步骤的 shell 是 `bash -e -o pipefail`，命令非 0 时脚本当场
      // 结束，下一行的 `$?` 永远取不到——表现是「扫描器有公告就把本应只上报的 job 判红」
      // （实测红过一次）。actionlint 不查这层语义，只能自己拦。
      if (/^[A-Za-z_][A-Za-z0-9_]*=\$\?$/.test(blob)) {
        errors.push(
          `${rel}: run 里裸写「${blob}」取退出码——shell 带 -e，上一条命令非 0 时这一步已退出，$? 取不到；改成 \`var=0; cmd || var=$?\``,
        );
      }
    }
    for (const [job, stats] of signals.jobStats) {
      if (stats.runs > 0 && stats.shells === 0) {
        errors.push(
          `${rel}: job「${job}」有 ${stats.runs} 个 run 步骤却没有任何显式 shell——Windows runner 默认 PowerShell、容器 job 默认 dash，都不认 set -o pipefail；请加 job 级 defaults.run.shell: bash`,
        );
      }
    }
    for (const permission of signals.permissionLines) {
      if (permission.value.includes("${{")) {
        errors.push(
          `${rel}: permissions 的 ${permission.scope} 写了表达式——该键只接受 read / write / none，含表达式会让整个文件解析失败（工作流名退化成文件路径、0 秒失败且无日志）`,
        );
        continue;
      }
      if (!["read", "write", "none"].includes(permission.value)) {
        errors.push(
          `${rel}: permissions 的 ${permission.scope} 取值「${permission.value}」不在 read / write / none 之内`,
        );
      }
    }
  }
  return { errors, files };
}

function statSyncExists(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { errors, files } = checkActions({ rootDir: process.cwd() });
  if (files.length === 0) {
    console.log("[actions] 没有 .github/workflows 可校验（跳过，不算失败）");
    process.exit(0);
  }
  if (errors.length > 0) {
    console.error(
      `[actions] ${files.length} 个工作流，${errors.length} 处问题：`,
    );
    for (const line of errors) console.error(`  - ${line}`);
    process.exit(1);
  }
  // 通用 YAML / 表达式 / action 参数校验交给 actionlint（它自带 Schema，且在 PATH 上有
  // shellcheck 时顺带把 run: 里的脚本一起查）。自研解析器只保留上面那 6 条「Actions 官方
  // 文档不会报错、但会让 job 静默不干活」的规则——继续往里堆通用解析就是在造第二个 actionlint。
  const lint = runActionlint();
  if (lint === "missing" && process.env.CI === "true") {
    console.error(
      "[actions] CI 里没找到 actionlint——静态门禁退化成 6 条自研规则等于没拦表达式类错误",
    );
    process.exit(1);
  }
  if (lint === "failed") process.exit(1);
  console.log(
    `[actions] ${files.length} 个工作流通过护栏${lint === "passed" ? "与 actionlint" : ""}`,
  );
}

/** @returns {"passed" | "failed" | "missing" | "skipped"} */
function runActionlint() {
  const binary = findBinary();
  if (!binary) return process.platform === "win32" ? "skipped" : "missing";
  const result = spawnSync(binary, [], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, RUNNER_TEMP: process.env.RUNNER_TEMP ?? "" },
  });
  if (result.status === 0) return "passed";
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  console.error(`[actionlint] 发现问题：\n${output}`);
  return "failed";
}

function findBinary() {
  for (const name of ["actionlint", "/usr/local/bin/actionlint"]) {
    const result = spawnSync(name, ["-version"], {
      encoding: "utf8",
      stdio: "ignore",
    });
    if (!result.error && result.status === 0) return name;
  }
  return null;
}
