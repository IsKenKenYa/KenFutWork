import { randomUUID } from "node:crypto";
import {
  createPlanApprovalRequest,
  planApprovalDecision,
} from "../code-ui/plan-approval.js";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import type {
  ApprovalEvent,
  ApprovalIdentity,
  ApprovalResolution,
  BoundApprovalRequest,
  CodeApprovalService,
  PermissionInvocation,
} from "./approval-types.js";
import { codePermissionPolicy } from "./code-policy.js";
import type { PermissionDecision } from "./permission-service.js";

interface ApprovalCall {
  request: BoundApprovalRequest;
  signature: string;
  state: "pending" | "resolving" | "allowed" | "denied" | "claimed";
  result: PermissionDecision;
  wait: Promise<PermissionDecision>;
  finish: (decision: PermissionDecision) => void;
}

function identity(input: PermissionInvocation): ApprovalIdentity {
  const {
    instanceId,
    taskId,
    runId,
    toolCallId,
    agentId,
    role,
    scopeGeneration,
    branchGeneration,
  } = input;
  return {
    instanceId,
    taskId,
    runId,
    toolCallId,
    agentId,
    role,
    scopeGeneration,
    branchGeneration,
    ...(input.planControl === "exit"
      ? { planningEpoch: input.planningEpoch }
      : {}),
  };
}

function callKey(input: ApprovalIdentity): string {
  return JSON.stringify([
    input.instanceId,
    input.taskId,
    input.runId,
    input.agentId,
    input.toolCallId,
  ]);
}

function signature(input: PermissionInvocation): string {
  return parameterFingerprint({
    identity: identity(input),
    toolName: input.toolName,
    args: input.args,
    access: input.access,
    planControl: input.planControl,
    readonlyExecution: input.readonlyExecution,
    approvalCeiling: input.approvalCeiling,
  });
}

function sameBinding(call: ApprovalCall, input: ApprovalResolution): boolean {
  const keys = [
    "instanceId",
    "taskId",
    "runId",
    "scopeGeneration",
    "branchGeneration",
  ] as const;
  return (
    (call.request.identity.planningEpoch === undefined ||
      call.request.identity.planningEpoch === input.binding.planningEpoch) &&
    keys.every((key) => call.request.identity[key] === input.binding?.[key])
  );
}

function deny(reason: string): PermissionDecision {
  return { decision: "deny", reason };
}

function answerDecision(
  answer: ApprovalResolution["answer"],
): "allow" | "deny" | undefined {
  if (answer.content && Object.keys(answer.content).length > 0)
    return undefined;
  if (
    answer.optionId !== undefined &&
    answer.optionId !== "allowOnce" &&
    answer.optionId !== "deny"
  )
    return undefined;
  const option =
    answer.optionId === "allowOnce"
      ? "allow"
      : answer.optionId === "deny"
        ? "deny"
        : undefined;
  const action =
    answer.action === "accept"
      ? "allow"
      : answer.action === "decline" || answer.action === "cancel"
        ? "deny"
        : undefined;
  if (option && action && option !== action) return undefined;
  return action ?? option;
}

function createRequest(input: PermissionInvocation): BoundApprovalRequest {
  if (input.planControl === "exit")
    return createPlanApprovalRequest(input, Object.freeze(identity(input)));
  return {
    identity: Object.freeze(identity(input)),
    parameterFingerprint: parameterFingerprint(input.args),
    interaction: {
      interactionId: randomUUID(),
      kind: "permission",
      anchorRowId: null,
      createdAt: Date.now(),
      payload: {
        kind: "permission",
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        summary: input.summary ?? `允许 ${input.toolName} 执行此操作？`,
        detail: structuredClone(input.displayArgs ?? input.args),
        ...(input.display ? { display: structuredClone(input.display) } : {}),
        options: [
          {
            optionId: "allowOnce",
            label: "本次允许",
            kind: "allowOnce",
            response: { decision: "allow" },
          },
          {
            optionId: "deny",
            label: "拒绝",
            kind: "deny",
            response: { decision: "deny" },
          },
        ],
      },
    },
  };
}

