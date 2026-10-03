import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { openCodeStream, request } from "./host-client.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";

async function nextTaskChange(
  stream: Awaited<ReturnType<typeof openCodeStream>>,
  reason: string,
) {
  for (;;) {
    const event = await stream.next();
    if (
      event.event === "service" &&
      event.name === "onDynamicWorkspaceEvent" &&
      event.data?.reason === reason
    )
      return event.data;
  }
}

async function delayRunRegistration() {
  const connectionString = process.env.CODE_UI_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("延迟场景必须指定独占测试数据库");
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("begin");
  await client.query("lock table public.agent_runs in share mode");
  return {
    release: () => client.query("commit"),
    close: async () => {
      await client.query("rollback").catch(() => {});
      await client.end();
    },
  };
}

async function waitForText(
  host: Awaited<ReturnType<typeof createSession>>,
  text: string,
) {
  let snapshot: Awaited<ReturnType<typeof host.snapshot>>;
  // 测试同步期限，非运行时限额：等待真实引擎消费外部模型夹具的首个流式 token。
  await vi.waitFor(
    async () => {
      snapshot = await host.snapshot();
      expect(snapshot.control.phase, JSON.stringify(snapshot.control)).toBe(
        "running",
      );
      expect(
        snapshot.rows.window.some(
          (row: { kind: string; text?: string }) =>
            row.kind === "assistantText" && row.text === text,
        ),
      ).toBe(true);
    },
    { timeout: 30_000 },
  );
  return snapshot;
}

