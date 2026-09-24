import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
//
// 只纳入**有 npm 清单**的 app：`apps/desktop` 是纯 Cargo/Tauri 壳
// （dev.sh + src-tauri/，没有 package.json，也不进 pnpm workspace），
// 对它的门禁是 `apps/desktop/src-tauri` 那一侧的 cargo check/test，
// 在这里按 npm 脚本口径要求它只会得到「文件不存在」的假警报。
const appNames = readdirSync(path.join(rootDir, "apps"), {
  withFileTypes: true,
})
  .filter(
    (entry) =>
      entry.isDirectory() &&
      existsSync(path.join(rootDir, "apps", entry.name, "package.json")),
  )
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

test("@kenfutwork/config exports a single low-drift package contract", async () => {
  const source = await readText("packages/config/src/index.ts");

  assert.doesNotMatch(source, /apps\/\*/);
  assert.doesNotMatch(source, /packages\/\*/);
});

test("shared package placeholder exists for the upcoming contract task", async () => {
  const manifest = await readJson("packages/shared/package.json");

  assert.equal(manifest.name, "@kenfutwork/shared");
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
  "| `方案设计/改造计划.md` | 权威（ctx key 表属主） |",
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
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kenfutwork-docs-"));
  try {
    await mkdir(path.join(fixtureRoot, "docs", "sub"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "docs", "方案设计"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixtureRoot, "docs", "README.md"),
      FIXTURE_README,
      "utf8",
    );
    await writeFile(
      path.join(fixtureRoot, "docs", "方案设计", "改造计划.md"),
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
    // 去空白后判定，两处负向断言（口径修正 2026-09-14）：
    // - `(?<!storage)`：`.storage.from(...)` 是对象存储调用，不是 DB 查询；
    // - `(?<!Buffer|Array|Uint8Array|String)`：`Buffer.from(...)` 这类**构造器**调用
    //   与 DB 无关。原口径把它们计进 DB 调用，实测噪声约 20 处（例如在 Provider 里
    //   用 `Buffer.from(hex, "utf8")` 做常量时间比较就会凭空 +2），
    //   逼得代码为了指标好看而绕开 `Buffer.from`——那是本末倒置。
    const flat = source.replace(/\s+/g, "");
    code.dbFromCalls += (
      flat.match(
        /(?<!storage)(?<!Buffer)(?<!Array)(?<!Uint8Array)(?<!String)\.from\(/g,
      ) ?? []
    ).length;
    // 口径（2026-09-14 三次修正 + 2026-09-19 第四次修正）：只数**存储客户端成员访问**
    // （`.storage.` / `.storage(`），不数产品数据字段 `storageUrl`。原口径把 `el.storageUrl`
    // 也算成存储耦合，实测让服务端清零后指标仍卡在 11 处（全在 web 且全是字段名）——
    // 那样的指标永远到不了 0，M1.5 的「全清」门禁也就永远过不去。
    // 第四次修正：新增的插件存储能力（能力名 `storage`，访问面固定是 `ctx.storage` /
    // `deps.storage`）与 Supabase 的 storage 客户端同名，属指标**误报**。按本文件自己的
    // 原则（不为了让指标好看而绕开正常命名），把这两个接收者排除；真正的存储客户端调用
    // （其它接收者的 `.storage.from(` / `.storage.upload(` 等）照旧计入。
    code.storageRefs += countOccurrences(
      flat,
      /(?<!ctx)(?<!deps)\.storage(?=[.(])/g,
    );
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
    // 用「排除中性化迁移」的净值：中性化迁移的语句里必然出现被改写的字面量，
    // 计入它等于惩罚「去除残留」本身（历史迁移不可改，指标会永久卡住）。
    cloudUrls: inventory.rewrite["硬编码云端 URL（排除中性化迁移后的净值）"],
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

// --- 项目类型契约 ↔ 库约束一致性（《flow 集成方案》P1 接缝 #2）---
//
// `projects.kind` 的枚举（packages/shared）与 CHECK（supabase/migrations）是**必须同改**的
// 两处：只改一处时，要么写入被库拒绝（契约先扩），要么契约拒绝一个库里合法的值（库先扩）。
// 加第三类 `flow` 时补上这条对账——跨文件的契约靠脚本校验落地，不靠自觉。
test("projects.kind 的库约束与共享契约枚举一致", async () => {
  const contracts = await readText("packages/shared/src/contracts.ts");
  const enumMatch = contracts.match(
    /projectKindSchema = z\.enum\(\[([^\]]*)\]\)/,
  );
  assert.ok(enumMatch, "contracts.ts 里应有 projectKindSchema 的封闭枚举");
  const contractKinds = [...enumMatch[1].matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );

  // 迁移按文件名顺序执行，故取**最后一处**定义（后面的 drop/add 覆盖前面的）。
  let constraintKinds = null;
  for (const dir of ["supabase/bootstrap", "supabase/migrations"]) {
    for (const name of readdirSync(path.join(rootDir, dir)).sort()) {
      if (!name.endsWith(".sql")) continue;
      const sql = readFileSync(path.join(rootDir, dir, name), "utf8");
      for (const match of sql.matchAll(
        /add constraint projects_kind_check check \(kind in \(([^)]*)\)\)/g,
      )) {
        constraintKinds = [...match[1].matchAll(/'([^']+)'/g)].map(
          (literal) => literal[1],
        );
      }
    }
  }
  assert.ok(constraintKinds, "应存在 projects_kind_check 的 CHECK 约束定义");
  assert.deepEqual(
    [...contractKinds].sort(),
    [...constraintKinds].sort(),
    "契约枚举与库约束必须一致：加项目类型时两处同改，漏改即此门禁红灯",
  );
});

// 安装向导的品牌图必须**超采样**出图，不能按名义尺寸（页头 150×57 / 侧边 164×314）出：
// 向导带 `ManifestDPIAwareness PerMonitorV2`，控件随 DPI 放大（150% 屏上 1.5 倍），而
// `MUI_HEADERIMAGE_BITMAP_STRETCH` 默认 `FitControl` —— NSIS 会把位图 StretchBlt 到控件大小。
// 按名义尺寸出图 = 上线就被放大 1.5 倍，用户看到的就是糊图（2026-09-19 实测，见
// docs/日志.md §三十八）。这条守门禁只拦「退回名义尺寸」这种改法。
test("安装向导品牌图按 DPI 超采样出图（退回名义尺寸即被拉伸成糊图）", async () => {
  for (const [file, nominal] of [
    ["installer-header.bmp", [150, 57]],
    ["installer-sidebar.bmp", [164, 314]],
  ]) {
    const filePath = path.join(rootDir, "apps/desktop/src-tauri", file);
    const bmp = await readFile(filePath);
    assert.equal(bmp.toString("ascii", 0, 2), "BM", `${file} 不是 BMP`);
    assert.equal(
      bmp.readUInt16LE(28),
      24,
      `${file} 必须是 24 位 BMP（MUI 只吃这个）`,
    );
    const width = bmp.readInt32LE(18);
    const height = Math.abs(bmp.readInt32LE(22));
    assert.ok(
      width >= nominal[0] * 2 && height >= nominal[1] * 2,
      `${file} 是 ${width}×${height}，低于 2× 下限（名义 ${nominal[0]}×${nominal[1]}）——` +
        "MUI 会把它拉伸到 DPI 缩放后的控件大小，按名义尺寸出图在 150% 屏上就是糊的",
    );
  }
});
