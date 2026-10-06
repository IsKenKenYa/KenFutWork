import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  ToolMessageChunk,
} from "@langchain/core/messages";
import {
  type CheckpointMetadata,
  DeltaSnapshot,
  emptyCheckpoint,
  isDeltaSnapshot,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { expect, it } from "vitest";
import type { AgentContextResourceBinding } from "./context-history.js";
import { createNativeContextBranchService } from "./native-context-branch.js";
import { encodeNativeContextReference } from "./native-context-reference.js";
import { createNativeContextResourceRebinder } from "./native-context-resources.js";
import { createAgentPersistenceService } from "./persistence/index.js";

const binding: AgentContextResourceBinding = {
  source: {
    id: "parent-output",
    outputRef: "/private/source/output.log",
    childSessionId: "parent-child-session",
  },
  target: {
    id: "owned-output",
    outputRef: "code-output:child-root/owned-output",
    childSessionId: "owned-child-session",
  },
};

async function fixture(
  channels: Record<string, unknown>,
  writes: PendingWrite[] = [],
) {
  const persistence = createAgentPersistenceService({});
  const native = await persistence.getPersistence();
  if (!native) throw new Error("真实原生 MemorySaver 未装配");
  const checkpoint = emptyCheckpoint();
  checkpoint.channel_values = channels;
  checkpoint.channel_versions = Object.fromEntries(
    Object.keys(channels).map((name) => [name, 1]),
  );
  const metadata: CheckpointMetadata<{ ownerFact: string }> = {
    source: "loop",
    step: 0,
    parents: {},
    ownerFact: "SOURCE_METADATA",
  };
  const config = await native.checkpointer.put(
    { configurable: { thread_id: "source-thread", checkpoint_ns: "" } },
    checkpoint,
    metadata,
    checkpoint.channel_versions,
  );
  if (writes.length)
    await native.checkpointer.putWrites(config, writes, "native-pending-task");
  const reference = encodeNativeContextReference("source-thread", config);
  if (!reference) throw new Error("真实源 checkpoint 没有生成引用");
  const provider = createNativeContextBranchService({
    agentPersistenceService: persistence,
  });
  const clone = provider.cloneHistory;
  if (!clone) throw new Error("原生历史复制端口未装配");
  const read = async (threadId: string) => {
    const tuple = await native.checkpointer.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: "" },
    });
    if (!tuple) throw new Error("复制后的实际 checkpoint 缺失");
    return tuple;
  };
  return { persistence, native, provider, clone, reference, read };
}

function messages(value: unknown): unknown[] {
  const list = isDeltaSnapshot(value) ? value.value : value;
  if (!Array.isArray(list)) throw new Error("实际消息通道未保留消息数组");
  return list;
}

function toolContent(values: unknown[], toolCallId: string) {
  const message = values.find(
    (value) =>
      ToolMessage.isInstance(value) && value.tool_call_id === toolCallId,
  );
  if (!ToolMessage.isInstance(message) || typeof message.content !== "string")
    throw new Error("实际原生工具文本或工具配对缺失");
  return { message, payload: JSON.parse(message.content) };
}

function summary(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("summaryMessage" in value) ||
    !HumanMessage.isInstance(value.summaryMessage)
  )
    throw new Error("实际摘要 HumanMessage 缺失");
  return value.summaryMessage;
}

