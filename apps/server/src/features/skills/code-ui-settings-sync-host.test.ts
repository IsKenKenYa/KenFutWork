import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
} from "@zcode/shared";
import { afterEach, expect, it } from "vitest";
import { CodeUiConnections } from "../code-ui/connections.js";
import type { LocalActor } from "../local-instance/types.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import {
  createCodeUiSettingsSyncHost,
  type StagedSkillImportSource,
} from "./code-ui-settings-sync-host.js";
import { externalSkillPackageDigest } from "./external-directory-import.js";
import {
  createSkillCatalogRepository,
  createSkillImportReceiptRepository,
} from "./repository.js";
import { readSandboxSkillPackage } from "./sandbox-skill-packages.js";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);
const SCRATCH_ROOT = join(REPO_ROOT, ".scratch");
const INSTANCE_ID = "00000000-0000-4000-8000-0000000000aa";
const SKILL_ID = "00000000-0000-4000-8000-000000000001";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createHome(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const home = mkdtempSync(join(SCRATCH_ROOT, "settings-sync-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const manifest = [
  "---",
  "name: Writer",
  "description: 写作技能",
  "---",
  "# Writer",
  "",
].join("\n");

function writePackage(home: string, slug = "writer"): string {
  const root = join(home, ".claude", "skills");
  const packageDir = join(root, slug);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "SKILL.md"), manifest);
  return root;
}

function scriptedDb(
  options: {
    receipt?: Record<string, unknown> | null;
    slugExists?: boolean;
  } = {},
) {
  const query: PostgresQueryRunner["query"] = async (sql) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.includes("pg_advisory_xact_lock")) {
      return { rowCount: 1, rows: [] };
    }
    if (normalized.startsWith("select status, skill_id")) {
      return {
        rowCount: options.receipt ? 1 : 0,
        rows: options.receipt ? [options.receipt] : [],
      };
    }
    if (normalized.startsWith("select id from public.skills")) {
      return options.slugExists
        ? { rowCount: 1, rows: [{ id: "existing-skill" }] }
        : { rowCount: 0, rows: [] };
    }
    if (normalized.includes("insert into public.skills")) {
      return { rowCount: 1, rows: [{ id: SKILL_ID }] };
    }
    return { rowCount: 1, rows: [] };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("设置同步不打开任务宿主会话。");
    },
    end: async () => {},
  };
  const persistence = createPersistenceFromRunner(runner);
  return {
    catalog: createSkillCatalogRepository(persistence),
    receipts: createSkillImportReceiptRepository(persistence),
  };
}

function createContext(actor: LocalActor) {
  const connections = new CodeUiConnections();
  const carrier = connections.open(
    actor.instanceId,
    actor.instanceId,
    async () => {},
    () => {},
    false,
    true,
    actor.accessClientId,
  );
  cleanups.push(() => void carrier.dispose());
  return {
    context: connections.context(
      actor.instanceId,
      carrier.hello.connectionId,
      actor.accessClientId,
    ),
    dispose: () => void carrier.dispose(),
  };
}

function createHarness(
  home: string,
  db: ReturnType<typeof scriptedDb>,
  options: {
    /** 本轮已暂存的来源（git 仓库快照 / zip 包），按来源 id 供宿主查询。 */
    stagedSources?: {
      list(instanceId: string): Promise<readonly StagedSkillImportSource[]>;
    };
    /** 实例设置里的扫描层数上限；缺省走沙箱技能包的固定上限。 */
    readMaxDepth?: (instanceId: string) => Promise<number>;
  } = {},
) {
  const actor: LocalActor = Object.freeze({
    instanceId: INSTANCE_ID,
    accessClientId: null,
  });
  const localInstance = {
    async resolve() {
      return { instanceId: INSTANCE_ID, accessClientId: null };
    },
    async update() {
      throw new Error("测试不修改实例");
    },
    async assertOwned() {
      return INSTANCE_ID;
    },
  } as unknown as Parameters<
    typeof createCodeUiSettingsSyncHost
  >[0]["localInstance"];
  const host = createCodeUiSettingsSyncHost({
    localInstance,
    catalog: db.catalog,
    receipts: db.receipts,
    homeDir: home,
    ...(options.stagedSources ? { stagedSources: options.stagedSources } : {}),
    ...(options.readMaxDepth ? { readMaxDepth: options.readMaxDepth } : {}),
  });
  const { context, dispose } = createContext(actor);
  return { actor, host, context, dispose };
}

