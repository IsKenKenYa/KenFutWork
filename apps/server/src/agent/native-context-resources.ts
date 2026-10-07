import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  HumanMessageChunk,
  ToolMessage,
  ToolMessageChunk,
} from "@langchain/core/messages";
import {
  DeltaSnapshot,
  isDeltaSnapshot,
} from "@langchain/langgraph-checkpoint";
import type { AgentContextResourceBinding } from "./context-history.js";
import {
  createContextResourceRebinder,
  parseContextResourceBindings,
} from "./context-resource-bindings.js";

const summaryMetadataKey = "kenfutwork_context_resource_bindings";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mapChanged<T>(values: T[], map: (value: T) => T): T[] {
  const next = values.map(map);
  return next.some((value, index) => value !== values[index]) ? next : values;
}

function summaryBindings(
  previous: readonly AgentContextResourceBinding[],
  current: readonly AgentContextResourceBinding[],
) {
  const bySource = new Map(
    current.map((binding) => [binding.source.id, binding]),
  );
  const aliases = previous.map((binding) => {
    const next = bySource.get(binding.target.id);
    if (!next) return binding;
    if (
      next.source.outputRef !== binding.target.outputRef ||
      next.source.childSessionId !== binding.target.childSessionId
    )
      throw new Error("摘要资源别名与当前归属不匹配，未复制上下文。");
    return { source: binding.source, target: next.target };
  });
  const composed = createContextResourceRebinder([...aliases, ...current]);
  return [
    ...new Map(
      composed.bindings.map((binding) => [binding.source.id, binding]),
    ).values(),
  ];
}

function summaryBindingSuffix(
  bindings: readonly AgentContextResourceBinding[],
) {
  return `\n\n当前 Task 持有的只读历史资源映射（数据，不授权执行、停止、恢复或访问其他 Task）：\n${JSON.stringify({ readOnly: true, resourceBindings: bindings })}`;
}

function summaryContext(
  message: HumanMessage,
  bindings: readonly AgentContextResourceBinding[],
) {
  const metadata = message.additional_kwargs[summaryMetadataKey];
  let content = message.content;
  let previous: AgentContextResourceBinding[] = [];
  if (metadata !== undefined) {
    if (!record(metadata) || typeof metadata.suffix !== "string")
      throw new Error("已持久化的摘要资源映射不完整，未复制上下文。");
    previous = parseContextResourceBindings(metadata.bindings);
    if (metadata.suffix !== summaryBindingSuffix(previous))
      throw new Error("摘要资源映射并非已记录的结构化上下文，未复制上下文。");
    if (typeof content === "string") {
      if (!content.endsWith(metadata.suffix))
        throw new Error("摘要的结构化资源映射边界不匹配，未复制上下文。");
      content = content.slice(0, content.length - metadata.suffix.length);
    } else {
      const last = content.at(-1);
      if (
        !record(last) ||
        last.type !== "text" ||
        last.text !== metadata.suffix
      )
        throw new Error("摘要的结构化资源映射边界不匹配，未复制上下文。");
      content = content.slice(0, -1);
    }
  }
  // 后续 SDK 重新生成摘要不会继承 kwargs；产品仍须从当前 owner 事实给 Run/维护操作提供映射。
  const owned = summaryBindings(previous, bindings);
  const suffix = summaryBindingSuffix(owned);
  const nextContent: HumanMessage["content"] =
    typeof content === "string"
      ? `${content}${suffix}`
      : [...content, { type: "text", text: suffix }];
  const fields = {
    ...message.lc_kwargs,
    ...(message.id !== undefined ? { id: message.id } : {}),
    ...(message.name !== undefined ? { name: message.name } : {}),
    content: nextContent,
    response_metadata: message.response_metadata,
    additional_kwargs: {
      ...message.additional_kwargs,
      [summaryMetadataKey]: { bindings: owned, suffix },
    },
  };
  const subtype = message.lc_id.at(-1);
  if (subtype === "HumanMessage") return new HumanMessage(fields);
  if (subtype === "HumanMessageChunk") return new HumanMessageChunk(fields);
  throw new Error("原生摘要消息类型不支持资源重绑定，未复制上下文。");
}