it.each([false, true])(
  "真实原生复制在 Delta=%s 时重绑定结构化资源，保留消息/工具配对、普通叙述及其它通道",
  async (delta) => {
    const task = {
      taskId: binding.source.id,
      childSessionId: binding.source.childSessionId,
      outputPath: binding.source.outputRef,
      summary: `普通正文 ${binding.source.id} ${binding.source.outputRef}`,
      outputStats: { retainedBytes: 7, totalBytes: 7, discardedBytes: 0 },
    };
    const output = {
      taskId: binding.source.id,
      outputRef: binding.source.outputRef,
      output: { data: `输出原文 ${binding.source.outputRef}`, nextOffset: 7 },
      display: { kind: "task_output", outputPath: binding.source.outputRef },
    };
    const sourceMessages = [
      new HumanMessage({
        id: "human",
        content: `用户原文 ${binding.source.id}`,
      }),
      new AIMessage({
        id: "ai-task",
        content: "正常派发正文",
        tool_calls: [
          {
            id: "call-task",
            name: "Task",
            args: { description: binding.source.outputRef },
          },
        ],
      }),
      new ToolMessage({
        id: "tool-task",
        name: "Task",
        tool_call_id: "call-task",
        content: JSON.stringify(task),
        artifact: { canonicalOutput: task },
        metadata: { providerFact: "preserved" },
        status: "success",
      }),
      new AIMessage({
        id: "ai-output",
        content: `模型叙述 ${binding.source.outputRef}`,
        tool_calls: [
          {
            id: "call-output",
            name: "TaskOutput",
            args: { task_id: binding.source.id, offset: 3 },
          },
        ],
        additional_kwargs: {
          unrelated: binding.source.outputRef,
          tool_calls: [
            {
              id: "call-output",
              type: "function",
              function: {
                name: "TaskOutput",
                arguments: JSON.stringify({
                  task_id: binding.source.id,
                  offset: 3,
                }),
              },
            },
          ],
        },
      }),
      new ToolMessage({
        id: "tool-output",
        tool_call_id: "call-output",
        content: JSON.stringify(output),
        artifact: {
          canonicalOutput: output,
          display: {
            kind: "bash_output",
            outputPath: binding.source.outputRef,
          },
        },
      }),
      new AIMessage({
        id: "ai-bash",
        content: "",
        tool_calls: [
          {
            id: "call-bash",
            name: "Bash",
            args: { command: "printf retained" },
          },
        ],
      }),
      new ToolMessage({
        id: "tool-bash",
        name: "Bash",
        tool_call_id: "call-bash",
        content: JSON.stringify({
          outputPath: binding.source.outputRef,
          output: "正文原样",
          display: { outputPath: binding.source.outputRef },
        }),
        artifact: { opaque: { outputRef: binding.source.outputRef } },
      }),
    ];
    const unrelated = {
      taskId: binding.source.id,
      outputRef: binding.source.outputRef,
    };
    const f = await fixture(
      {
        messages: delta ? new DeltaSnapshot(sourceMessages) : sourceMessages,
        todos: [{ content: "真实 Todo 保留", status: "completed" }],
        unrelated,
      },
      [
        [
          "messages",
          new ToolMessage({
            name: "TaskOutput",
            id: "pending-output",
            tool_call_id: "call-output",
            content: JSON.stringify(output),
            artifact: { canonicalOutput: output },
          }),
        ],
        ["other-pending-channel", unrelated],
      ],
    );
    try {
      const copied = await f.clone({
        sourceThreadId: "source-thread",
        targetThreadId: "child-thread",
        reference: f.reference,
        boundaries: [{ id: "selected/post", reference: f.reference }],
        resourceBindings: [binding],
      });
      const child = await f.read("child-thread");
      expect(child.checkpoint.channel_values.unrelated).toEqual(unrelated);
      expect(child.checkpoint.channel_values.todos).toEqual([
        { content: "真实 Todo 保留", status: "completed" },
      ]);
      expect(child.metadata).toMatchObject({
        ownerFact: "SOURCE_METADATA",
        source: "fork",
        step: 0,
      });
      const values = messages(child.checkpoint.channel_values.messages);
      expect(
        values.filter(HumanMessage.isInstance).map((value) => value.content),
      ).toEqual([`用户原文 ${binding.source.id}`]);
      const taskResult = toolContent(values, "call-task");
      expect(taskResult.payload).toEqual({
        ...task,
        taskId: "owned-output",
        childSessionId: "owned-child-session",
        outputPath: "code-output:child-root/owned-output",
      });
      expect(taskResult.message.artifact).toEqual({
        canonicalOutput: taskResult.payload,
      });
      expect(taskResult.message).toMatchObject({
        id: "tool-task",
        metadata: { providerFact: "preserved" },
        status: "success",
      });
      const outputResult = toolContent(values, "call-output");
      expect(outputResult.payload).toEqual({
        ...output,
        taskId: "owned-output",
        outputRef: "code-output:child-root/owned-output",
        display: {
          kind: "task_output",
          outputPath: "code-output:child-root/owned-output",
        },
      });
      expect(outputResult.message.artifact).toEqual({
        canonicalOutput: outputResult.payload,
        display: {
          kind: "bash_output",
          outputPath: "code-output:child-root/owned-output",
        },
      });
      const ai = values.find(
        (value) => AIMessage.isInstance(value) && value.id === "ai-output",
      );
      if (!AIMessage.isInstance(ai))
        throw new Error("原生 TaskOutput AI 消息缺失");
      expect(ai.content).toBe(`模型叙述 ${binding.source.outputRef}`);
      expect(ai.tool_calls).toEqual([
        {
          id: "call-output",
          name: "TaskOutput",
          args: { task_id: "owned-output", offset: 3 },
        },
      ]);
      expect(ai.additional_kwargs.unrelated).toBe(binding.source.outputRef);
      expect(
        JSON.parse(
          ai.additional_kwargs.tool_calls?.[0]?.function.arguments ?? "null",
        ),
      ).toEqual({ task_id: "owned-output", offset: 3 });
      expect(toolContent(values, "call-bash").message.artifact).toEqual({
        opaque: { outputRef: binding.source.outputRef },
      });
      expect(toolContent(values, "call-bash").payload).toMatchObject({
        outputPath: "code-output:child-root/owned-output",
        output: "正文原样",
        display: { outputPath: "code-output:child-root/owned-output" },
      });
      const pending = child.pendingWrites?.find(
        (write) => write[1] === "messages",
      );
      if (!pending) throw new Error("原生 messages pending write 丢失");
      expect(pending[0]).toBe("native-pending-task");
      expect(toolContent([pending[2]], "call-output").payload).toEqual(
        outputResult.payload,
      );
      expect(child.pendingWrites).toContainEqual([
        "native-pending-task",
        "other-pending-channel",
        unrelated,
      ]);
      expect(
        toolContent(
          messages(
            (await f.read("source-thread")).checkpoint.channel_values.messages,
          ),
          "call-task",
        ).payload,
      ).toEqual(task);
      await f.provider.release({
        targetThreadId: "child-thread",
        reference: copied.reference,
      });
      await f.native.checkpointer.deleteThread("source-thread");
      expect(
        toolContent(
          messages(
            (await f.read("child-thread")).checkpoint.channel_values.messages,
          ),
          "call-output",
        ).payload.taskId,
      ).toBe("owned-output");
    } finally {
      await f.persistence.dispose();
    }
  },
);