it("扫描外部技能目录并输出可导入的技能与来源根目录", async () => {
  const home = createHome();
  const root = writePackage(home);
  const f = createHarness(home, scriptedDb());
  const detect = f.host["settings-sync.detect"];
  if (!detect) throw new Error("扫描入口未注册");
  const result = (await detect.call(
    f.actor,
    [{ categories: ["skills"] }],
    f.context,
  )) as SettingsSyncDiscoveryResult;
  f.dispose();

  expect(result.agents).toEqual([
    {
      agent: "claudeCode",
      discovered: true,
      categories: [
        {
          category: "skills",
          discoveredCount: 1,
          importableCount: 1,
          skippedCount: 0,
          sourcePaths: [root],
          sourceRoots: [
            {
              scope: "global",
              path: root,
              discoveredCount: 1,
              importableCount: 1,
              skippedCount: 0,
              skills: [
                {
                  name: "Writer",
                  path: join(root, "writer"),
                  importable: true,
                },
              ],
            },
          ],
          selectedByDefault: true,
        },
      ],
    },
  ]);
});

it("已导入或内容变化的外部技能标记为不可导入并给出跳过原因", async () => {
  const home = createHome();
  writePackage(home);
  const root = join(home, ".claude", "skills");
  const digest = externalSkillPackageDigest(
    readSandboxSkillPackage(root, "writer"),
  );

  const imported = createHarness(
    home,
    scriptedDb({
      receipt: {
        parameter_fingerprint: digest,
        skill_id: SKILL_ID,
        status: "imported",
      },
    }),
  );
  const detectImported = imported.host["settings-sync.detect"];
  if (!detectImported) throw new Error("扫描入口未注册");
  const importedResult = (await detectImported.call(
    imported.actor,
    [{}],
    imported.context,
  )) as SettingsSyncDiscoveryResult;
  imported.dispose();
  expect(
    importedResult.agents[0]?.categories[0]?.sourceRoots?.[0]?.skills?.[0],
  ).toMatchObject({ importable: false, skipReason: "targetExists" });

  const changed = createHarness(
    home,
    scriptedDb({
      receipt: {
        parameter_fingerprint: "c".repeat(64),
        skill_id: SKILL_ID,
        status: "imported",
      },
    }),
  );
  const detectChanged = changed.host["settings-sync.detect"];
  if (!detectChanged) throw new Error("扫描入口未注册");
  const changedResult = (await detectChanged.call(
    changed.actor,
    [{}],
    changed.context,
  )) as SettingsSyncDiscoveryResult;
  changed.dispose();
  expect(
    changedResult.agents[0]?.categories[0]?.sourceRoots?.[0]?.skills?.[0],
  ).toMatchObject({ importable: false, skipReason: "sameNameExists" });
});

