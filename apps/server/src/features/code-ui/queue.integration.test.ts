import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { attachmentChecksum } from "./attachments/bytes.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

async function uploadAttachment(host: Host, fileName: string) {
  const content = Buffer.from(fileName);
  const identity = { sessionId: host.sessionId, uploadId: randomUUID() };
  const mime = "text/plain";
  const opened = await host.stream.rpc("attachmentBeginV4", [
    {
      ...identity,
      fileName,
      mime,
      totalBytes: content.length,
      totalChunks: 1,
      checksum: attachmentChecksum(content),
    },
  ]);
  expect(opened.status).toBe(200);
  const chunk = await host.stream.rpc("attachmentChunkV4", [
    {
      ...identity,
      chunkIndex: 0,
      dataBase64: content.toString("base64"),
    },
  ]);
  expect(chunk.status).toBe(200);
  const committed = await host.stream.rpc("attachmentCommitV4", [identity]);
  expect(committed.status).toBe(200);
  return {
    fileName,
    mime,
    bytes: content.length,
    ref: protocol.v4AttachmentCommitResultSchema.parse(committed.body.result)
      .ref,
  };
}

async function waitForRunning(host: Host, text: string) {
  // 仅测试同步期限：等待真实模型流和公开转录，不是产品超时配置。
  await vi.waitFor(
    async () => {
      const snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(snapshot.control.phase).toBe("running");
      expect(
        snapshot.rows.window.filter((row) => row.kind === "assistantText"),
      ).toContainEqual(expect.objectContaining({ text }));
    },
    { timeout: 30_000 },
  );
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

async function queueCommand(
  host: Host,
  type: protocol.CommandType,
  payload: unknown,
  snapshot: protocol.ConversationSnapshot,
  commandId = randomUUID(),
) {
  const clientId = snapshot.queue.items[0]?.clientId;
  if (!clientId) throw new Error("队列验收必须沿用已接入输入的原clientId");
  const result = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        commandId,
        clientId,
        sessionId: host.sessionId,
        type,
        payload,
        issuedAt: Date.now(),
        baseRevision: snapshot.revision,
        baseLogEpoch: snapshot.logEpoch,
      },
    },
  ]);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return protocol.commandAckSchema.parse(result.body.result);
}

