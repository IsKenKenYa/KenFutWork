import { randomUUID } from "node:crypto";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import type {
  ApprovalIdentity,
  ApprovalResolution,
} from "../permissions/approval-types.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionInput,
  type AskUserQuestionOutput,
  askUserQuestionAnnotationSchema,
  askUserQuestionInputSchema,
  projectAskUserQuestionInput,
} from "./user-input-schema.js";
import type {
  BoundUserInputRequest,
  CodeUserInputService,
  UserInputAction,
  UserInputEvent,
  UserInputInvocation,
  UserInputResolutionResult,
} from "./user-input-types.js";

interface UserInputCall {
  request: BoundUserInputRequest;
  input: AskUserQuestionInput;
  signature: string;
  state: "pending" | "resolving" | "cancelling" | "settled" | "cancelled";
  wait: Promise<AskUserQuestionOutput>;
  finish(result: AskUserQuestionOutput): void;
  fail(error: Error): void;
  publication: Promise<void>;
  resolution?: Promise<UserInputResolutionResult> | undefined;
  cancellation?: Promise<void> | undefined;
  cancellationReason?: string | undefined;
}

function boundIdentity(input: UserInputInvocation): ApprovalIdentity {
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
  };
}

function callKey(identity: ApprovalIdentity): string {
  return JSON.stringify([
    identity.instanceId,
    identity.taskId,
    identity.runId,
    identity.agentId,
    identity.toolCallId,
  ]);
}

function sameBinding(call: UserInputCall, input: ApprovalResolution): boolean {
  return (
    [
      "instanceId",
      "taskId",
      "runId",
      "scopeGeneration",
      "branchGeneration",
    ] as const
  ).every((key) => call.request.identity[key] === input.binding?.[key]);
}

function cancelled(reason: string): Error {
  const error = new Error(reason);
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function answerText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    return null;
  return value.filter((item: string) => item.trim()).join(", ") || undefined;
}

function responseAnswers(
  input: AskUserQuestionInput,
  content: Record<string, unknown>,
): Record<string, string> | undefined {
  const entries: [string, string][] = [];
  if (Object.hasOwn(content, "answers")) {
    if (!isRecord(content.answers)) return undefined;
    for (const [question, value] of Object.entries(content.answers)) {
      if (typeof value !== "string") return undefined;
      entries.push([question, value]);
    }
  } else {
    for (const [index, question] of input.questions.entries()) {
      const key = `answer_${index}`;
      const value = Object.hasOwn(content, key)
        ? content[key]
        : input.questions.length === 1
          ? content.answer
          : undefined;
      const normalized = answerText(value);
      if (normalized === null) return undefined;
      if (normalized !== undefined)
        entries.push([question.question, normalized]);
    }
  }
  // 安全自有键也保留合法题文__proto__；不经Zod record输出再解析，否则该键会被跳过。
  return Object.fromEntries(entries);
}

function responseAnnotations(
  content: Record<string, unknown>,
): AskUserQuestionOutput["annotations"] | null {
  if (!Object.hasOwn(content, "annotations")) return undefined;
  if (!isRecord(content.annotations)) return null;
  const entries: [
    string,
    NonNullable<AskUserQuestionOutput["annotations"]>[string],
  ][] = [];
  for (const [question, value] of Object.entries(content.annotations)) {
    const annotation = askUserQuestionAnnotationSchema.safeParse(value);
    if (!annotation.success) return null;
    entries.push([question, annotation.data]);
  }
  return Object.fromEntries(entries);
}