it("选中技能路径后导入并返回成功计数", async () => {
  const home = createHome();
  const root = writePackage(home);
  const f = createHarness(home, scriptedDb());
  const importSelected = f.host["settings-sync.importSelected"];
  if (!importSelected) throw new Error("导入入口未注册");
  const result = (await importSelected.call(
    f.actor,
    [
      {
        selections: [
          {
            agent: "claudeCode",
            category: "skills",
            sourceScope: "global",
            targetScope: "global",
            importMode: "copy",
            skillPaths: [join(root, "writer")],
          },
        ],
      },
    ],
    f.context,
  )) as SettingsSyncImportResult;
  f.dispose();

  expect(result).toMatchObject({
    successCount: 1,
    skippedCount: 0,
    failedCount: 0,
  });
  expect(result.taskResults[0]).toMatchObject({
    agent: "claudeCode",
    category: "skills",
    status: "success",
    importedCount: 1,
    skillResults: [
      {
        name: "writer",
        path: join(root, "writer"),
        sourceScope: "global",
        status: "imported",
      },
    ],
  });
});

it("slug 被占用时跳过并说明同名已存在", async () => {
  const home = createHome();
  const root = writePackage(home);
  const f = createHarness(home, scriptedDb({ slugExists: true }));
  const importSelected = f.host["settings-sync.importSelected"];
  if (!importSelected) throw new Error("导入入口未注册");
  const result = (await importSelected.call(
    f.actor,
    [
      {
        selections: [
          {
            agent: "claudeCode",
            category: "skills",
            skillPaths: [join(root, "writer")],
          },
        ],
      },
    ],
    f.context,
  )) as SettingsSyncImportResult;
  f.dispose();

  expect(result).toMatchObject({
    successCount: 0,
    skippedCount: 1,
    failedCount: 0,
  });
  expect(result.taskResults[0]?.skillResults?.[0]).toMatchObject({
    status: "skipped",
    skipReason: "sameNameExists",
  });
});

it("删除后命中墓碑的迟到导入记为失败，不复活内容", async () => {
  const home = createHome();
  const root = writePackage(home);
  const f = createHarness(
    home,
    scriptedDb({
      receipt: {
        parameter_fingerprint: null,
        skill_id: null,
        status: "deleted",
      },
    }),
  );
  const importSelected = f.host["settings-sync.importSelected"];
  if (!importSelected) throw new Error("导入入口未注册");
  const result = (await importSelected.call(
    f.actor,
    [
      {
        selections: [
          {
            agent: "claudeCode",
            category: "skills",
            skillPaths: [join(root, "writer")],
          },
        ],
      },
    ],
    f.context,
  )) as SettingsSyncImportResult;
  f.dispose();

  expect(result.taskResults[0]).toMatchObject({
    status: "failed",
    failedCount: 1,
  });
});

it("拒绝白名单之外的路径并返回可读原因", async () => {
  const home = createHome();
  const outsider = join(home, "skills");
  mkdirSync(join(outsider, "writer"), { recursive: true });
  writeFileSync(join(outsider, "writer", "SKILL.md"), manifest);
  const f = createHarness(home, scriptedDb());
  const importSelected = f.host["settings-sync.importSelected"];
  if (!importSelected) throw new Error("导入入口未注册");
  await expect(
    importSelected.call(
      f.actor,
      [
        {
          selections: [
            {
              agent: "claudeCode",
              category: "skills",
              skillPaths: [join(outsider, "writer")],
            },
          ],
        },
      ],
      f.context,
    ),
  ).rejects.toMatchObject({
    code: "settings_sync_path_outside_whitelist",
    statusCode: 400,
  });
  f.dispose();
});

/** 建一个假想的已暂存来源（git 仓库快照形态）：内容目录里有 writer 技能。 */
function writeStagedPackage(options?: { skillSlug: string }): {
  workDirectory: string;
  contentRoot: string;
  staged: StagedSkillImportSource;
} {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const workDirectory = mkdtempSync(join(SCRATCH_ROOT, "staged-host-"));
  cleanups.push(() => rmSync(workDirectory, { recursive: true, force: true }));
  const contentRoot = join(workDirectory, "content");
  const packageDir = join(contentRoot, options?.skillSlug ?? "writer");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "SKILL.md"), manifest);
  const staged: StagedSkillImportSource = {
    kind: "git",
    label: "https://github.com/anthropics/skills",
    rootPath: contentRoot,
    sourceKey: "git:https://github.com/anthropics/skills@abc123#deadbeef",
  };
  return {
    workDirectory,
    contentRoot,
    staged,
  };
}

