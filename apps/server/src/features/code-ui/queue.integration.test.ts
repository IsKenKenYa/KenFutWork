import { randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

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
