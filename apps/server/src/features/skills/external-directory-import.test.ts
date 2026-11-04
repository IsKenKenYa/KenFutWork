import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import {
  ExternalSkillPathError,
  ExternalSkillSlugConflictError,
  externalSkillPackageDigest,
  importExternalSkill,
  resolveExternalSkillRoots,
  scanExternalSkillDirectories,
} from "./external-directory-import.js";
import {
  createSkillCatalogRepository,
  createSkillImportReceiptRepository,
  SkillImportConflictError,
  SkillImportDeletedError,
} from "./repository.js";
import {
  MAX_FILES,
  readSandboxSkillPackage,
} from "./sandbox-skill-packages.js";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);
const SCRATCH_ROOT = join(REPO_ROOT, ".scratch");
const INSTANCE_ID = "instance-1";
const SKILL_ID = "skill-1";

const homes: string[] = [];

function createHome(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const home = mkdtempSync(join(SCRATCH_ROOT, "skill-import-"));
  homes.push(home);
  return home;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

const manifest = [
  "---",
  "name: Writer",
  "description: 写作技能",
  "---",
  "# Writer",
  "",
].join("\n");

function writePackage(
  home: string,
  agentDirectory: string,
  slug: string,
  files: Record<string, string> = {
    "SKILL.md": manifest,
    "scripts/run.py": "print('ok')",
    "README.md": "说明",
  },
): string {
  const root = join(home, agentDirectory, "skills");
  writeFiles(join(root, slug), files);
  return root;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function scriptedDb(
  options: {
    receipt?: Record<string, unknown> | null;
    slugExists?: boolean;
    skillId?: string;
  } = {},
) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const skillId = options.skillId ?? SKILL_ID;
  const query: PostgresQueryRunner["query"] = async (sql, values) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, values });
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
      return { rowCount: 1, rows: [{ id: skillId }] };
    }
    return { rowCount: 1, rows: [] };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("外部目录导入不打开任务宿主会话。");
    },
    end: async () => {},
  };
  const persistence = createPersistenceFromRunner(runner);
  return {
    calls,
    catalog: createSkillCatalogRepository(persistence),
    receipts: createSkillImportReceiptRepository(persistence),
  };
}