function stagedListerOf(staged: readonly StagedSkillImportSource[]): {
  list(instanceId: string): Promise<readonly StagedSkillImportSource[]>;
} {
  return {
    async list(instanceId) {
      expect(instanceId).toBe(INSTANCE_ID);
      return staged;
    },
  };
}

it("暂存来源出现在扫描结果里，展示名用仓库地址而不是临时目录", async () => {
  const home = createHome();
  const { staged } = writeStagedPackage();
  const f = createHarness(home, scriptedDb(), {
    stagedSources: stagedListerOf([staged]),
  });
  const detect = f.host["settings-sync.detect"];
  if (!detect) throw new Error("扫描入口未注册");
  const result = (await detect.call(
    f.actor,
    [{ categories: ["skills"] }],
    f.context,
  )) as SettingsSyncDiscoveryResult;
  f.dispose();

  const gitAgent = result.agents.find(
    (agent) => agent.agent === "gitRepository",
  );
  expect(gitAgent).toBeDefined();
  const category = gitAgent?.categories[0];
  expect(category).toMatchObject({
    category: "skills",
    discoveredCount: 1,
    importableCount: 1,
    selectedByDefault: true,
  });
  expect(category?.sourcePaths).toEqual([staged.label]);
  expect(category?.sourceRoots?.[0]?.path).toBe(staged.label);
  expect(category?.sourceRoots?.[0]?.skills?.[0]).toMatchObject({
    name: "Writer",
    path: join(staged.rootPath, "writer"),
    importable: true,
  });
  // 外部 Agent 目录与暂存来源并列出现
  expect(result.agents.some((agent) => agent.agent === "claudeCode")).toBe(
    false,
  );
});

it("暂存来源里的技能可以导入，导入身份用稳定来源标识", async () => {
  const home = createHome();
  const { contentRoot, staged, workDirectory } = writeStagedPackage();
  const root = join(contentRoot, "writer");
  const digest = externalSkillPackageDigest(
    readSandboxSkillPackage(contentRoot, "writer"),
  );

  const first = createHarness(home, scriptedDb(), {
    stagedSources: stagedListerOf([staged]),
  });
  const importSelected = first.host["settings-sync.importSelected"];
  if (!importSelected) throw new Error("导入入口未注册");
  const result = (await importSelected.call(
    first.actor,
    [
      {
        selections: [
          {
            agent: "gitRepository",
            category: "skills",
            sourceScope: "global",
            targetScope: "global",
            importMode: "copy",
            skillPaths: [root],
          },
        ],
      },
    ],
    first.context,
  )) as SettingsSyncImportResult;
  first.dispose();
  expect(result.taskResults[0]).toMatchObject({
    agent: "gitRepository",
    status: "success",
    importedCount: 1,
    skillResults: [{ name: "writer", path: root, status: "imported" }],
  });

  // 同一来源标识 + 同一内容再次扫描：标记已导入（临时目录换了也不影响）
  const { staged: stagedAgain } = writeStagedPackage();
  expect(stagedAgain.rootPath).not.toBe(workDirectory);
  const second = createHarness(
    home,
    scriptedDb({
      receipt: {
        parameter_fingerprint: digest,
        skill_id: SKILL_ID,
        status: "imported",
      },
    }),
    { stagedSources: stagedListerOf([stagedAgain]) },
  );
  const detect = second.host["settings-sync.detect"];
  if (!detect) throw new Error("扫描入口未注册");
  const detected = (await detect.call(
    second.actor,
    [{}],
    second.context,
  )) as SettingsSyncDiscoveryResult;
  second.dispose();
  expect(
    detected.agents.find((agent) => agent.agent === "gitRepository")
      ?.categories[0]?.sourceRoots?.[0]?.skills?.[0],
  ).toMatchObject({ importable: false, skipReason: "targetExists" });
});

