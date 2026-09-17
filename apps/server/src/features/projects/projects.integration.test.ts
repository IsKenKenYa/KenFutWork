import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createProjectRepository } from "./repository.js";

/**
 * projects 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明建项目事务、占位符绑序、父链归属校验与归档语义在真库上成立——
 * 占位符错位这类缺陷单测看不出来。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @kenfutwork/server exec vitest run projects.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("projects 真实库集成", () => {
  async function withProjectFixture(
    run: (input: {
      persistence: ReturnType<typeof createPostgresPersistence>;
      projectId: string;
      workspaceId: string;
    }) => Promise<void>,
  ) {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const viewer = createViewerRepository(persistence);
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();

      const workspace = await viewer.findPersonalWorkspace(
        (profile as IdRow).id,
      );
      expect(workspace, "夹具用户必须有个人工作区").not.toBeNull();
      const workspaceId = workspace?.id as string;

      const projects = createProjectRepository(persistence);
      const slug = `integration-${Date.now().toString(36)}`;
      const created = await projects.createWithCanvas({
        canvasName: "集成画布",
        description: "集成测试",
        name: "集成项目",
        slug,
        userId: (profile as IdRow).id,
        workspaceId,
      });

      try {
        await run({
          persistence,
          projectId: created.project.id,
          workspaceId,
        });
      } finally {
        // 清理：构图 FK 顺序物理删除（集成夹具不留残留数据）。
        await persistence.query(
          "delete from public.canvases where project_id = $1",
          [created.project.id],
        );
        await persistence.query("delete from public.projects where id = $1", [
          created.project.id,
        ]);
      }
    } finally {
      await persistence.close();
    }
  }

  it("建项目 + 主画布在同一事务内落库，且画布归属本项目", async () => {
    await withProjectFixture(
      async ({ persistence, projectId, workspaceId }) => {
        const canvases = await persistence
          .forWorkspace(workspaceId)
          .query<{ is_primary: boolean; name: string; project_id: string }>(
            `select c.name, c.is_primary, c.project_id
             from public.canvases c
             join public.projects p on p.id = c.project_id
            where p.workspace_id = :workspace
              and c.project_id = $1`,
            [projectId],
          );

        expect(canvases).toEqual([
          { is_primary: true, name: "集成画布", project_id: projectId },
        ]);
      },
    );
  });

  it("列表与主画布批量查询可读回新建项目", async () => {
    await withProjectFixture(
      async ({ persistence, projectId, workspaceId }) => {
        const projects = createProjectRepository(persistence);
        const list = await projects.listActive(workspaceId);
        expect(list.map((row) => row.id)).toContain(projectId);

        const primary = await projects.listPrimaryCanvases(workspaceId, [
          projectId,
        ]);
        expect(primary.map((row) => row.project_id)).toContain(projectId);
      },
    );
  });

  it("更新补丁确实落到指定列（占位符绑序正确）", async () => {
    await withProjectFixture(
      async ({ persistence, projectId, workspaceId }) => {
        const projects = createProjectRepository(persistence);

        await expect(
          projects.update(workspaceId, projectId, { name: "改名后" }),
        ).resolves.toBe(1);

        const after = await projects.findActiveById(workspaceId, projectId);
        expect(after?.name).toBe("改名后");
        // 未给出的列不被 coalsece 覆盖：描述保持原值。
        expect(after?.description).toBe("集成测试");
      },
    );
  });

  it("跨工作区不可读写：同一项目在其它工作区作用域下查不到、改不动", async () => {
    await withProjectFixture(async ({ persistence, projectId }) => {
      const projects = createProjectRepository(persistence);
      const foreignWorkspace = "00000000-0000-0000-0000-000000000000";

      await expect(
        projects.findActiveById(foreignWorkspace, projectId),
      ).resolves.toBeNull();
      await expect(
        projects.update(foreignWorkspace, projectId, { name: "越权改名" }),
      ).resolves.toBe(0);
      await expect(projects.archive(foreignWorkspace, projectId)).resolves.toBe(
        0,
      );
    });
  });

  it("归档幂等：首次生效，重复归档返回 0（404 语义）", async () => {
    await withProjectFixture(
      async ({ persistence, projectId, workspaceId }) => {
        const projects = createProjectRepository(persistence);

        await expect(projects.archive(workspaceId, projectId)).resolves.toBe(1);
        await expect(projects.archive(workspaceId, projectId)).resolves.toBe(0);
        await expect(
          projects.findActiveById(workspaceId, projectId),
        ).resolves.toBeNull();
      },
    );
  });
});
