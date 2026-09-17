import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../auth/types.js";
import { BlobError } from "../blob/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import { BootstrapError } from "../bootstrap/errors.js";
import { SQLSTATE_UNIQUE_VIOLATION, SqlError } from "../persistence/errors.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import {
  createProjectService,
  ProjectServiceError,
} from "./project-service.js";
import {
  CODE_WORKBENCH_SLUG,
  type CreateProjectInput,
  createProjectRepository,
  type ProjectUpdatePatch,
} from "./repository.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";
const PROJECT_ID = "project-1";

const USER: AuthenticatedUser = {
  accessToken: "token",
  email: "user@example.com",
  id: USER_ID,
  userMetadata: {},
};

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

type QueryCall = { text: string; values: unknown[] };

/** 按语句响应；控制语句也走同一入口。断言的是「真正下发到驱动」的 SQL。 */
function createRunner(
  respond: (text: string, values: unknown[]) => FakeResult = () => ({
    rowCount: 0,
    rows: [],
  }),
) {
  const calls: QueryCall[] = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text, values);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async end() {},
  };

  return { calls, runner };
}

/** 归一空白后比较 SQL，避免缩进与换行导致的脆弱断言。 */
function dataCalls(calls: QueryCall[]) {
  return calls
    .filter((call) => !["begin", "commit", "rollback"].includes(call.text))
    .map((call) => ({
      sql: call.text.replace(/\s+/g, " ").trim(),
      values: call.values,
    }));
}

const VIEWER_STUB: ViewerService = {
  // 建项目前会做引导；返回合法 viewer 响应即可（本文件不校验其内容）。
  ensureViewer: async () => ({
    membership: {
      role: "owner",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    },
    profile: {
      avatarUrl: null,
      displayName: "Personal",
      email: USER.email,
      id: USER_ID,
    },
    workspace: {
      id: WORKSPACE_ID,
      name: "Personal Workspace",
      ownerUserId: USER_ID,
      type: "personal",
    },
  }),
  resolveWorkspace: async () => ({
    id: WORKSPACE_ID,
    name: "Personal Workspace",
    ownerUserId: USER_ID,
    type: "personal",
  }),
  updateProfile: async () => {
    throw new Error("not used");
  },
};

