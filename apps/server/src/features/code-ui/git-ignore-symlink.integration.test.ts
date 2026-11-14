import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;

async function taskScope(host: Host, taskId: string) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${taskId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function createSiblingTask(host: Host) {
  const snapshot = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const response = await host.stream.rpc("sendConversationCommandV4", [
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
          config: { modelSelection: snapshot.config.modelSelection },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(response.body.result);
  expect(ack.status).toBe("accepted");
  if (ack.result?.type !== "createSession")
    throw new Error("Git验收没有取得第二个真实Task。");
  return ack.result.sessionId;
}

function ignoredPaths(host: Host, taskId: string, paths: string[]) {
  return host.client.request("/api/code-ui/rpc", {
    service: "git",
    method: "getIgnoredPaths",
    args: [
      {
        workspacePath: host.workspacePath,
        viewerScope: { kind: "task", taskId },
        paths,
      },
    ],
  });
}

async function verifyGitIgnore(host: Host, directory: string) {
  const otherId = await createSiblingTask(host);
  const otherScope = await taskScope(host, otherId);
  expect(otherScope.additionalDirectories).toEqual([]);
  const grant = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    { additionalDirectories: [{ path: directory, access: "read-only" }] },
    "PATCH",
  );
  expect(grant.status, JSON.stringify(grant.body)).toBe(200);
  const scope = codeTaskScopeResponseSchema.parse(grant.body).scope;
  expect(scope).toMatchObject({
    taskId: host.sessionId,
    rootDirectory: host.workspacePath,
    additionalDirectories: [{ path: directory, access: "read-only" }],
  });

  const target = join(directory, "真实原件.txt");
  const ignored = join(host.workspacePath, "应忽略链接.txt");
  const visible = join(host.workspacePath, "可见链接.txt");
  const ignoreFile = join(host.workspacePath, ".gitignore");
  await writeFile(target, "两个仓库内链接指向同一份已授权原件\n", "utf8");
  await symlink(target, ignored);
  await symlink(target, visible);
  await writeFile(ignoreFile, "应忽略链接.txt\n", "utf8");
  const first = await ignoredPaths(host, host.sessionId, [ignored, visible]);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body).toEqual({ result: [ignored] });

  await writeFile(ignoreFile, "可见链接.txt\n", "utf8");
  const changed = await ignoredPaths(host, host.sessionId, [ignored, visible]);
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body).toEqual({ result: [visible] });

  const denied = await ignoredPaths(host, otherId, [ignored, visible]);
  expect(denied.status, JSON.stringify(denied.body)).toBe(404);
  expect(denied.body.error.code).toBe("code_ui_path_denied");
  const outside = await ignoredPaths(host, host.sessionId, [target]);
  expect(outside.status, JSON.stringify(outside.body)).toBe(500);
  expect(outside.body.error).toEqual({
    code: "code_ui_error",
    message: "Git路径越出仓库根。",
  });
  const deniedFile = await host.client.request("/api/code-ui/rpc", {
    service: "file",
    method: "readTextFile",
    args: [{ path: ignored, viewerScope: { kind: "task", taskId: otherId } }],
  });
  expect(deniedFile.status, JSON.stringify(deniedFile.body)).toBe(404);
  expect(deniedFile.body.error.code).toBe("code_ui_path_denied");
  expect(await taskScope(host, host.sessionId)).toEqual(scope);
  expect(await taskScope(host, otherId)).toEqual(otherScope);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Git ignore符号链接的真实HTTP、Task权限与PostgreSQL integration",
  () => {
    it("按仓库内链接名读取真实忽略规则，未授权Task与仓库外原路径继续拒绝", async () => {
      const fixture = await createCodeUiHttpFixture();
      let host: Host | undefined;
      let model: Model | undefined;
      let directory: string | undefined;
      const failures: unknown[] = [];
      try {
        model = await heldModel();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        directory = await realpath(
          await mkdtemp(join(tmpdir(), "code-git-ignore-symlink-")),
        );
        await verifyGitIgnore(host, directory);
        expect(model.requests).toEqual([]);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => host?.dispose(),
          () => fixture.close(),
          () => model?.close(),
          () =>
            directory
              ? rm(directory, { recursive: true, force: true })
              : undefined,
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Git符号链接验收或资源关闭失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占真实HTTP/SSE、临时PostgreSQL及Task目录关闭期限。
  },
);
