import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { nextHostServiceEvent } from "./host-client.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目编辑器的真实宿主 integration",
  () => {
    it("修改项目名称与附加目录只影响新Task，原Task目录与授权保持", async () => {
      const model = await heldModel();
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "code-project-editor-")),
      );
      let host:
        | Awaited<ReturnType<typeof createCodeSessionFixture>>
        | undefined;
      try {
        const readOnly = join(directory, "参考资料");
        const readWrite = join(directory, "输出文件");
        await mkdir(readOnly);
        await mkdir(readWrite);
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        const session = host;
        const scope = async (taskId: string) => {
          const result = await session.client.request(
            `/api/code-ui/tasks/${taskId}/scope`,
          );
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          return codeTaskScopeResponseSchema.parse(result.body).scope;
        };
        const before = await scope(host.sessionId);
        const rpc = (method: string, args: unknown[] = []) =>
          session.client.request("/api/code-ui/rpc", {
            service: "project",
            method,
            args,
          });
        const listed = await rpc("readProjects");
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const project = listed.body.result.find(
          (item: { id: string }) => item.id === session.projectId,
        );
        if (!project) throw new Error("原项目列表缺少刚创建的项目");
        const draft = {
          id: project.id,
          hostId: "local",
          name: "项目编辑验证",
          roots: [host.workspacePath, readOnly, readWrite],
          primaryRoot: host.workspacePath,
          rootPermissions: {
            [readOnly]: "read-only",
            [readWrite]: "read-write",
          },
          expectedRevision: project.revision,
        };
        const saved = await rpc("saveProject", [draft]);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.result).toMatchObject({
          id: host.projectId,
          name: "项目编辑验证",
          revision: project.revision + 1,
          roots: [
            { rootPath: host.workspacePath, position: 0, isPrimary: true },
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
        for (;;) {
          const notification = await nextHostServiceEvent(
            host.stream,
            "broadcast",
            "onMessage",
          );
          if (
            notification.data.channel === "state:projects" &&
            notification.data.payload.projectId === host.projectId
          )
            break;
        }
        expect((await rpc("saveProject", [draft])).body).toEqual(saved.body);
        expect((await rpc("readProjects")).body.result).toContainEqual(
          saved.body.result,
        );
        expect(await scope(host.sessionId)).toEqual(before);
        const current = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        const created = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              commandId: randomUUID(),
              clientId: host.clientId,
              sessionId: null,
              type: "createSession",
              payload: {
                workspaceId: host.projectId,
                config: {
                  modelSelection: current.config.modelSelection,
                  mode: "build",
                  planEnabled: false,
                },
              },
              issuedAt: Date.now(),
            },
          },
        ]);
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const ack = protocol.commandAckSchema.parse(created.body.result);
        expect(ack.status).toBe("accepted");
        const nextTaskId = created.body.result.result.sessionId;
        expect(nextTaskId).not.toBe(host.sessionId);
        expect(await scope(nextTaskId)).toMatchObject({
          projectId: host.projectId,
          rootDirectory: before.rootDirectory,
          additionalDirectories: [
            { path: readOnly, access: "read-only" },
            { path: readWrite, access: "read-write" },
          ],
        });
        expect(await scope(host.sessionId)).toEqual(before);
        expect(model.requests).toEqual([]);
      } finally {
        await host?.dispose();
        await model.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000); // 独占真实HTTP与PG的测试期限，不是Agent运行时限额。
  },
);
