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
  },
);
