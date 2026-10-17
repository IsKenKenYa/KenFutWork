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
import { createLocalInstanceService } from "../local-instance/service.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import {
  nodeCommand,
  slashPath,
} from "../process-sandbox/test-node-command.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskCommandTools } from "./command-tools.js";
import { createTaskWorkManager } from "./service.js";
import { createMemoryTaskWorkStore } from "./test-store.js";
import type { TaskWorkContext } from "./types.js";

/**
 * 真沙箱里冷启动一个 node 进程（bwrap + apply-seccomp + seccomp 过滤器）在 CI 容器上
 * 明显慢于本机：`expect.poll` 默认 1s 会在进程还没吐出第一行时就判红（实测
 * `expected '' to contain 'ready'`）。这里给的是**进程启动预算**，不是掩盖同步错误——
 * 沙箱启动失败由 failFast 立刻抛出原始原因，不会等满这个预算。
 */
const SANDBOX_STARTUP_MS = 30_000;

/**
 * 真沙箱用例的测试级预算。轮询本身允许等满 SANDBOX_STARTUP_MS，
 * 测试超时必须严格大于它——否则 CI 上一慢就只会判成「超时」，拿不到真结论。
 */
const REAL_PROCESS_TEST_MS = SANDBOX_STARTUP_MS * 2;

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

async function fixture(preset: "code" | "design" = "code") {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "command-ownership-")),
  );
  // Windows 上子进程退出后目录会短暂处于删除挂起态，立刻 rmdir 报 EBUSY（与
  // windows-native.integration.test.ts 同一现象）；POSIX 侧这两个参数是 no-op。
  cleanups.push(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    }),
  );
  const root = join(directory, "project");
  await mkdir(root);
  const actor = {
    instanceId: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
    accessClientId: null,
  };
  const scope: CodeExecutionScope = {
    instanceId: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
    projectId: "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5",
    taskId: "0432143f-e2b8-4ea6-adea-01f706f537d3",
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const scopes = createExecutionScopes({
    repository: {
      load: async () => ({
        preset,
        scope,
        state: "ready",
        branchGeneration: 1,
      }),
    },
    localInstance: {
      resolve: async () => ({
        instanceId: scope.instanceId,
        dataDir: directory,
      }),
    },
  });
  const main = await scopes.openTask(actor, scope.taskId);
  const context: TaskWorkContext = {
    actor,
    scope,
    ownerKind: preset,
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
    localInstance: createLocalInstanceService({
      repository: { ensure: async () => scope.instanceId },
      dataDir: directory,
    }),
  });
  const controller = createTaskCommandTools(
    { manager, sandbox, settings },
    { scope: preset },
  );
  const tool = (name: string) => {
    const found = controller.tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`缺少 ${name}`);
    return found;
  };
  const execution = (
    handle: ExecutionScopeHandle,
    call: string,
  ): ToolExecutionContext => ({
    actor,
    scopeHandle: handle,
    taskWorkContext: { ...context, runId: `run-${handle.agentId}` },
    toolCallId: call,
    runId: `run-${handle.agentId}`,
  });
  /**
   * 沙箱起不来时失败会被记成 status=failed + summary，输出里永远不会有 ready。
   * 夹具必须在轮询里主动把原始失败抛出，否则用例只报「expected '' to contain 'ready'」，
   * 把根因（apply-seccomp / 授权 / 隔离不可用）埋成一次空等超时。
   */
  const failFast = async (workId: string) => {
    const record = await manager.find(context, workId);
    if (record?.status === "failed")
      throw new Error(
        `后台命令启动即失败（${workId}）：${record.summary ?? "(未记录原因)"}`,
      );
  };
  const start = async (handle: ExecutionScopeHandle, call: string) => {
    const program =
      "process.stdin.setEncoding('utf8');process.stdin.on('data',data=>process.stdout.write('echo:'+data));setInterval(()=>{},1000);process.stdout.write('ready\\n')";
    const work = bashResult.parse(
      await tool("Bash").execute(
        {
          command: nodeCommand(program),
          run_in_background: true,
        },
        execution(handle, call),
      ),
    );
    await expect
      .poll(
        async () => {
          await failFast(work.taskId);
          return (
            outputResult.parse(
              await tool("TaskOutput").execute(
                { task_id: work.taskId },
                execution(main, "output"),
              ),
            ).canonicalOutput.output?.data ?? ""
          );
        },
        { timeout: SANDBOX_STARTUP_MS },
      )
      .toContain("ready");
    return work.taskId;
  };
  return { root, main, manager, context, tool, execution, start, failFast };
}