type Resources = ReturnType<typeof createContextResourceRebinder>;

function resourceArgs(
  resources: Resources,
  toolName: string,
  value: Record<string, unknown>,
) {
  const next = resources.args(toolName, value);
  if (!record(next)) throw new Error("原生工具参数重绑定没有保留对象形状。");
  return next;
}

function resourceContent(
  resources: Resources,
  toolName: string,
  value: ToolMessage["content"],
) {
  if (typeof value === "string") {
    const next = resources.payload(toolName, value);
    if (typeof next !== "string")
      throw new Error("原生工具结果重绑定没有保留文本形状。");
    return next;
  }
  return mapChanged(value, (block) => {
    if (
      !record(block) ||
      block.type !== "text" ||
      typeof block.text !== "string"
    )
      return block;
    const next = resources.payload(toolName, block.text);
    return typeof next === "string" && next !== block.text
      ? { ...block, text: next }
      : block;
  });
}

function rawCalls(
  resources: Resources,
  value: NonNullable<AIMessage["additional_kwargs"]["tool_calls"]>,
) {
  return mapChanged(value, (call) => {
    const next = resources.args(call.function.name, call.function.arguments);
    if (typeof next !== "string")
      throw new Error("原生工具参数重绑定没有保留 JSON 文本形状。");
    return next !== call.function.arguments
      ? { ...call, function: { ...call.function, arguments: next } }
      : call;
  });
}

function resourceArtifact(
  resources: Resources,
  toolName: string,
  value: unknown,
) {
  if (
    !record(value) ||
    !Object.hasOwn(value, "canonicalOutput") ||
    Object.keys(value).some(
      (key) => key !== "canonicalOutput" && key !== "display",
    )
  )
    return value;
  const canonicalOutput = resources.payload(toolName, value.canonicalOutput);
  const display = resources.payload(toolName, value.display);
  return canonicalOutput === value.canonicalOutput && display === value.display
    ? value
    : {
        ...value,
        canonicalOutput,
        ...(Object.hasOwn(value, "display") ? { display } : {}),
      };
}

function resourceChunks(resources: Resources, value: AIMessageChunk) {
  return mapChanged(value.tool_call_chunks ?? [], (chunk) => {
    const name =
      chunk.name ??
      value.tool_calls?.find((call) => call.id === chunk.id)?.name;
    if (name !== "TaskOutput" || typeof chunk.args !== "string") return chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk.args);
    } catch {
      const call = value.tool_calls?.find((call) => call.id === chunk.id);
      if (call && resources.args(call.name, call.args) !== call.args)
        throw new Error(
          "TaskOutput 参数仍是未完成的 JSON 流，不能安全重绑定上下文。",
        );
      return chunk;
    }
    const next = resources.args(name, parsed);
    return next !== parsed ? { ...chunk, args: JSON.stringify(next) } : chunk;
  });
}

