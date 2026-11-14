import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeProjectEditorProjectSchema,
  codeProjectTreeRpcResponseSchema,
  codeUiWorkspaceSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createProjectGitFixture } from "./project-git.fixture.js";

async function openGitClient(
  fixture: Awaited<ReturnType<typeof createCodeUiHttpFixture>>,
) {
  const stream = await fixture.client.openCodeStream();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId: randomUUID(),
      appVersion: "project-git-public-test",
      clientKind: "web",
    },
  ]);
  expect(initialized.status).toBe(200);
  return {
    stream,
    rpc: (service: string, method: string, args: unknown[]) =>
      fixture.client.request("/api/code-ui/rpc", {
        connectionId: stream.ready.hello.connectionId,
        service,
        method,
        args,
      }),
  };
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Project文件面板的真实Git与无Task工作域 integration",
  () => {
    it("没有Task的Project读取真实变更及忽略状态，读取后仍没有Task", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const { root } = await createProjectGitFixture(fixture.directory);
        let client = await openGitClient(fixture);
        const rpc = (service: string, method: string, args: unknown[]) =>
          client.rpc(service, method, args);
        const opened = await rpc("workspace", "open", [{ path: root }]);
        expect(opened.status, JSON.stringify(opened.body)).toBe(200);
        const project = codeUiWorkspaceSchema.parse(opened.body.result);
        const readTree = async () => {
          const response = await rpc("project", "readTree", [{}]);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return codeProjectTreeRpcResponseSchema.parse(response.body).result;
        };
        expect((await readTree()).tasks).toEqual([]);
        const target = {
          workspacePath: root,
          workspaceIdentity: JSON.stringify([project.projectId, root]),
          viewerScope: { kind: "project", projectId: project.projectId },
        };
        const refreshed = await rpc("git", "refresh", [target]);
        expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
        expect(refreshed.body.result).toMatchObject({
          summary: { isRepository: true, branchName: "main", isDirty: true },
          stagedChanges: [],
          unstagedChanges: [
            {
              path: join(root, "tracked.txt"),
              kind: "modified",
              section: "unstaged",
              added: 1,
              removed: 0,
            },
          ],
        });
        const ignored = await rpc("git", "getIgnoredPaths", [
          {
            ...target,
            paths: [join(root, "ignored.txt"), join(root, "tracked.txt")],
          },
        ]);
        expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
        expect(ignored.body.result).toEqual([join(root, "ignored.txt")]);
        const outside = join(fixture.directory, "outside-project.txt");
        await writeFile(outside, "outside project");
        const denied = await rpc("git", "getIgnoredPaths", [
          { ...target, paths: [outside] },
        ]);
        expect(denied.status).toBe(404);
        expect(denied.body.error.code).toBe("code_ui_path_denied");
        const wrongProject = await rpc("git", "refresh", [
          {
            ...target,
            viewerScope: { kind: "project", projectId: randomUUID() },
          },
        ]);
        expect(wrongProject.status).toBe(404);
        const write = await rpc("git", "stagePaths", [
          { ...target, paths: [join(root, "tracked.txt")] },
        ]);
        expect(write.status).toBe(500);
        expect(write.body.error.message).toContain("尚不支持stagePaths");
        client.stream.controller.abort();
        await client.stream.closed;
        const late = await rpc("git", "refresh", [target]);
        expect(late.status).toBe(404);
        client = await openGitClient(fixture);
        expect(
          (await rpc("git", "getRepositorySummary", [target])).status,
        ).toBe(200);
        const archived = await fixture.client.request(
          `/api/projects/${project.projectId}`,
          undefined,
          "DELETE",
        );
        expect(archived.status).toBe(204);
        expect((await rpc("git", "refresh", [target])).status).toBe(404);
        expect((await readTree()).tasks).toEqual([]);
      } finally {
        await fixture.close();
      }
    }, 120_000); // 真实HTTP/SSE、临时PostgreSQL、Git仓库、沙箱与全部资源关闭期限。

    it("普通项目目录没有Git仓库时返回空忽略列表，目录外请求仍拒绝", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const root = join(fixture.directory, "plain-project");
        await mkdir(root);
        await writeFile(join(root, "plain.txt"), "plain");
        const { rpc } = await openGitClient(fixture);
        const opened = await rpc("workspace", "open", [{ path: root }]);
        expect(opened.status).toBe(200);
        const project = codeUiWorkspaceSchema.parse(opened.body.result);
        const target = {
          workspacePath: root,
          viewerScope: { kind: "project", projectId: project.projectId },
        };
        const summary = await rpc("git", "getRepositorySummary", [target]);
        expect(summary.status).toBe(200);
        expect(summary.body.result.isRepository).toBe(false);
        const ignored = await rpc("git", "getIgnoredPaths", [
          { ...target, paths: [join(root, "plain.txt")] },
        ]);
        expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
        expect(ignored.body.result).toEqual([]);
        const denied = await rpc("git", "getIgnoredPaths", [
          { ...target, paths: [join(fixture.directory, "outside")] },
        ]);
        expect(denied.status).toBe(404);
      } finally {
        await fixture.close();
      }
    }, 120_000); // 普通目录同样经过真实沙箱，拒绝从父仓库借用授权。

    it("已授权附加目录不借用主仓库忽略规则，撤销后原路径立即拒绝", async () => {
      const fixture = await createCodeUiHttpFixture();
      try {
        const { root } = await createProjectGitFixture(fixture.directory);
        const reference = join(fixture.directory, "reference");
        await mkdir(reference);
        const path = join(reference, "reference.txt");
        await writeFile(path, "reference");
        const { rpc } = await openGitClient(fixture);
        const opened = await rpc("workspace", "open", [{ path: root }]);
        expect(opened.status).toBe(200);
        const workspace = codeUiWorkspaceSchema.parse(opened.body.result);
        const projects = await rpc("project", "readProjects", [{}]);
        const project = codeProjectEditorProjectSchema
          .array()
          .parse(projects.body.result)
          .find((entry) => entry.id === workspace.projectId);
        if (!project) throw new Error("真实项目尚未创建");
        const granted = await rpc("project", "saveProject", [
          {
            id: project.id,
            expectedRevision: project.revision,
            roots: [root, reference],
            primaryRoot: root,
            rootPermissions: { [reference]: "read-only" },
          },
        ]);
        expect(granted.status, JSON.stringify(granted.body)).toBe(200);
        const target = {
          workspacePath: root,
          viewerScope: { kind: "project", projectId: project.id },
        };
        const ignored = await rpc("git", "getIgnoredPaths", [
          { ...target, paths: [path] },
        ]);
        expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
        expect(ignored.body.result).toEqual([]);
        const readable = await rpc("file", "readTextFile", [
          { path, viewerScope: target.viewerScope },
        ]);
        expect(readable.status).toBe(200);
        expect(readable.body.result).toMatchObject({
          content: "reference",
          bytesRead: 9,
          totalBytes: 9,
          truncated: false,
        });
        const updated = codeProjectEditorProjectSchema.parse(
          granted.body.result,
        );
        const revoked = await rpc("project", "saveProject", [
          {
            id: project.id,
            expectedRevision: updated.revision,
            roots: [root],
            primaryRoot: root,
            rootPermissions: {},
          },
        ]);
        expect(revoked.status).toBe(200);
        expect(
          (await rpc("git", "getIgnoredPaths", [{ ...target, paths: [path] }]))
            .status,
        ).toBe(404);
        expect(
          (
            await rpc("file", "readTextFile", [
              { path, viewerScope: target.viewerScope },
            ])
          ).status,
        ).toBe(404);
        const tree = await rpc("project", "readTree", [{}]);
        expect(
          codeProjectTreeRpcResponseSchema.parse(tree.body).result.tasks,
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    }, 120_000); // 通过原项目编辑与文件/Git读取接口验证目录变更和旧路径拒绝。
  },
);