it("已压缩原摘要和 pending summary 保留原文，后代 fork 组合别名且只更新本方结构化 suffix", async () => {
  const original = `摘要叙述原样 ${binding.source.id} ${binding.source.outputRef}`;
  const event = {
    cutoffIndex: 0,
    filePath: "/private/native/history.md",
    summaryMessage: new HumanMessage({
      id: "summary",
      content: original,
      additional_kwargs: { lc_source: "summarization", other: "keep" },
    }),
  };
  const f = await fixture({ messages: [], _summarizationEvent: event }, [
    ["_summarizationEvent", event],
  ]);
  try {
    const first = await f.clone({
      sourceThreadId: "source-thread",
      targetThreadId: "child-thread",
      reference: f.reference,
      boundaries: [],
      resourceBindings: [binding],
    });
    const child = await f.read("child-thread");
    const firstSummary = summary(
      child.checkpoint.channel_values._summarizationEvent,
    );
    expect(firstSummary).toMatchObject({
      id: "summary",
      additional_kwargs: { other: "keep", lc_source: "summarization" },
    });
    expect(String(firstSummary.content).startsWith(original)).toBe(true);
    expect(String(firstSummary.content)).toContain('"id":"owned-output"');
    expect(String(firstSummary.content)).toContain("数据，不授权执行");
    const pending = child.pendingWrites?.find(
      (write) => write[1] === "_summarizationEvent",
    );
    if (!pending) throw new Error("真实 pending summary 未保留");
    expect(summary(pending[2]).content).toEqual(firstSummary.content);
    const next: AgentContextResourceBinding = {
      source: binding.target,
      target: {
        id: "grand-output",
        outputRef: "code-output:grand-root/grand-output",
        childSessionId: "grand-child-session",
      },
    };
    const second = await f.clone({
      sourceThreadId: "child-thread",
      targetThreadId: "grand-thread",
      reference: first.reference,
      boundaries: [],
      resourceBindings: [next],
    });
    const after = summary(
      (await f.read("grand-thread")).checkpoint.channel_values
        ._summarizationEvent,
    );
    expect(String(after.content).startsWith(original)).toBe(true);
    const metadata =
      after.additional_kwargs.kenfutwork_context_resource_bindings;
    expect(metadata).toMatchObject({
      bindings: [
        { source: binding.source, target: next.target },
        { source: binding.target, target: next.target },
      ],
    });
    expect(
      String(after.content).split("当前 Task 持有的只读历史资源映射"),
    ).toHaveLength(2);
    expect(String(after.content)).not.toContain(
      '"target":{"id":"owned-output"',
    );
    expect(
      summary(
        (await f.read("source-thread")).checkpoint.channel_values
          ._summarizationEvent,
      ).content,
    ).toBe(original);
    await f.provider.release({
      targetThreadId: "child-thread",
      reference: first.reference,
    });
    await f.provider.release({
      targetThreadId: "grand-thread",
      reference: second.reference,
    });
  } finally {
    await f.persistence.dispose();
  }
});

