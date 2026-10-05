import { describe, expect, it } from "vitest";
import type { ApprovalIdentity } from "../permissions/approval-types.js";
import { createUserInputBroker } from "./user-input-broker.js";
import type {
  CodeUserInputService,
  UserInputEvent,
  UserInputInvocation,
} from "./user-input-types.js";

const identity: ApprovalIdentity = {
  instanceId: "local-instance-question",
  taskId: "main-task-question",
  runId: "main-run-question",
  toolCallId: "original-question-call",
  agentId: "main",
  role: "main",
  scopeGeneration: 2,
  branchGeneration: 3,
};
const questionText = "两个模式如何共享运行能力？";
const questions = [
  {
    question: questionText,
    header: "运行能力",
    options: [
      { label: "共享内核", description: "共用内核并保留模式边界。" },
      { label: "分别运行", description: "两个模式分别维护运行能力。" },
    ],
    multiSelect: false,
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** 仅观察公开Promise的消费终态；不窥探broker内部状态。 */
function observeSettlement(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

function controlledPublications(broker: CodeUserInputService) {
  const requestedEntered = deferred<UserInputEvent>();
  const resolvedEntered = deferred<UserInputEvent>();
  const requestedPublication = deferred<void>();
  const resolvedPublication = deferred<void>();
  const started: UserInputEvent[] = [];
  const published: UserInputEvent[] = [];
  // 外部持久发布port：延迟回执由listener自身控制，不替换自家模块。
  const unsubscribe = broker.onEvent(async (event) => {
    started.push(event);
    if (event.type === "requested") {
      requestedEntered.resolve(event);
      await requestedPublication.promise;
    }
    if (event.type === "resolved") {
      resolvedEntered.resolve(event);
      await resolvedPublication.promise;
    }
    published.push(event);
  });
  return {
    requestedEntered,
    resolvedEntered,
    requestedPublication,
    resolvedPublication,
    started,
    published,
    unsubscribe,
  };
}

function resolveAnswer(
  broker: CodeUserInputService,
  interactionId: string,
  answer: string,
) {
  return broker.resolve({
    interactionId,
    binding: identity,
    answer: {
      action: "accept",
      content: { answers: { [questionText]: answer } },
    },
  });
}

function questionInvocation(signal: AbortSignal): UserInputInvocation {
  return {
    ...identity,
    preset: "code",
    mode: "build",
    approvalCeiling: "build",
    toolName: "AskUserQuestion",
    args: { questions },
    access: "read",
    signal,
  };
}

/** 真实broker的公开port契约；不作为HTTP/auth/原UI/模型回流证据。 */
describe("CodeUserInputService公开发布与结算", () => {
  it("取消发布失败可见且可重试，保留首取消原因并阻止迟到答案唤醒原调用", async () => {
    const broker = createUserInputBroker();
    const controller = new AbortController();
    const requestedEntered = deferred<UserInputEvent>();
    const events: UserInputEvent[] = [];
    const publicationFailure = new Error("取消事件持久发布失败");
    let rejectCancellation = true;
    const unsubscribe = broker.onEvent((event) => {
      events.push(event);
      if (event.type === "requested") requestedEntered.resolve(event);
      if (event.type === "cancelled" && rejectCancellation)
        throw publicationFailure;
    });
    const request = broker.request(questionInvocation(controller.signal));
    const outcome = request.then(
      (answer) => ({ status: "answered" as const, answer }),
      (error: unknown) => ({ status: "cancelled" as const, error }),
    );
    try {
      const requested = await Promise.race([
        requestedEntered.promise,
        request.then(() => {
          throw new Error("问题尚未发布，原调用已经返回答案。");
        }),
      ]);
      const interactionId = requested.interaction.interactionId;
      const selector = {
        instanceId: identity.instanceId,
        taskId: identity.taskId,
        runId: identity.runId,
      };
      await expect(
        broker.cancel(selector, "Task作用域已撤销"),
      ).rejects.toMatchObject({
        name: "AggregateError",
        errors: [publicationFailure],
      });
      expect(await outcome).toMatchObject({
        status: "cancelled",
        error: { name: "AbortError", message: "Task作用域已撤销" },
      });
      expect(broker.listPending(identity.instanceId, identity.taskId)).toEqual(
        [],
      );
      expect(
        broker.find(identity.instanceId, identity.taskId, interactionId),
      ).toMatchObject({
        identity,
        interaction: { interactionId },
      });

      rejectCancellation = false;
      await broker.cancel(selector, "重试取消不能改变首次原因");
      expect(
        events.flatMap((event) =>
          event.type === "cancelled" ? [event.reason] : [],
        ),
      ).toEqual(["Task作用域已撤销", "Task作用域已撤销"]);
      expect(await resolveAnswer(broker, interactionId, "迟到答案")).toEqual({
        status: "alreadyResolved",
        reasonCode: "proto.alreadyResolved",
      });
      await expect(
        broker.request(questionInvocation(controller.signal)),
      ).rejects.toMatchObject({
        name: "AbortError",
        message: "Task作用域已撤销",
      });
      expect(events.map((event) => event.type)).toEqual([
        "requested",
        "cancelled",
        "cancelled",
      ]);
    } finally {
      rejectCancellation = false;
      await broker.close("test cleanup");
      await outcome;
      unsubscribe();
    }
  });
  it("requested先完成持久发布，resolved发布完成前请求与不同答案的并发回执均等待，首答案唯一结算", async () => {
    const broker = createUserInputBroker();
    const controller = new AbortController();
    const invocation = questionInvocation(controller.signal);
    const publication = controlledPublications(broker);
    const request = broker.request(invocation);
    const requestState = observeSettlement(request);
    const completions: Promise<unknown>[] = [request];
    try {
      const requested = await Promise.race([
        publication.requestedEntered.promise,
        request.then(() => {
          throw new Error("尚未发布问题，请求就提前完成。");
        }),
      ]);
      expect(requested).toMatchObject({
        type: "requested",
        identity,
        interaction: {
          kind: "userInput",
          payload: {
            kind: "userInput",
            toolName: "AskUserQuestion",
            toolCallId: identity.toolCallId,
            questions: [{ question: questionText, header: "运行能力" }],
          },
        },
      });
      const interactionId = requested.interaction.interactionId;
      expect(
        broker.listPending(identity.instanceId, identity.taskId),
      ).toHaveLength(1);
      expect(
        broker.find(identity.instanceId, identity.taskId, interactionId),
      ).toMatchObject({ identity, interaction: { interactionId } });
      const first = resolveAnswer(broker, interactionId, "共享内核");
      const second = resolveAnswer(broker, interactionId, "分别运行");
      completions.push(first, second);
      const firstState = observeSettlement(first);
      const secondState = observeSettlement(second);
      const states = [requestState, firstState, secondState];
      await Promise.resolve();
      expect(publication.started.map((event) => event.type)).toEqual([
        "requested",
      ]);
      expect(publication.published).toEqual([]);
      expect(states.map((state) => state.settled)).toEqual([
        false,
        false,
        false,
      ]);

      publication.requestedPublication.resolve(undefined);
      const resolving = await Promise.race([
        publication.resolvedEntered.promise,
        first.then(() => {
          throw new Error("答案尚未发布，回执就提前完成。");
        }),
      ]);
      expect(resolving).toMatchObject({
        type: "resolved",
        action: "accept",
        identity,
        result: { questions, answers: { [questionText]: "共享内核" } },
      });
      expect(publication.started.map((event) => event.type)).toEqual([
        "requested",
        "resolved",
      ]);
      expect(publication.published.map((event) => event.type)).toEqual([
        "requested",
      ]);
      expect(states.map((state) => state.settled)).toEqual([
        false,
        false,
        false,
      ]);

      publication.resolvedPublication.resolve(undefined);
      const [firstResult, secondResult, answer] = await Promise.all([
        first,
        second,
        request,
      ]);
      expect(firstResult).toEqual({ status: "resolved", action: "accept" });
      expect(secondResult).toEqual({
        status: "alreadyResolved",
        reasonCode: "proto.alreadyResolved",
      });
      expect(answer).toEqual({
        questions,
        answers: { [questionText]: "共享内核" },
      });
      expect(publication.published.map((event) => event.type)).toEqual([
        "requested",
        "resolved",
      ]);
      expect(broker.listPending(identity.instanceId, identity.taskId)).toEqual(
        [],
      );
      expect(
        broker.find(identity.instanceId, identity.taskId, interactionId),
      ).toMatchObject({ identity, interaction: { interactionId } });
    } finally {
      publication.requestedPublication.resolve(undefined);
      publication.resolvedPublication.resolve(undefined);
      controller.abort();
      await broker.close("test cleanup");
      await Promise.allSettled(completions);
      publication.unsubscribe();
    }
  });
  it("caller修改已返回答案、嵌套注解和问题后，同一合法工具调用重放仍返回首次Alpha与原始内容", async () => {
    const broker = createUserInputBroker();
    const controller = new AbortController();
    const invocation = questionInvocation(controller.signal);
    const requestedEntered = deferred<UserInputEvent>();
    const events: UserInputEvent[] = [];
    const unsubscribe = broker.onEvent((event) => {
      events.push(event);
      if (event.type === "requested") requestedEntered.resolve(event);
    });
    const request = broker.request(invocation);
    observeSettlement(request);
    const expected = {
      questions: structuredClone(questions),
      answers: { [questionText]: "Alpha" },
      annotations: {
        [questionText]: {
          notes: "首次人类注解",
          preview: "首次选项预览",
        },
      },
    };
    try {
      const requested = await Promise.race([
        requestedEntered.promise,
        request.then(() => {
          throw new Error("问题发布之前请求已完成。");
        }),
      ]);
      const interactionId = requested.interaction.interactionId;
      expect(
        await broker.resolve({
          interactionId,
          binding: identity,
          answer: {
            action: "accept",
            content: {
              answers: expected.answers,
              annotations: expected.annotations,
            },
          },
        }),
      ).toEqual({ status: "resolved", action: "accept" });
      const answer = await request;
      expect(answer).toEqual(expected);

      answer.answers[questionText] = "Beta";
      const annotation = answer.annotations?.[questionText];
      const question = answer.questions[0];
      const option = question?.options[0];
      if (!annotation || !question || !option)
        throw new Error("首次返回缺少本案注解与问题，无法执行caller修改");
      annotation.notes = "caller修改的注解";
      annotation.preview = "caller修改的预览";
      question.question = "caller修改的问题";
      option.label = "caller修改的选项";

      expect(
        events.flatMap((event) =>
          event.type === "resolved" ? [event.result] : [],
        ),
      ).toEqual([expected]);
      expect(
        broker.find(identity.instanceId, identity.taskId, interactionId),
      ).toMatchObject({
        identity,
        interaction: {
          payload: {
            questions: [
              {
                question: questionText,
                options: [{ label: "共享内核" }, { label: "分别运行" }],
              },
            ],
          },
        },
      });
      const replay = await broker.request(invocation);
      expect(replay).toEqual(expected);
      expect(events.map((event) => event.type)).toEqual([
        "requested",
        "resolved",
      ]);
    } finally {
      controller.abort();
      await broker.close("test cleanup");
      await Promise.allSettled([request]);
      unsubscribe();
    }
  });
  it("模型预填不当人答，用户显式空answers与annotations不被answer_0或answer补回，同call只发布一次", async () => {
    const broker = createUserInputBroker();
    const controller = new AbortController();
    const invocation: UserInputInvocation = {
      ...questionInvocation(controller.signal),
      args: {
        questions,
        answers: { [questionText]: "模型预填答案" },
        annotations: {
          [questionText]: {
            notes: "模型预填注解",
            preview: "模型预填预览",
          },
        },
      },
    };
    const publication = controlledPublications(broker);
    publication.requestedPublication.resolve(undefined);
    publication.resolvedPublication.resolve(undefined);
    const request = broker.request(invocation);
    const requestState = observeSettlement(request);
    const expected = { questions, answers: {}, annotations: {} };
    try {
      const requested = await Promise.race([
        publication.requestedEntered.promise,
        request.then(() => {
          throw new Error("真实人答尚未提交，请求就使用模型预填完成。");
        }),
      ]);
      const interactionId = requested.interaction.interactionId;
      expect(requested.interaction.payload.input).toEqual({ questions });
      expect(
        broker.find(identity.instanceId, identity.taskId, interactionId)
          ?.interaction.payload.input,
      ).toEqual({ questions });
      await Promise.resolve();
      expect(requestState.settled).toBe(false);
      expect(
        await broker.resolve({
          interactionId,
          binding: identity,
          answer: {
            action: "accept",
            content: {
              answers: {},
              annotations: {},
              answer_0: "兼容answer_0值不能回填",
              answer: "兼容单题answer值不能回填",
            },
          },
        }),
      ).toEqual({ status: "resolved", action: "accept" });
      expect(await request).toEqual(expected);
      expect(await broker.request(invocation)).toEqual(expected);
      expect(publication.published.map((event) => event.type)).toEqual([
        "requested",
        "resolved",
      ]);
      expect(
        publication.published.flatMap((event) =>
          event.type === "resolved" ? [event.result] : [],
        ),
      ).toEqual([expected]);
      expect(broker.listPending(identity.instanceId, identity.taskId)).toEqual(
        [],
      );
    } finally {
      publication.requestedPublication.resolve(undefined);
      publication.resolvedPublication.resolve(undefined);
      controller.abort();
      await broker.close("test cleanup");
      await Promise.allSettled([request]);
      publication.unsubscribe();
    }
  });
});
