import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  projectListResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

function projectRpc(host: Host, method: string, args: unknown[] = []) {
  return host.client.request("/api/code-ui/rpc", {
    service: "project",
    method,
    args,
  });
}

async function createProject(host: Host, path: string, name: string) {
  const response = await projectRpc(host, "saveProject", [
    {
      creationId: randomUUID(),
      hostId: "local",
      kind: "code",
      name,
      roots: [path],
      primaryRoot: path,
      rootPermissions: {},
      directoryChoice: "independent",
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const project = codeProjectEditorProjectSchema.parse(response.body.result);
  expect(project.roots).toEqual([
    { rootPath: path, position: 0, isPrimary: true },
  ]);
  return project;
}

async function readTree(host: Host) {
  const response = await projectRpc(host, "readTree", [
    { hostId: "local", includeDeleted: true, includeDeletedTasks: true },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectTreeSchema.parse(response.body.result);
}

async function taskScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function readProjects(host: Host) {
  const response = await host.client.request("/api/projects?kind=code");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return projectListResponseSchema.parse(response.body);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目新草稿准备的HTTP、SSE与PostgreSQL integration",
  () => {
    it("明确准备B只返回B的真实目录和身份，同目录C、项目及既有Task授权保持", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        const root = join(host.workspacePath, "准备草稿的同目录项目");
        await mkdir(root);
        const projectB = await createProject(host, root, "准备草稿项目 B");
        const projectC = await createProject(host, root, "同目录独立项目 C");
        expect(projectB.id).not.toBe(projectC.id);
        const beforeTree = await readTree(host);
        const beforeProjects = await readProjects(host);
        const beforeScope = await taskScope(host);
        const beforeSnapshot = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(
          beforeTree.tasks.filter(
            (task) =>
              task.projectId === projectB.id || task.projectId === projectC.id,
          ),
        ).toEqual([]);
        const prepared = await projectRpc(host, "prepareSession", [
          { projectId: projectB.id, hostId: "local", preset: "code" },
        ]);
        expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
        expect(prepared.body).toEqual({
          result: {
            projectId: projectB.id,
            workspacePath: root,
            workspaceIdentity: canonicalLocalWorkspaceIdentity(
              projectB.id,
              root,
            ),
          },
        });
        expect(await readTree(host)).toEqual(beforeTree);
        expect(await readProjects(host)).toEqual(beforeProjects);
        expect(await taskScope(host)).toEqual(beforeScope);
        const afterSnapshot = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(afterSnapshot).toEqual(beforeSnapshot);
        expect(model.requests).toEqual([]);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [() => host?.dispose(), () => model.close()]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "项目草稿准备验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占真实HTTP、SSE、PostgreSQL与模型HTTP服务的关闭期限。
  },
);
