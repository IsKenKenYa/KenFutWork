import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionScopes,
  type ExecutionScopes,
} from "../features/execution/scope-service.js";
import { createLocalInstanceService } from "../features/local-instance/service.js";
import { SqlError } from "../features/persistence/errors.js";
import type { SkillCatalogRepository } from "../features/skills/repository.js";
import { registerSkillRoutes } from "./skills.js";
import { registerMarketplaceRoutes } from "./skills-marketplace.js";

// 外部网络调用（URL 导入 / npm 市场）在本文件内一律替身；这两个模块其余导出保留原实现，
// 因为路由用它们的错误类做 `instanceof` 判定。
vi.mock(
  "../features/skills/skill-import-service.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../features/skills/skill-import-service.js")
      >();
    return { ...actual, importSkillFromUrl: vi.fn() };
  },
);

vi.mock("../features/skills/marketplace-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../features/skills/marketplace-service.js")
    >();
  return { ...actual, installFromMarketplace: vi.fn() };
});

const INSTANCE_ID = "1b18ef1f-1d78-4469-bbfe-9a245e73636b";
const ACTOR = { instanceId: INSTANCE_ID, accessClientId: "client-1" };
const localInstance = createLocalInstanceService({
  repository: { ensure: async () => INSTANCE_ID },
  dataDir: "/tmp/skills-http-test",
});
const SKILL_ID = "skill-1";

/** 目录行按 repository 的裸行形状（snake_case + ISO 字符串时间戳）。 */
const SKILL_ROW = {
  id: SKILL_ID,
  name: "Canvas Design",
  slug: "canvas-design",
  description: "画布设计技能",
  author: "system",
  version: "1.0",
  license: null,
  category: "design",
  icon_name: "palette",
  source: "system",
  skill_content: "# SKILL",
  metadata: {},
  is_featured: true,
  created_by_client_id: null,
  created_at: "2026-09-13T00:00:00.000Z",
  updated_at: "2026-09-13T00:00:00.000Z",
  source_url: null,
  package_name: null,
};

const FILE_ROW = {
  id: "file-1",
  skill_id: SKILL_ID,
  file_path: "scripts/analyze.py",
  content: "print(1)",
  mime_type: "text/plain",
  created_at: "2026-09-13T00:00:00.000Z",
  updated_at: "2026-09-13T00:00:00.000Z",
};

function fakeRepository(
  overrides: Partial<SkillCatalogRepository> = {},
): SkillCatalogRepository {
  return {
    deleteOwnedById: async () => 0,
    findVisibleById: async () => null,
    findVisibleSkill: async () => null,
    insertFilesForOwnedSkill: async () => 0,
    insertOwned: async () => null,
    listFilesForVisibleSkill: async () => [],
    listInstalled: async () => [],
    listSkillFiles: async () => [],
    listVisible: async () => [],
    listInstanceSkills: async () => [],
    uninstall: async () => 0,
    updateOwnedById: async () => null,
    upsertInstallation: async () => {},
    setEnabled: async () => true,
    ...overrides,
  };
}

