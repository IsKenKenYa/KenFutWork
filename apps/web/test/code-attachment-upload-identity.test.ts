import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadAttachmentTransaction } from "../src/components/workbench/zcode/v4/attachmentUploadTransaction.js";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.stubGlobal("crypto", webcrypto));

it("同一chip网络重放保持uploadId，明确人工新attempt换键且不重新上传committed内容", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const committed = new Map<string, string>();
  const beginIds: string[] = [];
  let chunks = 0;
  const agent = {
    async attachmentBeginV4(input: { uploadId: string }) {
      beginIds.push(input.uploadId);
      const ref = committed.get(input.uploadId);
      return ref
        ? {
            uploadId: input.uploadId,
            state: "committed" as const,
            nextChunkIndex: 1,
            ref,
          }
        : {
            uploadId: input.uploadId,
            state: "staging" as const,
            nextChunkIndex: 0,
            chunkMaxBytes: 3,
            totalChunks: 1,
          };
    },
    async attachmentChunkV4(input: { uploadId: string; chunkIndex: number }) {
      chunks += 1;
      return { uploadId: input.uploadId, nextChunkIndex: input.chunkIndex + 1 };
    },
    async attachmentCommitV4(input: { uploadId: string }) {
      const ref = `code-attachment:${input.uploadId}`;
      committed.set(input.uploadId, ref);
      return { ref };
    },
    async attachmentAbortV4() {},
  };
  const workspace = { workspacePath: "/owned/project" };
  const input = {
    sessionId: "same-task",
    fileName: "three.bin",
    mime: "application/octet-stream",
    dataBase64: "AAEC",
  };
  const first = await uploadAttachmentTransaction(agent, workspace, input, {
    uploadId: "chip-a:attempt-1",
  });
  const replay = await uploadAttachmentTransaction(agent, workspace, input, {
    uploadId: "chip-a:attempt-1",
  });
  expect(replay).toEqual(first);
  expect(beginIds).toEqual(["chip-a:attempt-1", "chip-a:attempt-1"]);
  expect(chunks).toBe(1);
  const manual = await uploadAttachmentTransaction(agent, workspace, input, {
    uploadId: "chip-a:attempt-2",
  });
  expect(manual.ref).not.toBe(first.ref);
  expect(beginIds[2]).toBe("chip-a:attempt-2");
  expect(chunks).toBe(2);
});

it("已持久化chunk的网络ACK丢失不abort同键事务，重放从权威进度继续", async () => {
  let nextChunkIndex = 0;
  let aborted = false;
  let chunkCalls = 0;
  const abort = vi.fn(async () => {
    aborted = true;
  });
  const agent = {
    async attachmentBeginV4(input: { uploadId: string }) {
      if (aborted) throw new Error("fault.attachment.interrupted");
      return {
        uploadId: input.uploadId,
        state: "staging" as const,
        nextChunkIndex,
        chunkMaxBytes: 3,
        totalChunks: 1,
      };
    },
    async attachmentChunkV4(input: { uploadId: string; chunkIndex: number }) {
      chunkCalls += 1;
      nextChunkIndex = input.chunkIndex + 1;
      throw new Error("temporary transport failure after persisted chunk");
    },
    async attachmentCommitV4(input: { uploadId: string }) {
      return { ref: `code-attachment:${input.uploadId}` };
    },
    attachmentAbortV4: abort,
  };
  const workspace = { workspacePath: "/owned/project" };
  const input = {
    sessionId: "same-task",
    fileName: "three.bin",
    mime: "application/octet-stream",
    dataBase64: "AAEC",
  };
  const options = { uploadId: "chip-a:attempt-1" };
  await expect(
    uploadAttachmentTransaction(agent, workspace, input, options),
  ).rejects.toThrow("temporary transport failure");
  await expect(
    uploadAttachmentTransaction(agent, workspace, input, options),
  ).resolves.toEqual({ ref: "code-attachment:chip-a:attempt-1" });
  expect(chunkCalls).toBe(1);
  expect(abort).not.toHaveBeenCalled();
});

it.each(["begin", "commit"] as const)(
  "明确取消后%s的迟到committed回执不能作为成功交付",
  async (pendingStage) => {
    let entered: (() => void) | undefined;
    const enteredStage = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish: (() => void) | undefined;
    const delayed = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
        entered?.();
      });
    const controller = new AbortController();
    const agent = {
      async attachmentBeginV4(input: { uploadId: string }) {
        if (pendingStage === "begin") {
          await delayed();
          return {
            uploadId: input.uploadId,
            state: "committed" as const,
            nextChunkIndex: 1,
            ref: "code-attachment:durable",
          };
        }
        return {
          uploadId: input.uploadId,
          state: "staging" as const,
          nextChunkIndex: 0,
          chunkMaxBytes: 3,
          totalChunks: 1,
        };
      },
      async attachmentChunkV4(input: { uploadId: string; chunkIndex: number }) {
        return {
          uploadId: input.uploadId,
          nextChunkIndex: input.chunkIndex + 1,
        };
      },
      async attachmentCommitV4() {
        await delayed();
        return { ref: "code-attachment:durable" };
      },
      async attachmentAbortV4() {},
    };
    const upload = uploadAttachmentTransaction(
      agent,
      { workspacePath: "/owned/project" },
      {
        sessionId: "same-task",
        fileName: "three.bin",
        mime: "application/octet-stream",
        dataBase64: "AAEC",
      },
      { uploadId: "chip-a:attempt-1", signal: controller.signal },
    );
    await enteredStage;
    controller.abort();
    finish?.();
    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
  },
);
