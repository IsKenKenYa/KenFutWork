import { createHash, randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import type { AgentRunService } from "../../agent/runtime.js";
import { createAssistantBlockCollector } from "../../ws/assistant-block-collector.js";
import type { ExecutionModeService } from "../agent-modes/execution-mode-service.js";
import type { AgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import type { ThreadService } from "../chat/thread-service.js";
import type { GoalFence } from "../goals/service.js";
import type { LocalAccessService } from "../local-access/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { TaskWorkManager } from "../task-work/types.js";
import type {
  DesignGoalsService,
  DesignInputOrigin,
} from "./design-goals-types.js";
import {
  type DesignModelSelection,
  designModelSpecifier,
} from "./design-model-selection.js";
import { designHostMessageId } from "./design-run-host-repository.js";
import type {
  DesignHostEvent,
  DesignHostRepository,
  DesignHostStoredInput,
  DesignRunHost,
} from "./design-run-host-types.js";
import { DesignTaskError } from "./design-task-errors.js";
import type { DesignTasksService } from "./design-task-types.js";
import type { ExecutionScopes } from "./scope-service.js";

type Active = {
  instanceId: string;
  taskId: string;
  runId: string;
  clientId: string | null;
  stopRequested: boolean;
  done: Promise<void>;
  settled: boolean;
  input?: DesignHostStoredInput;
  canvasId?: string;
  accepted: boolean;
  goalClaimed: boolean;
};
const keyOf = (instanceId: string, taskId: string) => `${instanceId}/${taskId}`;
export function createDesignRunHost(deps: {
  modelSelection: DesignModelSelection;
  repository: DesignHostRepository;
  designGoals: Pick<
    DesignGoalsService,
    "initialize" | "readTask" | "observe" | "continuation" | "onLost"
  >;
  agentModes: Pick<ExecutionModeService, "activate" | "hydrate">;
  designTasks: DesignTasksService;
  agentRuns: Pick<
    AgentRunService,
    "createRun" | "streamRun" | "cancelRun" | "cancelRunAndWait"
  >;
  metadata: Pick<AgentRunMetadataService, "createAcceptedRun">;
  threads: Pick<ThreadService, "resolveOwnedSessionThread">;
  executionScopes: Pick<ExecutionScopes, "openTask" | "openRestoringTask">;
  localInstance: Pick<LocalInstanceService, "serviceActor" | "getContext">;
  localAccess: Pick<LocalAccessService, "onRevoked">;
  taskWork: Pick<TaskWorkManager, "onReady" | "list" | "closeTask">;
}): DesignRunHost {
  const active = new Map<string, Active>();
  const backgroundFailures = new Map<string, unknown>();
  const drives = new Set<Promise<void>>();
  const reportFailure = (
    instanceId: string,
    taskId: string,
    error: unknown,
  ) => {
    backgroundFailures.set(keyOf(instanceId, taskId), error);
    console.error("Design任务生命周期失败", {
      instanceId,
      taskId,
      code:
        error && typeof error === "object" && "code" in error
          ? error.code
          : "design_host_failure",
    });
  };
  const listeners = new Set<(event: DesignHostEvent) => void | Promise<void>>();
  let closing = false;
  let initialized: Promise<void> | undefined;
  const cleanup: (() => void)[] = [];
  async function broadcast(event: DesignHostEvent) {
    for (const listener of listeners) {
      try {
        await listener(event);
      } catch {
        /* Transport disconnect cannot cancel accepted work. */
      }
    }
  }
  async function terminal(
    input: DesignHostStoredInput,
    canvasId: string,
    event: StreamEvent,
    collector: ReturnType<typeof createAssistantBlockCollector>,
  ) {
    if (
      event.type !== "run.completed" &&
      event.type !== "run.failed" &&
      event.type !== "run.canceled"
    )
      return false;
    const outcome =
      event.type === "run.completed"
        ? "completed"
        : event.type === "run.canceled"
          ? "canceled"
          : "failed";
    const policy = await deps.designTasks.readPolicy(input.actor, input.taskId);
    if (policy.activeRunId !== input.runId) return false;
    const settled = await deps.designTasks.settleRun(input.actor, {
      taskId: input.taskId,
      runId: input.runId,
      outcome,
      terminalMetadata: {
        completedAt: event.timestamp,
        ...(event.type === "run.completed"
          ? { stopReason: event.stopReason ?? "completed" }
          : event.type === "run.canceled"
            ? {
                stopReason:
                  event.stopReason ??
                  (closing ? "host_shutdown" : "task_stopped"),
              }
            : {}),
        ...(event.type === "run.failed"
          ? { errorCode: event.error.code, errorMessage: event.error.message }
          : {}),
        ...(collector.blocks.length
          ? {
              assistant: {
                messageId: designHostMessageId(
                  `${input.taskId}/assistant/${input.runId}`,
                ),
                text: collector.text,
                blocks: [...collector.blocks],
              },
            }
          : {}),
      },
    });
    if (settled)
      await broadcast({
        instanceId: input.actor.instanceId,
        taskId: input.taskId,
        canvasId,
        event,
      });
    return settled;
  }
  async function loadAuthorizedRun(item: Active) {
    const input = await deps.repository.loadInput(
      item.instanceId,
      item.taskId,
      item.runId,
    );
    if (!input) {
      const actor = await deps.localInstance.serviceActor();
      item.settled = await deps.designTasks.settleRun(actor, {
        taskId: item.taskId,
        runId: item.runId,
        outcome: "canceled",
      });
      return null;
    }
    item.input = input;
    item.clientId = input.actor.accessClientId;
    const binding = await deps.threads.resolveOwnedSessionThread(
      input.actor,
      item.taskId,
    );
    if (binding.mode !== "design" || !binding.canvasId)
      throw new DesignTaskError(
        "design_task_identity_mismatch",
        "任务缺少持久画布身份",
      );
    item.canvasId = binding.canvasId;
    const scope = await deps.executionScopes.openTask(input.actor, item.taskId);
    if (
      scope.preset !== "design" ||
      scope.describe().projectId !== binding.projectId
    )
      throw new DesignTaskError(
        "design_task_identity_mismatch",
        "任务工作域不匹配",
      );
    const admittedPolicy = await deps.designTasks.readPolicy(
      input.actor,
      item.taskId,
    );
    if (
      scope.describe().generation !== input.scopeGeneration ||
      admittedPolicy.branchGeneration !== input.branchGeneration ||
      admittedPolicy.activeRunId !== item.runId
    )
      throw new DesignTaskError(
        "design_task_policy_changed",
        "任务准入权限已改变，请重试",
      );
    return {
      input,
      binding: { ...binding, canvasId: binding.canvasId },
      scope,
      policy: admittedPolicy,
    };
  }
  function createProjection(
    item: Active,
    input: DesignHostStoredInput,
    canvasId: string,
  ) {
    const collector = createAssistantBlockCollector();
    const eventSink = async (event: StreamEvent) => {
      const observed = item.goalClaimed
        ? await deps.designGoals.observe(input.actor, item.taskId, event)
        : { stop: false };
      if (observed.stop) {
        item.stopRequested = true;
        deps.agentRuns.cancelRun(
          item.runId,
          closing ? "host_shutdown" : "task_stopped",
        );
      }
      if (event.runId !== item.runId)
        throw new DesignTaskError("design_run_conflict", "运行事件身份不匹配");
      if (
        event.type === "message.delta" ||
        event.type === "thinking.delta" ||
        event.type === "tool.started" ||
        event.type === "tool.completed"
      )
        collector.onEvent(event);
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.canceled"
      ) {
        const effective: StreamEvent =
          event.type === "run.completed" && !collector.hasVisibleContent
            ? {
                type: "run.failed",
                runId: item.runId,
                timestamp: event.timestamp,
                error: {
                  code: "run_failed",
                  message: "模型本轮没有返回内容，请重试或更换模型",
                },
              }
            : event;
        item.settled = await terminal(input, canvasId, effective, collector);
        return;
      }
      const policy = await deps.designTasks.readPolicy(
        input.actor,
        item.taskId,
      );
      if (policy.activeRunId === item.runId)
        await broadcast({
          instanceId: item.instanceId,
          taskId: item.taskId,
          canvasId,
          event,
        });
    };
    return eventSink;
  }
  async function execute(item: Active) {
    const context = await loadAuthorizedRun(item);
    if (!context) return;
    const { input, binding, scope, policy } = context;
    const eventSink = createProjection(item, input, binding.canvasId);
    const canceled = () => ({
      type: "run.canceled" as const,
      stopReason: closing
        ? ("host_shutdown" as const)
        : ("task_stopped" as const),
      runId: item.runId,
      timestamp: new Date().toISOString(),
    });
    if (!input.modelInvocation)
      throw new DesignTaskError("design_model_invalid", "请重新选择模型后发送");
    await deps.modelSelection.validate(input.actor, input.modelInvocation);
    const model = designModelSpecifier(input.modelInvocation);
    await deps.metadata.createAcceptedRun({
      runId: item.runId,
      sessionId: item.taskId,
      threadId: binding.threadId,
      ...(model ? { model } : {}),
    });
    item.accepted = true;
    const goal = await deps.designGoals.readTask(input.actor, item.taskId);
    item.goalClaimed = goal?.claimedRunId === item.runId;
    let mode = input.request.executionMode;
    if (mode === "loop")
      throw new DesignTaskError(
        "design_mode_unsupported",
        "循环模式已停用，请使用目标模式",
        400,
      );
    if (
      item.goalClaimed &&
      (input.origin === "goalContinuation" || !mode || mode === "goal")
    )
      mode = "goal";
    else if (mode === "goal")
      throw new DesignTaskError(
        "design_goal_paused",
        "请先手动恢复当前目标",
        409,
      );
    if (!mode)
      mode = policy.planEnabled
        ? "plan"
        : await deps.agentModes.hydrate(binding.threadId, {
            instanceId: input.actor.instanceId,
          });
    if (
      mode === "goal" &&
      !item.goalClaimed &&
      !input.request.executionMode &&
      goal
    )
      mode = "agent";
    if (mode === "loop" || (mode === "goal" && !item.goalClaimed))
      throw new DesignTaskError(
        "design_mode_unsupported",
        "请使用当前Task的真实目标控制",
        400,
      );
    if (mode === "plan" && !policy.planEnabled)
      throw new DesignTaskError(
        "design_plan_update_required",
        "请先更新任务计划状态，再发送",
        409,
      );
    await deps.agentModes.activate(binding.threadId, mode, {
      instanceId: input.actor.instanceId,
    });
    if (item.stopRequested || closing) {
      await eventSink(canceled());
      return;
    }
    if (
      !(await deps.designTasks.markRunStarted(input.actor, {
        taskId: item.taskId,
        runId: item.runId,
      }))
    )
      throw new DesignTaskError(
        "design_run_conflict",
        "运行已结束或宿主归属已改变",
      );
    const request = {
      ...input.request,
      sessionId: item.taskId,
      taskId: item.taskId,
      projectId: binding.projectId,
      canvasId: binding.canvasId,
      preset: "design" as const,
      executionMode: mode,
    };
    const background = input.origin !== "userInput";
    if (!background) await deps.repository.persistInput(input);
    deps.agentRuns.createRun(request, {
      model,
      modelInvocation: input.modelInvocation,
      terminalPersistence: "host",
      runId: item.runId,
      actor: input.actor,
      scopeHandle: scope,
      threadId: binding.threadId,
      inputIdentity: {
        clientId: input.actor.accessClientId!,
        sourceCommandId: input.inputId,
      },
      inputOrigin: background ? "backgroundResult" : "userInput",
      eventSink,
    });
    if (item.stopRequested || closing)
      deps.agentRuns.cancelRun(
        item.runId,
        closing ? "host_shutdown" : "task_stopped",
      );
    try {
      for await (const _event of deps.agentRuns.streamRun(item.runId)) {
        /* Runtime eventSink is the sole durable/transport projection. */
      }
      if (!item.settled)
        throw new DesignTaskError("design_run_incomplete", "运行缺少终态回执");
    } catch {
      deps.agentRuns.cancelRun(
        item.runId,
        closing ? "host_shutdown" : "task_stopped",
      );
      if (!item.settled)
        await eventSink({
          type: "run.failed",
          runId: item.runId,
          timestamp: new Date().toISOString(),
          error: { code: "run_failed", message: "运行已中断，请重试" },
        });
    }
  }
  function start(instanceId: string, taskId: string, runId: string) {
    const key = keyOf(instanceId, taskId);
    if (active.has(key)) return;
    const item: Active = {
      instanceId,
      taskId,
      runId,
      clientId: null,
      stopRequested: false,
      done: Promise.resolve(),
      settled: false,
      accepted: false,
      goalClaimed: false,
    };
    active.set(key, item);
    item.done = execute(item)
      .catch(async () => {
        if (item.accepted && item.input && item.canvasId) {
          item.settled = await terminal(
            item.input,
            item.canvasId,
            item.stopRequested || closing
              ? {
                  type: "run.canceled",
                  runId,
                  timestamp: new Date().toISOString(),
                }
              : {
                  type: "run.failed",
                  runId,
                  timestamp: new Date().toISOString(),
                  error: {
                    code: "run_failed",
                    message: "运行启动失败，请重试",
                  },
                },
            createAssistantBlockCollector(),
          );
        } else {
          const actor = await deps.localInstance.serviceActor();
          item.settled = await deps.designTasks.settleRun(actor, {
            taskId,
            runId,
            outcome: "failed",
          });
        }
      })
      .finally(async () => {
        if (active.get(key) === item) active.delete(key);
        if (!closing && item.settled) {
          if (
            !(await host.dispatchNext(instanceId, taskId)) &&
            !(await ready(instanceId, taskId))
          )
            await host.dispatchGoal(instanceId, taskId);
        }
      });
    // Attach a rejection observer while retaining the rejecting promise for stop/close.
    drives.add(item.done);
    void item.done.then(
      () => drives.delete(item.done),
      (error) => {
        drives.delete(item.done);
        reportFailure(instanceId, taskId, error);
      },
    );
  }
  async function ready(instanceId: string, taskId: string): Promise<boolean> {
    if (closing || active.has(keyOf(instanceId, taskId))) return false;
    if ((await deps.repository.lastOutcome(instanceId, taskId)) === "canceled")
      return false;
    const latest = await deps.repository.loadLatestActor(instanceId, taskId);
    if (!latest) return false;
    const actor = latest.actor;
    const policy = await deps.designTasks.readPolicy(actor, taskId);
    if (policy.activeRunId || policy.executionState !== "ready") return false;
    const scope = await deps.executionScopes.openTask(actor, taskId);
    const pending = (
      await deps.taskWork.list({
        actor,
        ownerKind: "design",
        scope: scope.describe(),
        agentId: scope.agentId,
        runId: "continuation-admission",
        branchGeneration: policy.branchGeneration,
      })
    ).filter(
      (work) =>
        !work.consumed &&
        work.status !== "running" &&
        work.branchGeneration === policy.branchGeneration,
    );
    if (!pending.length) return false;
    const origin = await deps.repository.loadOriginActor(
      instanceId,
      taskId,
      pending[0]!.originRunId,
    );
    if (!origin) return false;
    const inputId = `task-work:${createHash("sha256")
      .update(
        `${policy.branchGeneration}/${pending
          .map((work) => work.id)
          .sort()
          .join(",")}`,
      )
      .digest("hex")}`;
    const result = await submitInput(
      origin.actor,
      {
        taskId,
        inputId,
        ...(origin.modelInvocation
          ? { modelInvocation: origin.modelInvocation }
          : {}),
        scopeGeneration: policy.scopeGeneration,
        branchGeneration: policy.branchGeneration,
        request: {
          sessionId: taskId,
          taskId,
          conversationId: taskId,
          prompt:
            "后台工作已有终态结果。请读取本轮模型边界送达的工作记录，继续完成当前 Task。",
          preset: "design",
          ...(origin.model ? { model: origin.model } : {}),
        },
      },
      "backgroundResult",
    );
    return result.kind !== "duplicate";
  }
  const submitInput = async (
    actor: LocalActor,
    input: Parameters<DesignRunHost["submit"]>[1],
    origin: DesignInputOrigin = "userInput",
    goalFence?: GoalFence,
  ) => {
    if (closing)
      throw new DesignTaskError("design_host_closing", "任务宿主正在关闭", 503);
    if (input.request.executionMode === "loop")
      throw new DesignTaskError(
        "design_mode_unsupported",
        "Design不支持目标或循环模式，请切回执行",
        400,
      );
    if (!actor.accessClientId)
      throw new DesignTaskError(
        "design_client_required",
        "任务输入缺少真实接入客户端",
        403,
      );
    const binding = await deps.threads.resolveOwnedSessionThread(
      actor,
      input.taskId,
    );
    if (
      binding.mode !== "design" ||
      !binding.canvasId ||
      input.request.sessionId !== input.taskId ||
      (input.request.canvasId && input.request.canvasId !== binding.canvasId) ||
      (input.request.preset && input.request.preset !== "design")
    )
      throw new DesignTaskError(
        "design_task_identity_mismatch",
        "任务或画布身份不匹配",
      );
    const current = active.get(keyOf(actor.instanceId, input.taskId));
    if (
      current &&
      !(await deps.designTasks.readPolicy(actor, input.taskId)).activeRunId
    )
      await current.done;
    const admitted = await deps.designTasks.admitInput(actor, {
      ...input,
      captureModelInvocation: () =>
        input.modelInvocation
          ? Promise.resolve(input.modelInvocation)
          : deps.modelSelection.capture(actor, input.request.model),
      runId: randomUUID(),
      origin,
      ...(goalFence ? { goalFence } : {}),
      request: {
        ...input.request,
        canvasId: binding.canvasId,
        preset: "design",
      },
    });
    if (admitted.kind === "running")
      start(actor.instanceId, input.taskId, admitted.runId);
    return admitted;
  };
  const host: DesignRunHost = {
    async beginRestore(actor, input) {
      if (closing)
        throw new DesignTaskError(
          "design_host_closing",
          "任务宿主正在关闭",
          503,
        );
      if (!actor.accessClientId)
        throw new DesignTaskError(
          "design_client_required",
          "恢复缺少真实接入客户端",
          403,
        );
      const lease = await deps.designTasks.beginRestore(actor, input);
      try {
        const item = active.get(keyOf(actor.instanceId, input.taskId));
        if (item && item.runId === lease.activeRunId) {
          item.stopRequested = true;
          deps.agentRuns.cancelRun(
            item.runId,
            closing ? "host_shutdown" : "task_stopped",
          );
        }
        await Promise.all([
          item?.runId === lease.activeRunId ? item.done : Promise.resolve(),
          deps.taskWork.closeTask(
            actor.instanceId,
            input.taskId,
            "任务检查点恢复",
            "design",
          ),
        ]);
        const handle = await deps.executionScopes.openRestoringTask(
          actor,
          input.taskId,
          lease.scopeGeneration,
        );
        if (
          handle.preset !== "design" ||
          handle.describe().projectId !== lease.projectId
        )
          throw new DesignTaskError(
            "design_restore_conflict",
            "恢复工作域不匹配",
          );
        return { ...lease, scope: handle.describe(), activeRunId: null };
      } catch (error) {
        await deps.designTasks.finishRestore(actor, {
          taskId: input.taskId,
          operationId: lease.operationId,
          scopeGeneration: lease.scopeGeneration,
          branchGeneration: lease.branchGeneration,
          state: "failed",
        });
        throw error;
      }
    },
    finishRestore: (actor, input) =>
      deps.designTasks.finishRestore(actor, input),
    initialize() {
      initialized ??= (async () => {
        await deps.designGoals.initialize();
        const actor = await deps.localInstance.serviceActor();
        await deps.designTasks.recoverInterruptedTasks(actor);
        for (const taskId of await deps.repository.listPending(
          actor.instanceId,
        ))
          if (!(await host.dispatchNext(actor.instanceId, taskId)))
            await ready(actor.instanceId, taskId);
      })();
      return initialized;
    },
    async submit(actor, input) {
      if (
        input.inputId.startsWith("task-work:") ||
        input.inputId.startsWith("goal:")
      )
        throw new DesignTaskError(
          "design_input_reserved",
          "输入编号保留给后台工作",
          400,
        );
      const admitted = await submitInput(actor, input);
      if (
        admitted.kind === "queued" &&
        !active.has(keyOf(actor.instanceId, input.taskId))
      )
        await host.dispatchNext(actor.instanceId, input.taskId);
      return admitted;
    },
    async stop(actor, input) {
      const result = await deps.designTasks.requestStop(actor, input);
      if (result.kind === "stopping" && result.runId) {
        const item = active.get(keyOf(actor.instanceId, input.taskId));
        if (item?.runId === result.runId) {
          item.stopRequested = true;
          deps.agentRuns.cancelRun(result.runId, "task_stopped");
          await item.done;
        }
      }
      return result;
    },
    async dispatchNext(instanceId, taskId) {
      if (closing || active.has(keyOf(instanceId, taskId))) return false;
      const actor = await deps.localInstance.serviceActor();
      if (actor.instanceId !== instanceId) return false;
      const next = await deps.designTasks.claimNextInput(actor, taskId);
      if (!next) return false;
      start(instanceId, taskId, next.runId);
      return true;
    },
    async dispatchGoal(instanceId, taskId) {
      if (closing || active.has(keyOf(instanceId, taskId))) return false;
      const step = await deps.designGoals.continuation(instanceId, taskId);
      if (!step) return false;
      const policy = await deps.designTasks.readPolicy(step.actor, taskId);
      try {
        const receipt = await submitInput(
          step.actor,
          {
            taskId,
            modelInvocation: step.modelInvocation,
            inputId: step.inputId,
            scopeGeneration: policy.scopeGeneration,
            branchGeneration: policy.branchGeneration,
            request: {
              sessionId: taskId,
              taskId,
              conversationId: taskId,
              prompt: step.prompt,
              preset: "design",
              executionMode: "goal",
            },
          },
          "goalContinuation",
          step.goalFence,
        );
        return receipt.kind === "running";
      } catch (error) {
        if (
          error instanceof DesignTaskError &&
          [
            "design_goal_conflict",
            "design_task_policy_changed",
            "design_task_host_busy",
          ].includes(error.code)
        )
          return false;
        throw error;
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closing = true;
      for (const unsubscribe of cleanup.splice(0)) unsubscribe();
      for (const item of active.values()) {
        item.stopRequested = true;
        deps.agentRuns.cancelRun(
          item.runId,
          closing ? "host_shutdown" : "task_stopped",
        );
      }
      await Promise.allSettled([...drives]);
      listeners.clear();
      if (backgroundFailures.size) {
        const errors = [...backgroundFailures.values()];
        backgroundFailures.clear();
        throw new AggregateError(errors, "Design任务生命周期失败");
      }
    },
  };
  cleanup.push(
    deps.designGoals.onLost(() => {
      for (const item of active.values())
        if (item.goalClaimed) {
          item.stopRequested = true;
          deps.agentRuns.cancelRun(
            item.runId,
            closing ? "host_shutdown" : "task_stopped",
          );
        }
    }),
  );
  cleanup.push(
    deps.designTasks.onLeaseLost((instanceId, taskId) => {
      const item = active.get(keyOf(instanceId, taskId));
      if (item) {
        item.stopRequested = true;
        deps.agentRuns.cancelRun(
          item.runId,
          closing ? "host_shutdown" : "task_stopped",
        );
      }
    }),
  );
  cleanup.push(
    deps.localAccess.onRevoked(async (clientId) => {
      const { instanceId } = await deps.localInstance.getContext();
      await deps.repository.cancelQueuedForClient(instanceId, clientId);
      const affected = [...active.values()].filter(
        (item) => item.clientId === clientId,
      );
      for (const item of affected) {
        item.stopRequested = true;
        deps.agentRuns.cancelRun(
          item.runId,
          closing ? "host_shutdown" : "task_stopped",
        );
      }
      await Promise.all(affected.map((item) => item.done));
    }),
  );
  cleanup.push(
    deps.taskWork.onReady((identity) =>
      identity.ownerKind === "design"
        ? ready(identity.instanceId, identity.taskId).catch((error) => {
            reportFailure(identity.instanceId, identity.taskId, error);
            throw error;
          })
        : Promise.resolve(false),
    ),
  );
  return host;
}