async function buildApp(
  repository: Partial<SkillCatalogRepository> = {},
  options: {
    unauthenticated?: boolean;
    /** 工作目录导入相关：假画布仓库 + 沙箱根（默认「画布找不到」）。 */
    canvas?: { id: string; project_id?: string } | null;
    sandboxRoot?: string;
    executionScopes?: Pick<ExecutionScopes, "openTask">;
    projectKind?: "design" | "code";
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const deps = {
    localAccess: {
      authenticate: async () => (options.unauthenticated ? null : ACTOR),
    },
    skillsRepository: fakeRepository(repository),
    localInstance,
    // 工作目录导入相关：默认「画布找不到」；用例可传入假画布与沙箱根
    canvasRepository: {
      findById: async () =>
        options.canvas === undefined || options.canvas === null
          ? null
          : {
              ...options.canvas,
              project_id: options.canvas.project_id ?? "visual-project",
            },
    } as never,
    projects: {
      getProject: async () => ({ kind: options.projectKind ?? "design" }),
    } as never,
    executionScopes: options.executionScopes ?? {
      openTask: async () => {
        throw new Error("测试未配置 Code Task。");
      },
    },
    ...(options.sandboxRoot ? { sandboxRoot: options.sandboxRoot } : {}),
  };
  await registerSkillRoutes(app, deps);
  await registerMarketplaceRoutes(app, deps);
  return app;
}

const IMPORTED = {
  manifest: {
    author: "someone",
    description: "导入的技能",
    license: "MIT",
    metadata: { tag: "x" },
    name: "Imported Skill",
    version: "2.1",
  },
  files: [
    {
      content: "print(1)",
      filePath: "scripts/a.py",
      mimeType: "text/x-python",
    },
  ],
  skillContent: "# imported",
  sourceUrl: "https://github.com/acme/skill",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/skills（目录读取）", () => {
  it("行按 camelCase 出参且通过共享契约校验（时间戳必须是 ISO 字符串）", async () => {
    const app = await buildApp({ listVisible: async () => [SKILL_ROW] });

    const res = await app.inject({ method: "GET", url: "/api/skills" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      skills: [
        {
          id: SKILL_ID,
          name: "Canvas Design",
          slug: "canvas-design",
          description: "画布设计技能",
          author: "system",
          version: "1.0",
          category: "design",
          iconName: "palette",
          source: "system",
          isFeatured: true,
          metadata: {},
          createdAt: "2026-09-13T00:00:00.000Z",
          updatedAt: "2026-09-13T00:00:00.000Z",
        },
      ],
    });
  });

  it("数据访问抛错折叠为 500 skill_query_failed", async () => {
    const app = await buildApp({
      listVisible: async () => {
        throw new Error("boom");
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/skills" });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("skill_query_failed");
  });

  it("未鉴权 → 401", async () => {
    const app = await buildApp({}, { unauthenticated: true });

    const res = await app.inject({ method: "GET", url: "/api/skills" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });
});

describe("GET /api/skills/:id（明细 + 附带文件）", () => {
  it("明细带 files，且文件取数走可见性谓词（不让越界 skill 的文件漏出）", async () => {
    const calls: Array<[string, string]> = [];
    const app = await buildApp({
      findVisibleById: async () => SKILL_ROW,
      listFilesForVisibleSkill: async (instanceId, skillId) => {
        calls.push([instanceId, skillId]);
        return [FILE_ROW];
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/skills/${SKILL_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([[ACTOR.instanceId, SKILL_ID]]);
    expect(res.json().skill.skillContent).toBe("# SKILL");
    expect(res.json().skill.files).toEqual([
      {
        id: "file-1",
        filePath: "scripts/analyze.py",
        content: "print(1)",
        mimeType: "text/plain",
        createdAt: "2026-09-13T00:00:00.000Z",
        updatedAt: "2026-09-13T00:00:00.000Z",
      },
    ]);
  });

  it("不可见 → 404 skill_not_found", async () => {
    const app = await buildApp({ findVisibleById: async () => null });

    const res = await app.inject({ method: "GET", url: "/api/skills/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("skill_not_found");
  });
});

describe("GET /api/skills/:id/files", () => {
  it("列文件成功", async () => {
    const app = await buildApp({
      listFilesForVisibleSkill: async () => [FILE_ROW],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/skills/${SKILL_ID}/files`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().files).toHaveLength(1);
  });

  it("取数失败 → 500 skill_file_query_failed（不静默返回空列表）", async () => {
    const app = await buildApp({
      listFilesForVisibleSkill: async () => {
        throw new Error("boom");
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/skills/${SKILL_ID}/files`,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("skill_file_query_failed");
  });
});

describe("POST /api/skills（新建）", () => {
  const body = {
    category: "custom",
    description: "自建技能",
    name: "My Skill",
    skillContent: "# mine",
  };

  it("建成功 → 201，且缺省列（author/version/metadata）交由列默认承担", async () => {
    const inserted: unknown[] = [];
    const app = await buildApp({
      insertOwned: async (_instanceId, input) => {
        inserted.push(input);
        return SKILL_ROW;
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    expect(inserted).toEqual([
      {
        category: "custom",
        createdByClientId: ACTOR.accessClientId,
        description: "自建技能",
        iconName: null,
        name: "My Skill",
        skillContent: "# mine",
        slug: "my-skill",
      },
    ]);
  });

  it("附带文件写入失败不致命：skill 已建成功仍返回 201（文件回读为空）", async () => {
    const app = await buildApp({
      insertFilesForOwnedSkill: async () => {
        throw new Error("files boom");
      },
      insertOwned: async () => SKILL_ROW,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        ...body,
        files: [{ content: "x", filePath: "scripts/a.py" }],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().skill.files).toEqual([]);
  });

  it("唯一 slug 冲突（SQLSTATE 23505）→ 409", async () => {
    const app = await buildApp({
      insertOwned: async () => {
        throw new SqlError("duplicate key", { code: "23505" });
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: body,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("skill_create_failed");
  });

  it("非唯一约束失败 → 500（不与 409 混同）", async () => {
    const app = await buildApp({
      insertOwned: async () => {
        throw new SqlError("fk violation", { code: "23503" });
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: body,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("skill_create_failed");
  });

  it("非法请求体 → 400 且带 issues", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { ...body, category: "not-a-category" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toBeDefined();
  });
});

describe("POST /api/skills/import（URL 导入）", () => {
  it("导入成功 → 201，且 author/version/license/metadata 逐字段落库并自动安装到实例", async () => {
    const { importSkillFromUrl } = await import(
      "../features/skills/skill-import-service.js"
    );
    vi.mocked(importSkillFromUrl).mockResolvedValue(IMPORTED);

    const inserted: unknown[] = [];
    const installs: unknown[] = [];
    const app = await buildApp({
      insertFilesForOwnedSkill: async () => 1,
      insertOwned: async (_instanceId, input) => {
        inserted.push(input);
        return SKILL_ROW;
      },
      upsertInstallation: async (input) => {
        installs.push(input);
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { url: IMPORTED.sourceUrl },
    });

    expect(res.statusCode).toBe(201);
    expect(inserted).toEqual([
      {
        author: "someone",
        category: "custom",
        createdByClientId: ACTOR.accessClientId,
        description: "导入的技能",
        license: "MIT",
        metadata: { source_url: IMPORTED.sourceUrl, tag: "x" },
        name: "Imported Skill",
        skillContent: "# imported",
        slug: "imported-skill",
        version: "2.1",
      },
    ]);
    expect(installs).toEqual([
      {
        enabled: true,
        installedByClientId: ACTOR.accessClientId,
        skillId: SKILL_ID,
        instanceId: INSTANCE_ID,
      },
    ]);
  });

  it("manifest 缺 author/version/license 时回落，不写入 undefined", async () => {
    const { importSkillFromUrl } = await import(
      "../features/skills/skill-import-service.js"
    );
    vi.mocked(importSkillFromUrl).mockResolvedValue({
      ...IMPORTED,
      files: [],
      manifest: { description: "d", name: "Bare Skill" },
    });

    const inserted: Array<Record<string, unknown>> = [];
    const app = await buildApp({
      insertOwned: async (_instanceId, input) => {
        inserted.push(input as Record<string, unknown>);
        return SKILL_ROW;
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { url: IMPORTED.sourceUrl },
    });

    expect(res.statusCode).toBe(201);
    expect(inserted[0]).toMatchObject({
      author: "unknown",
      license: null,
      version: "1.0",
    });
    expect(Object.values(inserted[0] ?? {})).not.toContain(undefined);
  });

  it("重复 slug（23505）→ 409", async () => {
    const { importSkillFromUrl } = await import(
      "../features/skills/skill-import-service.js"
    );
    vi.mocked(importSkillFromUrl).mockResolvedValue(IMPORTED);

    const app = await buildApp({
      insertOwned: async () => {
        throw new SqlError("duplicate key", { code: "23505" });
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { url: IMPORTED.sourceUrl },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("skill_import_failed");
  });
});

describe("POST /api/skills/marketplace/install", () => {
  it("安装成功 → 201，metadata 带 source_url/package_name", async () => {
    const { installFromMarketplace } = await import(
      "../features/skills/marketplace-service.js"
    );
    vi.mocked(installFromMarketplace).mockResolvedValue({
      imported: IMPORTED,
      packageName: "@acme/skill",
    });

    const inserted: Array<Record<string, unknown>> = [];
    const app = await buildApp({
      insertFilesForOwnedSkill: async () => 1,
      insertOwned: async (_instanceId, input) => {
        inserted.push(input as Record<string, unknown>);
        return SKILL_ROW;
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { packageName: "@acme/skill" },
    });

    expect(res.statusCode).toBe(201);
    expect(inserted[0]).toMatchObject({
      author: "someone",
      createdByClientId: ACTOR.accessClientId,
      metadata: {
        package_name: "@acme/skill",
        source_url: "https://www.npmjs.com/package/@acme/skill",
        tag: "x",
      },
      version: "2.1",
    });
  });

  it("重复安装（23505）→ 409", async () => {
    const { installFromMarketplace } = await import(
      "../features/skills/marketplace-service.js"
    );
    vi.mocked(installFromMarketplace).mockResolvedValue({
      imported: IMPORTED,
      packageName: "@acme/skill",
    });

    const app = await buildApp({
      insertOwned: async () => {
        throw new SqlError("duplicate key", { code: "23505" });
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { packageName: "@acme/skill" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("marketplace_install_failed");
  });
});

describe("PUT / DELETE /api/skills/:id", () => {
  it("更新成功 → 200", async () => {
    const app = await buildApp({ updateOwnedById: async () => SKILL_ROW });

    const res = await app.inject({
      method: "PUT",
      url: `/api/skills/${SKILL_ID}`,
      payload: { name: "Renamed" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().skill.name).toBe("Canvas Design");
  });

  it("无字段可更新 → 400（不发空 UPDATE）", async () => {
    let called = 0;
    const app = await buildApp({
      updateOwnedById: async () => {
        called += 1;
        return null;
      },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/skills/${SKILL_ID}`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("skill_update_failed");
    expect(called).toBe(0);
  });

  it("非本人创建（0 行）→ 404", async () => {
    const app = await buildApp({ updateOwnedById: async () => null });

    const res = await app.inject({
      method: "PUT",
      url: `/api/skills/${SKILL_ID}`,
      payload: { name: "Renamed" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("删除成功 → 204；不存在 → 404", async () => {
    const hit = await buildApp({ deleteOwnedById: async () => 1 });
    const miss = await buildApp({ deleteOwnedById: async () => 0 });

    const ok = await hit.inject({
      method: "DELETE",
      url: `/api/skills/${SKILL_ID}`,
    });
    const gone = await miss.inject({
      method: "DELETE",
      url: `/api/skills/${SKILL_ID}`,
    });

    expect(ok.statusCode).toBe(204);
    expect(gone.statusCode).toBe(404);
  });
});

describe("/api/instance/skills（安装态）", () => {
  it("列表：只出带 skill 明细的行，并带 installed/enabled 标记", async () => {
    const app = await buildApp({
      listInstalled: async () => [
        {
          enabled: false,
          installed_at: "2026-09-13T00:00:00.000Z",
          skill_id: SKILL_ID,
          skills: SKILL_ROW,
        },
        {
          enabled: true,
          installed_at: "2026-09-13T00:00:00.000Z",
          skill_id: "ghost",
          skills: null,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/instance/skills",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().skills).toEqual([
      expect.objectContaining({
        enabled: false,
        id: SKILL_ID,
        installed: true,
        installedAt: "2026-09-13T00:00:00.000Z",
      }),
    ]);
  });

  it("安装：先查可见性，再 upsert 到当前实例", async () => {
    const visible: Array<[string, string]> = [];
    const installs: unknown[] = [];
    const app = await buildApp({
      findVisibleSkill: async (instanceId, skillId) => {
        visible.push([instanceId, skillId]);
        return { id: skillId };
      },
      upsertInstallation: async (input) => {
        installs.push(input);
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/instance/skills",
      payload: { skillId: SKILL_ID },
    });

    expect(res.statusCode).toBe(204);
    expect(visible).toEqual([[ACTOR.instanceId, SKILL_ID]]);
    expect(installs).toEqual([
      {
        enabled: true,
        installedByClientId: ACTOR.accessClientId,
        skillId: SKILL_ID,
        instanceId: INSTANCE_ID,
      },
    ]);
  });

  it("安装内置目录之外的不可见 skill → 404（不越界安装）", async () => {
    let installs = 0;
    const app = await buildApp({
      findVisibleSkill: async () => null,
      upsertInstallation: async () => {
        installs += 1;
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/instance/skills",
      payload: { skillId: "someone-elses" },
    });

    expect(res.statusCode).toBe(404);
    expect(installs).toBe(0);
  });

  it("卸载 → 204；未安装 → 404", async () => {
    const hit = await buildApp({ uninstall: async () => 1 });
    const miss = await buildApp({ uninstall: async () => 0 });

    const ok = await hit.inject({
      method: "DELETE",
      url: `/api/instance/skills/${SKILL_ID}`,
    });
    const gone = await miss.inject({
      method: "DELETE",
      url: `/api/instance/skills/${SKILL_ID}`,
    });

    expect(ok.statusCode).toBe(204);
    expect(gone.statusCode).toBe(404);
  });

  it("启停：按请求体写入 enabled", async () => {
    const installs: Array<{ enabled: boolean }> = [];
    const app = await buildApp({
      findVisibleSkill: async (_instanceId, skillId) => ({ id: skillId }),
      setEnabled: async (_instanceId, _skillId, enabled) => {
        installs.push({ enabled });
        return true;
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/instance/skills/${SKILL_ID}`,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(204);
    expect(installs).toEqual([expect.objectContaining({ enabled: false })]);
  });
});

/**
 * 「从工作目录导入」：agent 在沙箱里造出来的技能包（创造模式产物）要能一键装进实例。
 * 这两条路由是创造模式的最后一段路：列出候选 → 读取并导入（自动安装 + 启用）。
 */
describe("工作目录里的技能包（从工作目录导入）", () => {
  const CANVAS_ID = "canvas-1";

  function makeSandbox(): string {
    const root = mkdtempSync(join(tmpdir(), "kfw-skill-import-"));
    // 包落在 `<沙箱根>/<画布UUID>/`：与 resolveSandboxDir 的口径一致
    const workspaceDir = join(root, CANVAS_ID);
    mkdirSync(join(workspaceDir, "en-zh-translate", "scripts"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceDir, "en-zh-translate", "SKILL.md"),
      "---\nname: en-zh-translate\ndescription: 英译中\n---\n\n步骤…\n",
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "en-zh-translate", "scripts", "run.py"),
      "print('x')",
      "utf8",
    );
    return root;
  }

  it("列出候选：只列含 SKILL.md 的目录，带解析出的名字与说明", async () => {
    const sandboxRoot = makeSandbox();
    const app = await buildApp({}, { canvas: { id: CANVAS_ID }, sandboxRoot });

    const res = await app.inject({
      method: "GET",
      url: `/api/skills/sandbox-packages?canvasId=${CANVAS_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      packages: [
        expect.objectContaining({
          path: "en-zh-translate",
          name: "en-zh-translate",
          description: "英译中",
        }),
      ],
    });
  });

  it("导入：读取磁盘内容 → 落库 → 自动装进当前实例（附带文件一并写入）", async () => {
    const sandboxRoot = makeSandbox();
    const inserts: unknown[] = [];
    const installs: unknown[] = [];
    const app = await buildApp(
      {
        insertOwned: async (_instanceId, input) => {
          inserts.push(input);
          return { ...SKILL_ROW, id: SKILL_ID };
        },
        insertFilesForOwnedSkill: async () => 1,
        listFilesForVisibleSkill: async () => [FILE_ROW],
        upsertInstallation: async (input) => {
          installs.push(input);
        },
      },
      { canvas: { id: CANVAS_ID }, sandboxRoot },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/skills/sandbox-import",
      payload: { canvasId: CANVAS_ID, path: "en-zh-translate" },
    });

    expect(res.statusCode).toBe(201);
    expect(inserts[0]).toMatchObject({
      name: "en-zh-translate",
      skillContent: expect.stringContaining("英译中"),
    });
    expect(installs[0]).toMatchObject({
      enabled: true,
      skillId: SKILL_ID,
      instanceId: INSTANCE_ID,
    });
    expect(res.json().skill.files).toHaveLength(1);
  });

  it("路径越界 / 缺 SKILL.md / 画布不属于本实例都如实拒绝", async () => {
    const sandboxRoot = makeSandbox();
    const app = await buildApp({}, { canvas: { id: CANVAS_ID }, sandboxRoot });

    const escaped = await app.inject({
      method: "POST",
      url: "/api/skills/sandbox-import",
      payload: { canvasId: CANVAS_ID, path: "../../etc" },
    });
    expect(escaped.statusCode).toBe(400);
    expect(escaped.json().error.message).toContain("越出工作目录");

    const missing = await app.inject({
      method: "POST",
      url: "/api/skills/sandbox-import",
      payload: { canvasId: CANVAS_ID, path: "en-zh-translate/scripts" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain("SKILL.md");

    // 画布查询默认返回 null（不属于当前实例）
    const foreign = await buildApp({}, { sandboxRoot });
    const denied = await foreign.inject({
      method: "POST",
      url: "/api/skills/sandbox-import",
      payload: { canvasId: "someone-else", path: "en-zh-translate" },
    });
    expect(denied.statusCode).toBe(404);
  });

  it("Code候选与导入绑定明确Task真实目录，旧Canvas与双身份请求拒绝", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kfw-task-skill-")));
    const taskId = "fb6d510a-5bf0-4870-8ec4-f4ce4e2d37e2";
    const scopeIdentity = {
      instanceId: INSTANCE_ID,
      projectId: "993e015e-0ee1-40e9-9d91-f5327556cdde",
      taskId,
      generation: 0,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "read-only" as const,
    };
    const scopes = createExecutionScopes({
      repository: {
        load: async (_instanceId, id) =>
          id === taskId
            ? { scope: scopeIdentity, state: "ready", branchGeneration: 1 }
            : null,
      },
      localInstance,
    });
    try {
      mkdirSync(join(root, "from-task"));
      writeFileSync(
        join(root, "from-task", "SKILL.md"),
        "---\nname: from-task\ndescription: Task目录\n---\n正文",
      );
      const inserts = vi.fn(async () => ({ ...SKILL_ROW, id: SKILL_ID }));
      const app = await buildApp(
        { insertOwned: inserts, insertFilesForOwnedSkill: async () => 0 },
        {
          executionScopes: scopes,
          canvas: { id: CANVAS_ID },
          projectKind: "code",
        },
      );
      const candidates = await app.inject({
        method: "GET",
        url: `/api/skills/sandbox-packages?taskId=${taskId}`,
      });
      expect(candidates.statusCode).toBe(200);
      expect(candidates.json().packages).toEqual([
        expect.objectContaining({
          path: join(root, "from-task"),
          name: "from-task",
        }),
      ]);
      const imported = await app.inject({
        method: "POST",
        url: "/api/skills/sandbox-import",
        payload: { taskId, path: "from-task" },
      });
      expect(imported.statusCode).toBe(201);
      expect(inserts).toHaveBeenCalledWith(
        ACTOR.instanceId,
        expect.objectContaining({
          name: "from-task",
          skillContent: expect.stringContaining("Task目录"),
        }),
      );
      const canvas = await app.inject({
        method: "GET",
        url: `/api/skills/sandbox-packages?canvasId=${CANVAS_ID}`,
      });
      expect(canvas.statusCode).toBe(400);
      expect(canvas.json().error.message).toContain("不能用 Canvas");
      const ambiguous = await app.inject({
        method: "POST",
        url: "/api/skills/sandbox-import",
        payload: { canvasId: CANVAS_ID, taskId, path: "from-task" },
      });
      expect(ambiguous.statusCode).toBe(400);
      const foreign = await app.inject({
        method: "GET",
        url: "/api/skills/sandbox-packages?taskId=948839a7-a8cc-4390-9e24-4dd0ae1902d5",
      });
      expect(foreign.statusCode).toBe(404);
      const escaped = await app.inject({
        method: "POST",
        url: "/api/skills/sandbox-import",
        payload: { taskId, path: "/etc" },
      });
      expect(escaped.statusCode).toBe(403);
      expect(escaped.json().error.message).toContain("授权目录");
      expect(inserts).toHaveBeenCalledTimes(1);
      await app.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("卸载后的迟到技能 PATCH 明确拒绝，不能偷偷重新安装", async () => {
  const install = vi.fn(async () => {});
  const app = await buildApp({
    findVisibleSkill: async () => ({ id: SKILL_ID }),
    setEnabled: async () => false,
    upsertInstallation: install,
  });
  const response = await app.inject({
    method: "PATCH",
    url: `/api/instance/skills/${SKILL_ID}`,
    payload: { enabled: true },
  });
  expect(response.statusCode).toBe(404);
  expect(install).not.toHaveBeenCalled();
});
