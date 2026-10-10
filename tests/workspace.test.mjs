import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkActions } from "../scripts/check-actions.mjs";
import { checkDocs, updateFrozenLock } from "../scripts/check-docs.mjs";
import * as envModule from "../scripts/check-env.mjs";

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
  "dist-types",
  "dist-host",
  "dist-design",
  ".next",
  "out",
  ".turbo",
  // i18n 目录是纯文案键值表（如 zcode 移植的 zh-CN.ts），键名里的 `.storage.`
  // （"resourceManager.storage.summaryTotal"）会被 storageRefs 误计为存储客户端
  // 访问——文案不是代码，与 ctx/deps 接收者同一条误报排除原则（口径修正 2026-09-30）。
  "i18n",
]);

/** 全部源文件（排除测试）——按全量统计才能同口径比较：只统计「已耦合文件」时，
 *  把一处存储调用从一个耦合文件挪到另一个，指标会凭空变化。 */
function listSupabaseSources() {
  const files = [];
  const inventoryPath = path.join(rootDir, "docs/源码来源/ZCode源码清单.json");
  const upstreamSources = existsSync(inventoryPath)
    ? new Map(
        JSON.parse(readFileSync(inventoryPath, "utf8")).records.map(
          (record) => [path.resolve(rootDir, record.target), record],
        ),
      )
    : new Map();

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
      const upstream = upstreamSources.get(target);
      if (
        upstream?.source.startsWith("references/zcode/") &&
        createHash("sha256").update(readFileSync(target)).digest("hex") ===
          upstream.copiedSha256
      ) {
        // 经来源清单锁定的外部源码不是第一方 Supabase 迁移对象。
        // 宿主代码及任何未登记改动仍纳入原棘轮，不放宽基线。
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

// --- 供应商协议契约 ↔ 库约束一致性（《flow 集成方案》P3 凭证缝接缝 #5）---
//
// `provider_instances.protocol` 的封闭集合（packages/shared 的 providerProtocolSchema）与
// 库 CHECK 是必须同改的两处：漏改库则创建实例直接 SQL 失败，漏改契约则库里的合法值
// 被应用层拒绝。与 projects.kind 同一条对账纪律，跨文件契约靠脚本校验落地。
test("provider_instances.protocol 的库约束与共享契约枚举一致", async () => {
  const contracts = await readText("packages/shared/src/provider-contracts.ts");
  const enumMatch = contracts.match(
    /providerProtocolSchema = z\.enum\(\[([^\]]*)\]\)/,
  );
  assert.ok(
    enumMatch,
    "provider-contracts.ts 里应有 providerProtocolSchema 的封闭枚举",
  );
  const contractProtocols = [...enumMatch[1].matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );

  // 迁移按文件名顺序执行，取**最后一处**定义（前向迁移的 drop/add 覆盖建表时的初值）。
  let constraintProtocols = null;
  for (const name of readdirSync(
    path.join(rootDir, "supabase/migrations"),
  ).sort()) {
    if (!name.endsWith(".sql")) continue;
    const sql = readFileSync(
      path.join(rootDir, "supabase/migrations", name),
      "utf8",
    );
    for (const match of sql.matchAll(/CHECK \(protocol IN \(([^)]*)\)\)/gi)) {
      constraintProtocols = [...match[1].matchAll(/'([^']+)'/g)].map(
        (literal) => literal[1],
      );
    }
  }
  assert.ok(
    constraintProtocols,
    "应存在 provider_instances 协议 CHECK 约束定义",
  );
  assert.deepEqual(
    [...contractProtocols].sort(),
    [...constraintProtocols].sort(),
    "协议封闭集合两处必须同改：shared 枚举与库 CHECK 漏改任一即此门禁红灯",
  );
});