it("未命中保持原消息，命中完整 JSON chunk 时保留 native chunk 子类型及 concat 能力", async () => {
  const ai = new AIMessageChunk({
    id: "chunk-ai",
    content: "原 chunk 叙述",
    tool_call_chunks: [
      {
        id: "chunk-call",
        name: "TaskOutput",
        args: JSON.stringify({ task_id: binding.source.id, offset: 0 }),
        index: 0,
        type: "tool_call_chunk",
      },
    ],
  });
  const tool = new ToolMessageChunk({
    id: "chunk-tool",
    name: "TaskOutput",
    tool_call_id: "chunk-call",
    content: JSON.stringify({
      taskId: binding.source.id,
      outputRef: binding.source.outputRef,
    }),
    artifact: {
      canonicalOutput: {
        taskId: binding.source.id,
        outputRef: binding.source.outputRef,
      },
    },
  });
  const unchanged = new AIMessageChunk({
    id: "unmatched-chunk",
    content: "正常叙述",
    tool_call_chunks: [],
  });
  const unchangedTool = new ToolMessageChunk({
    name: "TaskOutput",
    content: "普通工具叙述 parent-output",
    tool_call_id: "unmatched-call",
  });
  const dispatch = new AIMessage({
    content: "普通派发",
    tool_calls: [
      {
        id: "ordinary-task",
        name: "Task",
        args: { description: binding.source.outputRef },
      },
    ],
  });
  const rebinder = createNativeContextResourceRebinder([binding]);
  expect(rebinder.channel("messages", unchanged)).toBe(unchanged);
  expect(rebinder.channel("messages", unchangedTool)).toBe(unchangedTool);
  expect(rebinder.channel("messages", dispatch)).toBe(dispatch);
  const mappedChunk = rebinder.channel("messages", tool);
  if (!ToolMessageChunk.isInstance(mappedChunk))
    throw new Error("完整工具 chunk 的原生子类型被改变");
  expect(mappedChunk.tool_call_id).toBe("chunk-call");
  expect(
    mappedChunk.concat(
      new ToolMessageChunk({ content: "后续片段", tool_call_id: "chunk-call" }),
    ).tool_call_id,
  ).toBe("chunk-call");
  // 实际工具 bridge 提交最终 ToolMessage；ToolChunk 的当前 SDK saver 基线会丢工具配对。
  const finalTool = new ToolMessage({
    id: "final-tool",
    name: "TaskOutput",
    tool_call_id: "chunk-call",
    content: tool.content,
    artifact: tool.artifact,
  });
  const f = await fixture({ messages: [unchanged, ai, finalTool] });
  try {
    await f.clone({
      sourceThreadId: "source-thread",
      targetThreadId: "child-thread",
      reference: f.reference,
      boundaries: [],
      resourceBindings: [binding],
    });
    const values = messages(
      (await f.read("child-thread")).checkpoint.channel_values.messages,
    );
    const mappedAi = values.find(
      (value) => AIMessageChunk.isInstance(value) && value.id === "chunk-ai",
    );
    const mappedTool = values.find(
      (value) => ToolMessage.isInstance(value) && value.id === "final-tool",
    );
    if (
      !AIMessageChunk.isInstance(mappedAi) ||
      !ToolMessage.isInstance(mappedTool)
    )
      throw new Error("原生 chunk 或最终工具消息的子类型被改变");
    expect(mappedAi.tool_calls?.[0]?.args.task_id).toBe("owned-output");
    expect(
      JSON.parse(mappedAi.tool_call_chunks?.[0]?.args ?? "null").task_id,
    ).toBe("owned-output");
    expect(mappedAi.concat(new AIMessageChunk("后续片段")).content).toBe(
      "原 chunk 叙述后续片段",
    );
    expect(mappedTool.tool_call_id).toBe("chunk-call");
    expect(mappedTool.artifact).toEqual({
      canonicalOutput: {
        taskId: "owned-output",
        outputRef: "code-output:child-root/owned-output",
      },
    });
  } finally {
    await f.persistence.dispose();
  }
});