// 真实HTTP/SSE、原V4命令、独占PG和真实Harness；仅外部模型保留确定性的流。
describe.skipIf(!enabled)("原队列公开宿主 integration", () => {
  it.each(["自动派发", "立即发送"])(
    "%s遇到无法读取的附件时结束该轮并保留后续队列",
    async (delivery) => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        const task = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        host = task;
        await task.command("sendText", { text: "保持会话有正在运行的输入" });
        await waitForRunning(task, "正在运行 1");
        const attachment = await uploadAttachment(task, "queue-attachment.txt");
        await task.command("sendText", {
          text: "带附件",
          attachments: [attachment],
        });
        await task.command("sendText", { text: "附件失败后仍留在队列" });
        const row = await fixture.database.persistence.queryOne<{
          object_path: string;
        }>(
          `select record->>'objectPath' as object_path from public.code_attachments
            where task_id = $1 and status = 'committed' and record->>'ref' = $2`,
          [task.sessionId, attachment.ref],
        );
        if (!row?.object_path) throw new Error("测试附件没有已提交的存储对象");
        await unlink(
          join(fixture.directory, "blobs", "code-attachments", row.object_path),
        );
        const snapshot = async () =>
          protocol.conversationSnapshotSchema.parse(await task.snapshot());
        const before = await snapshot();
        const [missing, next] = before.queue.items;
        if (!missing || !next) throw new Error("未生成两个待发送的输入");

        if (delivery === "立即发送") {
          expect(
            await queueCommand(
              task,
              "sendQueuedNow",
              { queueItemId: missing.queueItemId },
              before,
            ),
          ).toMatchObject({ status: "accepted" });
        } else {
          model.finish(0);
        }
        await vi.waitFor(
          async () => expect((await snapshot()).control.phase).toBe("error"),
          { timeout: 15_000 },
        );
        const failed = await snapshot();
        expect(failed.control.lastError?.message).toBe(
          "无法读取排队消息的附件，请重新添加附件后发送。",
        );
        expect(failed.control.canStop).toBe(false);
        expect(failed.queue.autoDrain).toBe(false);
        expect(
          failed.queue.items.map(({ queueItemId }) => queueItemId),
        ).toEqual([next.queueItemId]);
        expect(model.requests).toHaveLength(1);

        expect(
          await queueCommand(
            task,
            "sendQueuedNow",
            { queueItemId: next.queueItemId },
            failed,
          ),
        ).toMatchObject({ status: "accepted" });
        await waitForRunning(task, "正在运行 2");
        model.finish(1);
        await vi.waitFor(async () =>
          expect((await snapshot()).control.phase).toBe("completedSuccess"),
        );
      } finally {
        await host?.dispose();
        await model.close();
        await fixture.close();
      }
    },
    120_000,
  );

  it("编辑冻结队首且不改输入身份，过期解除不能释放新锁", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Host | undefined;
    try {
      const currentHost = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      host = currentHost;
      const snapshot = async () =>
        protocol.conversationSnapshotSchema.parse(await currentHost.snapshot());
      await host.command("sendText", { text: "前台轮次" });
      await waitForRunning(host, "正在运行 1");
      const previousAttachment = await uploadAttachment(
        host,
        "before-edit.txt",
      );
      await host.command("sendText", {
        text: "需要编辑的原文",
        attachments: [previousAttachment],
      });
      const queued = await snapshot();
      const item = queued.queue.items[0];
      if (!item) throw new Error("未形成真实的排队输入");
      const firstEditor = {
        queueItemId: item.queueItemId,
        editorId: randomUUID(),
      };
      const nextEditor = { ...firstEditor, editorId: randomUUID() };
      const command = async (type: string, payload: unknown, id?: string) => {
        const result = await currentHost.command(type, payload, id);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return protocol.commandAckSchema.parse(result.body.result);
      };
      const contenders = await Promise.all([
        command("lockQueueItemEdit", firstEditor),
        command("lockQueueItemEdit", nextEditor),
      ]);
      expect(contenders.map((ack) => ack.status).sort()).toEqual([
        "accepted",
        "rejected",
      ]);
      const [owner, challenger] =
        contenders[0]?.status === "accepted"
          ? [firstEditor, nextEditor]
          : [nextEditor, firstEditor];
      expect((await snapshot()).queue.items[0]).toMatchObject({
        queueItemId: item.queueItemId,
        editLock: { editorId: owner.editorId },
      });
      expect(await command("releaseQueueItemEdit", owner)).toMatchObject({
        status: "accepted",
      });
      expect(await command("releaseQueueItemEdit", owner)).toMatchObject({
        status: "noop",
      });
      expect(await command("lockQueueItemEdit", challenger)).toMatchObject({
        status: "accepted",
      });
      expect(
        await queueCommand(
          host,
          "sendQueuedNow",
          { queueItemId: item.queueItemId },
          await snapshot(),
        ),
      ).toMatchObject({
        status: "rejected",
        reasonCode: "guard.queueItemEditLocked",
      });
      model.finish(0);
      await vi.waitFor(async () =>
        expect((await snapshot()).control.phase).toBe("completedSuccess"),
      );
      expect((await snapshot()).inputRouting.mode).toBe("enqueue");
      expect(await command("sendText", { text: "应排到后面" })).toMatchObject({
        result: { delivery: "queue" },
      });
      expect(model.requests).toHaveLength(1);
      expect(await command("releaseQueueItemEdit", owner)).toMatchObject({
        status: "rejected",
        reasonCode: "guard.queueEditLockLost",
      });
      expect(
        await command("editQueueItem", {
          ...owner,
          newText: "不能被写入",
        }),
      ).toMatchObject({
        status: "rejected",
        reasonCode: "guard.queueEditLockLost",
      });
      const edit = {
        ...challenger,
        newText: "保留身份的新版文字",
        planEnabled: true,
        attachments: [await uploadAttachment(host, "after-edit.txt")],
      };
      const editCommand = randomUUID();
      expect(await command("editQueueItem", edit, editCommand)).toMatchObject({
        status: "accepted",
      });
      expect(await command("editQueueItem", edit, editCommand)).toMatchObject({
        status: "duplicate",
      });
      const conflict = await host.command(
        "editQueueItem",
        { ...edit, newText: "同键不同正文" },
        editCommand,
      );
      expect(conflict.status).toBe(409);
      const running = await waitForRunning(host, "正在运行 2");
      expect(
        running.rows.window.filter((row) => row.kind === "userInput").at(-1),
      ).toMatchObject({
        text: edit.newText,
        sourceCommandId: item.sourceCommandId,
        attachments: edit.attachments,
      });
      expect(running.config.planEnabled).toBe(true);
      expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
        "after-edit.txt",
      );
      expect(JSON.stringify(model.requests[1]?.body.messages)).not.toContain(
        "before-edit.txt",
      );
      expect(running.queue.items.map((entry) => entry.text)).toEqual([
        "应排到后面",
      ]);
    } finally {
      if (host) {
        const current = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        if (current.control.canStop) await host.command("stop", {});
        await host.dispose();
      }
      await model.close();
      await fixture.close();
    }
  }, 90_000);

  it("排队撤回、重排与指定立即发送保留输入身份，停止后队列可恢复且迟到重放不能再次抢占", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Host | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const first = await host.command("sendText", { text: "真实前台第一轮" });
      expect(first.body.result.status).toBe("accepted");
      await waitForRunning(host, "正在运行 1");
      const alpha = await host.command("sendText", {
        text: "撤回编辑的输入甲",
      });
      const beta = await host.command("sendText", { text: "指定立即输入乙" });
      expect(alpha.body.result.result).toMatchObject({ delivery: "queue" });
      expect(beta.body.result.result).toMatchObject({ delivery: "queue" });
      let current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(
        current.rows.window
          .filter((row) => row.kind === "userInput")
          .map((row) => row.text),
      ).toEqual(["真实前台第一轮"]);
      expect(model.requests).toHaveLength(1);
      const [alphaItem, betaItem] = current.queue.items;
      if (!alphaItem || !betaItem) throw new Error("真实队列未保留两个输入");
      const deleteId = randomUUID();
      expect(
        await queueCommand(
          host,
          "deleteQueueItem",
          { queueItemId: alphaItem.queueItemId },
          current,
          deleteId,
        ),
      ).toMatchObject({ status: "accepted" });
      expect(
        await queueCommand(
          host,
          "deleteQueueItem",
          { queueItemId: alphaItem.queueItemId },
          current,
          deleteId,
        ),
      ).toMatchObject({ status: "duplicate" });
      await host.command("sendText", { text: "重新编辑后的输入甲" });
      current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      const editedItem = current.queue.items[1];
      if (!editedItem) throw new Error("重新发送的输入未进入原队列");
      expect(
        await queueCommand(
          host,
          "reorderQueueItem",
          {
            queueItemId: editedItem.queueItemId,
            beforeQueueItemId: betaItem.queueItemId,
          },
          current,
        ),
      ).toMatchObject({ status: "accepted" });
      current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(current.queue.items.map((item) => item.text)).toEqual([
        "重新编辑后的输入甲",
        "指定立即输入乙",
      ]);
      const promoteId = randomUUID();
      const beforePromotion = current;
      expect(
        await queueCommand(
          host,
          "sendQueuedNow",
          { queueItemId: betaItem.queueItemId },
          current,
          promoteId,
        ),
      ).toMatchObject({ status: "accepted" });
      current = await waitForRunning(host, "正在运行 2");
      expect(model.requests.map((entry) => entry.closed)).toEqual([
        true,
        false,
      ]);
      expect(current.queue.items).toMatchObject([
        {
          queueItemId: editedItem.queueItemId,
          sourceCommandId: editedItem.sourceCommandId,
          text: "重新编辑后的输入甲",
        },
      ]);
      expect(
        current.rows.window
          .filter((row) => row.kind === "userInput")
          .map((row) => ({ text: row.text, commandId: row.sourceCommandId })),
      ).toEqual([
        { text: "真实前台第一轮", commandId: first.body.result.commandId },
        { text: "指定立即输入乙", commandId: betaItem.sourceCommandId },
      ]);
      expect(
        await queueCommand(
          host,
          "sendQueuedNow",
          { queueItemId: betaItem.queueItemId },
          beforePromotion,
          promoteId,
        ),
      ).toMatchObject({ status: "duplicate" });
      expect(
        await queueCommand(
          host,
          "deleteQueueItem",
          { queueItemId: editedItem.queueItemId },
          beforePromotion,
        ),
      ).toMatchObject({
        status: "rejected",
        reasonCode: "proto.staleRevision",
      });
      expect(model.requests).toHaveLength(2);
      const runId = current.control.activeWorks.find(
        (work) => work.kind === "primaryTurn",
      )?.foregroundExecutionId;
      if (!runId) throw new Error("抢占轮次缺少真实前台身份");
      expect(
        (await host.command("stop", { expectedForegroundExecutionId: runId }))
          .body.result.status,
      ).toBe("accepted");
      current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(current.control.phase).toBe("completedInterrupted");
      expect(current.queue).toMatchObject({
        autoDrain: false,
        pauseReason: "stopped",
        items: [{ queueItemId: editedItem.queueItemId }],
      });
      expect(
        await queueCommand(host, "setAutoDrain", { autoDrain: true }, current),
      ).toMatchObject({ status: "accepted" });
      current = await waitForRunning(host, "正在运行 3");
      expect(current.queue.items).toEqual([]);
      expect(
        current.rows.window
          .filter((row) => row.kind === "userInput")
          .map((row) => row.text),
      ).toEqual(["真实前台第一轮", "指定立即输入乙", "重新编辑后的输入甲"]);
      const lastRunId = current.control.activeWorks.find(
        (work) => work.kind === "primaryTurn",
      )?.foregroundExecutionId;
      if (!lastRunId) throw new Error("恢复轮次缺少真实前台身份");
      expect(
        (
          await host.command("stop", {
            expectedForegroundExecutionId: lastRunId,
          })
        ).body.result.status,
      ).toBe("accepted");
      await vi.waitFor(() =>
        expect(model.requests.map((entry) => entry.closed)).toEqual([
          true,
          true,
          true,
        ]),
      );
    } finally {
      if (host) {
        const current = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        if (current.control.canStop) await host.command("stop", {});
        await host.dispose();
      }
      await model.close();
      await fixture.close();
    }
  }, 90_000);
});