// --- 桌面版本四处一致 + SEA 宿主与 .nvmrc 钉死（CI 出包可复现性的前置门）---
//
// 版本声明散在四个文件（tauri.conf.json 权威、Cargo.toml 的 [package]、Cargo.lock 的包条目、
// desktop package.json），历史上每次发版手改四处，0.1.1→0.1.3 皆如此；漏改的代价是安装包元数据
// 与产物互不相认。唯一写入入口是 `pnpm version:bump`，本门禁只负责在合入前拦住漂移。
// SEA 宿主另算一件：`package-win.mjs` 拿 `process.execPath` 当宿主，构建机上的 node 版本就是
// 随包服务端未来的运行版本，所以必须与 `.nvmrc` 精确一致——而且脚本里得**真的存在**这道断言，
// 否则「加了 pin 但没人读」比没有 pin 更危险。
test("桌面版本四处一致，且 SEA 宿主与 .nvmrc 钉死", async () => {
  const tauri = await readJson("apps/desktop/src-tauri/tauri.conf.json");
  const desktopManifest = await readJson("apps/desktop/package.json");
  const cargoToml = await readText("apps/desktop/src-tauri/Cargo.toml");
  const cargoLock = await readText("apps/desktop/src-tauri/Cargo.lock");

  const packageTomlVersion = cargoToml.match(
    /\[package\][^[]*?version = "([^"]+)"/,
  )?.[1];
  const lockVersion = cargoLock.match(
    /name = "kenfutwork-desktop"\nversion = "([^"]+)"/,
  )?.[1];

  const declared = {
    "tauri.conf.json": tauri.version,
    "Cargo.toml [package]": packageTomlVersion,
    "Cargo.lock": lockVersion,
    "desktop package.json": desktopManifest.version,
  };
  for (const [where, value] of Object.entries(declared)) {
    assert.ok(
      value,
      `${where} 里没读出版本号——文件形状变了，改 bump-version.mjs 对齐真实结构`,
    );
    assert.equal(
      value,
      tauri.version,
      `版本漂移：${where}=${value} 但 tauri.conf.json=${tauri.version}；用 pnpm version:bump ${tauri.version} 改齐`,
    );
  }

  // SEA 宿主：.nvmrc 必须是精确版本（非范围），且与 engines.node 同值，package-win 必须读它。
  const pin = (await readText(".nvmrc")).trim();
  assert.match(
    pin,
    /^\d+\.\d+\.\d+$/,
    `.nvmrc 应是精确版本（SEA 宿主按它对账），当前是 "${pin}"`,
  );
  const rootManifest = await readJson("package.json");
  assert.equal(
    rootManifest.engines?.node,
    pin,
    "根 engines.node 与 .nvmrc 必须同值，否则本地与 CI 各跑一套 node",
  );
  const winScript = await readText("scripts/package-win.mjs");
  assert.match(
    winScript,
    /\.nvmrc/,
    "package-win.mjs 必须读 .nvmrc 校验 SEA 宿主版本——只加 pin 不做断言等于没锁",
  );

  // CI 容器 job 的 node 也归 .nvmrc 管：`node:24-bookworm` 是浮动 tag（实测解析到 24.21.0），
  // 用它跑出来的「真沙箱绿」不代表发布运行时（SEA 宿主 / 桌面捆绑都是 pin 版本）。
  const ciText = await readText(".github/workflows/ci.yml");
  for (const [, image] of ciText.matchAll(/^.*image:\s*(node:\S+)\s*$/gm)) {
    assert.match(
      image,
      new RegExp(`^node:${pin.replace(/\./g, "\\.")}-`),
      `CI 容器镜像「${image}」没钉到 .nvmrc 的 ${pin}；浮动 tag 让 CI 与出包用的 node 不是同一份`,
    );
  }
});

