import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createDeepAgent } from "deepagents";
import { expect, it } from "vitest";
import { createNativeContextArchiveReader } from "./native-context-archive.js";
import { encodeNativeContextReference } from "./native-context-reference.js";
import { recoverySummaryPrompt } from "./native-recovery-summary.js";

class ArchiveModel extends BaseChatModel {
  _llmType() {
    return "archive-regression";
  }
  bindTools() {
    return this;
  }
  async _generate(_messages: BaseMessage[]) {
    return { generations: [{ text: "done", message: new AIMessage("done") }] };
  }
}

it("real SDK checkpoint archive pages preserve long messages and revalidate Task access", async () => {
  const agent = createDeepAgent({
    model: new ArchiveModel({}),
    checkpointer: new MemorySaver(),
  });
  const threadId = "archive-owned-task";
  const saved = await agent.graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: [new HumanMessage("中文😀".repeat(10_000))] },
    "__start__",
  );
  const reference = encodeNativeContextReference(threadId, saved);
  if (!reference) throw new Error("checkpoint missing");
  let reads = 0;
  let revoked = false;
  const read = createNativeContextArchiveReader(
    agent,
    async (ownedReference, owner) => {
      expect(ownedReference).toEqual(reference);
      expect(owner).toBe(threadId);
      reads++;
      if (revoked) throw new Error("scope_stale");
    },
  );
  const chunks: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await read({ reference, offset, limit: 997 });
    expect(page.text.length).toBeLessThanOrEqual(997);
    chunks.push(page.text);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  const restored = JSON.parse(chunks.join(""));
  expect(JSON.stringify(restored)).toContain("中文😀".repeat(10_000));
  expect(reads).toBe(chunks.length * 2);
  revoked = true;
  await expect(read({ reference })).rejects.toThrow("scope_stale");
  const controller = new AbortController();
  controller.abort();
  await expect(
    read({ reference, signal: controller.signal }),
  ).rejects.toThrow();
  await expect(read({ reference, limit: 0 })).rejects.toThrow("分页");
  revoked = false;
  const readMissing = createNativeContextArchiveReader(agent, async () => {});
  await expect(
    readMissing({
      reference: {
        ...reference,
        key: JSON.stringify({
          threadId,
          namespace: "",
          checkpointId: "absent",
        }),
      },
    }),
  ).rejects.toThrow();
});

it("recovery summary requires unfinished work, evidence gaps and fresh Task permissions", () => {
  expect(recoverySummaryPrompt).toContain("Remaining work");
  expect(recoverySummaryPrompt).toContain("Evidence and gaps");
  expect(recoverySummaryPrompt).toContain(
    "actual persistent Task on every turn",
  );
  expect(recoverySummaryPrompt.split("{conversation}")).toHaveLength(2);
});