/** Broker for bound, in-process Code calls. No model-visible approval entry. */
export function createCodeApprovalService(): CodeApprovalService {
  const calls = new Map<string, ApprovalCall>();
  const interactions = new Map<string, ApprovalCall>();
  const automaticClaims = new Set<string>();
  const listeners = new Set<(event: ApprovalEvent) => void | Promise<void>>();

  async function emit(
    call: ApprovalCall,
    detail:
      | { type: "requested" }
      | { type: "resolved"; decision: "allow" | "deny" }
      | { type: "cancelled"; reason: string },
  ) {
    for (const listener of listeners)
      await listener({ ...structuredClone(call.request), ...detail });
  }

  function find(input: PermissionInvocation): ApprovalCall | undefined {
    return calls.get(callKey(input));
  }

  function conflict(
    call: ApprovalCall,
    input: PermissionInvocation,
  ): PermissionDecision | undefined {
    if (call.signature !== signature(input))
      return deny("同一工具调用的身份或参数已改变，原审批不能复用。");
    if (call.state === "claimed")
      return deny("此工具调用的授权已消费，不能再次执行。");
    return undefined;
  }

  async function cancelCall(call: ApprovalCall, reason: string) {
    if (call.state === "claimed" || call.state === "denied") return;
    call.state = "denied";
    call.result = deny(reason);
    try {
      await emit(call, { type: "cancelled", reason });
    } finally {
      call.finish(call.result);
    }
  }

  const service: CodeApprovalService = {
    async admit(input) {
      if (input.signal?.aborted)
        return deny("此 Run 已停止，审批不能恢复执行。");
      if (automaticClaims.has(callKey(input)))
        return deny("此工具调用的授权已消费，不能再次执行。");
      const previous = find(input);
      const changed = previous && conflict(previous, input);
      if (changed) return changed;
      const policy = codePermissionPolicy(input);
      if (policy === "deny")
        return deny("当前 Task 模式或角色不允许此工具效果，审批不能扩权。");
      if (previous)
        return previous.state === "pending" || previous.state === "resolving"
          ? previous.wait
          : previous.result;
      if (policy === "allow") return { decision: "allow" };
      let finish!: ApprovalCall["finish"];
      let releaseSignal = () => {};
      const wait = new Promise<PermissionDecision>((resolve) => {
        finish = (decision) => {
          releaseSignal();
          resolve(decision);
        };
      });
      const request = createRequest(input);
      const call: ApprovalCall = {
        request,
        signature: signature(input),
        state: "pending",
        result: deny("等待用户审批。"),
        wait,
        finish,
      };
      calls.set(callKey(input), call);
      interactions.set(request.interaction.interactionId, call);
      if (input.signal) {
        const signal = input.signal;
        const abort = () => {
          void cancelCall(call, "此 Run 已停止。").catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        releaseSignal = () => signal.removeEventListener("abort", abort);
      }
      try {
        await emit(call, { type: "requested" });
      } catch {
        await cancelCall(call, "审批请求发布失败，未授权执行。").catch(
          () => {},
        );
      }
      return wait;
    },
    peek(input) {
      if (input.signal?.aborted)
        return deny("此 Run 已停止，审批不能恢复执行。");
      if (automaticClaims.has(callKey(input)))
        return deny("此工具调用的授权已消费，不能再次执行。");
      const call = find(input);
      if (codePermissionPolicy(input) === "deny")
        return deny("当前 Task 模式或角色不允许此工具效果，审批不能扩权。");
      if (call) return conflict(call, input) ?? call.result;
      return codePermissionPolicy(input) === "allow"
        ? { decision: "allow" }
        : deny("等待用户审批。");
    },
    claim(input) {
      const result = service.peek(input);
      if (result.decision === "allow") {
        const call = find(input);
        if (call) call.state = "claimed";
        else automaticClaims.add(callKey(input));
      }
      return result;
    },
    async resolve(input) {
      const call = interactions.get(input.interactionId);
      if (!call) return { status: "rejected", reasonCode: "approval.notFound" };
      if (!sameBinding(call, input))
        return { status: "rejected", reasonCode: "approval.invalidBinding" };
      if (call.state !== "pending")
        return {
          status: "alreadyResolved",
          reasonCode: "proto.alreadyResolved",
        };
      const decision =
        call.request.interaction.kind === "userInput"
          ? planApprovalDecision(input.answer)
          : answerDecision(input.answer);
      if (!decision)
        return { status: "rejected", reasonCode: "approval.invalidAnswer" };
      const allowed = decision === "allow";
      call.state = "resolving";
      try {
        await emit(call, {
          type: "resolved",
          decision: allowed ? "allow" : "deny",
        });
        if (call.state === "resolving") {
          call.state = allowed ? "allowed" : "denied";
          call.result = allowed
            ? { decision: "allow" }
            : deny(input.answer.freeText ?? "用户拒绝此操作。");
        }
      } catch {
        call.state = "denied";
        call.result = deny("审批结果发布失败，未授权执行。");
      }
      call.finish(call.result);
      return { status: "resolved", decision: call.result.decision };
    },
    find(instanceId, taskId, interactionId) {
      const call = interactions.get(interactionId);
      if (
        !call ||
        call.request.identity.instanceId !== instanceId ||
        call.request.identity.taskId !== taskId
      )
        return undefined;
      return structuredClone(call.request);
    },
    listPending(instanceId, taskId) {
      return [...calls.values()]
        .filter(
          (call) =>
            call.state === "pending" &&
            call.request.identity.instanceId === instanceId &&
            call.request.identity.taskId === taskId,
        )
        .map((call) => structuredClone(call.request));
    },
    async cancel(selector, reason) {
      const affected = [...calls.values()].filter((call) =>
        Object.entries(selector).every(
          ([key, value]) =>
            call.request.identity[key as keyof ApprovalIdentity] === value,
        ),
      );
      await Promise.all(affected.map((call) => cancelCall(call, reason)));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return service;
}