// --- 随包运行时锁定表：对账规则与合并写 ---
//
// `fetch-runtimes.mjs` 的 python/uv/jdk/git 都解析「最新发布」，同一 commit 隔天出包可以拿到
// 不同内容；`runtime-lock.json` 把这层不确定性显式化。这里用夹具验四条规则，外加
// 「永远 PASS 的检查等于没有检查」的反例（不匹配必须判红）。
test("runtime-lock：无条目放行、哈希不符与改名必拦、按目标平台合并写", async () => {
  const lockModule = await import("../scripts/runtime-lock.mjs");
  const {
    assertLockAssetName,
    assertLockSha,
    buildLockEntry,
    lockEntryFor,
    mergeLockTargets,
    readRuntimeLock,
    LOCK_FILE_NAME,
    LOCK_SCHEMA,
  } = lockModule;

  const entry = buildLockEntry({
    version: "3.12",
    fileName:
      "cpython-3.12.11+20260101-aarch64-apple-darwin-install_only.tar.gz",
    sha256: "a".repeat(64),
    url: "https://example.invalid/x.tar.gz",
  });

  // 1) 无锁定条目（本机开发过渡态）：放行但要说清是哪一种
  const none = assertLockSha({
    entry: null,
    sha256: "b".repeat(64),
    name: "python",
    target: "darwin-arm64",
  });
  assert.equal(none.ok, true);
  assert.match(none.reason, /无锁定条目/);

  // 2) 哈希不符：必须拦，且报错要给出「去哪改」
  const drift = assertLockSha({
    entry,
    sha256: "b".repeat(64),
    name: "python",
    target: "darwin-arm64",
  });
  assert.equal(drift.ok, false, "内容变了却放行，lock 就成了摆设");
  assert.match(drift.reason, /write-lock/);

  // 3) 资产名变了：下载前就该拦（省一趟几百 MB）；名字取不到时交给哈希兜底
  assert.equal(
    assertLockAssetName({
      entry,
      fileName:
        "cpython-3.12.9+20251201-aarch64-apple-darwin-install_only.tar.gz",
      name: "python",
      target: "darwin-arm64",
    }).ok,
    false,
  );
  assert.equal(
    assertLockAssetName({
      entry,
      fileName: null,
      name: "jdk",
      target: "darwin-arm64",
    }).ok,
    true,
    "Adoptium 直链没有文件名时不许误拦",
  );

  // 4) 合并写：mac 打包机重锁不能抹掉 Windows 那一节
  const seed = { schema: LOCK_SCHEMA, targets: { "win-x64": { node: entry } } };
  const merged = mergeLockTargets(seed, "darwin-arm64", { python: entry });
  assert.deepEqual(Object.keys(merged.targets).sort(), [
    "darwin-arm64",
    "win-x64",
  ]);
  assert.equal(
    merged.targets["win-x64"].node,
    entry,
    "另一平台的条目必须原样保留",
  );
  assert.equal(lockEntryFor(merged, "darwin-arm64", "python"), entry);
  assert.equal(lockEntryFor(merged, "darwin-arm64", "git"), null);

  // 5) 结构不符 / 非法 JSON 一律 fail loud，不静默当作「没有 lock」
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kfw-runtime-lock-"));
  try {
    assert.equal(
      readRuntimeLock(fixtureRoot),
      null,
      "文件不存在=无 lock（允许）",
    );
    writeFileSync(path.join(fixtureRoot, LOCK_FILE_NAME), "{ 坏掉的 JSON");
    assert.throws(() => readRuntimeLock(fixtureRoot), /不是合法 JSON/);
    writeFileSync(
      path.join(fixtureRoot, LOCK_FILE_NAME),
      JSON.stringify({ schema: 99, targets: {} }),
    );
    assert.throws(() => readRuntimeLock(fixtureRoot), /结构不符/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// --- GitHub Actions 护栏 ---
//
// 拦的是「Actions UI 显示绿色、实际什么都没干」这一类失败：job 级 `if` 与 workflow 级
// `concurrency` 拿不到 `matrix` 上下文，表达式不报错只取空值；复用工作流的顶层 `permissions`
// 只能收窄会把调用方给的 write 压回 read；`pnpm dev` 在 CI 里因 --env-file 缺文件必死。
// 本轮在同一次提交里撞中三种，所以护栏必须带**反例夹具**——只验真仓通过等于没验。
test("Actions 护栏：真仓通过，七类「静默不干活/假红」各自被拦", async () => {
  const real = checkActions({ rootDir });
  assert.ok(
    real.files.length >= 4,
    `应扫到 .github/workflows 下的工作流，实际 ${real.files.length} 个`,
  );
  assert.deepEqual(
    real.errors,
    [],
    `真仓护栏不应红：\n  - ${real.errors.join("\n  - ")}`,
  );

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kfw-actions-"));
  const dir = path.join(fixtureRoot, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  const put = (name, text) =>
    writeFileSync(path.join(dir, `${name}.yml`), text, "utf8");
  const clean = `name: clean
on: push
jobs:
  a:
    if: github.repository == 'IsKenKenYa/KenFutWork'
    defaults:
      run:
        shell: bash
    runs-on: ubuntu-latest
    steps:
      - name: 干活
        run: |
          echo hi
`;
  try {
    put("clean", clean);
    assert.deepEqual(
      checkActions({ rootDir: fixtureRoot }).errors,
      [],
      "干净夹具必须通过，否则护栏在误伤",
    );

    put(
      "a1",
      `name: a1
on: push
jobs:
  mac:
    if: github.event.inputs.platform == 'both' || github.event.inputs.platform == matrix.os
    runs-on: macos-latest
    steps:
      - run: echo hi
`,
    );
    let result = checkActions({ rootDir: fixtureRoot });
    assert.ok(
      result.errors.some((line) => /job「mac」.*matrix/s.test(line)),
      `A1 应拦住 job 级 matrix：${JSON.stringify(result.errors)}`,
    );
    rmSync(path.join(dir, "a1.yml"));

    put(
      "a2",
      `name: a2
on: push
concurrency:
  group: codeql-\${{ matrix.language }}
  cancel-in-progress: true
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
    );
    result = checkActions({ rootDir: fixtureRoot });
    assert.ok(
      result.errors.some((line) => /concurrency\.group/.test(line)),
      `A2 应拦住 concurrency 引用 matrix：${JSON.stringify(result.errors)}`,
    );
    rmSync(path.join(dir, "a2.yml"));

    put(
      "a3",
      `name: a3
on:
  workflow_call:
    inputs:
      platform:
        required: true
        type: string
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
    );
    result = checkActions({ rootDir: fixtureRoot });
    assert.ok(
      result.errors.some((line) => /复用工作流写了顶层/.test(line)),
      `A3 应拦住复用工作流的顶层 permissions：${JSON.stringify(result.errors)}`,
    );
    rmSync(path.join(dir, "a3.yml"));

    put(
      "a4",
      `name: a4
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: 起服务
        run: |
          pnpm dev
`,
    );
    result = checkActions({ rootDir: fixtureRoot });
    assert.ok(
      result.errors.some((line) => /pnpm dev/.test(line)),
      `A4 应拦住 run 里的 pnpm dev：${JSON.stringify(result.errors)}`,
    );
    rmSync(path.join(dir, "a4.yml"));

    put(
      "a5",
      `name: a5
on: push
permissions:
  contents: read
jobs:
  a:
    permissions:
      contents: \${{ github.event_name == 'push' && 'write' || 'read' }}
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
    );
    result = checkActions({ rootDir: fixtureRoot });
    assert.ok(
      result.errors.some((line) =>
        /permissions 的 contents 写了表达式/.test(line),
      ),
      `A5 应拦住 permissions 里的表达式：${JSON.stringify(result.errors)}`,
    );
    rmSync(path.join(dir, "a5.yml"));

    put(
      "a6",
      `name: a6
on: push
jobs:
  a:
    runs-on: windows-latest
    steps:
      - name: 干活
        run: |
          set -euo pipefail
          echo hi
`,
    );
    result = checkActions({ rootDir: fixtureRoot });
    assert.ok(
      result.errors.some((line) => /没有任何显式 shell/.test(line)),
      `A6 应拦住「整 job 没声明 shell」的 bash 写法：${JSON.stringify(result.errors)}`,
    );
    rmSync(path.join(dir, "a6.yml"));

    put(
      "a7",
      `name: a7
on: push
jobs:
  a:
    defaults:
      run:
        shell: bash
    runs-on: ubuntu-latest
    steps:
      - name: 取退出码
        run: |
          set -uo pipefail
          scan --out x.sarif
          code=$?
          echo "code=$code"
`,
    );
    result = checkActions({ rootDir: fixtureRoot });
    assert.ok(
      result.errors.some((line) => /取退出码/.test(line)),
      `A7 应拦住 bash -e 下裸写 code=$?（这一步永远执行不到）：${JSON.stringify(result.errors)}`,
    );
    rmSync(path.join(dir, "a7.yml"));

    // 正确写法：先置 0，再用 || 捕获——不得被 A7 误伤
    put(
      "a7ok",
      `name: a7ok
on: push
jobs:
  a:
    defaults:
      run:
        shell: bash
    runs-on: ubuntu-latest
    steps:
      - name: 取退出码
        run: |
          set -uo pipefail
          code=0
          scan --out x.sarif || code=$?
          echo "code=$code"
`,
    );
    assert.deepEqual(
      checkActions({ rootDir: fixtureRoot }).errors,
      [],
      "A7 不得误伤 `cmd || code=$?` 的正确写法",
    );
    rmSync(path.join(dir, "a7ok.yml"));

    // 回到干净态必须再次全绿（证明上面每条都是「这一处」引起的，不是常驻误报）
    assert.deepEqual(checkActions({ rootDir: fixtureRoot }).errors, []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// --- fetch-runtimes 的 `--only` 解析 ---
// 文件头用法写的是空格形式（`--only node,python`），而解析器曾只认 `--only=`：
// 结果是这条命令**静默变成「全部运行时」**，既慢又误导（实测过一次）。
test("fetch-runtimes 的 --only 两种写法都必须生效", async () => {
  const { parseArgs } = await import("../scripts/fetch-runtimes.mjs");
  const available = ["node", "python", "uv", "jdk"];
  assert.deepEqual(
    parseArgs(["--only", "uv"], available).only,
    ["uv"],
    "空格形式的 --only 必须真的过滤，不能退回全部",
  );
  assert.deepEqual(parseArgs(["--only=node,uv"], available).only, [
    "node",
    "uv",
  ]);
  assert.deepEqual(parseArgs([], available).only, available);
  assert.equal(parseArgs(["--only", "uv", "--force"], available).force, true);
});

// --- SEA 产物必须自带「以发布 exe 为基准」的文件型 require ---
//
// 懒解析只解决了**我们源码里**的四处外部包；`--external` 的包一旦被第三方代码
// `require("pkg")` 命中，SEA 的内置 require 仍会抛 ERR_UNKNOWN_BUILTIN_MODULE。
// 所以产物头部必须重绑定 require 并把 import.meta.url 指到 <exe>/server.cjs；
// 「加了 external 但没加 banner」是最容易漏的一半。
test("SEA 产物头部建立 exe 锚点的文件型 require", async () => {
  const script = await readText("scripts/package-win.mjs");
  const banner = /const seaBanner = `([\s\S]*?)`;/.exec(script)?.[1];
  assert.ok(
    banner,
    "package-win.mjs 里找不到 seaBanner——external 会退回启动期裸 require",
  );
  assert.match(
    banner,
    /createRequire\(base\)/,
    "banner 必须用 createRequire(base) 重绑定 require",
  );
  assert.match(
    banner,
    /require\("node:sea"\)\.isSea\(\)/,
    "banner 必须区分 SEA 与普通 node 运行（否则 node server.cjs 会被错误锚定）",
  );
  assert.match(
    banner,
    /process\.execPath/,
    "解析基准必须是发布 exe 位置，不能是构建机路径",
  );
  assert.match(
    script,
    /--banner:js=\$\{seaBanner\}/,
    "banner 必须真的传给 esbuild，只写在字符串里等于没生效",
  );
  assert.match(
    script,
    /--define:import\.meta\.url=globalThis\.__kfwModuleUrl/,
    "import.meta.url 必须映射到 banner 计算的 exe 基准（SEA 里 __filename 是构建机路径）",
  );
});

// --- 外部原生包不许顶层静态 import ---
//
// Windows 打包走 Node SEA：`require` 在 SEA 内只认内建模块。esbuild 把
// `--external` 的包（node-pty / @vscode/ripgrep / @napi-rs/canvas / sherpa-onnx-node）
// 的顶层静态 import 打成**启动期** require，于是整个服务端启动即抛
// `ERR_UNKNOWN_BUILTIN_MODULE`（实测：canvas 让 win 安装包 1 秒退出；ripgrep 同形）。
// 正确写法是懒解析 `createRequire(import.meta.url)`——`import type` 会被编译器擦除，放行。
test("SEA 外部原生包只能懒解析，禁止顶层值导入", async () => {
  const SEA_EXTERNAL = [
    "node-pty",
    "@vscode/ripgrep",
    "@napi-rs/canvas",
    "sherpa-onnx-node",
  ];
  const pattern = new RegExp(
    `^import\\s+(?!type\\b)[^;]*?from\\s+"(${SEA_EXTERNAL.join("|")})"`,
    "mu",
  );
  // 先自证规则抓得住：这两条必须被识别，否则门禁是摆设。
  assert.match(
    'import { rgPath } from "@vscode/ripgrep";\n',
    pattern,
    "值级顶层 import 必须被抓到",
  );
  assert.doesNotMatch('import type * as pty from "node-pty";\n', pattern);

  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name))
        continue;
      const source = readFileSync(full, "utf8");
      if (pattern.test(source))
        offenders.push(path.relative(rootDir, full).replaceAll("\\", "/"));
    }
  };
  walk(path.join(rootDir, "apps/server/src"));
  assert.deepEqual(
    offenders,
    [],
    `以下文件顶层静态 import 了 SEA 外部原生包，会让 Windows 包启动即死：\n  ${offenders.join("\n  ")}`,
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

test("env 权威表：真仓校验通过（全部 KENFUTWORK_/LOOMIC_ 引用已登记）", () => {
  const { checkEnv } = envModule;
  const { errors, files } = checkEnv({ rootDir });
  assert.ok(files.length > 0, "env 扫描面不应为空");
  assert.deepEqual(errors, [], `env 校验失败：\n  - ${errors.join("\n  - ")}`);
});

test("env 门禁 fixture：未登记名 / 读者漂移 / 样例互锁各自被拦截", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kfw-env-fixture-"));
  const registryPath = path.join(fixtureRoot, "tests", "env-registry.json");
  const examplePath = path.join(fixtureRoot, ".env.example");
  const readerRel = "apps/server/src/a.ts";
  const readerPath = path.join(fixtureRoot, readerRel);

  const registry = {
    vars: {
      KFW_FIXTURE_A: {
        surface: "server",
        readers: [readerRel],
        inExamples: true,
        status: "active",
      },
    },
    legacy: {
      LOOMIC_FIXTURE_OLD: { allowedIn: ["src/legacy.ts"], reason: "兼容" },
    },
  };

  await mkdir(path.join(fixtureRoot, "tests"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "apps/server/src"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry));
  writeFileSync(examplePath, "KFW_FIXTURE_A=1\n");
  writeFileSync(readerPath, "use KFW_FIXTURE_A;");

  // 干净基线：全链路通过
  let result = envModule.checkEnv({ rootDir: fixtureRoot });
  assert.deepEqual(result.errors, []);

  // 读者文件消失（契约漂移·文件被删）→ fail
  await rm(readerPath);
  result = envModule.checkEnv({ rootDir: fixtureRoot });
  assert.ok(
    result.errors.some((line) => /读者文件不存在或不可读/.test(line)),
    `读者文件消失应被拦截：${JSON.stringify(result.errors)}`,
  );

  // 读者漂移（文件在但不引用该名）→ fail
  writeFileSync(readerPath, "export {};");
  result = envModule.checkEnv({ rootDir: fixtureRoot });
  assert.ok(
    result.errors.some((line) => /已不再引用/.test(line)),
    `读者漂移应被拦截：${JSON.stringify(result.errors)}`,
  );
  writeFileSync(readerPath, "use KFW_FIXTURE_A;");

  // 未登记的新名出现 → fail
  mkdirSync(path.join(fixtureRoot, "src"), { recursive: true });
  writeFileSync(
    path.join(fixtureRoot, "apps", "server", "src", "rogue.ts"),
    "KENFUTWORK_FIXTURE_NEW=1;",
  );
  result = envModule.checkEnv({ rootDir: fixtureRoot });
  assert.ok(
    result.errors.some((line) => /未登记进/.test(line)),
    `表外新名应被拦截：${JSON.stringify(result.errors)}`,
  );
  rmSync(path.join(fixtureRoot, "apps", "server", "src", "rogue.ts"));

  // 旧前缀出现在白名单之外的文件 → fail
  writeFileSync(
    path.join(fixtureRoot, "apps", "server", "src", "rogue.ts"),
    "LOOMIC_FIXTURE_OLD=1;",
  );
  result = envModule.checkEnv({ rootDir: fixtureRoot });
  assert.ok(
    result.errors.some((line) => /旧前缀 LOOMIC_FIXTURE_OLD/.test(line)),
    `白名单外的 LOOMIC_ 引用应被拦截：${JSON.stringify(result.errors)}`,
  );
  rmSync(path.join(fixtureRoot, "apps", "server", "src", "rogue.ts"));

  // 回到干净态：应通过
  result = envModule.checkEnv({ rootDir: fixtureRoot });
  assert.deepEqual(result.errors, []);
});
