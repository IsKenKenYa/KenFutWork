import type { StreamEvent } from "@kenfutwork/shared";
import { streamEventSchema } from "@kenfutwork/shared";
import type { RunUsageTotals } from "../features/usage/run-usage-accumulator.js";
import type { CompactionPlan } from "./auto-compact.js";
import type { AgentContextHistory } from "./context-history.js";
import type { ModelCallUsage } from "./model-call-usage.js";
import type { CompositionPart } from "./prompt-composition.js";
import { withStreamIdleGuard } from "./stream-idle-guard.js";
import type { ProviderToolReceiptGate } from "./tool-execution-receipts.js";

/** Product input data; conversion to SDK messages belongs solely to an adapter. */
export interface AgentProviderMessage {
  id?: string;
  content: string | Array<Record<string, unknown>>;
}
export interface AgentProviderInput {
  messages: AgentProviderMessage[];
}
export interface AgentProviderTools {
  catalog: ReadonlyArray<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  /** Host-owned executor activity includes genuine permission waits. */
  isExecuting?(): boolean;
  /** Private host binds real Task/Actor/schema/admission/claim; Provider cannot supply those facts. */
  execute(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ): Promise<unknown>;
}
export interface AgentProviderContext {
  /** Composed product prompt; adapters receive the same role/project/plugin instructions. */
  systemPrompt: string;
  runId: string;
  sessionId: string;
  conversationId: string;
  tools: AgentProviderTools;
  signal?: AbortSignal;
  now?: () => string;
  onUsage?: (usage: ModelCallUsage) => RunUsageTotals | undefined;
  toolComposition?: readonly CompositionPart[];
  autoCompact?: CompactionPlan;
  idleTimeoutMs?: number;
  abortRun?: () => void;
}
export interface AgentProviderSession {
  stream(input: AgentProviderInput): AsyncIterable<StreamEvent>;
  /** Unavailable maintenance is explicit; native checkpoint formats remain adapter-owned. */
  contextHistory?: AgentContextHistory;
  release?(): void;
}
export interface AgentRuntimeProvider {
  id: string;
  open(
    context: AgentProviderContext,
  ): AgentProviderSession | Promise<AgentProviderSession>;
}

/** Opening is one guarded upstream wait. Unknown outcomes are never replayed. */
export async function openAgentProviderSession(
  provider: AgentRuntimeProvider,
  context: AgentProviderContext,
  toolReceipts?: ProviderToolReceiptGate,
): Promise<AgentProviderSession | undefined> {
  if (context.signal?.aborted) return undefined;
  let accepted = false;
  let abandoned = false;
  let candidate: AgentProviderSession | undefined;
  const release = (session: AgentProviderSession) => {
    try {
      void Promise.resolve(session.release?.()).catch(() => {});
    } catch {
      /* best effort; late cleanup cannot block host settlement */
    }
  };
  const pending = Promise.resolve().then(() => provider.open(context));
  void pending.then(
    (session) => {
      candidate = session;
      if (abandoned) release(session);
    },
    () => {},
  );
  const source: AsyncIterable<AgentProviderSession> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: await pending }),
    }),
  };
  try {
    for await (const session of withStreamIdleGuard(source, {
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.idleTimeoutMs === undefined
        ? {}
        : { idleMs: context.idleTimeoutMs }),
      ...(context.abortRun ? { onIdle: context.abortRun } : {}),
      ...(toolReceipts
        ? { onIdleStateChange: toolReceipts.onActivityChange }
        : {}),
      idleEnabled: () =>
        !context.tools.isExecuting?.() && !toolReceipts?.isExecuting(),
    })) {
      if (context.signal?.aborted) return undefined;
      accepted = true;
      return session;
    }
    return undefined;
  } finally {
    if (!accepted) {
      abandoned = true;
      if (candidate) release(candidate);
    }
  }
}

/** Validate product protocol and per-frame identity; host owns continuation/admission/terminal persistence. */
export async function* consumeAgentProviderStream(
  session: AgentProviderSession,
  input: AgentProviderInput,
  context: Pick<
    AgentProviderContext,
    "runId" | "sessionId" | "conversationId"
  > &
    Partial<AgentProviderContext>,
  toolReceipts?: ProviderToolReceiptGate,
): AsyncGenerator<StreamEvent> {
  if (context.signal?.aborted) {
    yield {
      type: "run.canceled",
      stopReason: cancellationReason(context.signal),
      runId: context.runId,
      timestamp: context.now?.() ?? new Date().toISOString(),
    };
    return;
  }
  let started = false;
  let terminal = false;
  const iterator = session.stream(input)[Symbol.asyncIterator]();
  // Provider cleanup may itself wait for an uncooperative pending next(); never block host settlement.
  const source: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => iterator.next(),
      return: async () => {
        try {
          void Promise.resolve(iterator.return?.()).catch(() => {});
        } catch {
          /* best effort */
        }
        return { done: true, value: undefined };
      },
    }),
  };
  for await (const value of withStreamIdleGuard(source, {
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.idleTimeoutMs === undefined
      ? {}
      : { idleMs: context.idleTimeoutMs }),
    ...(context.abortRun ? { onIdle: context.abortRun } : {}),
    ...(toolReceipts
      ? { onIdleStateChange: toolReceipts.onActivityChange }
      : {}),
    idleEnabled: () =>
      !context.tools?.isExecuting?.() && !toolReceipts?.isExecuting(),
  })) {
    if (context.signal?.aborted) break;
    const event = streamEventSchema.parse(value);
    if (
      (!started && event.type !== "run.started") ||
      (started && event.type === "run.started")
    )
      throw new Error("Provider开始事件缺失或重复。");
    if (event.type === "run.started") started = true;
    if (event.runId !== context.runId || terminal)
      throw new Error("Provider事件不属于当前运行或发生在终态之后。");
    if (
      event.type === "run.started" &&
      (event.sessionId !== context.sessionId ||
        event.conversationId !== context.conversationId)
    )
      throw new Error("Provider事件不属于当前Task会话。");
    for (const actual of toolReceipts?.drain() ?? []) yield actual;
    if (event.type === "tool.started" || event.type === "tool.completed") {
      if (
        !toolReceipts &&
        event.type === "tool.completed" &&
        event.status === "success"
      )
        throw new Error("工具成功事件缺少真实执行结果。");
      toolReceipts?.verify(event);
      if (toolReceipts) continue;
    }
    if (event.type === "run.completed" && toolReceipts?.isExecuting()) {
      context.abortRun?.();
      throw new Error("真实工具调用尚未结算，不能完成当前Run。");
    }
    terminal =
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.canceled";
    yield event.type === "run.completed"
      ? { ...event, stopReason: event.stopReason ?? "completed" }
      : event.type === "run.canceled"
        ? {
            ...event,
            stopReason: event.stopReason ?? cancellationReason(context.signal),
          }
        : event;
    if (terminal) return;
  }
  if (context.signal?.aborted) {
    yield {
      type: "run.canceled",
      stopReason: cancellationReason(context.signal),
      runId: context.runId,
      timestamp: context.now?.() ?? new Date().toISOString(),
    };
    return;
  }
  if (!terminal) throw new Error("Provider流结束但没有运行终态。");
}

function cancellationReason(
  signal?: AbortSignal,
): "user_cancelled" | "task_stopped" | "host_shutdown" {
  return signal?.reason === "task_stopped" || signal?.reason === "host_shutdown"
    ? signal.reason
    : "user_cancelled";
}
