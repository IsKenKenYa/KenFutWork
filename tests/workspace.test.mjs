import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkDocs, updateFrozenLock } from "../scripts/check-docs.mjs";

const execFileAsync = promisify(execFile);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, "..");

// Enumerate actual apps instead of hardcoding names, so the test survives
// apps being added or removed (e.g., the removed desktop app).
const appNames = readdirSync(path.join(rootDir, "apps"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

async function readJson(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function readText(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  return readFile(filePath, "utf8");
}

test("root manifest exposes dev, build, test, and lint scripts", async () => {
  const manifest = await readJson("package.json");

  assert.equal(typeof manifest.scripts?.dev, "string");
  assert.equal(typeof manifest.scripts?.build, "string");
  assert.equal(typeof manifest.scripts?.test, "string");
  assert.equal(typeof manifest.scripts?.lint, "string");
});

test("workspace includes apps and packages globs", async () => {
  const workspace = await readText("pnpm-workspace.yaml");

  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);
});

test("root test command wires node:test and turbo package tests", async () => {
  const manifest = await readJson("package.json");

  assert.match(manifest.scripts["test:workspace"], /node --test/);
  assert.match(manifest.scripts["test:packages"], /turbo run test/);
  assert.match(manifest.scripts.test, /test:workspace/);
  assert.match(manifest.scripts.test, /test:packages/);
});

test("vitest root config exists for later package-level adoption", async () => {
  const vitestConfig = await readText("vitest.config.mjs");

  // Vitest 4 removed defineWorkspace/vitest.workspace.ts in favor of
  // `test.projects` declared in a root vitest config.
  assert.match(vitestConfig, /defineConfig/);
  assert.match(vitestConfig, /projects/);
  assert.match(vitestConfig, /tests\/\*\*\/\*\.test\.mjs/);
});

for (const appName of appNames) {
  test(`${appName} app scripts perform real validation instead of placeholder logs`, async () => {
    const manifest = await readJson(`apps/${appName}/package.json`);

    assert.equal(typeof manifest.scripts?.build, "string");
    assert.equal(typeof manifest.scripts?.test, "string");
    assert.equal(typeof manifest.scripts?.typecheck, "string");
    assert.doesNotMatch(manifest.scripts.build, /placeholder/i);
    assert.doesNotMatch(manifest.scripts.build, /console\.log/);
    assert.doesNotMatch(manifest.scripts.test, /placeholder/i);
    assert.doesNotMatch(manifest.scripts.test, /console\.log/);
    assert.doesNotMatch(manifest.scripts.typecheck, /placeholder/i);
    assert.doesNotMatch(manifest.scripts.typecheck, /console\.log/);
  });
}

test("@loomic/config exports a single low-drift package contract", async () => {
  const source = await readText("packages/config/src/index.ts");

  assert.doesNotMatch(source, /apps\/\*/);
  assert.doesNotMatch(source, /packages\/\*/);
});

test("shared package placeholder exists for the upcoming contract task", async () => {
  const manifest = await readJson("packages/shared/package.json");

  assert.equal(manifest.name, "@loomic/shared");
  assert.equal(manifest.type, "module");
});

test("root lint baseline is wired through Biome", async () => {
  const manifest = await readJson("package.json");
  const biomeConfig = await readJson("biome.json");

  assert.equal(typeof manifest.devDependencies["@biomejs/biome"], "string");
  assert.match(manifest.scripts.lint, /biome/);
  assert.match(biomeConfig.$schema, /biome/);
  assert.equal(biomeConfig.formatter.enabled, true);
  assert.equal(biomeConfig.linter.enabled, true);
});

test("docs governance rules are enforced mechanically", async () => {
  const manifest = await readJson("package.json");

  // 治理规则靠校验落地，不靠自觉（docs/README.md 治理规则 6）。
  assert.match(manifest.scripts["test:docs"], /check-docs\.mjs/);

  const { errors, files } = await checkDocs({ rootDir });

  assert.ok(files.length > 0, "docs 下应存在 markdown 文件");
  assert.deepEqual(errors, [], `docs 校验失败：\n  - ${errors.join("\n  - ")}`);
});

// 校验脚本自身的有效性必须被锁死：一个「永远返回 PASS」的检查等于没有检查。
// 用临时 fixture 覆盖每条规则的拦截行为（正常路径 + 越界路径）。
const FIXTURE_README = [
  "# docs 地图",
  "",
  "| 文档 | 角色 |",
  "| --- | --- |",
  "| `tech/改造计划.md` | 权威（ctx key 表属主） |",
  "| `sub/frozen.md` | 快照 |",
  "| `ok.md` | 权威 |",
  "",
  "| ID | 决策 |",
  "| --- | --- |",
  "| `DEC-1` | 事件缝 |",
  "",
].join("\n");

// 唯一允许定义 ctx key 清单的文档（规则 5 需要它存在且唯一）。
const FIXTURE_PLAN = [
  "# 改造计划",
  "",
  "| ctx key | 服务 |",
  "| --- | --- |",
  "| `tools` | 工具注册表 |",
  "",
].join("\n");

const FIXTURE_FROZEN = [
  "# 冻结文档",
  "",
  "<!-- frozen:start -->",
  "## 0. 历史",
  "内容 A",
  "<!-- frozen:end -->",
  "",
  "## 8. 可编辑",
  "内容 B",
  "",
].join("\n");

const FIXTURE_OK = [
  "# 正常",
  "",
  "[跳转](./README.md)",
  "[锚点](#正常)",
  "",
].join("\n");

async function withDocsFixture(run) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "loomic-docs-"));
  try {
    await mkdir(path.join(fixtureRoot, "docs", "sub"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "docs", "tech"), { recursive: true });
    await writeFile(
      path.join(fixtureRoot, "docs", "README.md"),
      FIXTURE_README,
      "utf8",
    );
    await writeFile(
      path.join(fixtureRoot, "docs", "tech", "改造计划.md"),
      FIXTURE_PLAN,
      "utf8",
    );
    await writeFile(
      path.join(fixtureRoot, "docs", "sub", "frozen.md"),
      FIXTURE_FROZEN,
      "utf8",
    );
    await writeFile(
      path.join(fixtureRoot, "docs", "ok.md"),
      FIXTURE_OK,
      "utf8",
    );
    await updateFrozenLock({ rootDir: fixtureRoot });
    return await run(fixtureRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function errorsOf(result) {
  return result.errors.join("\n");
}

test("docs fixture: 干净的文档树校验通过", async () => {
  await withDocsFixture(async (fixtureRoot) => {
    const result = await checkDocs({ rootDir: fixtureRoot });
    assert.deepEqual(result.errors, [], errorsOf(result));
  });
});

test("docs fixture: 篡改冻结区被拦截，改可编辑区放行", async () => {
  await withDocsFixture(async (fixtureRoot) => {
    const frozenFile = path.join(fixtureRoot, "docs", "sub", "frozen.md");

    await writeFile(
      frozenFile,
      FIXTURE_FROZEN.replace("内容 A", "内容 A 篡改"),
      "utf8",
    );
    assert.match(
      errorsOf(await checkDocs({ rootDir: fixtureRoot })),
      /冻结区被修改/,
    );

    await writeFile(
      frozenFile,
      FIXTURE_FROZEN.replace("内容 B", "内容 B 已更新"),
      "utf8",
    );
    const editable = await checkDocs({ rootDir: fixtureRoot });
    assert.deepEqual(editable.errors, [], errorsOf(editable));
  });
});

test("docs fixture: 未入图的文档与未登记的决策 ID 被拦截", async () => {
  await withDocsFixture(async (fixtureRoot) => {
    await writeFile(
      path.join(fixtureRoot, "docs", "新文档.md"),
      "# 新\n",
      "utf8",
    );
    assert.match(
      errorsOf(await checkDocs({ rootDir: fixtureRoot })),
      /未登记进/,
    );

    await rm(path.join(fixtureRoot, "docs", "新文档.md"));
    await writeFile(
      path.join(fixtureRoot, "docs", "ok.md"),
      "# 正常\n\n见 DEC-99。\n",
      "utf8",
    );
    assert.match(errorsOf(await checkDocs({ rootDir: fixtureRoot })), /DEC-99/);
  });
});

test("docs fixture: 断链与坏锚点被拦截", async () => {
  await withDocsFixture(async (fixtureRoot) => {
    await writeFile(
      path.join(fixtureRoot, "docs", "ok.md"),
      "# 正常\n\n[坏锚点](#不存在)\n[断链](./ghost.md)\n",
      "utf8",
    );
    const errors = errorsOf(await checkDocs({ rootDir: fixtureRoot }));
    assert.match(errors, /锚点不存在/);
    assert.match(errors, /链接目标不存在/);
  });
});

test("docs fixture: 第二处 ctx key 表被拦截", async () => {
  await withDocsFixture(async (fixtureRoot) => {
    await writeFile(
      path.join(fixtureRoot, "docs", "ok.md"),
      "# 正常\n\n| ctx key | 服务 |\n| --- | --- |\n| `x` | X |\n",
      "utf8",
    );

    const errors = errorsOf(await checkDocs({ rootDir: fixtureRoot }));
    assert.match(errors, /ctx key 清单表/);
  });
});

// --- 去 Supabase 棘轮门禁（§4.13）---
//
// 底账不能只活在文档里：残留量一旦只靠自觉，迁移就会边清边涨。这里把
// 代码侧与 SQL 侧的残留计数做成**只许减不许增**的门禁，消除残留的 PR
// 必须在同一 PR 下调基线（tests/supabase-cleanup-baseline.json）。

function countOccurrences(source, pattern) {
  return (source.match(pattern) ?? []).length;
}

const SUPABASE_SOURCE_ROOTS = ["apps/server/src", "apps/web/src", "packages"];
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  "out",
  ".turbo",
]);