it(
  "Design Task 命令沿真实 Design ScopeHandle 接入共享 TaskWork",
  async () => {
    const f = await fixture("design");
    expect(f.tool("Bash").scope).toBe("design");
    const workId = await f.start(f.main, "design-command");
    expect(await f.manager.find(f.context, workId)).toMatchObject({
      ownerKind: "design",
      scope: {
        instanceId: f.context.scope.instanceId,
        projectId: f.context.scope.projectId,
        taskId: f.context.scope.taskId,
        rootDirectory: f.root,
      },
    });
    await f.manager.stop(f.context, workId, "test complete");
  },
  REAL_PROCESS_TEST_MS,
);

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
  REAL_PROCESS_TEST_MS,
);

it(
  "worker可向自身派发的命令输入并停止，TaskOutput仍能读取整个Task",
  async () => {
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
        async () => {
          await state.failFast(own);
          return (
            outputResult.parse(
              await state
                .tool("TaskOutput")
                .execute(
                  { task_id: own },
                  state.execution(state.main, "read-child"),
                ),
            ).canonicalOutput.output?.data ?? ""
          );
        },
        { timeout: SANDBOX_STARTUP_MS },
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
  },
  REAL_PROCESS_TEST_MS,
);

/**
 * §186 起，计划档不再为 Bash 派生只读作用域：只读由**文件工具**与**内核层逐次审批**兑现
 * （见 `kernel/code-approval.test.ts`），不由沙箱假装 —— Windows 的只读沙箱不给目录
 * traverse，派生只读会让 `cd`／子目录读写一律被拒，是假可用。
 *
 * 本例锁住这一层的真实行为：直连工具执行时，进程按 Task 当前作用域真执行、写盘成功、
 * 记账如实。原用例挂的 `permissionInvocation` / `codeApproval` / `approvedExecutionMode`
 * 三个字段不在 `ToolExecutionContext` 上，Bash 工具读不到，审批语义也不在这一层，故删除。
 */
it(
  "计划档 Bash 真执行：批准后写盘成功且记账如实（§186 口径）",
  async () => {
    const state = await fixture();
    const exec = state.execution(state.main, "plan-bash-writes");
    const marker = join(state.root, "plan-writes-forreal.txt");
    // 正斜杠 + 单引号：整段程序里没有双引号，PowerShell 的 -Command 才不会把路径引号吞掉。
    const program = `require('node:fs').writeFileSync('${slashPath(marker)}','written')`;
    const work = bashResult.parse(
      await state.tool("Bash").execute(
        {
          command: nodeCommand(program),
          run_in_background: true,
        },
        exec,
      ),
    );
    await expect
      .poll(
        async () => {
          await state.failFast(work.taskId);
          return (await state.manager.find(state.context, work.taskId))?.status;
        },
        { timeout: SANDBOX_STARTUP_MS },
      )
      .toBe("completed");
    expect(await state.manager.find(state.context, work.taskId)).toMatchObject({
      scope: { sandboxMode: "workspace-write" },
    });
    expect(
      (await state.main.backend.readPage({ path: marker })).content,
    ).toContain("written");
  },
  REAL_PROCESS_TEST_MS,
);
