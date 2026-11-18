import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  codeProjectEditorProjectSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;

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
  const root = join(host.workspacePath, "项目置顶目录");
  await mkdir(root);
  const response = await projectRpc(host, "saveProject", [
    {
      creationId: randomUUID(),
      kind: "code",
      hostId: "local",
      name: "项目置顶验证 B",
      roots: [root],
      primaryRoot: root,
      rootPermissions: {},
      directoryChoice: "independent",
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectEditorProjectSchema.parse(response.body.result);
}

async function seedTaskHistory(host: Host, model: Model) {
  const sent = await host.command("sendText", {
    text: "项目置顶前保留的任务历史",
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await model.firstRequest;
  model.finish(0);
  await vi.waitFor(
    async () => {
      const snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(snapshot.control.phase).toBe("completedSuccess");
      expect(
        snapshot.rows.window
          .filter((row) => row.kind === "userInput")
          .map((row) => row.text),
      ).toEqual(["项目置顶前保留的任务历史"]);
    },
    { timeout: 30_000 },
  ); // 仅等待原Task通过真实受控模型HTTP完成历史输入。
}

async function verifyPin(host: Host) {
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
  const saved = await projectRpc(host, "saveProject", [input]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const pinned = codeProjectEditorProjectSchema.parse(saved.body.result);
  expect(pinned).toMatchObject({
    id: project.id,
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
  expect(afterPin.projects.filter((entry) => entry.id !== project.id)).toEqual(
    beforeTree.projects.filter((entry) => entry.id !== project.id),
  );
  const replay = await projectRpc(host, "saveProject", [input]);
  expect(replay.status, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body).toEqual(saved.body);
  expect(await readTree(host)).toEqual(afterPin);
  const conflict = await projectRpc(host, "saveProject", [
    { ...input, pinned: false },
  ]);
  expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
  applicationErrorResponseSchema.parse(conflict.body);
  const invalid = await projectRpc(host, "saveProject", [
    { ...input, expectedRevision: pinned.revision, pinned: "true" },
  ]);
  expect(invalid.status, JSON.stringify(invalid.body)).toBe(400);
  applicationErrorResponseSchema.parse(invalid.body);
  expect(await readTree(host)).toEqual(afterPin);
  const unpin = await projectRpc(host, "saveProject", [
    {
      id: project.id,
      hostId: "local",
      expectedRevision: pinned.revision,
      pinned: false,
    },
  ]);
  expect(unpin.status, JSON.stringify(unpin.body)).toBe(200);
  const unpinned = codeProjectEditorProjectSchema.parse(unpin.body.result);
  expect(unpinned).toMatchObject({
    id: project.id,
    name: project.name,
    roots: project.roots,
    createdAt: project.createdAt,
    revision: project.revision + 2,
    pinned: false,
  });
  const afterUnpin = await readTree(host);
  expect(afterUnpin.projects.find((entry) => entry.id === project.id)).toEqual(
    unpinned,
  );
  const oldReplay = await projectRpc(host, "saveProject", [input]);
  expect(oldReplay.status, JSON.stringify(oldReplay.body)).toBe(200);
  expect(oldReplay.body).toEqual(saved.body);
  expect(await readTree(host)).toEqual(afterUnpin);
  expect(afterUnpin.tasks).toEqual(beforeTree.tasks);
  expect(await taskScope(host)).toEqual(beforeScope);
  expect(
    protocol.conversationSnapshotSchema.parse(await host.snapshot()),
  ).toEqual(beforeSnapshot);
}

async function verifyPinnedProjectEdit(host: Host, readOnly: string) {
  const beforeTree = await readTree(host);
  const project = beforeTree.projects.find(
    (entry) => entry.id === host.projectId,
  );
  if (!project) throw new Error("原项目列表缺少Task所属项目");
  expect(
    beforeTree.tasks.find((entry) => entry.taskId === host.sessionId),
  ).toMatchObject({ projectId: project.id });
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
  const saved = await projectRpc(host, "saveProject", [input]);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const pinned = codeProjectEditorProjectSchema.parse(saved.body.result);
  expect(pinned).toMatchObject({
    id: project.id,
    name: project.name,
    roots: project.roots,
    revision: project.revision + 1,
    pinned: true,
  });
  const edited = await projectRpc(host, "saveProject", [
    {
      id: project.id,
      hostId: "local",
      expectedRevision: pinned.revision,
      name: "置顶后编辑已有Task项目",
      roots: [host.workspacePath, readOnly],
      primaryRoot: host.workspacePath,
      rootPermissions: { [readOnly]: "read-only" },
    },
  ]);
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  const changed = codeProjectEditorProjectSchema.parse(edited.body.result);
  expect(changed).toMatchObject({
    id: project.id,
    name: "置顶后编辑已有Task项目",
    roots: [
      { rootPath: host.workspacePath, position: 0, isPrimary: true },
      {
        rootPath: readOnly,
        position: 1,
        isPrimary: false,
        access: "read-only",
      },
    ],
    createdAt: project.createdAt,
    revision: pinned.revision + 1,
    pinned: true,
  });
  const afterEdit = await readTree(host);
  expect(afterEdit.projects.find((entry) => entry.id === project.id)).toEqual(
    changed,
  );
  expect(afterEdit.projects.filter((entry) => entry.id !== project.id)).toEqual(
    beforeTree.projects.filter((entry) => entry.id !== project.id),
  );
  const conflict = await projectRpc(host, "saveProject", [
    { ...input, expectedRevision: pinned.revision, pinned: false },
  ]);
  expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
  applicationErrorResponseSchema.parse(conflict.body);
  expect(await readTree(host)).toEqual(afterEdit);
  const replay = await projectRpc(host, "saveProject", [input]);
  expect(replay.status, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body).toEqual(saved.body);
  expect(await readTree(host)).toEqual(afterEdit);
  expect(afterEdit.tasks).toEqual(beforeTree.tasks);
  expect(await taskScope(host)).toEqual(beforeScope);
  expect(
    protocol.conversationSnapshotSchema.parse(await host.snapshot()),
  ).toEqual(beforeSnapshot);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目置顶保存的HTTP、SSE与PostgreSQL integration",
  () => {
    it("稀疏置顶和取消保留项目内容，原回执重放不覆盖新值且Task授权保持", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        await seedTaskHistory(host, model);
        const modelRequestCountBefore = model.requests.length;
        await verifyPin(host);
        expect(model.requests).toHaveLength(modelRequestCountBefore);
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
        throw new AggregateError(failures, "项目置顶验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占真实HTTP、SSE、PostgreSQL和模型HTTP服务的验证期限。

    it("已有Task的项目置顶后完整编辑保留置顶，旧请求不覆盖名称目录和Task状态", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      let readOnly: string | undefined;
      const failures: unknown[] = [];
      try {
        readOnly = await mkdtemp(join(tmpdir(), "code-project-pin-edit-"));
        readOnly = await realpath(readOnly);
        host = await createCodeSessionFixture(model.baseUrl, {
          client: isolatedHttp,
        });
        await seedTaskHistory(host, model);
        const modelRequestCountBefore = model.requests.length;
        await verifyPinnedProjectEdit(host, readOnly);
        expect(model.requests).toHaveLength(modelRequestCountBefore);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => host?.dispose(),
          () => model.close(),
          () => readOnly && rm(readOnly, { recursive: true, force: true }),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "置顶项目编辑验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占真实HTTP、SSE、PostgreSQL和模型HTTP服务的验证期限。
  },
);
