import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  codeTaskGroupSchema,
  codeTaskGroupStructureSchema,
  codeUiRpcResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const http = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

function rpc(method: string, args: unknown[] = []) {
  return http.request("/api/code-ui/rpc", {
    service: "task-groups",
    method,
    args,
  });
}

async function read() {
  const response = await rpc("read");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupStructureSchema.parse(response.body.result);
}

function taskReference(
  host: Awaited<ReturnType<typeof createCodeSessionFixture>>,
) {
  return {
    hostId: "local",
    taskId: host.sessionId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
  };
}

async function createGroup(title: string) {
  const response = await rpc("save", [
    {
      creationId: randomUUID(),
      expectedRevision: (await read()).revision,
      title,
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupSchema.parse(response.body.result);
}

async function acceptFirstInput(
  host: Host,
  model: Awaited<ReturnType<typeof heldModel>>,
) {
  const sent = await host.command("sendText", { text: "创建归属的原始首发" });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const first = protocol.commandAckSchema.parse(sent.body.result);
  expect(first.status).toBe("accepted");
  expect(first.result).toMatchObject({
    type: "inputAccepted",
    inputId: first.commandId,
  });
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  });
  const stopped = await host.command("stop", {});
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  const stop = protocol.commandAckSchema.parse(stopped.body.result);
  expect(stop.status).toBe("accepted");
  await vi.waitFor(
    async () => {
      const snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(snapshot.control.phase).toBe("completedInterrupted");
      expect(model.requests[0]?.closed).toBe(true);
    },
    { timeout: 30_000 },
  ); // 仅等待本例实际HTTP流及停止完成。
  return { firstId: first.commandId, stopId: stop.commandId };
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原首次Task登记的真实HTTP与PostgreSQL integration",
  () => {
    it("只登记真实Task一次，重复和并发登记保持根顺序、快照、目录及权限", async () => {
      const model = await heldModel();
      let host:
        | Awaited<ReturnType<typeof createCodeSessionFixture>>
        | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, { client: http });
        const task = taskReference(host);
        const snapshot = await host.snapshot();
        const scope = await http.request(
          `/api/code-ui/tasks/${task.taskId}/scope`,
        );
        expect(scope.status, JSON.stringify(scope.body)).toBe(200);
        expect(await read()).toEqual({
          revision: 0,
          groups: [],
          members: [],
          order: [],
        });
        const admitted = await rpc("admit", [{ tasks: [task] }]);
        expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
        expect(codeUiRpcResponseSchema.parse(admitted.body)).toEqual({
          result: null,
        });
        const after = await read();
        expect(after).toEqual({
          revision: 1,
          groups: [],
          members: [],
          order: [
            {
              type: "task",
              key: JSON.stringify([task.workspaceIdentity, task.taskId]),
              sortOrder: 0,
            },
          ],
        });
        for (const response of await Promise.all([
          rpc("admit", [{ tasks: [task] }]),
          rpc("admit", [{ tasks: [task, task] }]),
          rpc("admit", [{ tasks: [] }]),
        ])) {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(codeUiRpcResponseSchema.parse(response.body)).toEqual({
            result: null,
          });
        }
        expect(await read()).toEqual(after);
        expect(await host.snapshot()).toEqual(snapshot);
        expect(
          await http.request(`/api/code-ui/tasks/${task.taskId}/scope`),
        ).toEqual(scope);
        expect(model.requests).toHaveLength(0);
      } finally {
        await host?.dispose();
        await model.close();
      }
    }, 90_000); // 独占HTTP、SSE、真实Task与临时PG的登记和资源关闭期限。

    it("新Task的创建归属只接纳一次，取消组后重放保留人工整理且同键改组返回409", async () => {
      const model = await heldModel();
      let host:
        | Awaited<ReturnType<typeof createCodeSessionFixture>>
        | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, { client: http });
        const task = taskReference(host);
        const created = await rpc("save", [
          {
            creationId: randomUUID(),
            expectedRevision: 0,
            title: "创建时选择的分组",
          },
        ]);
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const group = codeTaskGroupSchema.parse(created.body.result);
        const intent = {
          tasks: [task],
          placement: { task, groupId: group.id, creationId: task.taskId },
        };
        const placed = await rpc("admit", [intent]);
        expect(placed.status, JSON.stringify(placed.body)).toBe(200);
        expect(codeUiRpcResponseSchema.parse(placed.body)).toEqual({
          result: null,
        });
        const grouped = await read();
        expect(grouped).toEqual({
          revision: 2,
          groups: [group],
          members: [
            {
              groupId: group.id,
              workspaceKey: task.workspaceIdentity,
              taskId: task.taskId,
              sortOrder: 0,
            },
          ],
          order: [{ type: "group", key: group.id, sortOrder: 0 }],
        });
        for (const response of await Promise.all([
          rpc("admit", [intent]),
          rpc("admit", [intent]),
        ]))
          expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(await read()).toEqual(grouped);
        const canceled = await rpc("ungroup", [
          { id: group.id, expectedRevision: 2 },
        ]);
        expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
        const afterCancel = await read();
        expect(afterCancel).toEqual({
          revision: 3,
          groups: [],
          members: [],
          order: [
            {
              type: "task",
              key: JSON.stringify([task.workspaceIdentity, task.taskId]),
              sortOrder: 0,
            },
          ],
        });
        const repeated = await rpc("admit", [intent]);
        expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
        const conflict = await rpc("admit", [
          { ...intent, placement: { ...intent.placement, groupId: null } },
        ]);
        expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
        expect(
          applicationErrorResponseSchema.parse(conflict.body).error.code,
        ).toBe("task_group_revision_conflict");
        expect(await read()).toEqual(afterCancel);
        expect(model.requests).toHaveLength(0);
      } finally {
        await host?.dispose();
        await model.close();
      }
    }, 90_000);

    it("首发命令和TaskId为同一创建别名，已接纳的Stop不能提供创建证明", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, { client: http });
        const { firstId, stopId } = await acceptFirstInput(host, model);
        const task = taskReference(host);
        const snapshot = await host.snapshot();
        const scope = await http.request(
          `/api/code-ui/tasks/${task.taskId}/scope`,
        );
        const group = await createGroup("真实首发创建的分组");
        const intent = {
          tasks: [task],
          placement: { task, groupId: group.id, creationId: firstId },
        };
        const before = await read();
        const rejected = await rpc("admit", [
          { ...intent, placement: { ...intent.placement, creationId: stopId } },
        ]);
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
        expect(
          applicationErrorResponseSchema.parse(rejected.body).error.code,
        ).toBe("task_group_revision_conflict");
        expect(await read()).toEqual(before);
        const admitted = await rpc("admit", [intent]);
        expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
        expect(codeUiRpcResponseSchema.parse(admitted.body)).toEqual({
          result: null,
        });
        const grouped = await read();
        expect(grouped).toEqual({
          revision: 2,
          groups: [group],
          members: [
            {
              groupId: group.id,
              workspaceKey: task.workspaceIdentity,
              taskId: task.taskId,
              sortOrder: 0,
            },
          ],
          order: [{ type: "group", key: group.id, sortOrder: 0 }],
        });
        for (const alias of [
          task.taskId,
          firstId.toUpperCase(),
          task.taskId.toUpperCase(),
        ]) {
          const replay = await rpc("admit", [
            {
              ...intent,
              placement: { ...intent.placement, creationId: alias },
            },
          ]);
          expect(replay.status, JSON.stringify(replay.body)).toBe(200);
          expect(await read()).toEqual(grouped);
        }
        expect(await host.snapshot()).toEqual(snapshot);
        expect(
          await http.request(`/api/code-ui/tasks/${task.taskId}/scope`),
        ).toEqual(scope);
        expect(model.requests).toHaveLength(1);
      } finally {
        await host?.dispose();
        await model.close();
      }
    }, 90_000); // 真实首发、停止、创建别名和权限保持的独占集成期限。
  },
);
