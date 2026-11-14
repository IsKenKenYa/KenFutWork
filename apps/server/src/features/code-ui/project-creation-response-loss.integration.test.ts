import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  canvasListResponseSchema,
  codeProjectEditorProjectSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;

async function initializeProjectClient(fixture: Fixture) {
  const stream = await fixture.client.openCodeStream();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId: randomUUID(),
      appVersion: "project-creation-commit-loss",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  const rpc = (method: string, args: unknown[] = []) =>
    fixture.client.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "project",
      method,
      args,
    });
  return {
    rpc,
    connectionId: stream.ready.hello.connectionId,
    async readProjects() {
      const response = await rpc("readProjects");
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return codeProjectEditorProjectSchema.array().parse(response.body.result);
    },
  };
}

async function expectEmptyProject(
  fixture: Fixture,
  connectionId: string,
  projectId: string,
  workspacePath: string,
) {
  const canvases = await fixture.client.request(
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
    const tasks = await fixture.client.request("/api/code-ui/rpc", {
      connectionId,
      service: "zcode-task",
      method,
      args: [{ workspacePath, projectId }],
    });
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    expect(tasks.body.result).toEqual([]);
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目创建COMMIT响应丢失 integration",
  () => {
    it("真实提交丢失响应后同创建身份只返回原项目，冲突保持409且不重建目录或Task", async () => {
      let proxy:
        | Awaited<ReturnType<typeof createCommitResponseLossProxy>>
        | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      try {
        if (!proxy) throw new Error("项目创建测试未建立真实PG故障代理");
        const { rpc, readProjects, connectionId } =
          await initializeProjectClient(fixture);
        const directory = join(fixture.directory, "创建目录集合");
        const primary = join(directory, "主目录");
        const reference = join(directory, "参考资料");
        await mkdir(directory);
        await mkdir(primary);
        await mkdir(reference);
        const before = await readProjects();
        const input = {
          creationId: randomUUID(),
          hostId: "local",
          kind: "code",
          name: "提交响应丢失项目",
          roots: [primary, reference],
          primaryRoot: primary,
          rootPermissions: { [reference]: "read-only" },
        };
        proxy.arm(input.creationId, { projectCreation: true });
        const unavailable = await rpc("saveProject", [input]);
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(unavailable.body.error.code).toBe("code_ui_error");
        expect(proxy.evidence()).toMatchObject({
          injected: {
            commitConfirmed: true,
            replySuppressed: true,
            commandId: input.creationId,
            creationId: input.creationId,
            projectCreation: true,
          },
        });
        expect(proxy.evidence().observerError).toBeUndefined();
        proxy.restore();
        const after = await readProjects();
        const previousIds = new Set(before.map((project) => project.id));
        const created = after.filter((project) => !previousIds.has(project.id));
        expect(after).toHaveLength(before.length + 1);
        expect(created).toHaveLength(1);
        const project = created[0];
        if (!project) throw new Error("公开目录未读到已提交项目");
        expect(project.id).toBe(proxy.evidence().injected?.targetProjectId);
        expect(project).toMatchObject({
          name: "提交响应丢失项目",
          roots: [
            { rootPath: primary, position: 0, isPrimary: true },
            {
              rootPath: reference,
              position: 1,
              isPrimary: false,
              access: "read-only",
            },
          ],
        });
        expect((await readdir(directory)).sort()).toEqual([
          "主目录",
          "参考资料",
        ]);
        await rm(reference, { recursive: true });
        const replay = await rpc("saveProject", [input]);
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        expect(
          codeProjectEditorProjectSchema.parse(replay.body.result),
        ).toEqual(project);
        const conflict = await rpc("saveProject", [
          { ...input, name: "响应丢失后修改原创建意图" },
        ]);
        expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
        expect(await readProjects()).toEqual(after);
        expect(await readdir(directory)).toEqual(["主目录"]);
        await expectEmptyProject(fixture, connectionId, project.id, primary);
      } finally {
        await fixture.close();
      }
    }, 60_000); // 独占真实HTTP、PG提交丢包代理与目录的创建恢复测试期限。
  },
);
