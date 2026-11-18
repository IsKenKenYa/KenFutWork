import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  projectListResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type Response = Awaited<ReturnType<Host["client"]["request"]>>;

function projectRpc(host: Host, method: string, args: unknown[]) {
  return host.client.request("/api/code-ui/rpc", {
    service: "project",
    method,
    args,
  });
}

function expectError(response: Response, status: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  applicationErrorResponseSchema.parse(response.body);
}

async function withHost(work: (host: Host, model: Model) => Promise<void>) {
  const model = await heldModel();
  let host: Host | undefined;
  const failures: unknown[] = [];
  try {
    host = await createCodeSessionFixture(model.baseUrl, {
      client: isolatedHttp,
    });
    await work(host, model);
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
    throw new AggregateError(failures, "项目准备边界验证或资源关闭失败", {
      cause: failures[0],
    });
}

async function createProject(
  host: Host,
  root: string,
  name: string,
  kind: "code" | "design",
) {
  await mkdir(root);
  const response = await projectRpc(host, "saveProject", [
    {
      creationId: randomUUID(),
      hostId: "local",
      kind,
      name,
      roots: [root],
      primaryRoot: root,
      rootPermissions: {},
      directoryChoice: "independent",
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectEditorProjectSchema.parse(response.body.result);
}

function preparedBody(projectId: string, root: string) {
  return {
    result: {
      projectId,
      workspacePath: root,
      workspaceIdentity: canonicalLocalWorkspaceIdentity(projectId, root),
    },
  };
}

async function readState(host: Host) {
  const tree = await projectRpc(host, "readTree", [
    { hostId: "local", includeDeleted: true, includeDeletedTasks: true },
  ]);
  const codeProjects = await host.client.request("/api/projects?kind=code");
  const designProjects = await host.client.request("/api/projects?kind=design");
  const scope = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  for (const response of [tree, codeProjects, designProjects, scope])
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  return {
    tree: codeProjectTreeSchema.parse(tree.body.result),
    codeProjects: projectListResponseSchema.parse(codeProjects.body),
    designProjects: projectListResponseSchema.parse(designProjects.body),
    scope: codeTaskScopeResponseSchema.parse(scope.body).scope,
    snapshot: protocol.conversationSnapshotSchema.parse(await host.snapshot()),
  };
}

async function expectConnectionBound(projectId: string, root: string) {
  const stream = await isolatedHttp.openCodeStream();
  const prepare = () =>
    isolatedHttp.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "project",
      method: "prepareSession",
      args: [{ projectId }],
    });
  try {
    expectError(await prepare(), 409);
    const initialized = await stream.rpc("initializeConversationV4", [
      {
        kind: "clientHello",
        protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
        clientId: randomUUID(),
        appVersion: "project-prepare-boundary-integration",
        clientKind: "web",
      },
    ]);
    expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
    const ready = await prepare();
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body).toEqual(preparedBody(projectId, root));
    stream.controller.abort();
    await stream.closed;
    await vi.waitFor(async () => expectError(await prepare(), 404));
  } finally {
    stream.controller.abort();
    await stream.closed;
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目新草稿准备边界的HTTP、SSE与PostgreSQL integration",
  () => {
    it("严格拒绝非法材料和未初始化连接，Design准备保持工作方式且关闭连接不再接纳", async () => {
      await withHost(async (host, model) => {
        const rootB = join(host.workspacePath, "严格准备Code项目");
        const rootD = join(host.workspacePath, "独立Design准备项目");
        const projectB = await createProject(
          host,
          rootB,
          "严格准备项目 B",
          "code",
        );
        const projectD = await createProject(
          host,
          rootD,
          "独立创作项目 D",
          "design",
        );
        const before = await readState(host);
        expect(
          before.codeProjects.projects.map((project) => project.id),
        ).not.toContain(projectD.id);
        expect(
          before.designProjects.projects.find(
            (project) => project.id === projectD.id,
          ),
        ).toMatchObject({
          id: projectD.id,
          kind: "design",
          enabledModes: ["design"],
        });
        const invalid: unknown[][] = [
          [],
          [{}],
          [null],
          [{ projectId: "not-a-uuid" }],
          [{ projectId: projectB.id, extra: true }],
          [{ projectId: projectB.id, hostId: "remote" }],
          [{ projectId: projectB.id, hostId: null }],
          [{ projectId: projectB.id, preset: "flow" }],
          [{ projectId: projectB.id }, { projectId: projectB.id }],
        ];
        for (const args of invalid)
          expectError(await projectRpc(host, "prepareSession", args), 400);
        expectError(
          await projectRpc(host, "prepareSession", [
            { projectId: randomUUID() },
          ]),
          404,
        );
        expectError(
          await projectRpc(host, "prepareSession", [
            { projectId: projectD.id, preset: "code" },
          ]),
          404,
        );
        const design = await projectRpc(host, "prepareSession", [
          { projectId: projectD.id, preset: "design" },
        ]);
        expect(design.status, JSON.stringify(design.body)).toBe(200);
        expect(design.body).toEqual(preparedBody(projectD.id, rootD));
        const defaults = await projectRpc(host, "prepareSession", [
          { projectId: projectB.id },
        ]);
        expect(defaults.status, JSON.stringify(defaults.body)).toBe(200);
        expect(defaults.body).toEqual(preparedBody(projectB.id, rootB));
        await expectConnectionBound(projectB.id, rootB);
        expect(await readState(host)).toEqual(before);
        expect(model.requests).toEqual([]);
      });
    }, 60_000); // 独占真实HTTP、SSE初始化与关闭、PostgreSQL的验证期限。

    it("并发与重复准备只读，临时目录恢复后可用，归档后的迟到准备不恢复项目或Task", async () => {
      await withHost(async (host, model) => {
        const root = join(host.workspacePath, "稍后不可用的准备目录");
        const movedRoot = `${root} 暂存`;
        const projectB = await createProject(
          host,
          root,
          "目录准备项目 B",
          "code",
        );
        const input = {
          projectId: projectB.id,
          hostId: "local",
          preset: "code",
        };
        const expected = preparedBody(projectB.id, root);
        const before = await readState(host);
        const concurrent = await Promise.all([
          projectRpc(host, "prepareSession", [input]),
          projectRpc(host, "prepareSession", [{ projectId: projectB.id }]),
          projectRpc(host, "prepareSession", [input]),
          projectRpc(host, "prepareSession", [
            { projectId: projectB.id, preset: "code" },
          ]),
        ]);
        for (const response of concurrent) {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(response.body).toEqual(expected);
        }
        for (const args of [[input], [input]]) {
          const repeated = await projectRpc(host, "prepareSession", args);
          expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
          expect(repeated.body).toEqual(expected);
        }
        expect(await readState(host)).toEqual(before);
        await rename(root, movedRoot);
        try {
          expectError(await projectRpc(host, "prepareSession", [input]), 404);
          expect(await readState(host)).toEqual(before);
        } finally {
          await rename(movedRoot, root);
        }
        const restored = await projectRpc(host, "prepareSession", [input]);
        expect(restored.status, JSON.stringify(restored.body)).toBe(200);
        expect(restored.body).toEqual(expected);
        expect(await readState(host)).toEqual(before);
        const archived = await projectRpc(host, "deleteProject", [
          projectB.id,
          "local",
        ]);
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        const afterArchive = await readState(host);
        expect(
          afterArchive.tree.projects.find(
            (project) => project.id === projectB.id,
          ),
        ).toMatchObject({ id: projectB.id, deleted: true });
        expect(
          afterArchive.codeProjects.projects.map((project) => project.id),
        ).not.toContain(projectB.id);
        expect(afterArchive.tree.tasks).toEqual(before.tree.tasks);
        expect(afterArchive.scope).toEqual(before.scope);
        expect(afterArchive.snapshot).toEqual(before.snapshot);
        expectError(await projectRpc(host, "prepareSession", [input]), 404);
        expectError(
          await projectRpc(host, "prepareSession", [
            { projectId: projectB.id },
          ]),
          404,
        );
        expect(await readState(host)).toEqual(afterArchive);
        expect(model.requests).toEqual([]);
      });
    }, 60_000); // 真实临时目录改名及恢复、只读并发和归档迟到请求的验证期限。
  },
);
