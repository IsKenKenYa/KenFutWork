import { isDeepStrictEqual } from "node:util";
import type { StreamEvent } from "@kenfutwork/shared";
import type { ExecutionScopeHandle } from "../features/execution/scope-service.js";
import type { ToolExecutionObservation } from "../kernel/types.js";

export type ProductToolEvent = Extract<
  StreamEvent,
  { type: "tool.started" | "tool.completed" }
>;
export interface ProviderToolReceiptGate {
  drain(): ProductToolEvent[];
  verify(event: ProductToolEvent): void;
  isExecuting(): boolean;
  onActivityChange(listener: () => void): () => void;
}
export interface NativeToolProof {
  toolName: string;
  toolCallId: string;
  registered: boolean;
  events: ProductToolEvent[];
}

/** Host-only authority; neither proof minting nor private Task bindings are exposed to Providers. */
export function createToolExecutionReceipts(options: {
  runId: string;
  scopeHandle?: ExecutionScopeHandle;
  project(fact: ToolExecutionObservation): Promise<ProductToolEvent[]>;
  publish(event: ProductToolEvent): Promise<void>;
}) {
  const completed = new Map<string, ProductToolEvent>();
  const started = new Set<string>();
  const pending: ProductToolEvent[] = [];
  const activityListeners = new Set<() => void>();
  const key = (event: ProductToolEvent) =>
    JSON.stringify([event.toolCallId, event.agentCallId ?? ""]);
  const emit = async (event: ProductToolEvent) => {
    if (event.runId !== options.runId)
      throw new Error("工具执行事实不属于当前Run。");
    const id = key(event);
    if (event.type === "tool.started") {
      if (started.has(id)) return;
      started.add(id);
    } else {
      const previous = completed.get(id);
      if (previous) return;
      completed.set(id, structuredClone(event));
    }
    for (const listener of activityListeners) listener();
    const immutable = structuredClone(event);
    pending.push(immutable);
    await options.publish(immutable);
  };
  const verify = (event: ProductToolEvent) => {
    if (event.type === "tool.started") return;
    const actual = completed.get(key(event));
    if (!actual) {
      if (event.status === "error" || event.status === "cancelled") return;
      throw new Error("工具成功事件缺少真实执行结果。");
    }
    if (
      actual.type !== "tool.completed" ||
      actual.toolName !== event.toolName ||
      actual.status !== event.status
    )
      throw new Error("工具事件与真实执行身份或结果状态不一致。");
    if (actual.status !== "success") return;
    for (const field of [
      "output",
      "outputText",
      "outputSummary",
      "artifacts",
      "agentName",
      "agentCallId",
    ] as const)
      if (
        event[field] !== undefined &&
        !isDeepStrictEqual(event[field], actual[field])
      )
        throw new Error("工具事件替换了真实执行结果。");
  };
  return {
    async observe(fact: ToolExecutionObservation) {
      if (
        fact.runId !== options.runId ||
        !fact.toolCallId ||
        fact.scopeHandle !== options.scopeHandle
      )
        throw new Error("工具执行证明没有绑定当前Task/Run。");
      for (const event of await options.project(fact)) await emit(event);
    },
    async observeNative(proof: NativeToolProof) {
      if (proof.registered) {
        for (const event of proof.events)
          if (event.type === "tool.completed" && event.status === "success")
            verify(event);
        return;
      }
      for (const event of proof.events) await emit(event);
    },
    gate: {
      drain: () => pending.splice(0),
      verify,
      isExecuting: () => [...started].some((id) => !completed.has(id)),
      onActivityChange: (listener: () => void) => {
        activityListeners.add(listener);
        return () => {
          activityListeners.delete(listener);
        };
      },
    } satisfies ProviderToolReceiptGate,
  };
}
