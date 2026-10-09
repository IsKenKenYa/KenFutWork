/**
 * 随包运行时的**锁定表**（`runtime-lock.json`）读写与对账。
 *
 * 为什么要有它：`fetch-runtimes.mjs` 里 python / uv / jdk / git 都是「解析最新发布」
 *（`resolvePythonAsset`、`resolveUvAsset`、Adoptium `latest`、MinGit 正则），于是
 * **同一个 commit 在两台打包机或隔两天出包，装进包里的东西可以不一样**，而官方校验值
 * 只保证「下到的东西等于上游给的哈希」，不保证「等于上次那次出包用的那个版本」。
 * CI 出包要能复现、缓存 key 要能表达内容，就必须把这层不确定性显式落成一份 lock。
 *
 * 口径：lock 里有的条目一律严格对账，不符即拒绝出包（《AGENTS.md》配置 fail loud）；
 * 升级运行时是**显式动作**——重跑 `node scripts/fetch-runtimes.mjs --write-lock` 再提交。
 * lock 里没有的条目沿用解析结果（过渡态，本机开发不受影响）。
 *
 * 纯函数模块，被 `scripts/fetch-runtimes.mjs` 消费，对账规则由
 * `tests/workspace.test.mjs` 用夹具直接验，不需要联网。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE_NAME = "runtime-lock.json";
export const LOCK_SCHEMA = 1;

/** 读 lock；文件不存在返回 null（不是错误——本机开发允许无 lock 跑）。 */
export function readRuntimeLock(root) {
  const file = join(root, LOCK_FILE_NAME);
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${LOCK_FILE_NAME} 不是合法 JSON，修好或删掉再出包：${error.message}`,
    );
  }
  if (parsed?.schema !== LOCK_SCHEMA || typeof parsed.targets !== "object") {
    throw new Error(
      `${LOCK_FILE_NAME} 结构不符（需要 schema=${LOCK_SCHEMA} 与 targets 表），请用 --write-lock 重新生成。`,
    );
  }
  return parsed;
}

/** 取某目标平台某运行时的锁定条目（没有则 null）。 */
export function lockEntryFor(lock, target, name) {
  if (!lock) return null;
  return lock.targets?.[target]?.[name] ?? null;
}

/**
 * 解析后、下载前比对资产名（同一哈希不会改名；版本跳变通常名字先变）。
 * 拿不到名字（如 Adoptium 的 `latest` 直链）时放行，交给下载后的哈希比对兜底。
 */
export function assertLockAssetName({ entry, fileName, name, target }) {
  if (!entry?.fileName || !fileName || entry.fileName === fileName) {
    return { ok: true, reason: "" };
  }
  return {
    ok: false,
    reason:
      `${target} 的 ${name} 资产名与 ${LOCK_FILE_NAME} 不一致：` +
      `锁定 ${entry.fileName}，解析到 ${fileName}` +
      "（上游发了新版本；确认要升就重跑 `node scripts/fetch-runtimes.mjs --write-lock` 并提交）",
  };
}

/** 下载并算完哈希后的严格对账。`entry` 为空即「无锁定条目」，沿用解析结果。 */
export function assertLockSha({ entry, sha256, name, target }) {
  if (!entry) {
    return {
      ok: true,
      reason: `${target} 的 ${name} 无锁定条目，沿用解析结果`,
    };
  }
  if (!entry.sha256) {
    return {
      ok: true,
      reason: `${target} 的 ${name} 锁定条目没有哈希，只比对资产名`,
    };
  }
  if (entry.sha256 !== sha256) {
    return {
      ok: false,
      reason:
        `${target} 的 ${name} 与 ${LOCK_FILE_NAME} 哈希不一致：` +
        `锁定 ${String(entry.sha256).slice(0, 12)}…，实际 ${String(sha256).slice(0, 12)}…` +
        "（内容变了；确认要升后跑 `node scripts/fetch-runtimes.mjs --write-lock` 并提交）",
    };
  }
  return { ok: true, reason: `${target} 的 ${name} 命中锁定条目` };
}

/** 组一条 lock 记录（缺字段就留 null，不编）。 */
export function buildLockEntry({ version, fileName, sha256, url }) {
  return {
    version: version ?? null,
    fileName: fileName ?? null,
    sha256: sha256 ?? null,
    url: url ?? null,
  };
}

/** 合并写：只覆盖本次目标平台的条目，另一台打包机的条目保持不动。 */
export function mergeLockTargets(lock, target, entries) {
  const base =
    lock && lock.schema === LOCK_SCHEMA
      ? lock
      : { schema: LOCK_SCHEMA, targets: {} };
  return {
    ...base,
    targets: { ...base.targets, [target]: entries },
  };
}