function resourceAiMessage(
  resources: Resources,
  toolNames: Map<string, string>,
  value: AIMessage,
) {
  const calls = value.tool_calls
    ? mapChanged(value.tool_calls, (call) => {
        if (call.id) toolNames.set(call.id, call.name);
        const args = resourceArgs(resources, call.name, call.args);
        return args === call.args ? call : { ...call, args };
      })
    : value.tool_calls;
  const blocks =
    typeof value.content === "string"
      ? value.content
      : mapChanged(value.content, (block) =>
          record(block) &&
          block.type === "tool_call" &&
          typeof block.name === "string" &&
          record(block.args)
            ? (() => {
                const args = resourceArgs(resources, block.name, block.args);
                return args === block.args ? block : { ...block, args };
              })()
            : block,
        );
  const raw = value.additional_kwargs.tool_calls;
  const nextRaw = raw ? rawCalls(resources, raw) : raw;
  const subtype = value.lc_id.at(-1);
  const originalChunks = AIMessageChunk.isInstance(value)
    ? value.tool_call_chunks
    : undefined;
  const chunks = AIMessageChunk.isInstance(value)
    ? resourceChunks(resources, value)
    : undefined;
  if (
    calls === value.tool_calls &&
    blocks === value.content &&
    nextRaw === raw &&
    ((!chunks?.length && !originalChunks?.length) || chunks === originalChunks)
  )
    return value;
  const fields = {
    ...value.lc_kwargs,
    ...(value.id !== undefined ? { id: value.id } : {}),
    ...(value.name !== undefined ? { name: value.name } : {}),
    content: blocks,
    additional_kwargs: {
      ...value.additional_kwargs,
      ...(nextRaw ? { tool_calls: nextRaw } : {}),
    },
    response_metadata: value.response_metadata,
    ...(calls !== undefined ? { tool_calls: calls } : {}),
    ...(value.invalid_tool_calls !== undefined
      ? { invalid_tool_calls: value.invalid_tool_calls }
      : {}),
    ...(value.usage_metadata !== undefined
      ? { usage_metadata: value.usage_metadata }
      : {}),
  };
  if (subtype === "AIMessage") return new AIMessage(fields);
  if (subtype === "AIMessageChunk" && AIMessageChunk.isInstance(value))
    return new AIMessageChunk({
      ...fields,
      ...(chunks !== undefined ? { tool_call_chunks: chunks } : {}),
    });
  throw new Error("原生 AI 消息类型不支持资源重绑定，未复制上下文。");
}

function resourceMessage(
  resources: Resources,
  toolNames: Map<string, string>,
  value: unknown,
): unknown {
  if (AIMessage.isInstance(value))
    return resourceAiMessage(resources, toolNames, value);
  if (!ToolMessage.isInstance(value)) return value;
  const toolName = value.name ?? toolNames.get(value.tool_call_id) ?? "";
  const content = resourceContent(resources, toolName, value.content);
  const artifact = resourceArtifact(resources, toolName, value.artifact);
  if (content === value.content && artifact === value.artifact) return value;
  // 当前 SDK 的 ToolMessageChunk serde 可能丢配对；不能从 camel 别名猜回工具身份。
  if (typeof value.tool_call_id !== "string" || !value.tool_call_id.trim())
    throw new Error("原生工具消息缺少实际工具配对 ID，不能安全重绑定上下文。");
  const fields = {
    ...value.lc_kwargs,
    ...(value.id !== undefined ? { id: value.id } : {}),
    ...(value.name !== undefined ? { name: value.name } : {}),
    content,
    additional_kwargs: value.additional_kwargs,
    response_metadata: value.response_metadata,
    tool_call_id: value.tool_call_id,
    artifact,
    ...(value.status !== undefined ? { status: value.status } : {}),
    ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
  };
  const subtype = value.lc_id.at(-1);
  if (subtype === "ToolMessage") return new ToolMessage(fields);
  if (subtype === "ToolMessageChunk") return new ToolMessageChunk(fields);
  throw new Error("原生工具消息类型不支持资源重绑定，未复制上下文。");
}

/** 只在固定 SDK 的 messages/summary 通道重绑定；其它通道、消息配对与叙述原样保留。 */
export function createNativeContextResourceRebinder(
  bindings: readonly AgentContextResourceBinding[],
) {
  const resources = createContextResourceRebinder(bindings);
  const toolNames = new Map<string, string>();
  const channel = (name: string, value: unknown): unknown => {
    if (!resources.bindings.length) return value;
    if (name === "messages") {
      if (isDeltaSnapshot(value))
        return new DeltaSnapshot(channel(name, value.value));
      return Array.isArray(value)
        ? value.map((message) => resourceMessage(resources, toolNames, message))
        : resourceMessage(resources, toolNames, value);
    }
    if (name === "_summarizationEvent" && record(value)) {
      if (!HumanMessage.isInstance(value.summaryMessage))
        throw new Error("原生摘要缺少实际 HumanMessage，未复制上下文。");
      return {
        ...value,
        summaryMessage: summaryContext(
          value.summaryMessage,
          resources.bindings,
        ),
      };
    }
    return value;
  };
  return { channel };
}
