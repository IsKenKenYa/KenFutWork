import type {
  ContextHeaders,
  ContextTimeline,
  ConversationNodeLike,
  HeaderEpochContent,
  RequestRecord,
  SurfaceNode,
} from "@kenfutwork/context-insights-ui";
import {
  estimateSystemTokens,
  estimateTextTokens,
} from "@kenfutwork/context-insights-ui/estimate";
import type {
  ContextRequestInput,
  ContextRequestSummary,
  ModelCallPurpose,
} from "@kenfutwork/shared";

export interface InspectedRequest {
  summary: ContextRequestSummary;
  input: ContextRequestInput;
}
export const contextRequestPurposeLabels: Record<ModelCallPurpose, string> = {
  agent: "对话",
  "automatic-compaction": "自动摘要",
  "manual-compaction": "手动摘要",
  "goal-evaluation": "目标验收",
  "approval-review": "审批评估",
};
export function inspectionStream(
  requests: ContextRequestSummary[],
  selected: ContextRequestSummary,
) {
  return requests
    .filter(
      (r) =>
        r.runId === selected.runId &&
        r.agentCallId === selected.agentCallId &&
        r.purpose === selected.purpose,
    )
    .sort((a, b) => a.sequence - b.sequence);
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const textOf = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
function toolOf(value: unknown, index: number) {
  const root = object(value);
  const tool = object(root?.function) ?? root;
  return {
    name: typeof tool?.name === "string" ? tool.name : `tool-${index + 1}`,
    ...(typeof tool?.description === "string"
      ? { description: tool.description }
      : {}),
    schema: tool?.parameters ?? tool?.input_schema ?? value,
  };
}
function categoryOf(type: string): SurfaceNode["cat"] {
  if (type === "human") return "user";
  if (type === "ai") return "assistant";
  if (type === "tool" || type === "function") return "tool";
  return "inject";
}

function messageView(
  message: ContextRequestInput["messages"][number][number],
  seq: number,
  time: number,
) {
  const cat = categoryOf(message.type);
  const content = Array.isArray(message.data.content)
    ? message.data.content
    : [{ type: "text", text: textOf(message.data.content) }];
  const text = content
    .flatMap((block) => {
      const item = object(block);
      return item?.type === "text" && typeof item.text === "string"
        ? [item.text]
        : [];
    })
    .join("\n");
  const calls = Array.isArray(message.data.tool_calls)
    ? message.data.tool_calls
    : [];
  const blocks: unknown[] = [
    ...content,
    ...calls.map((call) => {
      const item = object(call);
      return {
        type: "tool-call",
        name: item?.name,
        argsRaw: textOf(item?.args),
        id: item?.id,
      };
    }),
  ];
  const node: SurfaceNode = {
    seq,
    time,
    cat,
    text,
    tokens: estimateTextTokens(JSON.stringify(message.data)),
    ...(typeof message.data.name === "string"
      ? { tool: message.data.name }
      : {}),
    ...(calls.length
      ? { calls: calls.map((c) => String(object(c)?.name ?? "tool")) }
      : {}),
  };
  const conv: ConversationNodeLike = {
    seq,
    kind:
      cat === "tool"
        ? "tool-result"
        : cat === "assistant"
          ? "assistant"
          : "user",
    ...(cat === "assistant" ? { blocks } : { content: blocks }),
  };
  return { node, conv };
}

function inputHeader(input: ContextRequestInput) {
  const all = input.messages.flat();
  const system = all
    .filter((m) => m.type === "system")
    .map((m) => textOf(m.data.content))
    .join("\n\n");
  const tools = (input.tools ?? []).map(toolOf);
  const headerTools = tools.map((t, i) => ({
    name: t.name,
    tokens: estimateTextTokens(JSON.stringify(input.tools?.[i])),
  }));
  return {
    system,
    tools,
    systemTokens: estimateSystemTokens(system),
    headerTools,
    messages: all.filter((m) => m.type !== "system"),
  };
}

function requestRecord(
  summary: ContextRequestSummary,
  seq: number,
  parts: ContextTimeline["current"],
): RequestRecord {
  const time = Date.parse(summary.startedAt);
  return {
    ...parts,
    seq,
    time,
    step: summary.sequence,
    ...(summary.usage
      ? {
          prompt: summary.usage.inputTokens,
          output: summary.usage.outputTokens,
          ...(summary.usage.cachedInputTokens !== undefined
            ? { cacheRead: summary.usage.cachedInputTokens }
            : {}),
        }
      : {}),
    ...(summary.endedAt
      ? { activeMs: Math.max(0, Date.parse(summary.endedAt) - time) }
      : {}),
  };
}

function emptyParts(): ContextTimeline["current"] {
  return {
    system: 0,
    tools: 0,
    user: 0,
    inject: 0,
    skill: 0,
    assistant: 0,
    tool: 0,
    total: 0,
  };
}

/** 序号只用于重建已冻结请求；只复用相邻快照中未变化的消息前缀。 */
export interface InspectionTimeline {
  timeline: ContextTimeline;
  headers: ContextHeaders;
  headerContent: Map<number, HeaderEpochContent>;
  convNodes: ConversationNodeLike[];
  seqByRequest: Map<string, number>;
  idBySeq: Map<number, string>;
}
export function buildContextTimeline(
  values: InspectedRequest[],
): InspectionTimeline {
  const sorted = [...values].sort(
    (a, b) => a.summary.sequence - b.summary.sequence,
  );
  if (
    sorted.some(
      (r) =>
        r.summary.runId !== sorted[0]?.summary.runId ||
        r.summary.agentCallId !== sorted[0]?.summary.agentCallId ||
        r.summary.purpose !== sorted[0]?.summary.purpose,
    )
  )
    throw new Error("请选择同一 Run、Agent 和用途的请求。");
  const nodes: SurfaceNode[] = [];
  const archive: SurfaceNode[] = [];
  const convNodes: ConversationNodeLike[] = [];
  const headers: ContextHeaders = { headers: [] };
  const headerContent = new Map<number, HeaderEpochContent>();
  const seqByRequest = new Map<string, number>();
  const idBySeq = new Map<number, string>();
  const requests: RequestRecord[] = [];
  let sequence = 0;
  let previous: { key: string; node: SurfaceNode }[] = [];
  for (const { summary, input } of sorted) {
    const headerSeq = ++sequence;
    const time = Date.parse(summary.startedAt);
    const { system, tools, systemTokens, headerTools, messages } =
      inputHeader(input);
    headers.headers.push({
      seq: headerSeq,
      time,
      ...(systemTokens > 0 ? { systemTokens } : {}),
      tools: headerTools,
    });
    headerContent.set(headerSeq, { system, tools });
    let prefix = true;
    const current = messages.map((message, index) => {
      const key = JSON.stringify(message);
      const prior = previous[index];
      if (prefix && prior?.key === key) return prior;
      prefix = false;
      const { node, conv } = messageView(message, ++sequence, time);
      convNodes.push(conv);
      return { key, node };
    });
    const retained = new Set(current.map((n) => n.node));
    for (const old of previous)
      if (!retained.has(old.node))
        archive.push({ ...old.node, gone: headerSeq });
    previous = current;
    const parts = emptyParts();
    parts.system = systemTokens;
    parts.tools = headerTools.reduce((sum, t) => sum + t.tokens, 0);
    for (const { node } of current) parts[node.cat] += node.tokens;
    parts.total = Object.values(parts).reduce((sum, n) => sum + n, 0);
    const seq = ++sequence;
    requests.push(requestRecord(summary, seq, parts));
    seqByRequest.set(summary.id, seq);
    idBySeq.set(seq, summary.id);
  }
  nodes.push(...previous.map((p) => p.node));
  const last = requests.at(-1);
  const current = last
    ? {
        system: last.system,
        tools: last.tools,
        user: last.user,
        inject: last.inject,
        skill: last.skill ?? 0,
        assistant: last.assistant,
        tool: last.tool,
        total: last.total,
      }
    : emptyParts();
  const timeline: ContextTimeline = {
    ok: true,
    current,
    nodes,
    archive,
    droppedNodes: 0,
    requests,
    events: [],
    ...(sorted.at(-1)?.input.model
      ? { model: sorted.at(-1)?.input.model ?? "" }
      : {}),
  };
  return { timeline, headers, headerContent, convNodes, seqByRequest, idBySeq };
}