async function bindSession(
  stream: Awaited<ReturnType<typeof openCodeStream>>,
  workspacePath: string,
  providerId: string,
) {
  const clientId = randomUUID();
  await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: 3,
      clientId,
      appVersion: "integration",
      clientKind: "web",
    },
  ]);
  const created = await stream.rpc("sendConversationCommandV4", [
    {
      workspacePath,
      envelope: {
        commandId: randomUUID(),
        clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: workspacePath,
          config: {
            modelSelection: {
              providerId,
              modelId: "stop-model",
              options: {},
            },
          },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const sessionId = created.body.result.result.sessionId as string;
  const command = (
    type: string,
    payload: unknown,
    commandId: string = randomUUID(),
  ) =>
    stream.rpc("sendConversationCommandV4", [
      {
        workspacePath,
        envelope: {
          commandId,
          clientId,
          sessionId,
          type,
          payload,
          issuedAt: Date.now(),
        },
      },
    ]);
  const snapshot = async () => {
    const result = await request(`/api/code-ui/sessions/${sessionId}`);
    expect(result.status).toBe(200);
    return result.body.snapshot;
  };
  return { command, snapshot, sessionId };
}

async function createSession(baseUrl: string) {
  const dir = await mkdtemp(join(tmpdir(), "code-ui-stop-"));
  const streams: AbortController[] = [];
  let projectId = "";
  let providerId = "";
  const dispose = async () => {
    for (const stream of streams) stream.abort();
    if (providerId)
      await request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method: "deletePersonalProvider",
        args: [providerId],
      });
    if (projectId)
      await request(`/api/projects/${projectId}`, undefined, "DELETE");
    await rm(dir, { recursive: true, force: true });
  };
  try {
    expect((await request("/api/viewer")).status).toBe(200);
    const opened = await request("/api/code-ui/rpc", {
      service: "workspace",
      method: "open",
      args: [{ path: dir }],
    });
    expect(opened.status).toBe(200);
    projectId = opened.body.result.projectId;
    const workspacePath = opened.body.result.path;
    const provider = (method: string, args: unknown[]) =>
      request("/api/code-ui/rpc", {
        service: "providerSettingsService",
        method,
        args,
      });
    const added = await provider("createPersonalProvider", [
      { providerName: "停止公开接口验收" },
    ]);
    providerId = added.body.result.providerId;
    await provider("savePersonalProviderOverlay", [
      providerId,
      {
        api: { type: "openai-chat-completions", baseUrl },
        access: { type: "api-key", apiKey: "integration-only-not-a-key" },
      },
    ]);
    await provider("addPersonalModel", [providerId, "stop-model", {}]);
    const stream = await openCodeStream(streams);
    const bound = await bindSession(stream, workspacePath, providerId);
    return { ...bound, stream, workspacePath, projectId, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function disposeModelRun(
  host: Awaited<ReturnType<typeof createSession>>,
  model: Awaited<ReturnType<typeof heldModel>>,
) {
  try {
    const current = await host.snapshot();
    for (const row of current.rows.window)
      if (row.kind === "turnHeader")
        await request(`/api/agent/runs/${row.turnId}/cancel`, {});
  } finally {
    await model.close();
    await host.dispose();
  }
}

async function assertStaleStopsKeepRunning(
  host: Awaited<ReturnType<typeof createSession>>,
  firstRunId: string,
  stopId: string,
) {
  const duplicate = await host.command(
    "stop",
    { expectedForegroundExecutionId: firstRunId },
    stopId,
  );
  expect(duplicate.body.result.status).toBe("duplicate");
  const late = await host.command("stop", {
    expectedForegroundExecutionId: firstRunId,
  });
  expect(late.body.result).toMatchObject({
    status: "noop",
    reasonCode: "guard.stopTargetChanged",
  });
  expect((await host.snapshot()).control).toMatchObject({
    phase: "running",
    canStop: true,
  });
}

describe.skipIf(!enabled)("原停止命令公开宿主 integration", () => {
  it.skipIf(!process.env.CODE_UI_TEST_DATABASE_URL)(
    "停止事务等待期间项目归档，迟到命令返回 404 且不保存 accepted 回执",
    async () => {
      const host = await createSession("https://example.invalid/v1");
      const delay = new Client({
        connectionString: process.env.CODE_UI_TEST_DATABASE_URL,
      });
      let stop: ReturnType<typeof host.command> | undefined;
      try {
        await delay.connect();
        await delay.query("begin");
        await delay.query(
          "select id from public.code_ui_sessions where id=$1 for update",
          [host.sessionId],
        );
        const commandId = randomUUID();
        stop = host.command("stop", {}, commandId);
        // 外部数据库故障同步点，不用于验证业务数据；确保请求已读完归属且在等根锁。
        await vi.waitFor(async () => {
          const blocked = await delay.query(
            "select 1 from pg_locks where granted=false and locktype='transactionid' and transactionid=pg_current_xact_id()::text::xid",
          );
          if (!blocked.rows.length) throw new Error("等待停止事务到达延迟点");
        });
        expect(
          (
            await request(
              `/api/projects/${host.projectId}`,
              undefined,
              "DELETE",
            )
          ).status,
        ).toBe(204);
        await delay.query("commit");
        const late = await stop;
        expect(late.status, JSON.stringify(late.body)).toBe(404);
        expect((await host.command("stop", {})).status).toBe(404);
        const queried = await host.stream.rpc("queryConversationCommandsV4", [
          {
            workspacePath: host.workspacePath,
            commands: [{ sessionId: host.sessionId, commandId }],
          },
        ]);
        expect(queried.body.result.results[0].result).toBe("unknown");
      } finally {
        await delay.query("rollback").catch(() => {});
        await delay.end();
        await stop;
        await host.dispose();
      }
    },
  );
  it.skipIf(!process.env.CODE_UI_TEST_DATABASE_URL)(
    "已获发送 ACK 但引擎尚未启动时停止，解除数据库延迟后不会重新执行模型",
    async () => {
      const model = await heldModel();
      const host = await createSession(model.baseUrl);
      const delay = await delayRunRegistration();
      try {
        // 独占测试库的外部故障注入：延迟运行登记；断言仍只走公开 HTTP 与模型边界。
        const sent = await host.command("sendText", {
          text: "延迟启动的测试消息。",
        });
        expect(sent.status, JSON.stringify(sent.body)).toBe(200);
        const running = await host.snapshot();
        expect(running.control.phase).toBe("running");
        const runId = running.control.activeWorks[0].foregroundExecutionId;
        await nextTaskChange(host.stream, "user_message_saved");
        const stopped = await host.command("stop", {
          expectedForegroundExecutionId: runId,
        });
        expect(stopped.body.result.status).toBe("accepted");
        expect((await host.snapshot()).control.phase).toBe(
          "completedInterrupted",
        );
        await nextTaskChange(host.stream, "task_status_changed");
        await delay.release();
        await Promise.race([
          nextTaskChange(host.stream, "task_status_changed"),
          model.firstRequest.then(() => {
            throw new Error("已停止运行仍启动了模型");
          }),
        ]);
        expect(model.requests).toEqual([]);
      } finally {
        await delay.close();
        await disposeModelRun(host, model);
      }
    },
  );
  it.skipIf(!process.env.CODE_UI_TEST_DATABASE_URL)(
    "前一轮取消事件迟到到达已获 ACK 的下一轮，不改变新运行身份",
    async () => {
      const model = await heldModel();
      const host = await createSession(model.baseUrl);
      let delay: Awaited<ReturnType<typeof delayRunRegistration>> | undefined;
      try {
        await host.command("sendText", { text: "第一轮等待停止。" });
        const first = await waitForText(host, "正在运行 1");
        await nextTaskChange(host.stream, "user_message_saved");
        delay = await delayRunRegistration();
        const stopped = await host.command("stop", {
          expectedForegroundExecutionId:
            first.control.activeWorks[0].foregroundExecutionId,
        });
        expect(stopped.body.result.status).toBe("accepted");
        await nextTaskChange(host.stream, "task_status_changed");
        await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
        await host.command("sendText", {
          text: "第二轮在前一轮结算迟到前创建。",
        });
        const second = await host.snapshot();
        expect(second.control.phase).toBe("running");
        const runId = second.control.activeWorks[0].foregroundExecutionId;
        await nextTaskChange(host.stream, "user_message_saved");
        await delay.release();
        const running = await waitForText(host, "正在运行 2");
        expect(running.control.activeWorks[0].foregroundExecutionId).toBe(
          runId,
        );
        const final = await host.command("stop", {
          expectedForegroundExecutionId: runId,
        });
        expect(final.body.result.status).toBe("accepted");
        await vi.waitFor(() =>
          expect(model.requests.map((request) => request.closed)).toEqual([
            true,
            true,
          ]),
        );
      } finally {
        await delay?.close();
        await disposeModelRun(host, model);
      }
    },
  );
  it("原 stop 真正取消流式引擎，并发/重放幂等，迟到停止不误杀下一轮", async () => {
    const model = await heldModel();
    const host = await createSession(model.baseUrl);
    try {
      expect(
        (
          await host.command("sendText", {
            text: "只输出文字，持续保持当前流。",
          })
        ).status,
      ).toBe(200);
      const running = await waitForText(host, "正在运行 1");
      const firstRunId = running.control.activeWorks[0].foregroundExecutionId;
      const stopId = randomUUID();
      const stopped = await Promise.all([
        host.command(
          "stop",
          { expectedForegroundExecutionId: firstRunId },
          stopId,
        ),
        host.command(
          "stop",
          { expectedForegroundExecutionId: firstRunId },
          stopId,
        ),
      ]);
      expect(stopped.map((response) => response.status)).toEqual([200, 200]);
      expect(
        stopped.map((response) => response.body.result.status).sort(),
      ).toEqual(["accepted", "duplicate"]);
      expect((await host.snapshot()).control).toMatchObject({
        phase: "completedInterrupted",
        canStop: false,
        sessionEnded: true,
      });
      expect(
        (await host.command("sendText", { text: "第二轮继续只输出文字。" }))
          .status,
      ).toBe(200);
      const second = await waitForText(host, "正在运行 2");
      const secondRunId = second.control.activeWorks[0].foregroundExecutionId;
      expect(secondRunId).not.toBe(firstRunId);
      await assertStaleStopsKeepRunning(host, firstRunId, stopId);
      expect(model.requests[1]?.closed).toBe(false);
      const final = await host.command("stop", {
        expectedForegroundExecutionId: secondRunId,
      });
      expect(final.body.result.status).toBe("accepted");
      await vi.waitFor(() =>
        expect(model.requests.map((request) => request.closed)).toEqual([
          true,
          true,
        ]),
      );
      const ended = await host.snapshot();
      expect(ended.control.phase).toBe("completedInterrupted");
      expect(
        ended.rows.window
          .filter((row: { kind: string }) => row.kind === "assistantText")
          .map((row: { state: string; text: string }) => ({
            state: row.state,
            text: row.text,
          })),
      ).toEqual([
        { state: "interrupted", text: "正在运行 1" },
        { state: "interrupted", text: "正在运行 2" },
      ]);
      expect(model.requests).toHaveLength(2);
    } finally {
      await disposeModelRun(host, model);
    }
  }, 90_000); // 真实数据库与外部模型替身的测试期限，非 Agent 运行限额。
  it("停止精确校验前台身份，空闲目标变化返回原 noop，重复命令对账和刷新保持同一结果", async () => {
    const host = await createSession("https://example.invalid/v1");
    try {
      const before = await host.snapshot();
      const commandId = randomUUID();
      const stale = await host.command(
        "stop",
        { expectedForegroundExecutionId: "ended-run" },
        commandId,
      );
      expect(stale.status, JSON.stringify(stale.body)).toBe(200);
      expect(stale.body.result).toMatchObject({
        commandId,
        status: "noop",
        reasonCode: "guard.stopTargetChanged",
        revisionAtDecision: before.revision,
      });
      const duplicate = await host.command(
        "stop",
        { expectedForegroundExecutionId: "ended-run" },
        commandId,
      );
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.result).toMatchObject({
        status: "duplicate",
        reasonCode: "guard.stopTargetChanged",
      });
      const idle = await host.command("stop", {});
      expect(idle.status).toBe(200);
      expect(idle.body.result.status).toBe("accepted");
      expect(await host.snapshot()).toEqual(before);
      const queried = await host.stream.rpc("queryConversationCommandsV4", [
        {
          workspacePath: host.workspacePath,
          commands: [{ sessionId: host.sessionId, commandId }],
        },
      ]);
      expect(queried.body.result.results[0].result).toEqual(stale.body.result);
    } finally {
      await host.dispose();
    }
  });
});
