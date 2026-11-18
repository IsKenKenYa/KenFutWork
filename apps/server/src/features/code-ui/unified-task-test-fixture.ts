import { randomUUID } from "node:crypto";
import type { AdditionalDirectory } from "@kenfutwork/shared";
import { createCanvasRepository } from "../canvas/repository.js";
import { createGoalService } from "../goals/service.js";
import { createProjectRepository } from "../projects/repository.js";
import type { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiRepository } from "./repository.js";

/** Real PG aggregate used by root migration/relink acceptance; no legacy Design host. */
export async function createUnifiedDesignTaskFixture(
  db: Awaited<ReturnType<typeof createTaskWorkDatabase>>,
  input: {
    root: string;
    name: string;
    budget: number;
    additionalDirectories?: AdditionalDirectory[];
  },
) {
  const { project } = await createProjectRepository(
    db.persistence,
  ).createProject({
    instanceId: db.instanceId,
    createdByClientId: db.actor.accessClientId,
    kind: "design",
    name: input.name,
    slug: randomUUID(),
    description: null,
    canvasName: "unused",
    workDir: input.root,
    additionalDirectories: input.additionalDirectories ?? [],
  });
  const canvases = createCanvasRepository(db.persistence);
  const canvas = await canvases.create({
    instanceId: db.instanceId,
    projectId: project.id,
    canvasId: randomUUID(),
    name: "Canvas",
  });
  if (!canvas) throw new Error("真实画布文档未创建");
  await canvases.claimRoot(db.instanceId, canvas.id, async () => input.root);
  const taskId = randomUUID();
  const scope = {
    instanceId: db.instanceId,
    projectId: project.id,
    taskId,
    generation: 1,
    rootDirectory: input.root,
    additionalDirectories: input.additionalDirectories ?? [],
    sandboxMode: "workspace-write" as const,
  };
  const pure = createGoalService();
  const goal = pure.create(null, {
    goalId: randomUUID(),
    objective: `保留目标 ${input.root}`,
    tokenBudget: input.budget,
    branchGeneration: 1,
    at: Date.now(),
  });
  const host = createCodeUiConversation({
    sessionId: taskId,
    workspacePath: input.root,
    config: {
      provider: "fixture",
      model: "fixture",
      thought: "",
      followupMode: "queue",
    },
    workContext: { preset: "design", canvasId: canvas.id },
  });
  host.setGoal(goal);
  const state = host.exportState();
  const recoveryHost = `fixture:${taskId}`;
  state.inputOwner = { hostId: recoveryHost, runtimeId: "before" };
  const repository = createCodeUiRepository(db.persistence);
  await repository.createRoot(db.instanceId, {
    sessionId: taskId,
    projectId: project.id,
    scope,
    createdByClientId: db.actor.accessClientId,
    threadId: randomUUID(),
    state,
    command: {
      clientId: "fixture",
      commandId: randomUUID(),
      fingerprint: randomUUID(),
    },
  });
  const readTask = async () => {
    const row = await repository.find(db.instanceId, taskId);
    if (!row) throw new Error("真实Task不存在");
    return {
      rootDirectory: row.root_directory,
      additionalDirectories: row.additional_directories,
      scopeGeneration: Number(row.scope_generation),
      branchGeneration: Number(row.branch_generation),
      activeRunId: row.active_run_id,
      executionState: row.execution_state,
    };
  };
  const readGoal = async () =>
    (await repository.find(db.instanceId, taskId))?.state?.goalRecord;
  const recover = () =>
    repository.recoverRuntimeInputs({
      hostId: recoveryHost,
      runtimeId: "after",
    });
  const admit = async (runId: string, text: string) => {
    const root = await repository.find(db.instanceId, taskId);
    if (!root?.state) throw new Error("真实Task状态不存在");
    const current = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: input.root,
      config: root.state.snapshots[0]!.config,
      state: root.state,
    });
    current.startTurn({
      runId,
      commandId: randomUUID(),
      text,
      workContext: { preset: "design", canvasId: canvas.id },
    });
    await repository.save(
      db.instanceId,
      taskId,
      Number(root.revision),
      current.exportState(),
      runId,
    );
    return { runId };
  };
  return {
    project,
    canvas,
    task: { id: taskId },
    scope,
    goal,
    readTask,
    readGoal,
    recover,
    admit,
  };
}