describe("projects repository（SQL 与隔离谓词）", () => {
  it("列表按工作区作用域 + 未归档 + updated_at 倒序", async () => {
    const { calls, runner } = createRunner();
    await createProjectRepository(
      createPersistenceFromRunner(runner),
    ).listActive(WORKSPACE_ID);

    const [call] = dataCalls(calls);
    expect(call?.sql).toContain("from public.projects");
    // kind 决定取哪一类项目（design=画布 / code=工作目录）
    expect(call?.sql).toContain("kind = $1");
    // Code 工作台载体是内部容器（保留 slug），不得出现在用户的项目列表里
    expect(call?.sql).toContain("and slug <> $2");
    // :workspace 由缝追加为末位参数
    expect(call?.sql).toContain("where workspace_id = $3");
    expect(call?.sql).toContain("and archived_at is null");
    expect(call?.sql).toContain("order by updated_at desc");
    expect(call?.values).toEqual(["design", CODE_WORKBENCH_SLUG, WORKSPACE_ID]);
  });

  /**
   * 回归：项目分两类（design=画布项目 / code=工作目录项目），各自只取自己那一类。
   * 此前 projects 只有一种语义，Code 侧「工作目录=项目」只能在客户端另造一套
   * localStorage 项目，导致两套真相（选了工作目录列表里看不到）。
   */
  it("按 kind 取列表：code 项目与画布项目互不串味", async () => {
    const { calls, runner } = createRunner();
    await createProjectRepository(
      createPersistenceFromRunner(runner),
    ).listActive(WORKSPACE_ID, "code");

    const [call] = dataCalls(calls);
    expect(call?.values).toEqual(["code", CODE_WORKBENCH_SLUG, WORKSPACE_ID]);
    expect(call?.sql).toContain("kind = $1");
  });

  it("建 code 类项目时 kind 随参数落库（不落 design）", async () => {
    const { calls, runner } = createRunner((text) => {
      if (text.includes("insert into public.projects")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: PROJECT_ID,
              kind: "code",
              name: "kenfutwork",
              slug: "kenfutwork-ab12cd",
              description: null,
              created_at: "2026-09-14T00:00:00+00:00",
              updated_at: "2026-09-14T00:00:00+00:00",
              workspace_id: WORKSPACE_ID,
            },
          ],
        };
      }
      if (text.includes("insert into public.canvases")) {
        return {
          rowCount: 1,
          rows: [{ id: "canvas-1", name: "Main Canvas", is_primary: true }],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const created = await createProjectRepository(
      createPersistenceFromRunner(runner),
    ).createWithCanvas({
      canvasName: "Main Canvas",
      description: null,
      kind: "code",
      name: "kenfutwork",
      slug: "kenfutwork-ab12cd",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });

    const [projectInsert] = dataCalls(calls);
    expect(projectInsert?.values).toEqual([
      "kenfutwork",
      "kenfutwork-ab12cd",
      "code",
      null,
      null,
      USER_ID,
      WORKSPACE_ID,
    ]);
    expect(created.project.kind).toBe("code");
  });

  it("主画布查询 JOIN projects 施加工作区谓词（canvases 无 workspace_id 列）", async () => {
    const { calls, runner } = createRunner();
    await createProjectRepository(
      createPersistenceFromRunner(runner),
    ).listPrimaryCanvases(WORKSPACE_ID, [PROJECT_ID, "project-2"]);

    const [call] = dataCalls(calls);
    expect(call?.sql).toContain(
      "join public.projects p on p.id = c.project_id",
    );
    expect(call?.sql).toContain("p.workspace_id = $2");
    expect(call?.sql).toContain("c.is_primary = true");
    expect(call?.sql).toContain("c.project_id = any($1::uuid[])");
    expect(call?.values).toEqual([[PROJECT_ID, "project-2"], WORKSPACE_ID]);
  });

  it("空项目列表不下发画布查询", async () => {
    const { calls, runner } = createRunner();
    await expect(
      createProjectRepository(
        createPersistenceFromRunner(runner),
      ).listPrimaryCanvases(WORKSPACE_ID, []),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("归档是单条 UPDATE，未命中返回 0（等价于原「先查后改」的 404 语义）", async () => {
    const missing = createRunner();
    await expect(
      createProjectRepository(
        createPersistenceFromRunner(missing.runner),
      ).archive(WORKSPACE_ID, PROJECT_ID),
    ).resolves.toBe(0);

    const [call] = dataCalls(missing.calls);
    expect(call?.sql).toContain(
      "update public.projects set archived_at = now()",
    );
    expect(call?.sql).toContain("where workspace_id = $2");
    expect(call?.sql).toContain("and archived_at is null");
    expect(call?.values).toEqual([PROJECT_ID, WORKSPACE_ID]);

    const hit = createRunner(() => ({ rowCount: 1, rows: [] }));
    await expect(
      createProjectRepository(createPersistenceFromRunner(hit.runner)).archive(
        WORKSPACE_ID,
        PROJECT_ID,
      ),
    ).resolves.toBe(1);
  });

  it("更新补丁只写显式给出的列，显式 null 表示清空（非 coalesce）", async () => {
    const nameOnly = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createProjectRepository(
      createPersistenceFromRunner(nameOnly.runner),
    ).update(WORKSPACE_ID, PROJECT_ID, { name: "新名" });

    const [call] = dataCalls(nameOnly.calls);
    expect(call?.sql).toContain("set name = $2");
    expect(call?.sql).not.toContain("brand_kit_id");
    expect(call?.values).toEqual([PROJECT_ID, "新名", WORKSPACE_ID]);

    const unbind = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createProjectRepository(
      createPersistenceFromRunner(unbind.runner),
    ).update(WORKSPACE_ID, PROJECT_ID, { brandKitId: null });

    const [unbindCall] = dataCalls(unbind.calls);
    expect(unbindCall?.sql).toContain("set brand_kit_id = $2");
    expect(unbindCall?.values).toEqual([PROJECT_ID, null, WORKSPACE_ID]);
  });

  it("空补丁不下发任何语句", async () => {
    const { calls, runner } = createRunner();
    await expect(
      createProjectRepository(createPersistenceFromRunner(runner)).update(
        WORKSPACE_ID,
        PROJECT_ID,
        {},
      ),
    ).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("建项目 + 主画布在同一事务内，且建项目带工作区谓词", async () => {
    const { calls, runner } = createRunner((text) => {
      if (text.includes("insert into public.projects")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: PROJECT_ID,
              name: "新项目",
              slug: "xin-xiangmu-ab12cd",
              description: null,
              created_at: "2026-09-13T00:00:00+00:00",
              updated_at: "2026-09-13T00:00:00+00:00",
              workspace_id: WORKSPACE_ID,
            },
          ],
        };
      }
      if (text.includes("insert into public.canvases")) {
        return {
          rowCount: 1,
          rows: [{ id: "canvas-1", name: "Main Canvas", is_primary: true }],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const created = await createProjectRepository(
      createPersistenceFromRunner(runner),
    ).createWithCanvas({
      canvasName: "Main Canvas",
      description: null,
      name: "新项目",
      slug: "xin-xiangmu-ab12cd",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(calls[0]?.text).toBe("begin");
    expect(calls.at(-1)?.text).toBe("commit");
    expect(created.canvas.is_primary).toBe(true);
    expect(created.canvas.name).toBe("Main Canvas");

    const [projectInsert, canvasInsert] = dataCalls(calls);
    expect(projectInsert?.sql).toContain("insert into public.projects");
    // :workspace 由缝追加为末位参数，故列位序里工作区落在 $6
    expect(projectInsert?.sql).toContain("values ($7, $1, $2, $3, $4, $5, $6)");
    // 缺省 kind 落 design：存量调用方（Design 建项目）语义不变
    expect(projectInsert?.values).toEqual([
      "新项目",
      "xin-xiangmu-ab12cd",
      "design",
      null,
      null,
      USER_ID,
      WORKSPACE_ID,
    ]);
    expect(canvasInsert?.sql).toContain("insert into public.canvases");
    // canvases 无 workspace_id 列：经 projects 父链校验归属，工作区谓词不可省。
    expect(canvasInsert?.sql).toContain("from public.projects p");
    expect(canvasInsert?.sql).toContain("p.workspace_id = $4");
    expect(canvasInsert?.values).toEqual([
      "Main Canvas",
      USER_ID,
      PROJECT_ID,
      WORKSPACE_ID,
    ]);
  });

  it("建项目未返回行时抛错并触发回滚", async () => {
    const { calls, runner } = createRunner();
    await expect(
      createProjectRepository(
        createPersistenceFromRunner(runner),
      ).createWithCanvas({
        canvasName: "Main Canvas",
        description: null,
        name: "x",
        slug: "x-1",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow(/建项目未返回行/);
    expect(calls.at(-1)?.text).toBe("rollback");
  });
});

describe("project service（错误映射与行为保持不变）", () => {
  const buildService = (options: {
    repository: Partial<ReturnType<typeof createProjectRepository>>;
    viewerService?: ViewerService;
    uploadError?: { message: string } | null;
  }) =>
    createProjectService({
      blob: {
        bucket: () => ({
          getPublicUrl: (path: string) => `https://blob.test/${path}`,
          // 缩略图走 resolveUrl（公开性由存储侧决定）；测试里等价于公开桶
          resolveUrl: async (path: string) => `https://blob.test/${path}`,
          upload: async () => {
            if (options.uploadError) {
              throw new BlobError(
                "upload",
                "project-assets",
                "x",
                options.uploadError.message,
              );
            }
          },
        }),
      } as never,
      repository: {
        archive: async () => 1,
        createWithCanvas: async () => {
          throw new Error("not used");
        },
        findActiveById: async () => null,
        listActive: async () => [],
        listPrimaryCanvases: async () => [],
        setThumbnailPath: async () => 1,
        update: async () => 1,
        ...options.repository,
      } as ReturnType<typeof createProjectRepository>,
      viewerService: options.viewerService ?? VIEWER_STUB,
    });

  it("列表把行映射为契约形状（含 primaryCanvas）", async () => {
    const service = buildService({
      repository: {
        listActive: async () => [
          {
            id: PROJECT_ID,
            name: "项目",
            slug: "xiangmu",
            kind: "design",
            description: "描述",
            created_at: "2026-09-13T00:00:00+00:00",
            updated_at: "2026-09-13T01:00:00+00:00",
            workspace_id: WORKSPACE_ID,
            thumbnail_path: null,
            work_dir: null,
          },
        ],
        listPrimaryCanvases: async () => [
          {
            id: "canvas-1",
            name: "Main Canvas",
            is_primary: true,
            project_id: PROJECT_ID,
          },
        ],
      },
    });

    await expect(service.listProjects(USER)).resolves.toEqual([
      {
        createdAt: "2026-09-13T00:00:00+00:00",
        description: "描述",
        id: PROJECT_ID,
        kind: "design",
        name: "项目",
        primaryCanvas: {
          id: "canvas-1",
          isPrimary: true,
          name: "Main Canvas",
        },
        slug: "xiangmu",
        updatedAt: "2026-09-13T01:00:00+00:00",
        workDir: null,
        workspace: {
          id: WORKSPACE_ID,
          name: "Personal Workspace",
          ownerUserId: USER_ID,
          type: "personal",
        },
      },
    ]);
  });

  it("项目缺主画布时按 project_query_failed 报错（保持历史行为）", async () => {
    const service = buildService({
      repository: {
        listActive: async () => [
          {
            id: PROJECT_ID,
            name: "项目",
            slug: "xiangmu",
            kind: "design",
            description: null,
            created_at: "2026-09-13T00:00:00+00:00",
            updated_at: "2026-09-13T00:00:00+00:00",
            workspace_id: WORKSPACE_ID,
            thumbnail_path: null,
            work_dir: null,
          },
        ],
        listPrimaryCanvases: async () => [],
      },
    });

    const error = await service.listProjects(USER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error).toMatchObject({
      code: "project_query_failed",
      statusCode: 500,
    });
  });

  it("slug 唯一冲突映射为 409 project_slug_taken", async () => {
    const service = buildService({
      repository: {
        createWithCanvas: async () => {
          throw new SqlError("duplicate key", {
            code: SQLSTATE_UNIQUE_VIOLATION,
          });
        },
      },
    });

    const error = await service
      .createProject(USER, { name: "项目" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "project_slug_taken",
      statusCode: 409,
    });
  });

  it("其它建项目失败映射为 500 project_create_failed（不泄露驱动细节）", async () => {
    const service = buildService({
      repository: {
        createWithCanvas: async () => {
          throw new SqlError("connection reset", { code: "08006" });
        },
      },
    });

    const error = await service
      .createProject(USER, { name: "项目" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "project_create_failed",
      statusCode: 500,
    });
    expect((error as Error).message).not.toContain("connection reset");
  });

  it("归档未命中返回 404 project_not_found", async () => {
    const service = buildService({ repository: { archive: async () => 0 } });
    await expect(
      service.archiveProject(USER, PROJECT_ID),
    ).rejects.toMatchObject({
      code: "project_not_found",
      statusCode: 404,
    });
  });

  it("更新未命中返回 404；空补丁不发请求", async () => {
    const notFound = buildService({ repository: { update: async () => 0 } });
    await expect(
      notFound.updateProject(USER, PROJECT_ID, { name: "x" }),
    ).rejects.toMatchObject({ code: "project_not_found", statusCode: 404 });

    let updateCalls = 0;
    const empty = buildService({
      repository: {
        update: async () => {
          updateCalls += 1;
          return 1;
        },
      },
    });
    await expect(
      empty.updateProject(USER, PROJECT_ID, {}),
    ).resolves.toBeUndefined();
    expect(updateCalls).toBe(0);
  });

  it("读取未命中返回 404 project_not_found", async () => {
    const service = buildService({
      repository: { findActiveById: async () => null },
    });
    await expect(service.getProject(USER, PROJECT_ID)).rejects.toMatchObject({
      code: "project_not_found",
      statusCode: 404,
    });
  });

  it("工作区解析失败按调用场景映射错误码", async () => {
    const failingViewer: ViewerService = {
      ...VIEWER_STUB,
      resolveWorkspace: async () => {
        throw new BootstrapError();
      },
    };
    const service = buildService({
      repository: {},
      viewerService: failingViewer,
    });

    await expect(service.listProjects(USER)).rejects.toMatchObject({
      code: "project_query_failed",
    });
    await expect(
      service.updateProject(USER, PROJECT_ID, { name: "x" }),
    ).rejects.toMatchObject({ code: "project_update_failed" });
  });

  it("缩略图上传失败时按 project_create_failed 报错且不写路径", async () => {
    let pathWrites = 0;
    const service = buildService({
      repository: {
        findActiveById: async () => ({
          id: PROJECT_ID,
          name: "项目",
          slug: "xiangmu",
          description: null,
          workspace_id: WORKSPACE_ID,
          brand_kit_id: null,
          work_dir: null,
          created_at: "2026-09-13T00:00:00+00:00",
          updated_at: "2026-09-13T00:00:00+00:00",
        }),
        setThumbnailPath: async () => {
          pathWrites += 1;
          return 1;
        },
      },
      uploadError: { message: "quota exceeded" },
    });

    await expect(
      service.saveThumbnail(USER, PROJECT_ID, Buffer.from("x"), "image/png"),
    ).rejects.toMatchObject({ code: "project_create_failed" });
    expect(pathWrites).toBe(0);
  });

  it("缩略图保存成功后返回公开 URL 并写入路径", async () => {
    let written: string | undefined;
    const service = buildService({
      repository: {
        findActiveById: async () => ({
          id: PROJECT_ID,
          name: "项目",
          slug: "xiangmu",
          description: null,
          workspace_id: WORKSPACE_ID,
          brand_kit_id: null,
          work_dir: null,
          created_at: "2026-09-13T00:00:00+00:00",
          updated_at: "2026-09-13T00:00:00+00:00",
        }),
        setThumbnailPath: async (_workspaceId, _projectId, path) => {
          written = path;
          return 1;
        },
      },
    });

    const result = await service.saveThumbnail(
      USER,
      PROJECT_ID,
      Buffer.from("x"),
      "image/webp",
    );

    expect(written).toBe(`${WORKSPACE_ID}/${PROJECT_ID}/thumbnail.webp`);
    expect(result.thumbnailUrl).toBe(
      `https://blob.test/${WORKSPACE_ID}/${PROJECT_ID}/thumbnail.webp`,
    );
  });
  it("建项目带工作目录：校验通过后按归一化路径落库", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kfw-projdir-"));
    let captured: CreateProjectInput | undefined;
    const service = buildService({
      repository: {
        createWithCanvas: async (input) => {
          captured = input;
          return {
            canvas: { id: "canvas-1", name: "Main Canvas", is_primary: true },
            project: {
              id: PROJECT_ID,
              kind: "code",
              name: input.name,
              slug: input.slug,
              description: null,
              created_at: "2026-09-17T00:00:00+00:00",
              updated_at: "2026-09-17T00:00:00+00:00",
              workspace_id: WORKSPACE_ID,
              work_dir: input.workDir ?? null,
            },
          };
        },
      },
    });

    const summary = await service.createProject(USER, {
      kind: "code",
      name: "test",
      work_dir: dir,
    });

    expect(captured?.workDir).toBe(resolve(dir));
    expect(summary.workDir).toBe(resolve(dir));
  });

  it("建项目带工作目录：不合格路径 400 invalid_work_dir，且不落库", async () => {
    let created = 0;
    const service = buildService({
      repository: {
        createWithCanvas: async () => {
          created += 1;
          throw new Error("not used");
        },
      },
    });

    await expect(
      service.createProject(USER, {
        kind: "code",
        name: "test",
        work_dir: "相对路径",
      }),
    ).rejects.toMatchObject({ code: "invalid_work_dir", statusCode: 400 });

    await expect(
      service.createProject(USER, {
        kind: "code",
        name: "test",
        work_dir: join(tmpdir(), "kfw-definitely-missing-dir"),
      }),
    ).rejects.toMatchObject({ code: "invalid_work_dir", statusCode: 400 });

    expect(created).toBe(0);
  });

  it("更新工作目录：null 解绑走显式 null，字符串重绑先校验", async () => {
    const patches: ProjectUpdatePatch[] = [];
    const service = buildService({
      repository: {
        update: async (_workspaceId, _projectId, patch) => {
          patches.push(patch);
          return 1;
        },
      },
    });

    await service.updateProject(USER, PROJECT_ID, { work_dir: null });
    expect(patches[0]?.workDir).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "kfw-projdir2-"));
    await service.updateProject(USER, PROJECT_ID, { work_dir: dir });
    expect(patches[1]?.workDir).toBe(resolve(dir));

    await expect(
      service.updateProject(USER, PROJECT_ID, { work_dir: "nope/relative" }),
    ).rejects.toMatchObject({ code: "invalid_work_dir" });
    expect(patches).toHaveLength(2);
  });
});