/** 原Elicitation answers/answer_N/answer兼容形状，只收本次真实人类响应。 */
function responseResult(
  input: AskUserQuestionInput,
  answer: ApprovalResolution["answer"],
): { action: UserInputAction; result: AskUserQuestionOutput } | undefined {
  const text = answer.freeText;
  const action =
    answer.action ??
    (text?.trim() ||
    answer.optionId === "allowOnce" ||
    answer.optionId === "allowAlways"
      ? "accept"
      : answer.optionId === "deny"
        ? "decline"
        : undefined);
  if (!action) return undefined;
  const content: Record<string, unknown> =
    answer.content ?? (text ? { answer: text } : {});
  if (!isRecord(content)) return undefined;
  const answers =
    action === "accept" || Object.hasOwn(content, "answers")
      ? responseAnswers(input, content)
      : {};
  const annotations = responseAnnotations(content);
  if (!answers || annotations === null) return undefined;
  return {
    action,
    result: {
      questions: input.questions,
      answers: action === "accept" ? answers : {},
      ...(action === "accept" && annotations !== undefined
        ? { annotations }
        : {}),
    },
  };
}

function createRequest(
  identity: ApprovalIdentity,
  input: AskUserQuestionInput,
): BoundUserInputRequest {
  const display = projectAskUserQuestionInput(input);
  return {
    identity: Object.freeze(identity),
    parameterFingerprint: parameterFingerprint(input),
    interaction: {
      interactionId: randomUUID(),
      kind: "userInput",
      anchorRowId: null,
      createdAt: Date.now(),
      payload: {
        kind: "userInput",
        prompt: input.questions[0]?.question ?? "",
        freeText: true,
        toolName: ASK_USER_QUESTION_TOOL_NAME,
        toolCallId: identity.toolCallId,
        traceId: identity.runId,
        input: display,
        questions: input.questions.map((question) => ({
          question: question.question,
          header: question.header,
          multiSelect: question.multiSelect,
          options: question.options.map((option) => ({
            ...option,
            value: option.label,
          })),
        })),
      },
    },
  };
}