it("暂存来源里重复的展示名加序号区分", async () => {
  const home = createHome();
  const first = writeStagedPackage({ skillSlug: "writer" });
  const second = writeStagedPackage({ skillSlug: "writer" });
  const f = createHarness(home, scriptedDb(), {
    stagedSources: stagedListerOf([first.staged, second.staged]),
  });
  const detect = f.host["settings-sync.detect"];
  if (!detect) throw new Error("扫描入口未注册");
  const result = (await detect.call(
    f.actor,
    [{ categories: ["skills"] }],
    f.context,
  )) as SettingsSyncDiscoveryResult;
  f.dispose();
  const gitAgents = result.agents.filter(
    (agent) => agent.agent === "gitRepository",
  );
  // 每个暂存来源各占一行，同名的展示名加序号区分
  expect(
    gitAgents.map((agent) => agent.categories[0]?.sourcePaths?.[0]),
  ).toEqual([first.staged.label, `${second.staged.label} (2)`]);
});

it("扫描层数上限来自实例设置：默认深度外的技能按设置放开", async () => {
  const home = createHome();
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const deepRoot = mkdtempSync(join(SCRATCH_ROOT, "staged-deep-"));
  cleanups.push(() => rmSync(deepRoot, { recursive: true, force: true }));
  const contentRoot = join(deepRoot, "content");
  const deepSkillDir = join(contentRoot, "docs", "guides", "writing", "writer");
  mkdirSync(deepSkillDir, { recursive: true });
  writeFileSync(join(deepSkillDir, "SKILL.md"), manifest);
  const staged: StagedSkillImportSource = {
    kind: "zip",
    label: "deep-skills.zip",
    rootPath: contentRoot,
    sourceKey: "zip:sha256:abc",
  };

  // 默认上限（3 层）够不到四层目录里的技能
  const byDefault = createHarness(home, scriptedDb(), {
    stagedSources: stagedListerOf([staged]),
  });
  const detectDefault = byDefault.host["settings-sync.detect"];
  if (!detectDefault) throw new Error("扫描入口未注册");
  const defaultResult = (await detectDefault.call(
    byDefault.actor,
    [{}],
    byDefault.context,
  )) as SettingsSyncDiscoveryResult;
  byDefault.dispose();
  expect(defaultResult.agents).toEqual([]);

  // 实例设置放宽到 5 层后可以找到
  const widened = createHarness(home, scriptedDb(), {
    stagedSources: stagedListerOf([staged]),
    readMaxDepth: async () => 5,
  });
  const detectWide = widened.host["settings-sync.detect"];
  if (!detectWide) throw new Error("扫描入口未注册");
  const wideResult = (await detectWide.call(
    widened.actor,
    [{}],
    widened.context,
  )) as SettingsSyncDiscoveryResult;
  widened.dispose();
  expect(
    wideResult.agents.find((agent) => agent.agent === "zipArchive")
      ?.categories[0]?.sourceRoots?.[0]?.skills?.[0],
  ).toMatchObject({ name: "Writer", importable: true });
});

it("只接了技能类别：其余类别显式报错，不返回空壳结果", async () => {
  const home = createHome();
  const f = createHarness(home, scriptedDb());
  const detect = f.host["settings-sync.detect"];
  if (!detect) throw new Error("扫描入口未注册");
  await expect(
    detect.call(f.actor, [{ categories: ["mcpServers"] }], f.context),
  ).rejects.toMatchObject({
    code: "settings_sync_category_unsupported",
    statusCode: 400,
  });
  await expect(
    detect.call(f.actor, [{ categories: ["commands"] }], f.context),
  ).rejects.toMatchObject({ code: "settings_sync_category_unsupported" });
  f.dispose();
});
