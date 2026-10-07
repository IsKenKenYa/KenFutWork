import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  type Fixture,
  type Host,
  sendToTask,
  snapshot,
  waitPhase,
} from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

function fork(
  host: Host,
  taskId: string,
  current: protocol.ConversationSnapshot,
) {
  const assistant = [...current.rows.window]
    .reverse()
    .find((row) => row.kind === "assistantText" && row.state === "complete");
  if (!assistant?.entityId) throw new Error("缺少原可定位assistant边界");
  return host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        type: "forkAssistant",
        sessionId: taskId,
        commandId: randomUUID(),
        clientId: host.clientId,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
        payload: {
          target: { rowId: assistant.rowId, entityId: assistant.entityId },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
}

function childId(response: Awaited<ReturnType<typeof fork>>) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(response.body.result);
  expect(ack.status, JSON.stringify(ack)).toBe("accepted");
  if (ack.result?.type !== "forkAssistant")
    throw new Error("原分叉ACK未返回Task身份");
  return ack.result.sessionId;
}

async function deleteParentHistory(fixture: Fixture, host: Host) {
  const binding = await fixture.app.kernel
    .get("threads")
    .resolveOwnedSessionThread(fixture.actor, host.sessionId);
  const removed = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "deleteTask",
    args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
  });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  const native = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!native) throw new Error("真实native持久化未装配");
  // 独占fixture强化独立性；公开delete仍保留CLI/native内容。
  await native.checkpointer.deleteThread(binding.threadId);
}

