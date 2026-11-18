import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { attachmentChecksum } from "./attachments/bytes.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { type Host, snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";
import { createPgQueryReplyGate } from "./pg-query-reply-gate.fixture.mjs";

const cases = [
  {
    name: "文本",
    fileName: "inherited-input.txt",
    mime: "text/plain",
    bytes: Buffer.from("INHERITED_ATTACHMENT_REAL_BYTES_中文"),
    encoding: "utf8" as const,
  },
  {
    name: "PNG",
    fileName: "inherited-input.png",
    mime: "image/png",
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
      "base64",
    ),
    encoding: "base64" as const,
  },
  {
    name: "PDF",
    fileName: "inherited-input.pdf",
    mime: "application/pdf",
    bytes: Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length 40 >> stream
BT /F1 12 Tf 30 50 Td (Hello PDF) Tj ET
endstream endobj
trailer << /Size 6 /Root 1 0 R >>
%%EOF
`),
    encoding: "base64" as const,
  },
]; // 既有runtime-checkpoints夹具字节，非用户文件或生产限额。

async function configureMedia(host: Host) {
  const current = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const selection = current.config.modelSelection;
  if (!selection) throw new Error("真实Task缺少模型");
  const view = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "getView",
    args: [],
  });
  expect(view.status, JSON.stringify(view.body)).toBe(200);
  const changed = await host.client.request("/api/code-ui/rpc", {
    service: "providerSettingsService",
    method: "savePersonalModelDraft",
    args: [
      {
        providerId: selection.providerId,
        originalModelId: selection.modelId,
        nextModelId: selection.modelId,
        personalConfig: {
          properties: {
            inputFormat: {
              supportsText: true,
              supportsImage: true,
              supportsPdf: true,
            },
          },
        },
        useRecommendedConfig: true,
        basedOnRevision: view.body.result.revision,
      },
    ],
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
}

async function upload(
  host: Host,
  content: Buffer,
  metadata = {
    fileName: "inherited-input.txt",
    mime: "text/plain",
    bytes: content.length,
  },
): Promise<protocol.AttachmentRef> {
  const uploadId = randomUUID();
  const identity = { sessionId: host.sessionId, uploadId };
  const begun = await host.stream.rpc("attachmentBeginV4", [
    {
      ...identity,
      fileName: metadata.fileName,
      mime: metadata.mime,
      totalBytes: content.length,
      totalChunks: 1,
      checksum: attachmentChecksum(content),
    },
  ]);
  expect(begun.status, JSON.stringify(begun.body)).toBe(200);
  const chunk = await host.stream.rpc("attachmentChunkV4", [
    { ...identity, chunkIndex: 0, dataBase64: content.toString("base64") },
  ]);
  expect(chunk.status, JSON.stringify(chunk.body)).toBe(200);
  const committed = await host.stream.rpc("attachmentCommitV4", [identity]);
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);
  return {
    ...metadata,
    ref: protocol.v4AttachmentCommitResultSchema.parse(committed.body.result)
      .ref,
  };
}

function userRow(current: protocol.ConversationSnapshot) {
  const row = current.rows.window.find((entry) => entry.kind === "userInput");
  if (row?.kind !== "userInput" || !row.entityId || !row.attachments?.[0])
    throw new Error("真实用户附件行缺失");
  return { ...row, entityId: row.entityId, attachment: row.attachments[0] };
}

async function read(
  host: Host,
  taskId: string,
  current: protocol.ConversationSnapshot,
  ref = userRow(current).attachment.ref,
) {
  const row = userRow(current);
  return host.stream.rpc("conversationAttachmentReadV4", [
    {
      sessionId: taskId,
      ref,
      target: { rowId: row.rowId, entityId: row.entityId },
      attachmentIndex: 0,
      offset: 0,
      limit: 1024,
    },
  ]); // 仅小型fixture读取范围，不定义生产上限。
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task附件继承独立归属 integration",
  () => {
    it("附件已准备且原生读取在途时源Task删除，迟到fork不能发表新Task", async () => {
      let gate: Awaited<ReturnType<typeof createPgQueryReplyGate>> | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          gate = await createPgQueryReplyGate(direct);
          return gate;
        },
      });
      const model = await heldModel();
      let host: Host | undefined;
      let pending: ReturnType<Host["command"]> | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const bytes = Buffer.from("DELETE_DURING_ATTACHMENT_FORK");
        const attachment = await upload(host, bytes);
        await host.command("sendText", {
          text: "DELETION_RACE_A",
          attachments: [attachment],
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.finish(0);
        const completed = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const reply = completed.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!reply?.entityId || !gate)
          throw new Error("真实source或gate未装配");
        const currentGate = gate;
        const binding = await fixture.app.kernel
          .get("threads")
          .resolveOwnedSessionThread(fixture.actor, host.sessionId);
        currentGate.arm();
        pending = host.command(
          "forkAssistant",
          { target: { rowId: reply.rowId, entityId: reply.entityId } },
          randomUUID(),
          {
            baseRevision: completed.revision,
            baseLogEpoch: completed.logEpoch,
          },
        );
        await vi.waitFor(
          () => expect(currentGate.evidence().serverReadyForQuery).toBe(true),
          { timeout: 30_000 },
        );
        expect(await currentGate.entered).toMatchObject({
          matched: true,
          serverReadyForQuery: true,
          readCompleted: true,
          replyHeld: true,
          queryFailed: false,
        });
        expect(currentGate.evidence().values).toContain(binding.threadId);
        expect(currentGate.evidence().observerError).toBeUndefined();
        const preparedFiles = (
          await readdir(join(fixture.directory, "blobs"), {
            recursive: true,
            withFileTypes: true,
          })
        ).filter((entry) => entry.isFile());
        expect(preparedFiles).toHaveLength(2); // source与未发表目标，证明不是尚未准备的等待。
        const removed = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "deleteTask",
          args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
        });
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        currentGate.release();
        const result = await pending;
        expect(result.status, JSON.stringify(result.body)).not.toBe(200);
        const listed = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "listTasks",
          args: [
            { workspacePath: host.workspacePath, projectId: host.projectId },
          ],
        });
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect(listed.body.result).toEqual([]);
        expect(model.requests).toHaveLength(1);
      } finally {
        gate?.release();
        await pending?.catch(() => {});
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
    it("同一图片ref出现在两条继承历史中，原无target缩略图读取仍可用且仅一份副本", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await configureMedia(host);
        const sample = cases.find((value) => value.mime === "image/png");
        if (!sample) throw new Error("已有PNG夹具缺失");
        const attachment = await upload(host, sample.bytes, {
          fileName: sample.fileName,
          mime: sample.mime,
          bytes: sample.bytes.length,
        });
        for (const index of [0, 1]) {
          expect(
            (
              await host.command("sendText", {
                text: `REUSED_IMAGE_${index}`,
                attachments: [attachment],
              })
            ).body.result.status,
          ).toBe("accepted");
          await vi.waitFor(
            () => expect(model.requests).toHaveLength(index + 1),
            { timeout: 30_000 },
          );
          model.finish(index);
          await waitPhase(fixture, host.sessionId, "completedSuccess");
        }
        const parent = await snapshot(fixture, host.sessionId);
        const assistant = [...parent.rows.window]
          .reverse()
          .find(
            (row) => row.kind === "assistantText" && row.state === "complete",
          );
        if (!assistant?.entityId) throw new Error("图片最新回复缺失");
        const forked = await host.command(
          "forkAssistant",
          { target: { rowId: assistant.rowId, entityId: assistant.entityId } },
          randomUUID(),
          { baseRevision: parent.revision, baseLogEpoch: parent.logEpoch },
        );
        const ack = protocol.commandAckSchema.parse(forked.body.result);
        expect(ack.status, JSON.stringify(ack)).toBe("accepted");
        if (ack.result?.type !== "forkAssistant")
          throw new Error("图片子Task缺失");
        const childId = ack.result.sessionId;
        const child = await snapshot(fixture, childId);
        const refs = child.rows.window.flatMap((row) =>
          row.kind === "userInput"
            ? (row.attachments?.map((value) => value.ref) ?? [])
            : [],
        );
        expect(refs).toHaveLength(2);
        expect(new Set(refs).size).toBe(1);
        const copied = userRow(child).attachment;
        const preview = await host.stream.rpc("attachmentReadV4", [
          { sessionId: childId, ref: copied.ref, offset: 0, limit: 1024 },
        ]);
        expect(preview.status, JSON.stringify(preview.body)).toBe(200);
        expect(Buffer.from(preview.body.result.dataBase64, "base64")).toEqual(
          sample.bytes,
        );
        const removed = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "deleteTask",
          args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
        });
        expect(removed.status).toBe(200);
        const after = await host.stream.rpc("attachmentReadV4", [
          { sessionId: childId, ref: copied.ref, offset: 0, limit: 1024 },
        ]);
        expect(after.status, JSON.stringify(after.body)).toBe(200);
        expect(Buffer.from(after.body.result.dataBase64, "base64")).toEqual(
          sample.bytes,
        );
        const wrongIndex = await host.stream.rpc(
          "conversationAttachmentReadV4",
          [
            {
              sessionId: childId,
              ref: copied.ref,
              target: {
                rowId: userRow(child).rowId,
                entityId: userRow(child).entityId,
              },
              attachmentIndex: 1,
              offset: 0,
              limit: 1024,
            },
          ],
        );
        expect(wrongIndex.status).toBe(404);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
    it("发表SQL真实失败时无半Task/附件/native，source内容不动且原失败命令可重放", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const bytes = Buffer.from("FORK_ATTACHMENT_ROLLBACK_SOURCE");
        const attachment = await upload(host, bytes);
        await host.command("sendText", {
          text: "ROLLBACK_A",
          attachments: [attachment],
        });
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
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!assistant?.entityId) throw new Error("source完成回复缺失");
        const files = async () =>
          (
            await readdir(join(fixture.directory, "blobs"), {
              recursive: true,
              withFileTypes: true,
            })
          )
            .filter((entry) => entry.isFile())
            .map((entry) => join(entry.parentPath, entry.name))
            .sort();
        const beforeFiles = await files();
        const beforeNative = await fixture.database.persistence.query(
          "select distinct thread_id from langgraph.checkpoints order by thread_id",
        );
        const currentHost = host;
        const list = async () => {
          const result = await currentHost.client.request("/api/code-ui/rpc", {
            service: "zcode-task",
            method: "listTasks",
            args: [
              {
                workspacePath: currentHost.workspacePath,
                projectId: currentHost.projectId,
              },
            ],
          });
          expect(result.status).toBe(200);
          return result.body.result;
        };
        const beforeList = await list();
        await fixture.database.persistence.execute(
          "create function public.reject_test_attachment_history() returns trigger language plpgsql as $$ begin raise exception '测试附件历史发表失败'; end $$",
        );
        await fixture.database.persistence.execute(
          "create trigger reject_test_attachment_history before insert on public.code_attachments for each row execute function public.reject_test_attachment_history()",
        );
        const commandId = randomUUID();
        const payload = {
          target: { rowId: assistant.rowId, entityId: assistant.entityId },
        };
        const guard = {
          baseRevision: completed.revision,
          baseLogEpoch: completed.logEpoch,
        };
        const failed = await host.command(
          "forkAssistant",
          payload,
          commandId,
          guard,
        );
        expect(failed.status, JSON.stringify(failed.body)).toBe(200);
        expect(failed.body.result).toMatchObject({
          status: "failed",
          reasonCode: "fork_failed",
          message: "测试附件历史发表失败",
        });
        expect(await list()).toEqual(beforeList);
        expect(await files()).toEqual(beforeFiles);
        expect(
          await fixture.database.persistence.query(
            "select distinct thread_id from langgraph.checkpoints order by thread_id",
          ),
        ).toEqual(beforeNative);
        const source = await snapshot(fixture, host.sessionId);
        const readback = await read(host, host.sessionId, source);
        expect(readback.status).toBe(200);
        expect(Buffer.from(readback.body.result.dataBase64, "base64")).toEqual(
          bytes,
        );
        const replay = await host.command(
          "forkAssistant",
          payload,
          commandId,
          guard,
        );
        expect(replay.body.result).toMatchObject({
          status: "duplicate",
          reasonCode: "fork_failed",
          message: "测试附件历史发表失败",
        });
        expect(await files()).toEqual(beforeFiles);
        expect(model.requests).toHaveLength(1);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
    it.each([
      ...cases.map((sample) => ({ ...sample, commitLoss: false })),
      ...cases.slice(0, 1).map((sample) => ({
        ...sample,
        name: `${sample.name}（COMMIT回包丢失）`,
        commitLoss: true,
      })),
    ])(
      "真实$name附件随fork独立发表，父删除清理后子公开读取和原retry仍使用相同内容",
      async (sample) => {
        let proxy:
          | Awaited<ReturnType<typeof createCommitResponseLossProxy>>
          | undefined;
        const fixture = await createCodeUiHttpFixture(
          sample.commitLoss
            ? {
                databaseTransport: async (direct) => {
                  proxy = await createCommitResponseLossProxy(direct);
                  return proxy;
                },
              }
            : {},
        );
        const model = await heldModel();
        let host: Host | undefined;
        try {
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          await configureMedia(host);
          const bytes = sample.bytes;
          const attachment = await upload(host, bytes, {
            fileName: sample.fileName,
            mime: sample.mime,
            bytes: bytes.length,
          });
          const sourceRecord = await fixture.database.persistence
            .forInstance(fixture.actor.instanceId)
            .queryOne<{ record: { objectPath: string } }>(
              "select record from public.code_attachments where instance_id=:instance and task_id=$1 and record->>'ref'=$2 and status='committed'",
              [host.sessionId, attachment.ref],
            );
          if (!sourceRecord) throw new Error("公开上传缺少实际committed记录");
          expect(
            (
              await host.command("sendText", {
                text: "ATTACHMENT_ORIGINAL_A",
                attachments: [attachment],
              })
            ).body.result.status,
          ).toBe("accepted");
          await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
            timeout: 30_000,
          });
          expect(JSON.stringify(model.requests[0]?.body.messages)).toContain(
            bytes.toString(sample.encoding),
          );
          model.finish(0);
          const parent = await waitPhase(
            fixture,
            host.sessionId,
            "completedSuccess",
          );
          const assistant = parent.rows.window.find(
            (row) => row.kind === "assistantText" && row.state === "complete",
          );
          if (!assistant?.entityId) throw new Error("完成A缺少原回复");
          const commandId = randomUUID();
          const target = {
            target: { rowId: assistant.rowId, entityId: assistant.entityId },
          };
          const guard = {
            baseRevision: parent.revision,
            baseLogEpoch: parent.logEpoch,
          };
          proxy?.arm(commandId);
          const results =
            sample.mime === "text/plain" && !sample.commitLoss
              ? await Promise.all([
                  host.command("forkAssistant", target, commandId, guard),
                  host.command("forkAssistant", target, commandId, guard),
                ])
              : [await host.command("forkAssistant", target, commandId, guard)];
          const accepted = results.filter(
            (result) =>
              result.status === 200 && result.body.result.status === "accepted",
          );
          expect(accepted).toHaveLength(1);
          const forked = accepted[0];
          if (!forked) throw new Error("原fork没有唯一accepted回执");
          for (const result of results) {
            if (result === forked) continue;
            if (result.status === 200)
              expect(result.body.result.status).toBe("duplicate");
            else
              expect(result).toMatchObject({
                status: 409,
                body: { error: { code: "code_ui_command_conflict" } },
              });
          }
          expect(forked.status, JSON.stringify(forked.body)).toBe(200);
          const ack = protocol.commandAckSchema.parse(forked.body.result);
          expect(ack.status, JSON.stringify(ack)).toBe("accepted");
          if (proxy) {
            expect(proxy.evidence()).toMatchObject({
              injected: {
                commitConfirmed: true,
                replySuppressed: true,
                commandId,
              },
            });
            expect(proxy.evidence().observerError).toBeUndefined();
          }
          if (ack.result?.type !== "forkAssistant")
            throw new Error("原fork ACK缺少子Task");
          const childId = ack.result.sessionId;
          expect(
            await fixture.database.persistence
              .forInstance(fixture.actor.instanceId)
              .query(
                "select r.id from public.agent_runs r join public.chat_sessions s on s.id=r.session_id where s.instance_id=:instance and s.id=$1",
                [childId],
              ),
          ).toEqual([]);
          const inherited = await snapshot(fixture, childId);
          const childAttachment = userRow(inherited).attachment;
          expect(childAttachment).toMatchObject({
            fileName: attachment.fileName,
            mime: attachment.mime,
            bytes: bytes.length,
          });
          expect(childAttachment.ref).not.toBe(attachment.ref);
          const before = await read(host, childId, inherited);
          expect(before.status, JSON.stringify(before.body)).toBe(200);
          expect(Buffer.from(before.body.result.dataBase64, "base64")).toEqual(
            bytes,
          );
          const repeated = await host.command(
            "forkAssistant",
            target,
            commandId,
            guard,
          );
          expect(repeated.body.result).toMatchObject({
            status: "duplicate",
            result: { type: "forkAssistant", sessionId: childId },
          });
          expect(userRow(await snapshot(fixture, childId)).attachment.ref).toBe(
            childAttachment.ref,
          );
          const conflicted = await host.command(
            "forkAssistant",
            { target: { ...target.target, rowId: target.target.rowId + 1 } },
            commandId,
            guard,
          );
          expect(conflicted.status, JSON.stringify(conflicted.body)).toBe(409);
          expect(conflicted.body.error.code).toBe("code_ui_command_conflict");
          const binding = await fixture.app.kernel
            .get("threads")
            .resolveOwnedSessionThread(fixture.actor, host.sessionId);
          const removed = await host.client.request("/api/code-ui/rpc", {
            service: "zcode-task",
            method: "deleteTask",
            args: [
              { taskId: host.sessionId, workspacePath: host.workspacePath },
            ],
          });
          expect(removed.status, JSON.stringify(removed.body)).toBe(200);
          // 补充Blob公共边界证明父对象真正清理；不是只因父GET不可见而认定独立。
          await expect(
            fixture.app.kernel
              .get("blob")
              .bucket("code-attachments")
              .download(sourceRecord.record.objectPath),
          ).rejects.toThrow();
          const native = await fixture.app.kernel
            .get("agentPersistence")
            .getPersistence();
          if (!native) throw new Error("真实native未配置");
          await native.checkpointer.deleteThread(binding.threadId);
          const child = await snapshot(fixture, childId);
          const after = await read(host, childId, child);
          expect(after.status, JSON.stringify(after.body)).toBe(200);
          expect(Buffer.from(after.body.result.dataBase64, "base64")).toEqual(
            bytes,
          );
          expect(
            (await read(host, childId, child, attachment.ref)).status,
          ).toBe(404);
          const reply = child.rows.window.find(
            (row) => row.kind === "assistantText",
          );
          if (!reply?.entityId) throw new Error("继承回复缺失");
          const retried = await host.stream.rpc("sendConversationCommandV4", [
            {
              workspacePath: host.workspacePath,
              projectId: host.projectId,
              envelope: {
                type: "retryTurn",
                sessionId: childId,
                clientId: host.clientId,
                commandId: randomUUID(),
                baseRevision: child.revision,
                baseLogEpoch: child.logEpoch,
                payload: {
                  target: { rowId: reply.rowId, entityId: reply.entityId },
                },
                issuedAt: Date.now(),
              },
            },
          ]);
          expect(
            retried.body.result,
            JSON.stringify(retried.body),
          ).toMatchObject({ status: "accepted" });
          await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
            timeout: 30_000,
          });
          expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
            bytes.toString(sample.encoding),
          );
          expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
            "ATTACHMENT_ORIGINAL_A",
          );
          model.finish(1);
          const ended = await waitPhase(fixture, childId, "completedSuccess");
          expect(userRow(ended).attachment.ref).toBe(childAttachment.ref);
          const closedChild = await host.client.request("/api/code-ui/rpc", {
            service: "zcode-task",
            method: "deleteTask",
            args: [{ taskId: childId, workspacePath: host.workspacePath }],
          });
          expect(closedChild.status, JSON.stringify(closedChild.body)).toBe(
            200,
          );
          expect((await read(host, childId, ended)).status).toBe(404);
          expect(model.requests).toHaveLength(2);
        } finally {
          if (host) await host.dispose();
          await model.close();
          await fixture.close();
        }
      },
      90_000,
    );
  },
);
