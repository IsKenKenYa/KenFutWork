import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";

const prefix = "references/zcode/";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commitPattern = /^[a-f0-9]{40}$/u;
function canonicalPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    !value.endsWith("/") &&
    !/[\r\n\0\\]/u.test(value) &&
    !posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    !value.startsWith("../")
  );
}
export function readZcodeInventory(root) {
  const inventory = JSON.parse(
    readFileSync(join(root, "docs/源码来源/ZCode源码清单.json"), "utf8"),
  );
  if (
    !commitPattern.test(inventory.revision) ||
    typeof inventory.version !== "string" ||
    !Array.isArray(inventory.records) ||
    !inventory.records.length
  )
    throw new Error("ZCode 清单缺少有效提交、版本或来源记录。");
  const targets = new Set();
  for (const record of inventory.records) {
    if (
      !canonicalPath(record.source) ||
      !record.source.startsWith(prefix) ||
      !canonicalPath(record.target) ||
      !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      !/^[a-f0-9]{64}$/u.test(record.copiedSha256) ||
      targets.has(record.target)
    )
      throw new Error(`ZCode 清单记录无效或目标重复：${record.target}`);
    targets.add(record.target);
  }
  return inventory;
}
function git(repo, args, options = {}) {
  return spawnSync("git", ["-C", repo, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}
function requireReferenceRepository(repo) {
  const top = git(repo, ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (
    top.status !== 0 ||
    realpathSync(top.stdout.trim()) !== realpathSync(repo)
  )
    throw new Error(
      "ZCode 参考仓未初始化，请执行 git submodule update --init references/zcode。",
    );
}
/** Fetch objects only; never checkout, reset, or update the reference repository's branch refs. */
export function prepareZcodeBaseline(repo, revision) {
  if (!commitPattern.test(revision)) throw new Error("ZCode 清单提交无效。");
  requireReferenceRepository(repo);
  if (git(repo, ["cat-file", "-e", `${revision}^{commit}`]).status === 0)
    return;
  const fetched = git(
    repo,
    ["fetch", "--no-tags", "--no-write-fetch-head", "origin", revision],
    { encoding: "utf8" },
  );
  if (
    fetched.status !== 0 ||
    git(repo, ["cat-file", "-e", `${revision}^{commit}`]).status !== 0
  )
    throw new Error(
      `无法取得 ZCode 清单基线 ${revision}，请核对清单提交和上游访问。`,
    );
}
function commitSources(repo, revision, paths) {
  requireReferenceRepository(repo);
  if (git(repo, ["cat-file", "-e", `${revision}^{commit}`]).status !== 0)
    throw new Error(
      `缺少 ZCode 清单基线 ${revision}；请执行 node scripts/vendor-zcode.mjs --prepare-source。`,
    );
  const result = git(repo, ["cat-file", "--batch"], {
    input: paths.map((path) => `${revision}:${path}\n`).join(""),
  });
  if (result.status !== 0)
    throw new Error("读取 ZCode 清单基线的 Git 对象失败。");
  const sources = new Map();
  let offset = 0;
  for (const path of paths) {
    const end = result.stdout.indexOf(10, offset);
    const header = result.stdout.subarray(offset, end).toString("utf8");
    if (end < 0) throw new Error("ZCode Git 对象输出不完整。");
    offset = end + 1;
    if (header === `${revision}:${path} missing`) {
      sources.set(path, null);
      continue;
    }
    const match = /^[a-f0-9]+ blob (\d+)$/u.exec(header);
    if (!match) throw new Error(`ZCode 基线条目不是文件：${path}`);
    const size = Number(match[1]);
    if (
      !Number.isSafeInteger(size) ||
      offset + size >= result.stdout.length ||
      result.stdout[offset + size] !== 10
    )
      throw new Error(`ZCode Git 文件输出不完整：${path}`);
    sources.set(path, result.stdout.subarray(offset, offset + size));
    offset += size + 1;
  }
  return sources;
}
/** Retain Windows checkout compatibility for explicit source mirrors; target bytes stay exact. */
function matchesSource(bytes, expected) {
  return (
    bytes !== null &&
    (sha(bytes) === expected ||
      (!bytes.includes(0) &&
        sha(Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"))) ===
          expected))
  );
}
export function verifyZcodeInventory({ root, sourceRoot, prepare = false }) {
  const inventory = readZcodeInventory(root);
  const donor = join(sourceRoot ?? root, "references/zcode");
  if (prepare && sourceRoot)
    throw new Error("--prepare-source 不能与 --source-root 同时使用。");
  if (prepare) prepareZcodeBaseline(donor, inventory.revision);
  const paths = [
    ...new Set([
      "package.json",
      ...inventory.records.map((record) => record.source.slice(prefix.length)),
    ]),
  ];
  const sources = sourceRoot
    ? new Map(
        paths.map((path) => [
          path,
          existsSync(join(donor, path))
            ? readFileSync(join(donor, path))
            : null,
        ]),
      )
    : commitSources(donor, inventory.revision, paths);
  const manifest = sources.get("package.json");
  if (
    !manifest ||
    JSON.parse(manifest.toString("utf8")).version !== inventory.version
  )
    throw new Error("ZCode 清单版本与所声明提交的 package.json 不一致。");
  const drift = [];
  for (const record of inventory.records) {
    const target = join(root, record.target);
    const reasons = [];
    if (
      !matchesSource(
        sources.get(record.source.slice(prefix.length)) ?? null,
        record.sha256,
      )
    )
      reasons.push("清单基线来源不符");
    if (!existsSync(target)) reasons.push("副本缺失");
    else if (sha(readFileSync(target)) !== record.copiedSha256)
      reasons.push("副本字节漂移");
    if (reasons.length) drift.push({ target: record.target, reasons });
  }
  return { inventory, drift };
}
