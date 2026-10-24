import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

function projectRpc(host: Host, method: string, args: unknown[]) {
  return host.client.request("/api/code-ui/rpc", {
    service: "project",
    method,
    args,
  });
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

async function createProject(host: Host) {
  const root = join(host.workspacePath, "并发置顶主目录");
  const additional = join(host.workspacePath, "并发置顶只读资料");
  await mkdir(root);
  await mkdir(additional);
  const response = await projectRpc(host, "saveProject", [
    {
      creationId: randomUUID(),
      kind: "code",
      hostId: "local",
      name: "并发置顶验证项目 B",
      roots: [root, additional],
      primaryRoot: root,
      rootPermissions: { [additional]: "read-only" },
      directoryChoice: "independent",
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectEditorProjectSchema.parse(response.body.result);
}

async function verifyConcurrentPin(host: Host) {
  const project = await createProject(host);
  const beforeTree = await readTree(host);
  const beforeScope = await taskScope(host);
  const beforeSnapshot = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const input = {
    id: project.id,
    hostId: "local",
    expectedRevision: project.revision,
    pinned: true,
  };
  // 两个真实HTTP请求分别使用Host夹具和默认夹具已初始化的独立SSE连接。
  const [first, second] = await Promise.all([
    projectRpc(host, "saveProject", [input]),
    isolatedHttp.request("/api/code-ui/rpc", {
      service: "project",
      method: "saveProject",
      args: [input],
    }),
  ]);
  for (const response of [first, second])
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(second.body).toEqual(first.body);
  const pinned = codeProjectEditorProjectSchema.parse(first.body.result);
  expect(pinned).toMatchObject({
    id: project.id,
    hostId: project.hostId,
    name: project.name,
    roots: project.roots,
    createdAt: project.createdAt,
    revision: project.revision + 1,
    pinned: true,
  });
  const afterPin = await readTree(host);
  expect(afterPin.projects.find((entry) => entry.id === project.id)).toEqual(
    pinned,
  );
  expect(afterPin.projects).toHaveLength(beforeTree.projects.length);
  expect(afterPin.projects.filter((entry) => entry.id !== project.id)).toEqual(
    beforeTree.projects.filter((entry) => entry.id !== project.id),
  );
  const invalid: unknown[][] = [
    [{ ...input, unknown: true }],
    [input, input],
    [{ ...input, roots: project.roots.map((root) => root.rootPath) }],
    [{ ...input, name: "不应保存的名称" }],
    [{ id: project.id, hostId: "local", pinned: true }],
  ];
  for (const args of invalid) {
    const response = await projectRpc(host, "saveProject", args);
    expect(response.status, JSON.stringify({ args, body: response.body })).toBe(
      400,
    );
    applicationErrorResponseSchema.parse(response.body);
    expect(await readTree(host)).toEqual(afterPin);
  }
  expect(afterPin.tasks).toEqual(beforeTree.tasks);
  expect(await taskScope(host)).toEqual(beforeScope);
  expect(
    protocol.conversationSnapshotSchema.parse(await host.snapshot()),
  ).toEqual(beforeSnapshot);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目置顶并发及严格参数的HTTP、SSE与PostgreSQL integration",
  () => {
    it("两个可信连接同意图并发只推进一次修订，非法材料拒绝且项目和Task保持", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        await verifyConcurrentPin(host);
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
        throw new AggregateError(failures, "并发置顶验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占真实HTTP、双SSE连接、PostgreSQL及模型HTTP服务的验证期限。
  },
);
