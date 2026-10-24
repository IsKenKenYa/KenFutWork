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
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type Proxy = Awaited<ReturnType<typeof createCommitResponseLossProxy>>;

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

async function seedTaskHistory(host: Host, model: Model) {
  const sent = await host.command("sendText", {
    text: "置顶提交回包丢失时保持的Task历史",
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
      ).toEqual(["置顶提交回包丢失时保持的Task历史"]);
    },
    { timeout: 30_000 },
  ); // 仅等待原Task通过真实受控模型HTTP完成历史输入。
}

async function createProject(host: Host) {
  const primary = join(host.workspacePath, "置顶回包主目录");
  const reference = join(host.workspacePath, "置顶回包只读资料");
  await mkdir(primary);
  await mkdir(reference);
  const response = await projectRpc(host, "saveProject", [
    {
      creationId: randomUUID(),
      hostId: "local",
      kind: "code",
      name: "置顶回包丢失项目 B",
      roots: [primary, reference],
      primaryRoot: primary,
      rootPermissions: { [reference]: "read-only" },
      directoryChoice: "independent",
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeProjectEditorProjectSchema.parse(response.body.result);
}

async function verifyCommittedPin(host: Host, proxy: Proxy) {
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
  const key = JSON.stringify([
    beforeScope.instanceId,
    project.id,
    project.revision,
  ]);
  proxy.arm(key, { projectEditorSave: true });
  const unavailable = await projectRpc(host, "saveProject", [input]);
  expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
  expect(
    applicationErrorResponseSchema.parse(unavailable.body).error.code,
  ).toBe("code_ui_error");
  expect(proxy.evidence()).toMatchObject({
    injected: {
      projectEditorSave: true,
      commandId: key,
      commitConfirmed: true,
      replySuppressed: true,
      targetProjectId: project.id,
      expectedProjectRevision: project.revision,
      targetProjectRevision: project.revision + 1,
    },
  });
  expect(proxy.evidence().observerError).toBeUndefined();
  proxy.restore();
  const afterPin = await readTree(host);
  const committed = afterPin.projects.find((entry) => entry.id === project.id);
  if (!committed) throw new Error("真实提交后的公开目录缺少目标项目。");
  expect(committed).toMatchObject({
    id: project.id,
    name: project.name,
    roots: project.roots,
    createdAt: project.createdAt,
    revision: project.revision + 1,
    pinned: true,
  });
  expect(afterPin.projects).toHaveLength(beforeTree.projects.length);
  expect(afterPin.projects.filter((entry) => entry.id !== project.id)).toEqual(
    beforeTree.projects.filter((entry) => entry.id !== project.id),
  );
  const replay = await projectRpc(host, "saveProject", [input]);
  expect(replay.status, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body).toEqual({ result: committed });
  expect(await readTree(host)).toEqual(afterPin);
  const unpin = await projectRpc(host, "saveProject", [
    {
      id: project.id,
      hostId: "local",
      expectedRevision: committed.revision,
      pinned: false,
    },
  ]);
  expect(unpin.status, JSON.stringify(unpin.body)).toBe(200);
  const unpinned = codeProjectEditorProjectSchema.parse(unpin.body.result);
  expect(unpinned).toMatchObject({
    id: project.id,
    name: project.name,
    roots: project.roots,
    revision: project.revision + 2,
    pinned: false,
  });
  const afterUnpin = await readTree(host);
  expect(afterUnpin.projects.find((entry) => entry.id === project.id)).toEqual(
    unpinned,
  );
  const oldReplay = await projectRpc(host, "saveProject", [input]);
  expect(oldReplay.status, JSON.stringify(oldReplay.body)).toBe(200);
  expect(oldReplay.body).toEqual(replay.body);
  expect(await readTree(host)).toEqual(afterUnpin);
  expect(afterUnpin.tasks).toEqual(beforeTree.tasks);
  expect(await taskScope(host)).toEqual(beforeScope);
  expect(
    protocol.conversationSnapshotSchema.parse(await host.snapshot()),
  ).toEqual(beforeSnapshot);
  expect(proxy.evidence().observerError).toBeUndefined();
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目置顶COMMIT回包丢失的真实HTTP、SSE与PostgreSQL integration",
  () => {
    it("真实COMMIT后丢失回包，原意图恢复唯一回执且取消后旧回执不覆盖当前状态", async () => {
      let proxy: Proxy | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      let host: Host | undefined;
      let model: Model | undefined;
      const failures: unknown[] = [];
      try {
        if (!proxy) throw new Error("项目置顶测试未建立独占PG故障代理。");
        model = await heldModel();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await seedTaskHistory(host, model);
        const modelRequestCountBefore = model.requests.length;
        await verifyCommittedPin(host, proxy);
        expect(model.requests).toHaveLength(modelRequestCountBefore);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => proxy?.restore(),
          () => host?.dispose(),
          () => fixture.close(),
          () => model?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "项目置顶丢包验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 90_000); // 独占真实HTTP、SSE、PG提交丢包及原Task历史的验证期限。
  },
);