it("需要改变资源但源工具配对已不完整时拒绝，不猜测别名并不留下目标", async () => {
  const tool = new ToolMessageChunk({
    name: "TaskOutput",
    tool_call_id: "",
    content: JSON.stringify({
      taskId: binding.source.id,
      outputRef: binding.source.outputRef,
    }),
  });
  const f = await fixture({ messages: [tool] });
  try {
    await expect(
      f.clone({
        sourceThreadId: "source-thread",
        targetThreadId: "child-thread",
        reference: f.reference,
        boundaries: [],
        resourceBindings: [binding],
      }),
    ).rejects.toThrow("缺少实际工具配对 ID");
    expect(
      await f.native.checkpointer.getTuple({
        configurable: { thread_id: "child-thread", checkpoint_ns: "" },
      }),
    ).toBeUndefined();
  } finally {
    await f.persistence.dispose();
  }
});

it("摘要本方 metadata 与 suffix 不匹配时拒绝，不把普通叙述当作可剥除内容", async () => {
  const original = "普通摘要正文和尾句";
  const event = {
    cutoffIndex: 0,
    summaryMessage: new HumanMessage({
      id: "summary",
      content: original,
      additional_kwargs: {
        kenfutwork_context_resource_bindings: {
          bindings: [binding],
          suffix: "和尾句",
        },
      },
    }),
  };
  const f = await fixture({ messages: [], _summarizationEvent: event });
  try {
    await expect(
      f.clone({
        sourceThreadId: "source-thread",
        targetThreadId: "child-thread",
        reference: f.reference,
        boundaries: [],
        resourceBindings: [binding],
      }),
    ).rejects.toThrow("并非已记录的结构化上下文");
    expect(
      await f.native.checkpointer.getTuple({
        configurable: { thread_id: "child-thread", checkpoint_ns: "" },
      }),
    ).toBeUndefined();
    expect(
      summary(
        (await f.read("source-thread")).checkpoint.channel_values
          ._summarizationEvent,
      ).content,
    ).toBe(original);
  } finally {
    await f.persistence.dispose();
  }
});

it("冲突资源映射与未完成的受影响 JSON chunk 可读拒绝，失败后目标无残留且可复用", async () => {
  const partial = new AIMessageChunk({
    id: "partial",
    content: "",
    tool_call_chunks: [
      {
        id: "partial-call",
        name: "TaskOutput",
        args: '{"task_id":"parent-output"',
        index: 0,
        type: "tool_call_chunk",
      },
    ],
  });
  const f = await fixture({ messages: [partial] });
  const input = {
    sourceThreadId: "source-thread",
    targetThreadId: "child-thread",
    reference: f.reference,
    boundaries: [],
  };
  try {
    await expect(
      f.clone({
        ...input,
        resourceBindings: [
          binding,
          {
            source: binding.source,
            target: { ...binding.target, id: "conflicting-output" },
          },
        ],
      }),
    ).rejects.toThrow("映射存在冲突");
    expect(
      await f.native.checkpointer.getTuple({
        configurable: { thread_id: "child-thread", checkpoint_ns: "" },
      }),
    ).toBeUndefined();
    await expect(
      f.clone({ ...input, resourceBindings: [binding] }),
    ).rejects.toThrow("未完成的 JSON 流");
    expect(
      await f.native.checkpointer.getTuple({
        configurable: { thread_id: "child-thread", checkpoint_ns: "" },
      }),
    ).toBeUndefined();
    expect(
      AIMessageChunk.isInstance(
        messages(
          (await f.read("source-thread")).checkpoint.channel_values.messages,
        )[0],
      ),
    ).toBe(true);
    const corrected = await f.clone({ ...input, resourceBindings: [] });
    expect(
      messages(
        (await f.read("child-thread")).checkpoint.channel_values.messages,
      ),
    ).toHaveLength(1);
    await f.provider.release({
      targetThreadId: "child-thread",
      reference: corrected.reference,
    });
  } finally {
    await f.persistence.dispose();
  }
});
