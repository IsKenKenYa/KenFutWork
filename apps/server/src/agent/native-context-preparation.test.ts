import { randomUUID } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { expect, it } from "vitest";
import { createTaskWorkDatabase } from "../features/task-work/test-postgres-schema.js";
import { createNativeContextBranchService } from "./native-context-branch.js";
import { encodeNativeContextReference } from "./native-context-reference.js";
import { createAgentPersistenceService } from "./persistence/index.js";

it("重建原生Provider后可按持久租约清理未发表目标，不依赖旧内存Map", async () => {
  const persistence = createAgentPersistenceService({});
  try {
    const native = await persistence.getPersistence();
    if (!native) throw new Error("未装配实际原生持久服务");
    const seed = emptyCheckpoint();
    seed.channel_values = {
      messages: [new HumanMessage("DURABLE_PREPARE_SOURCE")],
    };
    seed.channel_versions = { messages: 1 };
    const config = await native.checkpointer.put(
      { configurable: { thread_id: "prepared-source", checkpoint_ns: "" } },
      seed,
      { source: "loop", step: 0, parents: {} },
      seed.channel_versions,
    );
    const reference = encodeNativeContextReference("prepared-source", config);
    if (!reference) throw new Error("源没有实际checkpoint");
    const first = createNativeContextBranchService({
      agentPersistenceService: persistence,
    });
    if (!first.cloneHistory) throw new Error("原生历史分支端口未装配");
    const copied = await first.cloneHistory({
      sourceThreadId: "prepared-source",
      targetThreadId: "prepared-target",
      reference,
      boundaries: [],
    });
    expect(
      (
        await native.checkpointer.getTuple({
          configurable: { thread_id: "prepared-target", checkpoint_ns: "" },
        })
      )?.checkpoint.channel_values.messages,
    ).toMatchObject([{ content: "DURABLE_PREPARE_SOURCE" }]);
    const cold = createNativeContextBranchService({
      agentPersistenceService: persistence,
    });
    await cold.discard({
      targetThreadId: "prepared-target",
      reference: copied.reference,
    });
    expect(
      await native.checkpointer.getTuple({
        configurable: { thread_id: "prepared-target", checkpoint_ns: "" },
      }),
    ).toBeUndefined();
    expect(
      (
        await native.checkpointer.getTuple({
          configurable: { thread_id: "prepared-source", checkpoint_ns: "" },
        })
      )?.checkpoint.channel_values.messages,
    ).toMatchObject([{ content: "DURABLE_PREPARE_SOURCE" }]);
  } finally {
    await persistence.dispose();
  }
});

it.skipIf(process.env.KENFUTWORK_HARNESS_TEST_PG !== "1")(
  "真实PG关闭全部持久池后重建Provider，未发表目标可清理，已释放目标不可清理",
  async () => {
    const database = await createTaskWorkDatabase();
    let persistence = createAgentPersistenceService({
      databaseUrl: database.connectionString,
    });
    try {
      const native = await persistence.getPersistence();
      if (!native) throw new Error("未装配实际PG原生持久服务");
      const sourceThreadId = `durable-source-${randomUUID()}`;
      const abandonedThreadId = `durable-abandoned-${randomUUID()}`;
      const publishedThreadId = `durable-published-${randomUUID()}`;
      const seed = emptyCheckpoint();
      seed.channel_values = {
        messages: [new HumanMessage("DURABLE_PG_PREPARATION_BYTES")],
      };
      seed.channel_versions = { messages: 1 };
      const config = await native.checkpointer.put(
        { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
        seed,
        { source: "loop", step: 0, parents: {} },
        seed.channel_versions,
      );
      const reference = encodeNativeContextReference(sourceThreadId, config);
      if (!reference) throw new Error("源没有实际checkpoint");
      const first = createNativeContextBranchService({
        agentPersistenceService: persistence,
      });
      if (!first.cloneHistory) throw new Error("没有原生历史端口");
      const abandoned = await first.cloneHistory({
        sourceThreadId,
        targetThreadId: abandonedThreadId,
        reference,
        boundaries: [],
      });
      const published = await first.cloneHistory({
        sourceThreadId,
        targetThreadId: publishedThreadId,
        reference,
        boundaries: [],
      });
      await first.release({
        targetThreadId: publishedThreadId,
        reference: published.reference,
      });
      await persistence.dispose();
      persistence = createAgentPersistenceService({
        databaseUrl: database.connectionString,
      });
      const restored = await persistence.getPersistence();
      if (!restored) throw new Error("PG持久服务重启失败");
      const cold = createNativeContextBranchService({
        agentPersistenceService: persistence,
      });
      await cold.discard({
        targetThreadId: abandonedThreadId,
        reference: abandoned.reference,
      });
      expect(
        await restored.checkpointer.getTuple({
          configurable: { thread_id: abandonedThreadId, checkpoint_ns: "" },
        }),
      ).toBeUndefined();
      await expect(
        cold.discard({
          targetThreadId: publishedThreadId,
          reference: published.reference,
        }),
      ).rejects.toThrow("尚未发布");
      expect(
        (
          await restored.checkpointer.getTuple({
            configurable: { thread_id: publishedThreadId, checkpoint_ns: "" },
          })
        )?.checkpoint.channel_values.messages,
      ).toMatchObject([{ content: "DURABLE_PG_PREPARATION_BYTES" }]);
      expect(
        (
          await restored.checkpointer.getTuple({
            configurable: { thread_id: sourceThreadId, checkpoint_ns: "" },
          })
        )?.checkpoint.channel_values.messages,
      ).toMatchObject([{ content: "DURABLE_PG_PREPARATION_BYTES" }]);
    } finally {
      await persistence.dispose();
      await database.close();
    }
  },
);