/** 单kernel broker；持久投影成功后才完成同一工具等待，不创建另一条Run。 */
export function createUserInputBroker(): CodeUserInputService {
  const calls = new Map<string, UserInputCall>();
  const interactions = new Map<string, UserInputCall>();
  const listeners = new Set<(event: UserInputEvent) => void | Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  async function emit(event: UserInputEvent) {
    for (const listener of listeners) await listener(structuredClone(event));
  }

  function cancelCall(call: UserInputCall, reason: string): Promise<void> {
    if (call.state === "settled" || call.state === "cancelled")
      return Promise.resolve();
    if (call.cancellation) return call.cancellation;
    call.cancellationReason ??= reason;
    const firstReason = call.cancellationReason;
    const resolution = call.resolution;
    if (call.state === "pending") call.state = "cancelling";
    call.cancellation = Promise.resolve()
      .then(async () => {
        // 请求的原发布promise不依赖取消；失败也必须先结束，避免事件倒序与依赖环。
        await call.publication.catch(() => {});
        await resolution?.catch(() => {});
        if (call.state === "settled" || call.state === "cancelled") return;
        call.state = "cancelling";
        try {
          await emit({
            ...call.request,
            type: "cancelled",
            reason: firstReason,
          });
          call.state = "cancelled";
        } finally {
          call.fail(cancelled(firstReason));
        }
      })
      .catch((error: unknown) => {
        call.cancellation = undefined;
        throw error;
      });
    return call.cancellation;
  }

  async function waitForCall(call: UserInputCall) {
    try {
      await call.publication;
    } catch (error) {
      await cancelCall(call, "结构化问题发布失败，未继续工具调用。").catch(
        () => {},
      );
      throw error;
    }
    return structuredClone(await call.wait);
  }

  async function waitForResolution(
    call: UserInputCall,
    resolution: Promise<UserInputResolutionResult>,
  ) {
    try {
      return await resolution;
    } catch (error) {
      await cancelCall(call, "结构化答案发布失败，未继续工具调用。").catch(
        () => {},
      );
      throw error;
    }
  }

  const service: CodeUserInputService = {
    async request(invocation) {
      if (closed) throw cancelled("结构化提问宿主已关闭。");
      invocation.signal.throwIfAborted();
      if (
        invocation.preset !== "code" ||
        invocation.toolName !== ASK_USER_QUESTION_TOOL_NAME ||
        invocation.access !== "read"
      )
        throw new Error("结构化提问缺少可信Code工具调用上下文。");
      const input = askUserQuestionInputSchema.parse(invocation.args);
      const identity = boundIdentity(invocation);
      const key = callKey(identity);
      const signature = parameterFingerprint({ identity, input });
      const previous = calls.get(key);
      if (previous) {
        if (previous.signature !== signature)
          throw new Error("同一工具调用的身份或问题已改变，原答案不能复用。");
        return waitForCall(previous);
      }
      if (!listeners.size)
        throw new Error("结构化提问的持久投影消费者未装配。");
      let finish!: UserInputCall["finish"];
      let fail!: UserInputCall["fail"];
      const wait = new Promise<AskUserQuestionOutput>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      // 请求发布期间也可能被取消；保留拒绝供实际caller接收，但不产生孤立reject。
      void wait.catch(() => {});
      const call: UserInputCall = {
        request: createRequest(identity, input),
        input,
        signature,
        state: "pending",
        wait,
        finish,
        fail,
        publication: Promise.resolve(),
      };
      const abort = () => {
        void cancelCall(call, "此Run已停止，问题等待已取消。").catch(() => {});
      };
      const release = () =>
        invocation.signal.removeEventListener("abort", abort);
      call.finish = (result) => {
        release();
        finish(result);
      };
      call.fail = (error) => {
        release();
        fail(error);
      };
      call.publication = Promise.resolve().then(() =>
        emit({ ...call.request, type: "requested" }),
      );
      calls.set(key, call);
      interactions.set(call.request.interaction.interactionId, call);
      invocation.signal.addEventListener("abort", abort, { once: true });
      return waitForCall(call);
    },
    async resolve(input): Promise<UserInputResolutionResult> {
      const call = interactions.get(input.interactionId);
      if (!call) return { status: "rejected", reasonCode: "not_found" };
      if (!sameBinding(call, input))
        return { status: "rejected", reasonCode: "proto.invalidBinding" };
      if (call.state !== "pending") {
        if (call.state === "resolving" && call.resolution)
          await waitForResolution(call, call.resolution);
        if (call.state === "cancelling")
          await cancelCall(call, "结构化问题等待已取消。");
        return {
          status: "alreadyResolved",
          reasonCode: "proto.alreadyResolved",
        };
      }
      const response = responseResult(call.input, input.answer);
      if (!response)
        return { status: "rejected", reasonCode: "proto.invalidAnswer" };
      call.state = "resolving";
      const resolution = Promise.resolve().then(
        async (): Promise<UserInputResolutionResult> => {
          await call.publication;
          await emit({ ...call.request, type: "resolved", ...response });
          call.state = "settled";
          call.finish(response.result);
          return { status: "resolved", action: response.action };
        },
      );
      call.resolution = resolution;
      return waitForResolution(call, resolution);
    },
    listPending(instanceId, taskId) {
      return [...interactions.values()]
        .filter(
          (call) =>
            call.state === "pending" &&
            call.request.identity.instanceId === instanceId &&
            call.request.identity.taskId === taskId,
        )
        .map((call) => structuredClone(call.request));
    },
    find(instanceId, taskId, interactionId) {
      const call = interactions.get(interactionId);
      return call &&
        call.request.identity.instanceId === instanceId &&
        call.request.identity.taskId === taskId
        ? structuredClone(call.request)
        : undefined;
    },
    async cancel(selector, reason) {
      const selected = [...interactions.values()].filter((call) =>
        Object.entries(selector).every(
          ([key, value]) =>
            call.request.identity[key as keyof ApprovalIdentity] === value,
        ),
      );
      const results = await Promise.allSettled(
        selected.map((call) => cancelCall(call, reason)),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, "部分结构化问题尚未确认取消。");
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(reason) {
      closed = true;
      closing ??= Promise.allSettled(
        [...interactions.values()].map((call) => cancelCall(call, reason)),
      ).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          closing = undefined;
          throw new AggregateError(failures, "结构化提问宿主尚未确认关闭。");
        }
      });
      return closing;
    },
  };
  return service;
}