/** 全部源文件（排除测试）——按全量统计才能同口径比较：只统计「已耦合文件」时，
 *  把一处存储调用从一个耦合文件挪到另一个，指标会凭空变化。 */
function listSupabaseSources() {
  const files = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(target);
        }
        continue;
      }
      if (
        !/\.(ts|tsx)$/.test(entry.name) ||
        /\.test\.(ts|tsx)$/.test(entry.name)
      ) {
        continue;
      }
      files.push(target);
    }
  };

  for (const root of SUPABASE_SOURCE_ROOTS) {
    walk(path.join(rootDir, root));
  }

  return files;
}

const CLIENT_WIRING_PATTERN =
  /createUserClient|createAdminClient|UserSupabaseClient|AdminSupabaseClient|@supabase\//g;

async function collectSupabaseResiduals() {
  const sources = listSupabaseSources();
  const code = {
    filesUsingSupabaseClient: 0,
    sdkRefs: 0,
    dbFromCalls: 0,
    storageRefs: 0,
  };

  for (const filePath of sources) {
    const source = readFileSync(filePath, "utf8");
    if (/UserSupabaseClient|AdminSupabaseClient|@supabase\//.test(source)) {
      code.filesUsingSupabaseClient += 1;
    }
    code.sdkRefs += countOccurrences(source, CLIENT_WIRING_PATTERN);
    // 去空白后判定：`.storage.from(...)` 是对象存储调用，不是 DB 查询，
    // 原口径把它计进 DB 调用，导致「把存储调用搬个位置」就能污染指标。
    const flat = source.replace(/\s+/g, "");
    code.dbFromCalls += (flat.match(/(?<!storage)\.from\(/g) ?? []).length;
    code.storageRefs += countOccurrences(flat, /\.storage/g);
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/supabase-inventory.mjs", "--json"],
    { cwd: rootDir },
  );
  const inventory = JSON.parse(stdout);
  const sql = {
    authUid: inventory.rewrite["auth.uid() 总数"],
    authUsersTables: inventory.rewrite["FK → auth.users 的表"].length,
    authUsersTriggers: inventory.rewrite["auth.users 上的触发器"].length,
    storageObjectsRefs: inventory.rewrite["storage.objects 引用"],
    cloudUrls: inventory.rewrite["硬编码云端 URL"],
  };

  return { code, sql };
}

test("去 Supabase 残留只许减不许增（棘轮门禁）", async () => {
  const baseline = await readJson("tests/supabase-cleanup-baseline.json");
  const actual = await collectSupabaseResiduals();

  // 基线必须与度量口径一一对应，防止某个指标被悄悄删掉而门禁失效。
  assert.deepEqual(
    Object.keys(actual).sort(),
    ["code", "sql"],
    "度量分组与基线不一致",
  );
  for (const group of ["code", "sql"]) {
    assert.deepEqual(
      Object.keys(actual[group]).sort(),
      Object.keys(baseline[group]).sort(),
      `${group} 度量指标与基线不一致：新增/删除指标必须同步基线`,
    );
  }

  const regressions = [];
  const improvements = [];
  for (const group of ["code", "sql"]) {
    for (const [metric, value] of Object.entries(actual[group])) {
      const limit = baseline[group][metric];
      assert.equal(typeof limit, "number", `${group}.${metric} 基线必须是数字`);
      if (value > limit) {
        regressions.push(`${group}.${metric}: ${value} > 基线 ${limit}`);
      } else if (value < limit) {
        improvements.push(`${group}.${metric}: ${value} < 基线 ${limit}`);
      }
    }
  }

  assert.deepEqual(
    regressions,
    [],
    `新增了 Supabase 耦合（去 Supabase 迁移期间禁止）：\n    ${regressions.join("\n    ")}`,
  );

  // 有进展就把基线一起降下来——否则基线会长期虚高，棘轮失去意义。
  assert.deepEqual(
    improvements,
    [],
    `残留已下降，请在本 PR 同步下调 tests/supabase-cleanup-baseline.json：\n    ${improvements.join("\n    ")}`,
  );
});