describe("外部技能目录解析与扫描", () => {
  it("只解析存在的白名单目录，同一个真实目录只保留一次", () => {
    const home = createHome();
    writePackage(home, ".claude", "writer");
    mkdirSync(join(home, ".agents"), { recursive: true });
    // .agents/skills 指向 .claude/skills：真实目录相同，只保留先出现的 claude。
    symlinkSync(
      join(home, ".claude", "skills"),
      join(home, ".agents", "skills"),
    );

    expect(resolveExternalSkillRoots(home)).toEqual([
      {
        agent: "claude",
        rootPath: join(home, ".claude", "skills"),
      },
    ]);
  });

  it("扫描含 SKILL.md 的目录并列出元数据，非技能目录不出现在候选里", async () => {
    const home = createHome();
    const root = writePackage(home, ".claude", "writer");
    writeFiles(join(root, "notes"), { "README.md": "不是技能" });
    const db = scriptedDb();

    const result = await scanExternalSkillDirectories({
      instanceId: INSTANCE_ID,
      homeDir: home,
      receipts: db.receipts,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        rootPath: root,
        relativePath: "writer",
        slug: "writer",
        name: "Writer",
        description: "写作技能",
        imported: false,
        changed: false,
        deleted: false,
      }),
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("拒绝不在白名单的源根目录，并给出可读原因", async () => {
    const home = createHome();
    const outsider = join(home, "skills");
    writeFiles(join(outsider, "writer"), { "SKILL.md": manifest });

    const result = await scanExternalSkillDirectories({
      instanceId: INSTANCE_ID,
      homeDir: home,
      roots: [outsider],
      receipts: scriptedDb().receipts,
    });

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toEqual([
      { rootPath: outsider, reason: "只能扫描已知外部技能目录。" },
    ]);
  });

  it("符号链接逃逸被跳过，不读出白名单之外的内容", async () => {
    const home = createHome();
    const root = join(home, ".claude", "skills");
    const outside = join(home, "outside");
    writeFiles(join(outside, "escaped"), { "SKILL.md": manifest });
    mkdirSync(root, { recursive: true });
    symlinkSync(join(outside, "escaped"), join(root, "escaped"));

    const result = await scanExternalSkillDirectories({
      instanceId: INSTANCE_ID,
      homeDir: home,
      receipts: scriptedDb().receipts,
    });

    expect(result.candidates).toEqual([]);
    expect(
      result.diagnostics.some((entry) =>
        entry.reason.includes("符号链接：escaped"),
      ),
    ).toBe(true);
  });

  it("文件数量超过共用上限时不列出候选，并说明原因", async () => {
    const home = createHome();
    const root = join(home, ".claude", "skills");
    const packageDir = join(root, "oversize");
    writeFiles(packageDir, { "SKILL.md": manifest });
    for (let index = 0; index < MAX_FILES + 1; index += 1) {
      writeFiles(packageDir, {
        [`scripts/file-${index}.txt`]: "x",
      });
    }

    const result = await scanExternalSkillDirectories({
      instanceId: INSTANCE_ID,
      homeDir: home,
      receipts: scriptedDb().receipts,
    });

    expect(result.candidates).toEqual([]);
    expect(
      result.diagnostics.some((entry) =>
        entry.reason.includes("技能包文件过多"),
      ),
    ).toBe(true);
  });

  it("同来源同摘要标已导入，摘要变化标冲突，删除后标已删除", async () => {
    const home = createHome();
    const root = writePackage(home, ".claude", "writer");
    const digest = externalSkillPackageDigest(
      readSandboxSkillPackage(root, "writer"),
    );

    const imported = await scanExternalSkillDirectories({
      instanceId: INSTANCE_ID,
      homeDir: home,
      receipts: scriptedDb({
        receipt: {
          parameter_fingerprint: digest,
          skill_id: SKILL_ID,
          status: "imported",
        },
      }).receipts,
    });
    expect(imported.candidates[0]).toMatchObject({ imported: true });

    const changed = await scanExternalSkillDirectories({
      instanceId: INSTANCE_ID,
      homeDir: home,
      receipts: scriptedDb({
        receipt: {
          parameter_fingerprint: "c".repeat(64),
          skill_id: SKILL_ID,
          status: "imported",
        },
      }).receipts,
    });
    expect(changed.candidates[0]).toMatchObject({ changed: true });

    const deleted = await scanExternalSkillDirectories({
      instanceId: INSTANCE_ID,
      homeDir: home,
      receipts: scriptedDb({
        receipt: {
          parameter_fingerprint: null,
          skill_id: null,
          status: "deleted",
        },
      }).receipts,
    });
    expect(deleted.candidates[0]).toMatchObject({ deleted: true });
  });
});

describe("外部技能目录导入", () => {
  it("导入技能正文、允许目录的附带文件与安装态，来源摘要写入回执", async () => {
    const home = createHome();
    const root = writePackage(home, ".claude", "writer");
    const db = scriptedDb();

    const result = await importExternalSkill({
      instanceId: INSTANCE_ID,
      homeDir: home,
      rootPath: root,
      relativePath: "writer",
      installedByClientId: null,
      receipts: db.receipts,
      catalog: db.catalog,
    });

    expect(result).toMatchObject({
      skillId: SKILL_ID,
      slug: "writer",
      name: "Writer",
      replayed: false,
    });
    const skillInsert = db.calls.find((call) =>
      call.sql.includes("insert into public.skills"),
    );
    expect(skillInsert?.values).toContain("Writer");
    expect(skillInsert?.values).toContain("写作技能");
    const fileInsert = db.calls.find((call) =>
      call.sql.includes("insert into public.skill_files"),
    );
    expect(fileInsert?.values).toContain("scripts/run.py");
    // 允许目录之外的 README.md 不进技能文件表（与 zip/tarball 导入同口径）。
    expect(fileInsert?.values).not.toContain("README.md");
    expect(
      db.calls.some((call) =>
        call.sql.includes("insert into public.instance_skills"),
      ),
    ).toBe(true);
    const receiptInsert = db.calls.find((call) =>
      call.sql.includes("insert into public.skill_import_receipts"),
    );
    expect(receiptInsert?.values).toContain("writer");
  });

  it("同来源同摘要重放返回既有技能并重新保持启用", async () => {
    const home = createHome();
    const root = writePackage(home, ".claude", "writer");
    const digest = externalSkillPackageDigest(
      readSandboxSkillPackage(root, "writer"),
    );
    const db = scriptedDb({
      receipt: {
        parameter_fingerprint: digest,
        skill_id: SKILL_ID,
        status: "imported",
      },
    });

    const result = await importExternalSkill({
      instanceId: INSTANCE_ID,
      homeDir: home,
      rootPath: root,
      relativePath: "writer",
      installedByClientId: null,
      receipts: db.receipts,
      catalog: db.catalog,
    });

    expect(result).toMatchObject({ skillId: SKILL_ID, replayed: true });
    expect(
      db.calls.some((call) => call.sql.includes("insert into public.skills")),
    ).toBe(false);
    expect(
      db.calls.some((call) =>
        call.sql.includes("insert into public.instance_skills"),
      ),
    ).toBe(true);
  });

  it("同来源内容变化返回冲突，不静默覆盖", async () => {
    const home = createHome();
    const root = writePackage(home, ".claude", "writer");
    const db = scriptedDb({
      receipt: {
        parameter_fingerprint: "c".repeat(64),
        skill_id: SKILL_ID,
        status: "imported",
      },
    });

    await expect(
      importExternalSkill({
        instanceId: INSTANCE_ID,
        homeDir: home,
        rootPath: root,
        relativePath: "writer",
        installedByClientId: null,
        receipts: db.receipts,
        catalog: db.catalog,
      }),
    ).rejects.toBeInstanceOf(SkillImportConflictError);
  });

  it("删除后的迟到导入返回已删除，不复活内容", async () => {
    const home = createHome();
    const root = writePackage(home, ".claude", "writer");
    const db = scriptedDb({
      receipt: {
        parameter_fingerprint: null,
        skill_id: null,
        status: "deleted",
      },
    });

    await expect(
      importExternalSkill({
        instanceId: INSTANCE_ID,
        homeDir: home,
        rootPath: root,
        relativePath: "writer",
        installedByClientId: null,
        receipts: db.receipts,
        catalog: db.catalog,
      }),
    ).rejects.toBeInstanceOf(SkillImportDeletedError);
    expect(
      db.calls.some((call) => call.sql.includes("insert into public.skills")),
    ).toBe(false);
  });

  it("同实例已有同名 slug 且来源不同时返回冲突", async () => {
    const home = createHome();
    const root = writePackage(home, ".claude", "writer");
    const db = scriptedDb({ slugExists: true });

    await expect(
      importExternalSkill({
        instanceId: INSTANCE_ID,
        homeDir: home,
        rootPath: root,
        relativePath: "writer",
        installedByClientId: null,
        receipts: db.receipts,
        catalog: db.catalog,
      }),
    ).rejects.toBeInstanceOf(ExternalSkillSlugConflictError);
  });

  it("拒绝白名单之外的根目录与越界相对路径", async () => {
    const home = createHome();
    const outsider = join(home, "skills");
    writeFiles(join(outsider, "writer"), { "SKILL.md": manifest });
    const db = scriptedDb();

    await expect(
      importExternalSkill({
        instanceId: INSTANCE_ID,
        homeDir: home,
        rootPath: outsider,
        relativePath: "writer",
        installedByClientId: null,
        receipts: db.receipts,
        catalog: db.catalog,
      }),
    ).rejects.toBeInstanceOf(ExternalSkillPathError);

    const root = writePackage(home, ".claude", "writer");
    await expect(
      importExternalSkill({
        instanceId: INSTANCE_ID,
        homeDir: home,
        rootPath: root,
        relativePath: "../escaped",
        installedByClientId: null,
        receipts: db.receipts,
        catalog: db.catalog,
      }),
    ).rejects.toThrow(/越出/u);
  });
});
