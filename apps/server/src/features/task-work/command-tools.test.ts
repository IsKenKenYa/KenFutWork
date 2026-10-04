import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import type { ToolExecutionContext } from "../../kernel/types.js";
import {
  createExecutionScopes,
  type ExecutionScopeHandle,
} from "../execution/scope-service.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskCommandTools } from "./command-tools.js";
import { createTaskWorkManager } from "./service.js";
import { createMemoryTaskWorkStore } from "./test-store.js";
import type { TaskWorkContext } from "./types.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const bashResult = z.object({ taskId: z.string() });
const outputResult = z.object({
  canonicalOutput: z.object({
    output: z.object({ data: z.string() }).nullable().optional(),
  }),
});
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "command-ownership-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  await mkdir(root);
  const actor = {
    id: "user",
    email: "user@example.test",
    accessToken: "test",
    userMetadata: {},
  };
  const scope: CodeExecutionScope = {
    workspaceId: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
    projectId: "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5",
    taskId: "0432143f-e2b8-4ea6-adea-01f706f537d3",
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const scopes = createExecutionScopes({
    repository: {
      load: async () => ({ scope, state: "ready", branchGeneration: 1 }),
    },
    viewerService: {
      resolveWorkspace: async () => ({
        id: scope.workspaceId,
        name: "工作区",
        type: "personal",
        ownerUserId: actor.id,
      }),
    },
  });
  const main = await scopes.openTask(actor, scope.taskId);
  const context: TaskWorkContext = {
    actor,
    scope,
    agentId: "main",
    runId: "run-main",
    branchGeneration: 1,
  };
  const manager = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: root,
    resolveMaxConcurrent: async () => 4,
  });
  const sandbox = createProcessSandbox({
    captureRoot: join(directory, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("test complete"));
  cleanups.push(() => manager.close("test complete"));
  const query = async () => ({ rows: [], rowCount: 0 });
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("设置夹具不提供执行宿主数据库会话。");
    },
    end: async () => {},
  };
  const settings = createSettingsService({
    repository: createSettingsRepository(createPersistenceFromRunner(runner)),
  });
  const controller = createTaskCommandTools({ manager, sandbox, settings });
  const tool = (name: string) => {
    const found = controller.tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`缺少 ${name}`);
    return found;
  };
  const execution = (
    handle: ExecutionScopeHandle,
    call: string,
  ): ToolExecutionContext => ({
    scopeHandle: handle,
    taskWorkContext: { ...context, runId: `run-${handle.agentId}` },
    toolCallId: call,
    runId: `run-${handle.agentId}`,
  });
  const start = async (handle: ExecutionScopeHandle, call: string) => {
    const program =
      "process.stdin.setEncoding('utf8');process.stdin.on('data',data=>process.stdout.write('echo:'+data));setInterval(()=>{},1000);process.stdout.write('ready\\n')";
    const work = bashResult.parse(
      await tool("Bash").execute(
        {
          command: `${quote(process.execPath)} -e ${quote(program)}`,
          run_in_background: true,
        },
        execution(handle, call),
      ),
    );
    await expect
      .poll(
        async () =>
          outputResult.parse(
            await tool("TaskOutput").execute(
              { task_id: work.taskId },
              execution(main, "output"),
            ),
          ).canonicalOutput.output?.data ?? "",
      )
      .toContain("ready");
    return work.taskId;
  };
  return { root, main, manager, context, tool, execution, start };
}

