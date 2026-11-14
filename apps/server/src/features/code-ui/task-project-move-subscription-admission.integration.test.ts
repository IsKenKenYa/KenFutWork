import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  codeProjectTreeSchema,
  codeTaskProjectMoveInputSchema,
  codeTaskScopeResponseSchema,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;

async function readState(host: Host) {
  const scope = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(scope.status, JSON.stringify(scope.body)).toBe(200);
  return {
    scope: codeTaskScopeResponseSchema.parse(scope.body).scope,
    snapshot: protocol.conversationSnapshotSchema.parse(await host.snapshot()),
  };
}

async function seedHistory(host: Host, model: Model) {
  const text = "订阅接纳期间项目往返仍保留的任务历史";
  const sent = await host.command("sendText", { text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await model.firstRequest;
  model.finish(0);
  await vi.waitFor(
    async () => {
      const current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(current.control.phase).toBe("completedSuccess");
      expect(current.control.activeWorks).toEqual([]);
      const input = current.rows.window.find((row) => row.kind === "userInput");
      expect(input).toMatchObject({ text, actions: { canEdit: true } });
      const reply = [...current.rows.window]
        .reverse()
        .find((row) => row.kind === "assistantText");
      expect(reply?.actions).toMatchObject({ canRetry: true, canFork: true });
    },
    { timeout: 30_000 },
  ); // 仅等待本例真实模型HTTP及持久轮次边界完成。
  expect(model.requests).toHaveLength(1);
}

async function createTarget(fixture: Fixture, host: Host) {
  const root = join(fixture.directory, "订阅接纳往返目标目录");
  await mkdir(root);
  const response = await host.client.request("/api/projects", {
    name: "订阅接纳往返目标项目",
    kind: "code",
    work_dir: root,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return projectCreateResponseSchema.parse(response.body).project.id;
}

async function holdBoundaryReads(fixture: Fixture) {
  const blocker = new Client({
    connectionString: fixture.database.connectionString,
  });
  await blocker.connect();
  let held = false;
  try {
    await blocker.query("begin");
    held = true;
    await blocker.query(
      "lock table public.agent_turn_boundaries in access exclusive mode",
    );
    const result = await blocker.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    const pid = result.rows[0]?.pid;
    if (pid === undefined) throw new Error("边界表锁连接缺少进程身份。");
    const release = async () => {
      if (!held) return;
      await blocker.query("rollback");
      held = false;
    };
    return {
      release,
      async waitBlocked() {
        await expect
          .poll(async () => {
            await blocker.query("select pg_stat_clear_snapshot()");
            const waiting = await blocker.query(
              `select pid from pg_stat_activity
                where datname=current_database() and pid<>pg_backend_pid()
                  and state='active' and wait_event_type='Lock'
                  and query like '%from public.agent_turn_boundaries b%'
                  and $1=any(pg_blocking_pids(pid))`,
              [pid],
            );
            return waiting.rows.length;
          })
          .toBe(1);
      },
      async close() {
        try {
          await release();
        } finally {
          await blocker.end();
        }
      },
    };
  } catch (error) {
    try {
      if (held) await blocker.query("rollback");
    } finally {
      await blocker.end();
    }
    throw error;
  }
}

function subscribe(host: Host) {
  return host.stream.rpc("subscribeConversationV4", [
    {
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
      projectId: host.projectId,
      sessionId: host.sessionId,
    },
  ]);
}

async function moveUsingProjectTree(host: Host, targetProjectId: string) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const task = codeProjectTreeSchema
    .parse(response.body.result)
    .tasks.find((entry) => entry.taskId === host.sessionId);
  if (!task) throw new Error("项目树缺少真实Task观察值。");
  const control = protocol.conversationTaskControlSchema.parse(
    task.taskControl,
  );
  const input = codeTaskProjectMoveInputSchema.parse({
    task: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
    },
    sourceProjectId: control.projectId,
    projectId: targetProjectId,
    observedRevision: task.conversationRevision,
    addMissingRoot: true,
  });
  const moved = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body).toEqual({ result: null });
}

async function readOwnedSnapshot(
  host: Host,
  assembler: protocol.TopicWireFrameAssembler<protocol.ConversationTopicFrame>,
  subscriptionId: string,
  deliveryKind: "initial" | "recovery",
) {
  for (;;) {
    const event = await host.stream.next();
    if (event.event !== "onDynamicConversationFrame") continue;
    const wire = protocol.topicWireFrameCandidateSchema.parse(event.frame);
    expect(wire.subscriptionId).toBe(subscriptionId);
    expect(wire.topic).toBe(protocol.conversationTopic(host.sessionId));
    expect(event.workspacePath).toBe(host.workspacePath);
    expect(event.workspaceIdentity).toBe(
      JSON.stringify([host.projectId, host.workspacePath]),
    );
    for (const result of assembler.accept(wire)) {
      if (result.kind === "fault")
        throw new Error(`订阅接纳帧无法解析：${result.fault.reasonCode}`);
      if (result.deliveryKind !== deliveryKind) continue;
      if (result.frame.payload.kind !== "snapshot")
        throw new Error("原会话订阅未返回完整快照。");
      return result.frame.payload.snapshot;
    }
  }
}

async function verifyFreshSubscription(
  host: Host,
  expected: protocol.ConversationSnapshot,
) {
  const response = await subscribe(host);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const { ack } = protocol.v4ConversationSubscribeResultSchema.parse(
    response.body.result,
  );
  const assembler = new protocol.TopicWireFrameAssembler(
    protocol.conversationTopicFrameSchema,
  );
  expect(
    await readOwnedSnapshot(host, assembler, ack.subscriptionId, "initial"),
  ).toEqual(expected);
  const resynced = await host.stream.rpc("resyncConversationV4", [
    protocol.conversationResyncParamsSchema.parse({
      subscriptionId: ack.subscriptionId,
      base: null,
      forceSnapshot: true,
    }),
  ]);
  expect(resynced.status, JSON.stringify(resynced.body)).toBe(200);
  expect(
    protocol.v4ConversationResyncResultSchema.parse(resynced.body.result).ack,
  ).toEqual({
    subscriptionId: ack.subscriptionId,
    mode: "snapshot",
    logEpoch: expected.logEpoch,
  });
  expect(
    await readOwnedSnapshot(host, assembler, ack.subscriptionId, "recovery"),
  ).toEqual(expected);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "项目移动期间订阅接纳的真实HTTP、SSE与PostgreSQL integration",
  () => {
    it("旧初始读取跨越项目往返后拒绝接纳，新A订阅和恢复保留正文与Task权限", async () => {
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      let model: Model | undefined;
      let blocker: Awaited<ReturnType<typeof holdBoundaryReads>> | undefined;
      let pending: ReturnType<typeof subscribe> | undefined;
      const failures: unknown[] = [];
      try {
        fixture = await createCodeUiHttpFixture();
        model = await heldModel();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await seedHistory(host, model);
        const targetProjectId = await createTarget(fixture, host);
        const before = await readState(host);
        const initialControl = protocol.conversationTaskControlSchema.parse(
          before.snapshot.taskControl,
        );
        blocker = await holdBoundaryReads(fixture);
        pending = subscribe(host);
        await blocker.waitBlocked();
        await moveUsingProjectTree(host, targetProjectId);
        await moveUsingProjectTree(host, host.projectId);
        await blocker.release();
        const rejected = await pending;
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
        expect(
          applicationErrorResponseSchema.parse(rejected.body).error.code,
        ).toBe("code_ui_command_conflict");
        const after = await readState(host);
        expect(after.scope).toEqual({
          ...before.scope,
          generation: before.scope.generation + 2,
        });
        expect(after.snapshot.taskControl).toEqual({
          projectId: host.projectId,
          branchGeneration: initialControl.branchGeneration + 2,
        });
        expect(after.snapshot.rows.window).toEqual(before.snapshot.rows.window);
        expect(after.snapshot.goal).toEqual(before.snapshot.goal);
        expect(after.snapshot.control).toEqual(before.snapshot.control);
        await verifyFreshSubscription(host, after.snapshot);
        expect(await readState(host)).toEqual(after);
        expect(model.requests).toHaveLength(1);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => blocker?.release(),
          () => pending?.then(() => undefined),
          () => blocker?.close(),
          () => host?.dispose(),
          () => fixture?.close(),
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
        throw new AggregateError(failures, "订阅接纳验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 60_000); // 独占真实HTTP、SSE、PG表锁及受控模型HTTP的验证期限。
  },
);
