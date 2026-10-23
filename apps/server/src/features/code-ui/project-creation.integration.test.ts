import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canvasListResponseSchema,
  codeProjectEditorProjectSchema,
  projectListResponseSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();

function rpc(method: string, args: unknown[] = []) {
  return isolatedHttp.request("/api/code-ui/rpc", {
    service: "project",
    method,
    args,
  });
}

async function readProjects() {
  const response = await rpc("readProjects");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectEditorProjectSchema.array().parse(response.body.result);
}

async function expectEmptyProject(projectId: string, workspacePath: string) {
  const canvases = await isolatedHttp.request(
    `/api/projects/${projectId}/canvases`,
  );
  expect(canvases.status, JSON.stringify(canvases.body)).toBe(200);
  expect(canvasListResponseSchema.parse(canvases.body).canvases).toEqual([]);
  for (const method of [
    "listTasks",
    "listPinnedTasks",
    "listArchivedTasks",
    "listDeletedTaskIds",
  ]) {
    const tasks = await isolatedHttp.request("/api/code-ui/rpc", {
      service: "zcode-task",
      method,
      args: [{ workspacePath, projectId }],
    });
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    expect(tasks.body.result).toEqual([]);
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目创建的真实宿主 integration",
  () => {
    it("无id创建本机多目录Code项目，保留目录权限且重放不重复创建或产生Task和Canvas", async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "code-project-creation-")),
      );
      try {
        const primary = join(directory, "主目录");
        const readOnly = join(directory, "参考资料");
        const readWrite = join(directory, "输出文件");
        for (const path of [primary, readOnly, readWrite]) await mkdir(path);
        const before = await readProjects();
        const input = {
          creationId: randomUUID(),
          hostId: "local",
          kind: "code",
          name: "原表单创建项目",
          roots: [primary, readOnly, readWrite],
          primaryRoot: primary,
          rootPermissions: {
            [readOnly]: "read-only",
            [readWrite]: "read-write",
          },
        };
        const response = await rpc("saveProject", [input]);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const project = codeProjectEditorProjectSchema.parse(
          response.body.result,
        );
        expect(project).toMatchObject({
          hostId: "local",
          name: "原表单创建项目",
          roots: [
            { rootPath: primary, position: 0, isPrimary: true },
            {
              rootPath: readOnly,
              position: 1,
              isPrimary: false,
              access: "read-only",
            },
            {
              rootPath: readWrite,
              position: 2,
              isPrimary: false,
              access: "read-write",
            },
          ],
        });
        const after = await readProjects();
        const previousIds = new Set(before.map((item) => item.id));
        expect(after).toHaveLength(before.length + 1);
        expect(after.filter((item) => !previousIds.has(item.id))).toEqual([
          project,
        ]);
        const listed = await isolatedHttp.request("/api/projects?kind=code");
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const summary = projectListResponseSchema
          .parse(listed.body)
          .projects.find((item) => item.id === project.id);
        expect(summary).toMatchObject({
          id: project.id,
          kind: "code",
          enabledModes: ["code"],
          workDir: primary,
          additionalDirectories: [
            { path: readOnly, access: "read-only" },
            { path: readWrite, access: "read-write" },
          ],
        });
        await expectEmptyProject(project.id, primary);
        const replay = await rpc("saveProject", [input]);
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        expect(replay.body).toEqual(response.body);
        expect(await readProjects()).toEqual(after);
        await expectEmptyProject(project.id, primary);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000); // 独占真实HTTP、PostgreSQL及目录的项目创建测试期限。
    it("创建Design项目保留原目录权限，仅启用Design且不产生Task和Canvas", async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "design-project-creation-")),
      );
      try {
        const primary = join(directory, "创作目录");
        const readOnly = join(directory, "参考资料");
        const readWrite = join(directory, "输出文件");
        for (const path of [primary, readOnly, readWrite]) await mkdir(path);
        const before = await readProjects();
        const response = await rpc("saveProject", [
          {
            creationId: randomUUID(),
            hostId: "local",
            kind: "design",
            name: "Design创建项目",
            roots: [primary, readOnly, readWrite],
            primaryRoot: primary,
            rootPermissions: {
              [readOnly]: "read-only",
              [readWrite]: "read-write",
            },
          },
        ]);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const project = codeProjectEditorProjectSchema.parse(
          response.body.result,
        );
        expect(project).toMatchObject({
          name: "Design创建项目",
          roots: [
            { rootPath: primary, position: 0, isPrimary: true },
            {
              rootPath: readOnly,
              position: 1,
              isPrimary: false,
              access: "read-only",
            },
            {
              rootPath: readWrite,
              position: 2,
              isPrimary: false,
              access: "read-write",
            },
          ],
        });
        const after = await readProjects();
        expect(after).toHaveLength(before.length + 1);
        expect(after.filter((item) => item.id === project.id)).toEqual([
          project,
        ]);
        const design = await isolatedHttp.request("/api/projects?kind=design");
        expect(design.status, JSON.stringify(design.body)).toBe(200);
        expect(
          projectListResponseSchema
            .parse(design.body)
            .projects.find((item) => item.id === project.id),
        ).toMatchObject({
          id: project.id,
          kind: "design",
          enabledModes: ["design"],
          workDir: primary,
          additionalDirectories: [
            { path: readOnly, access: "read-only" },
            { path: readWrite, access: "read-write" },
          ],
        });
        const code = await isolatedHttp.request("/api/projects?kind=code");
        expect(code.status, JSON.stringify(code.body)).toBe(200);
        expect(
          projectListResponseSchema
            .parse(code.body)
            .projects.map((item) => item.id),
        ).not.toContain(project.id);
        await expectEmptyProject(project.id, primary);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000); // 真实HTTP、PG及Design目录授权的独立创建测试期限。
    it("不同目录同名创建自动追加原后缀，并发创建的项目均可读取", async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "project-creation-name-")),
      );
      try {
        const primary = join(directory, "第一个目录");
        const second = join(directory, "第二个目录");
        const third = join(directory, "第三个目录");
        for (const path of [primary, second, third]) await mkdir(path);
        const before = await readProjects();
        const input = (path: string, creationId: string) => ({
          creationId,
          hostId: "local",
          kind: "code",
          name: "自动重名项目",
          roots: [path],
          primaryRoot: path,
          rootPermissions: {},
        });
        const response = await rpc("saveProject", [
          input(primary, randomUUID()),
        ]);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const first = codeProjectEditorProjectSchema.parse(
          response.body.result,
        );
        expect(first.name).toBe("自动重名项目");
        const secondCreationId = randomUUID();
        const thirdCreationId = randomUUID();
        const responses = await Promise.all([
          rpc("saveProject", [input(second, secondCreationId)]),
          rpc("saveProject", [input(third, thirdCreationId)]),
        ]);
        const concurrent = responses.map((created, index) => {
          expect(created.status, JSON.stringify(created.body)).toBe(200);
          const project = codeProjectEditorProjectSchema.parse(
            created.body.result,
          );
          expect(project.roots).toEqual([
            {
              rootPath: index === 0 ? second : third,
              position: 0,
              isPrimary: true,
            },
          ]);
          return project;
        });
        expect(new Set(concurrent.map((project) => project.name))).toEqual(
          new Set(["自动重名项目 (2)", "自动重名项目 (3)"]),
        );
        const created = [first, ...concurrent];
        expect(new Set(created.map((project) => project.id)).size).toBe(3);
        const after = await readProjects();
        expect(after).toHaveLength(before.length + 3);
        for (const project of created) expect(after).toContainEqual(project);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000); // 独占真实HTTP、PG与不同目录的同名并发创建测试期限。
    it("创建身份并发与重放共用原项目，冲突不改权限且移除目录后仍可重放", async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "project-creation-replay-")),
      );
      try {
        const primary = join(directory, "主目录");
        const readOnly = join(directory, "稍后移除的参考目录");
        const readWrite = join(directory, "输出文件");
        for (const path of [primary, readOnly, readWrite]) await mkdir(path);
        const before = await readProjects();
        const input = {
          creationId: randomUUID(),
          hostId: "local",
          kind: "code",
          name: "创建身份回放",
          roots: [primary, readOnly, readWrite],
          primaryRoot: primary,
          rootPermissions: {
            [readOnly]: "read-only",
            [readWrite]: "read-write",
          },
        };
        const [first, concurrent] = await Promise.all([
          rpc("saveProject", [input]),
          rpc("saveProject", [input]),
        ]);
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(concurrent.status, JSON.stringify(concurrent.body)).toBe(200);
        expect(concurrent.body).toEqual(first.body);
        const project = codeProjectEditorProjectSchema.parse(first.body.result);
        expect(project).toMatchObject({
          name: "创建身份回放",
          roots: [
            { rootPath: primary, position: 0, isPrimary: true },
            {
              rootPath: readOnly,
              position: 1,
              isPrimary: false,
              access: "read-only",
            },
            {
              rootPath: readWrite,
              position: 2,
              isPrimary: false,
              access: "read-write",
            },
          ],
        });
        const after = await readProjects();
        expect(after).toHaveLength(before.length + 1);
        expect(after.filter((item) => item.id === project.id)).toEqual([
          project,
        ]);
        const replay = await rpc("saveProject", [input]);
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        expect(replay.body).toEqual(first.body);
        for (const changed of [
          { ...input, name: "同键修改名称" },
          {
            ...input,
            rootPermissions: {
              ...input.rootPermissions,
              [readOnly]: "read-write",
            },
          },
        ]) {
          const conflict = await rpc("saveProject", [changed]);
          expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
          expect(await readProjects()).toEqual(after);
        }
        await rm(readOnly, { recursive: true });
        const missingDirectoryReplay = await rpc("saveProject", [input]);
        expect(
          missingDirectoryReplay.status,
          JSON.stringify(missingDirectoryReplay.body),
        ).toBe(200);
        expect(missingDirectoryReplay.body).toEqual(first.body);
        expect(await readProjects()).toEqual(after);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000); // 真实HTTP、PG与目录移除的创建身份测试期限。
    it("项目真实归档后同键创建均返回404，回执仅保留最小删除墓碑", async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "project-creation-archived-")),
      );
      const persistence = createPostgresPersistence({
        databaseUrl: isolatedHttp.databaseUrl(),
      });
      try {
        const before = await readProjects();
        const input = {
          creationId: randomUUID(),
          hostId: "local",
          kind: "code",
          name: "归档创建回执",
          roots: [directory],
          primaryRoot: directory,
          rootPermissions: {},
        };
        const response = await rpc("saveProject", [input]);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const project = codeProjectEditorProjectSchema.parse(
          response.body.result,
        );
        const listed = await isolatedHttp.request("/api/projects?kind=code");
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const summary = projectListResponseSchema
          .parse(listed.body)
          .projects.find((item) => item.id === project.id);
        if (!summary) throw new Error("创建项目未出现在公开项目列表");
        const archived = await isolatedHttp.request(
          `/api/projects/${project.id}`,
          undefined,
          "DELETE",
        );
        expect(archived.status, JSON.stringify(archived.body)).toBe(204);
        expect(await readProjects()).toEqual(before);
        for (const intent of [
          input,
          { ...input, name: "归档后迟到修改名称" },
        ]) {
          const late = await rpc("saveProject", [intent]);
          expect(late.status, JSON.stringify(late.body)).toBe(404);
          expect(await readProjects()).toEqual(before);
        }
        // 墓碑隐私是持久化验收，查询只作用于公开项目归属的实例与创建身份。
        const receipt = await persistence
          .forInstance(summary.instanceId)
          .queryOne(
            `select * from public.project_creation_receipts
              where instance_id=:instance and creation_id=$1`,
            [input.creationId],
          );
        expect(receipt).toEqual({
          instance_id: summary.instanceId,
          creation_id: input.creationId,
          project_id: null,
          parameter_fingerprint: null,
          result: null,
        });
      } finally {
        try {
          await persistence.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }, 60_000); // 真实HTTP归档与PG创建墓碑隐私的测试期限。
    it("维护操作物理删除项目后保留最小墓碑，删除隔离实例时级联清空回执", async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "project-creation-deleted-")),
      );
      const persistence = createPostgresPersistence({
        databaseUrl: isolatedHttp.databaseUrl(),
      });
      try {
        const before = await readProjects();
        const input = {
          creationId: randomUUID(),
          hostId: "local",
          kind: "code",
          name: "物理删除创建回执",
          roots: [directory],
          primaryRoot: directory,
          rootPermissions: {},
        };
        const response = await rpc("saveProject", [input]);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const project = codeProjectEditorProjectSchema.parse(
          response.body.result,
        );
        const listed = await isolatedHttp.request("/api/projects?kind=code");
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const summary = projectListResponseSchema
          .parse(listed.body)
          .projects.find((item) => item.id === project.id);
        if (!summary) throw new Error("创建项目未出现在公开项目列表");
        const instance = persistence.forInstance(summary.instanceId);
        // 物理删除属于本例隔离实例的维护操作，产品归档继续使用原公开入口。
        expect(
          await instance.execute(
            "delete from public.projects where instance_id=:instance and id=$1",
            [project.id],
          ),
        ).toBe(1);
        expect(await readProjects()).toEqual(before);
        for (const intent of [
          input,
          { ...input, name: "物理删除后迟到修改名称" },
        ]) {
          const late = await rpc("saveProject", [intent]);
          expect(late.status, JSON.stringify(late.body)).toBe(404);
          expect(await readProjects()).toEqual(before);
        }
        expect(
          await instance.queryOne(
            `select * from public.project_creation_receipts
              where instance_id=:instance and creation_id=$1`,
            [input.creationId],
          ),
        ).toEqual({
          instance_id: summary.instanceId,
          creation_id: input.creationId,
          project_id: null,
          parameter_fingerprint: null,
          result: null,
        });
        // 全部业务断言完成后删除本例实例，随后只核对其持久化级联结果。
        expect(
          await instance.execute(
            "delete from public.local_instances where id=:instance",
          ),
        ).toBe(1);
        expect(
          await instance.query(
            "select * from public.project_creation_receipts where instance_id=:instance",
          ),
        ).toEqual([]);
      } finally {
        try {
          await persistence.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }, 60_000); // 隔离实例的真实维护删除、迟到RPC及墓碑级联测试期限。
  },
);