it.each(["TaskInput", "TaskStop"] as const)(
  "只读child不能通过%s控制parent，TaskOutput仍可读而主代理可停止",
  async (operation) => {
    const state = await fixture();
    const workId = await state.start(state.main, "main-command");
    const review = state.main.derive("review", "review-one");
    expect(
      outputResult.parse(
        await state
          .tool("TaskOutput")
          .execute({ task_id: workId }, state.execution(review, "read-parent")),
      ).canonicalOutput.output?.data,
    ).toContain("ready");
    await expect(
      state
        .tool(operation)
        .execute(
          operation === "TaskInput"
            ? { task_id: workId, data: "forged\n", close: true }
            : { task_id: workId },
          state.execution(review, "control-parent"),
        ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await state.manager.find(state.context, workId)).toMatchObject({
      agentId: "main",
      status: "running",
    });
    expect(
      await state
        .tool("TaskStop")
        .execute({ task_id: workId }, state.execution(state.main, "main-stop")),
    ).toMatchObject({ stopped: true });
    expect(await state.manager.find(state.context, workId)).toMatchObject({
      status: "canceled",
    });
    await expect(
      state
        .tool("TaskStop")
        .execute(
          { task_id: workId },
          state.execution(review, "late-parent-stop"),
        ),
    ).rejects.toMatchObject({ statusCode: 403 });
  },
);

it("worker可向自身派发的命令输入并停止，TaskOutput仍能读取整个Task", async () => {
  const state = await fixture();
  const worker = state.main.derive("worker", "worker-one");
  const own = await state.start(worker, "own-command");
  expect(await state.manager.find(state.context, own)).toMatchObject({
    agentId: "worker-one",
    status: "running",
  });
  expect(
    await state
      .tool("TaskInput")
      .execute(
        { task_id: own, data: "owned\n" },
        state.execution(worker, "own-input"),
      ),
  ).toMatchObject({ inputSent: true });
  await expect
    .poll(
      async () =>
        outputResult.parse(
          await state
            .tool("TaskOutput")
            .execute(
              { task_id: own },
              state.execution(state.main, "read-child"),
            ),
        ).canonicalOutput.output?.data ?? "",
    )
    .toContain("echo:owned");
  expect(
    await state
      .tool("TaskStop")
      .execute({ task_id: own }, state.execution(worker, "own-stop")),
  ).toMatchObject({ stopped: true });
  expect(await state.manager.find(state.context, own)).toMatchObject({
    status: "canceled",
  });
  const childForMain = await state.start(worker, "child-for-main");
  expect(
    await state
      .tool("TaskStop")
      .execute(
        { task_id: childForMain },
        state.execution(state.main, "main-stop-child"),
      ),
  ).toMatchObject({ stopped: true });
});

it.each([
  { original: "plan", approved: "yolo" },
  { original: "build", approved: "plan" },
] as const)(
  "原$original/final $approved真实process始终向只读收紧并如实记账",
  async ({ original, approved }) => {
    const state = await fixture();
    const exec = state.execution(state.main, "readonly-plan");
    const marker = join(state.root, "plan-must-not-write.txt");
    const program = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'forbidden')`;
    exec.permissionInvocation = {
      preset: "code",
      workspaceId: state.context.scope.workspaceId,
      taskId: state.context.scope.taskId,
      runId: state.context.runId,
      toolCallId: "readonly-plan",
      userId: "user",
      agentId: "main",
      role: "main",
      scopeGeneration: 1,
      branchGeneration: 1,
      mode: original,
      approvalCeiling: "plan",
      toolName: "Bash",
      access: "execute",
      args: { command: program },
      readonlyExecution: true,
    };
    exec.codeApproval = {
      ceiling: "plan",
      resolve: async () => ({
        mode: "yolo",
        scopeGeneration: 1,
        branchGeneration: 1,
      }),
    };
    exec.approvedExecutionMode = approved;
    const work = bashResult.parse(
      await state.tool("Bash").execute(
        {
          command: `${quote(process.execPath)} -e ${quote(program)}`,
          run_in_background: true,
        },
        exec,
      ),
    );
    await expect
      .poll(
        async () =>
          (await state.manager.find(state.context, work.taskId))?.status,
      )
      .toBe("failed");
    expect(await state.manager.find(state.context, work.taskId)).toMatchObject({
      scope: { sandboxMode: "read-only" },
    });
    await expect(
      state.main.backend.readPage({ path: marker }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
