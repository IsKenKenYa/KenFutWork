import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodeProjectEditorProject,
  codeProjectEditorProjectSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();

async function editorFixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "code-editor-boundaries-")),
  );
  const model = await heldModel();
  const host = await createCodeSessionFixture(model.baseUrl, {
    client: isolatedHttp,
  });
  const rpc = (method: string, args: unknown[] = []) =>
    host.client.request("/api/code-ui/rpc", {
      service: "project",
      method,
      args,
    });
  const read = async () => {
    const result = await rpc("readProjects");
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const project = codeProjectEditorProjectSchema
      .array()
      .parse(result.body.result)
      .find((item) => item.id === host.projectId);
    if (!project) throw new Error("编辑器列表缺少当前项目");
    return project;
  };
  return {
    directory,
    host,
    model,
    rpc,
    read,
    draft(project: CodeProjectEditorProject) {
      return {
        id: project.id,
        hostId: "local" as const,
        name: project.name,
        roots: project.roots.map((root) => root.rootPath),
        primaryRoot: host.workspacePath,
        rootPermissions: Object.fromEntries(
          project.roots.flatMap((root) =>
            root.isPrimary || !root.access
              ? []
              : [[root.rootPath, root.access]],
          ),
        ),
        expectedRevision: project.revision,
      };
    },
    async dispose() {
      try {
        await host.dispose();
      } finally {
        try {
          await model.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  };
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目编辑的公共边界 integration",
  () => {
    it("超出存储范围的项目修订返回400且保留项目，随后合法保存成功", async () => {
      const fixture = await editorFixture();
      try {
        const project = await fixture.read();
        const draft = {
          ...fixture.draft(project),
          name: "合法修订保存",
        };
        const invalid = await fixture.rpc("saveProject", [
          { ...draft, expectedRevision: 2_147_483_648 },
        ]);
        expect(invalid.status, JSON.stringify(invalid.body)).toBe(400);
        expect(await fixture.read()).toEqual(project);
        const saved = await fixture.rpc("saveProject", [draft]);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.result).toMatchObject({
          id: project.id,
          name: "合法修订保存",
          revision: project.revision + 1,
        });
        expect(await fixture.read()).toEqual(saved.body.result);
        expect(fixture.model.requests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    }, 60_000); // 真实HTTP与PG中修订范围校验的测试期限。
    it("同值保存保留修订，同键并发和重放复用结果且拒绝冲突参数", async () => {
      const fixture = await editorFixture();
      try {
        const project = await fixture.read();
        const unchanged = await fixture.rpc("saveProject", [
          fixture.draft(project),
        ]);
        expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
        expect(unchanged.body.result).toEqual(project);
        const draft = {
          ...fixture.draft(project),
          name: "并发保存项目",
        };
        const concurrent = await Promise.all(
          Array.from({ length: 8 }, () => fixture.rpc("saveProject", [draft])),
        );
        const first = concurrent[0];
        if (!first) throw new Error("并发项目保存未返回结果");
        for (const result of concurrent) {
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          expect(result.body).toEqual(first.body);
        }
        expect(first.body.result).toMatchObject({
          id: project.id,
          name: "并发保存项目",
          revision: project.revision + 1,
        });
        const replay = await fixture.rpc("saveProject", [draft]);
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        expect(replay.body).toEqual(first.body);
        const conflict = await fixture.rpc("saveProject", [
          { ...draft, name: "同修订冲突项目" },
        ]);
        expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
        const saved = await fixture.read();
        expect(saved).toEqual(first.body.result);
        const noChange = await fixture.rpc("saveProject", [
          fixture.draft(saved),
        ]);
        expect(noChange.status, JSON.stringify(noChange.body)).toBe(200);
        expect(noChange.body.result).toEqual(saved);
        const next = await fixture.rpc("saveProject", [
          { ...fixture.draft(saved), name: "同值后继续修改" },
        ]);
        expect(next.status, JSON.stringify(next.body)).toBe(200);
        expect(next.body.result).toMatchObject({
          id: project.id,
          name: "同值后继续修改",
          revision: project.revision + 2,
        });
        const oldReplay = await fixture.rpc("saveProject", [draft]);
        expect(oldReplay.status, JSON.stringify(oldReplay.body)).toBe(200);
        expect(oldReplay.body).toEqual(first.body);
        expect(await fixture.read()).toEqual(next.body.result);
        expect(fixture.model.requests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    }, 60_000); // 独占真实HTTP与PG的并发、重放及同值保存测试期限。
    it("目录末尾空格保留真实身份，浏览与保存均不指向相邻同名目录", async () => {
      const fixture = await editorFixture();
      try {
        const ordinary = join(fixture.directory, "实际目录");
        const spaced = join(fixture.directory, "实际目录 ");
        const child = join(spaced, "空格目录中的子目录");
        await mkdir(ordinary);
        await mkdir(spaced);
        await mkdir(child);
        const project = await fixture.read();
        const browsed = await fixture.rpc("readDirectory", [{ path: spaced }]);
        expect(browsed.status, JSON.stringify(browsed.body)).toBe(200);
        expect(browsed.body.result).toEqual({
          path: spaced,
          entries: [
            {
              name: "空格目录中的子目录",
              path: child,
              type: "directory",
            },
          ],
        });
        const draft = {
          ...fixture.draft(project),
          roots: [fixture.host.workspacePath, spaced],
          rootPermissions: { [spaced]: "read-only" },
        };
        const saved = await fixture.rpc("saveProject", [draft]);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.result.roots).toEqual([
          {
            rootPath: fixture.host.workspacePath,
            position: 0,
            isPrimary: true,
          },
          {
            rootPath: spaced,
            position: 1,
            isPrimary: false,
            access: "read-only",
          },
        ]);
        expect(await fixture.read()).toEqual(saved.body.result);
        expect((await fixture.rpc("saveProject", [draft])).body).toEqual(
          saved.body,
        );
        expect(fixture.model.requests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    }, 60_000); // 真实相邻目录的浏览、保存与重放测试期限。
    it("目录别名与重复选择只保存一个真实附加目录，读取与重放使用同一目录身份", async () => {
      const fixture = await editorFixture();
      try {
        const root = join(fixture.directory, "真实目录");
        const alias = join(fixture.directory, "目录别名");
        await mkdir(root);
        await symlink(root, alias);
        const project = await fixture.read();
        const browsed = await fixture.rpc("readDirectory", [{ path: alias }]);
        expect(browsed.status, JSON.stringify(browsed.body)).toBe(200);
        expect(browsed.body.result).toEqual({ path: root, entries: [] });
        const draft = {
          ...fixture.draft(project),
          roots: [fixture.host.workspacePath, root, alias, root],
          rootPermissions: { [root]: "read-only", [alias]: "read-only" },
        };
        const saved = await fixture.rpc("saveProject", [draft]);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.result.roots).toEqual([
          {
            rootPath: fixture.host.workspacePath,
            position: 0,
            isPrimary: true,
          },
          {
            rootPath: root,
            position: 1,
            isPrimary: false,
            access: "read-only",
          },
        ]);
        expect((await fixture.rpc("saveProject", [draft])).body).toEqual(
          saved.body,
        );
        expect(await fixture.read()).toEqual(saved.body.result);
        expect(fixture.model.requests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    }, 60_000); // 独占真实HTTP、PG及目录的测试期限。
    it("已提交编辑的重放不重新读取已移除目录，项目归档后拒绝迟到保存", async () => {
      const fixture = await editorFixture();
      try {
        const root = join(fixture.directory, "稍后移除的目录");
        await mkdir(root);
        const project = await fixture.read();
        const draft = {
          ...fixture.draft(project),
          roots: [fixture.host.workspacePath, root],
          rootPermissions: { [root]: "read-only" },
        };
        const saved = await fixture.rpc("saveProject", [draft]);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        await rm(root, { recursive: true });
        const replay = await fixture.rpc("saveProject", [draft]);
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        expect(replay.body).toEqual(saved.body);
        expect(await fixture.read()).toEqual(saved.body.result);
        const archived = await fixture.rpc("deleteProject", [
          project.id,
          "local",
        ]);
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        const late = await fixture.rpc("saveProject", [draft]);
        expect(late.status, JSON.stringify(late.body)).toBe(404);
        const listed = await fixture.rpc("readProjects");
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect(listed.body.result).not.toContainEqual(
          expect.objectContaining({ id: project.id }),
        );
        expect(fixture.model.requests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    }, 60_000); // 真实目录移除、持久回执与归档的测试期限。
  },
);