function historyCommand(
  host: Host,
  taskId: string,
  current: protocol.ConversationSnapshot,
  type: "retryTurn" | "editUserQuery",
  payload: unknown,
) {
  return host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        type,
        sessionId: taskId,
        commandId: randomUUID(),
        clientId: host.clientId,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
        payload,
        issuedAt: Date.now(),
      },
    },
  ]);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task继承历史独立归属 integration",
  () => {
    it("A与B间的手动压缩记录也归属子Task，父删除后重试B不被维护历史阻塞", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const settings = await host.client.request(
          "/api/instance/settings",
          {
            autoCompactEnabled: false,
            compactKeepMessages: 100,
            compactFallbackKeepMessages: 100,
          },
          "PATCH",
        );
        expect(settings.status, JSON.stringify(settings.body)).toBe(200);
        await host.command("sendText", { text: "COMPACT_PREFIX_A" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.finish(0);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        expect((await host.command("compact", {})).body.result.status).toBe(
          "accepted",
        );
        const currentHost = host;
        await vi.waitFor(
          async () => {
            const current = protocol.conversationSnapshotSchema.parse(
              await currentHost.snapshot(),
            );
            expect(current.control.phase).toBe("completedSuccess");
            expect(
              current.rows.window.filter(
                (row) => row.kind === "timelineMarker",
              ),
            ).toContainEqual(
              expect.objectContaining({
                marker: expect.objectContaining({
                  type: "compact",
                  origin: "manual",
                  status: "noop",
                }),
              }),
            );
          },
          { timeout: 30_000 },
        );
        // 保留目标高于当前历史，真实维护Run unchanged且不调用额外模型；仍有真实pre/post与marker。
        expect(model.requests).toHaveLength(1);
        await host.command("sendText", { text: "COMPACT_INHERITED_B" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        model.finish(1);
        const parent = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const child = childId(await fork(host, host.sessionId, parent));
        await deleteParentHistory(fixture, host);
        const inherited = await snapshot(fixture, child);
        const assistant = [...inherited.rows.window]
          .reverse()
          .find((row) => row.kind === "assistantText");
        if (!assistant) throw new Error("继承B缺少回复");
        const retried = await historyCommand(
          host,
          child,
          inherited,
          "retryTurn",
          { target: { rowId: assistant.rowId, entityId: assistant.entityId } },
        );
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect(retried.body.result, JSON.stringify(retried.body)).toMatchObject(
          { status: "accepted" },
        );
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        const messages = JSON.stringify(model.requests[2]?.body.messages);
        expect(messages).toContain("COMPACT_PREFIX_A");
        expect(messages).toContain("COMPACT_INHERITED_B");
        model.finish(2);
        const completed = await waitPhase(fixture, child, "completedSuccess");
        const sourceMarker = parent.rows.window.find(
          (row) => row.kind === "timelineMarker",
        );
        const childMarker = completed.rows.window.find(
          (row) => row.kind === "timelineMarker",
        );
        if (!sourceMarker || !childMarker) throw new Error("真实维护记录丢失");
        expect(childMarker.turnId).not.toBe(sourceMarker.turnId);
        expect(childMarker.marker).toEqual(sourceMarker.marker);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
    it("父删除后编辑继承B保留文件，随后重试编辑结果并从保留A分叉", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await host.command("sendText", { text: "EDIT_PREFIX_A" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.finish(0);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        await host.command("sendText", { text: "EDIT_OLD_B" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        model.finish(1);
        const parent = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const child = childId(await fork(host, host.sessionId, parent));
        await deleteParentHistory(fixture, host);
        const inherited = await snapshot(fixture, child);
        const row = [...inherited.rows.window]
          .reverse()
          .find((entry) => entry.kind === "userInput");
        if (!row) throw new Error("继承B输入缺失");
        expect(row.actions?.canEdit).toBe(true);
        const marker = join(host.workspacePath, "inherited-edit-preserve.txt");
        await writeFile(marker, "CURRENT_FILE_PRESERVED");
        const edited = await historyCommand(
          host,
          child,
          inherited,
          "editUserQuery",
          {
            target: { rowId: row.rowId, entityId: row.entityId },
            newText: "EDIT_NEW_B",
            workspaceMode: "preserve",
          },
        );
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        expect(edited.body.result, JSON.stringify(edited.body)).toMatchObject({
          status: "accepted",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        const editMessages = JSON.stringify(model.requests[2]?.body.messages);
        expect(editMessages).toContain("EDIT_PREFIX_A");
        expect(editMessages).toContain("EDIT_NEW_B");
        expect(editMessages).not.toContain("EDIT_OLD_B");
        expect(editMessages).not.toContain("正在运行 2");
        expect(await readFile(marker, "utf8")).toBe("CURRENT_FILE_PRESERVED");
        model.finish(2);
        const completed = await waitPhase(fixture, child, "completedSuccess");
        const latest = [...completed.rows.window]
          .reverse()
          .find((entry) => entry.kind === "assistantText");
        if (!latest) throw new Error("编辑后回复缺失");
        const retried = await historyCommand(
          host,
          child,
          completed,
          "retryTurn",
          { target: { rowId: latest.rowId, entityId: latest.entityId } },
        );
        expect(retried.body.result, JSON.stringify(retried.body)).toMatchObject(
          { status: "accepted" },
        );
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        const retryMessages = JSON.stringify(model.requests[3]?.body.messages);
        expect(retryMessages).toContain("EDIT_PREFIX_A");
        expect(retryMessages).toContain("EDIT_NEW_B");
        expect(retryMessages).not.toContain("EDIT_OLD_B");
        expect(retryMessages).not.toContain("正在运行 3");
        model.finish(3);
        const retriedState = await waitPhase(
          fixture,
          child,
          "completedSuccess",
        );
        const prefix = retriedState.rows.window.find(
          (entry) =>
            entry.kind === "assistantText" && entry.text === "正在运行 1",
        );
        if (!prefix) throw new Error("连续换分支后A历史丢失");
        const forked = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "forkAssistant",
              sessionId: child,
              commandId: randomUUID(),
              clientId: host.clientId,
              baseRevision: retriedState.revision,
              baseLogEpoch: retriedState.logEpoch,
              payload: {
                target: { rowId: prefix.rowId, entityId: prefix.entityId },
              },
              issuedAt: Date.now(),
            },
          },
        ]);
        const grandchild = childId(forked);
        expect(
          (await sendToTask(host, grandchild, "EDIT_DESCENDANT_INPUT")).body
            .result.status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(5), {
          timeout: 30_000,
        });
        expect(JSON.stringify(model.requests[4]?.body.messages)).toContain(
          "EDIT_PREFIX_A",
        );
        expect(JSON.stringify(model.requests[4]?.body.messages)).not.toContain(
          "EDIT_NEW_B",
        );
        model.finish(4);
        await waitPhase(fixture, grandchild, "completedSuccess");
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
    it("真实pre已落库而post写入失败时仍可重试，不把缺失post伪造为captured", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        // 仅独占临时PG边界故障，真实pre/native与业务producer仍执行。
        await fixture.database.persistence.execute(
          "create function public.reject_test_history_post() returns trigger language plpgsql as $$ begin if new.phase='post' then raise exception '测试post写失败'; end if; return new; end $$",
        );
        await fixture.database.persistence.execute(
          "create trigger reject_test_history_post before insert on public.agent_turn_boundaries for each row execute function public.reject_test_history_post()",
        );
        await host.command("sendText", { text: "PARTIAL_PRE_ORIGINAL" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.finish(0);
        const completed = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const assistant = completed.rows.window.find(
          (row) => row.kind === "assistantText",
        );
        if (!assistant) throw new Error("原回复缺失");
        const pair = await fixture.app.kernel
          .get("agentRunMetadata")
          .getOwnedTurnBoundaries(fixture.actor, {
            taskId: host.sessionId,
            runId: assistant.turnId,
          });
        expect(pair.pre?.context.status).toBe("captured");
        expect(pair.post).toBeNull();
        expect(assistant.actions?.canFork).toBeUndefined();
        await fixture.database.persistence.execute(
          "drop trigger reject_test_history_post on public.agent_turn_boundaries",
        );
        const retried = await historyCommand(
          host,
          host.sessionId,
          completed,
          "retryTurn",
          { target: { rowId: assistant.rowId, entityId: assistant.entityId } },
        );
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect(retried.body.result, JSON.stringify(retried.body)).toMatchObject(
          { status: "accepted" },
        );
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
          "PARTIAL_PRE_ORIGINAL",
        );
        expect(JSON.stringify(model.requests[1]?.body.messages)).not.toContain(
          "正在运行 1",
        );
        model.finish(1);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
    it("父删除后子Task重试继承B使用原输入，并保留A可再次分叉的归属", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await host.command("sendText", { text: "RETRY_PREFIX_A" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.finish(0);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        await host.command("sendText", { text: "RETRY_INHERITED_B" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        model.finish(1);
        const parent = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const child = childId(await fork(host, host.sessionId, parent));
        await deleteParentHistory(fixture, host);
        const inherited = await snapshot(fixture, child);
        const assistant = [...inherited.rows.window]
          .reverse()
          .find(
            (row) => row.kind === "assistantText" && row.state === "complete",
          );
        if (!assistant) throw new Error("继承B回复缺失");
        const retried = await historyCommand(
          host,
          child,
          inherited,
          "retryTurn",
          {
            target: { rowId: assistant.rowId, entityId: assistant.entityId },
          },
        );
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect(retried.body.result, JSON.stringify(retried.body)).toMatchObject(
          { status: "accepted" },
        );
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        const messages = JSON.stringify(model.requests[2]?.body.messages);
        expect(messages).toContain("RETRY_PREFIX_A");
        expect(messages).toContain("RETRY_INHERITED_B");
        expect(messages).toContain("正在运行 1");
        expect(messages).not.toContain("正在运行 2");
        model.finish(2);
        const completed = await waitPhase(fixture, child, "completedSuccess");
        const prefix = completed.rows.window.find(
          (row) => row.kind === "assistantText" && row.text === "正在运行 1",
        );
        if (!prefix) throw new Error("重试后A历史丢失");
        expect(prefix.actions).toMatchObject({ canFork: true });
        const grandchild = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "forkAssistant",
              sessionId: child,
              commandId: randomUUID(),
              clientId: host.clientId,
              baseRevision: completed.revision,
              baseLogEpoch: completed.logEpoch,
              payload: {
                target: { rowId: prefix.rowId, entityId: prefix.entityId },
              },
              issuedAt: Date.now(),
            },
          },
        ]);
        const descendant = childId(grandchild);
        expect(
          (await sendToTask(host, descendant, "RETRY_PREFIX_DESCENDANT")).body
            .result.status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        expect(JSON.stringify(model.requests[3]?.body.messages)).toContain(
          "RETRY_PREFIX_A",
        );
        expect(JSON.stringify(model.requests[3]?.body.messages)).not.toContain(
          "RETRY_INHERITED_B",
        );
        model.finish(3);
        await waitPhase(fixture, descendant, "completedSuccess");
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
    it("子Task可从继承A再分叉，孙Task真正续跑保留A工具结果且不生成伪Run", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel({
        initialTool: {
          id: "lineage-a-read",
          name: "Read",
          arguments: { file_path: "lineage-a.txt" },
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await writeFile(
          join(host.workspacePath, "lineage-a.txt"),
          "LINEAGE_A_REAL_READ",
        );
        await host.command("sendText", { text: "LINEAGE_A_ORIGINAL_INPUT" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
          "LINEAGE_A_REAL_READ",
        );
        model.finish(1);
        const completed = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const child = childId(await fork(host, host.sessionId, completed));
        const inherited = await snapshot(fixture, child);
        expect(inherited.control.activeWorks).toEqual([]);
        const header = completed.rows.window.find(
          (row) => row.kind === "turnHeader" && row.executionKind === "agent",
        );
        if (!header) throw new Error("原A缺少真实轮次身份");
        const parentBoundary = await fixture.app.kernel
          .get("agentRunMetadata")
          .getOwnedTurnBoundaries(fixture.actor, {
            taskId: host.sessionId,
            runId: header.turnId,
          });
        if (!parentBoundary.post) throw new Error("原A缺少owned post");
        const removed = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "deleteTask",
          args: [
            {
              taskId: host.sessionId,
              workspacePath: host.workspacePath,
              workspaceIdentity: JSON.stringify([
                host.projectId,
                host.workspacePath,
              ]),
            },
          ],
        });
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        expect(
          (
            await fixture.client.request(
              `/api/code-ui/sessions/${host.sessionId}`,
            )
          ).status,
        ).toBe(404);
        // 原delete仅使Task不可见；独占fixture另删父native，强证不借父历史，不升级产品删除语义。
        const native = await fixture.app.kernel
          .get("agentPersistence")
          .getPersistence();
        if (!native) throw new Error("真实native持久化未装配");
        await native.checkpointer.deleteThread(parentBoundary.post.threadId);
        expect(
          await native.checkpointer.getTuple({
            configurable: { thread_id: parentBoundary.post.threadId },
          }),
        ).toBeUndefined();
        const grandchild = childId(await fork(host, child, inherited));
        expect(grandchild).not.toBe(child);
        const inheritedGrandchild = await snapshot(fixture, grandchild);
        expect(JSON.stringify(inheritedGrandchild.rows.window)).toContain(
          "LINEAGE_A_ORIGINAL_INPUT",
        );
        const before = await fixture.database.persistence
          .forInstance(fixture.actor.instanceId)
          .query(
            "select r.id from public.agent_runs r join public.chat_sessions s on s.id=r.session_id where s.instance_id=:instance and s.id=any($1::uuid[])",
            [[child, grandchild]],
          );
        expect(before).toEqual([]);
        expect(
          (await sendToTask(host, grandchild, "LINEAGE_GRANDCHILD_REAL_INPUT"))
            .body.result.status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        const messages = JSON.stringify(model.requests[2]?.body.messages);
        expect(messages).toContain("LINEAGE_A_ORIGINAL_INPUT");
        expect(messages).toContain("LINEAGE_A_REAL_READ");
        expect(messages).toContain("LINEAGE_GRANDCHILD_REAL_INPUT");
        model.finish(2);
        await waitPhase(fixture, grandchild, "completedSuccess");
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
  },
);
