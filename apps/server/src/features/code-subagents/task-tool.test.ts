import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ToolExecutionContext } from "../../kernel/types.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createTaskWorkManager } from "../task-work/service.js";
import { createMemoryTaskWorkStore } from "../task-work/test-store.js";
import type { TaskWorkContext } from "../task-work/types.js";
import { createCodeSubagentTool } from "./task-tool.js";
import type { CodeChildRequest, CodeChildResult } from "./types.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kfw-child-tool-"));
  const scope = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    taskId: "00000000-0000-4000-8000-000000000003",
    generation: 1,
    rootDirectory: await realpath(directory),
    additionalDirectories: [],
    sandboxMode: "workspace-write" as const,
  };
  const actor = { id: "owner", email: "", accessToken: "", userMetadata: {} };
  const handle = await createExecutionScopes({
    repository: {
      load: async () => ({ state: "ready", branchGeneration: 1, scope }),
    },
    viewerService: {
      resolveWorkspace: async () => ({ id: scope.workspaceId }),
    } as never,
  }).openTask(actor, scope.taskId);
  const context: TaskWorkContext = {
    actor,
    scope,
    agentId: "main",
    runId: "parent",
    branchGeneration: 1,
  };
  const manager = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: directory,
    resolveMaxConcurrent: async () => 4,
  });
  const controller = new AbortController();
  const execution: ToolExecutionContext = {
    scopeHandle: handle,
    taskWorkContext: context,
    signal: controller.signal,
    sessionId: scope.taskId,
    toolCallId: "call",
    modelSpecifier: "provider:model",
    delegationDepth: 0,
    codeApproval: {
      ceiling: "build",
      resolve: async () => ({
        mode: "build",
        scopeGeneration: 1,
        branchGeneration: 1,
      }),
    },
  };
  const requests: CodeChildRequest[] = [];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (result: CodeChildResult) => void;
  const done = new Promise<CodeChildResult>((resolve) => {
    finish = resolve;
  });
  let childSignal: AbortSignal | undefined;
  const tool = createCodeSubagentTool({
    manager,
    limitsFor: async () => ({ maxDepth: 2, previewMaxChars: 4 }),
    runChild: async (request, signal) => {
      requests.push(request);
      childSignal = signal;
      started();
      signal.addEventListener(
        "abort",
        () =>
          finish({
            status: "canceled",
            summary: "stopped",
            outputRef: "/logs/result",
            outputStats: { retainedBytes: 7, totalBytes: 7, discardedBytes: 0 },
            childSessionId: request.childSessionId,
            childRunId: "child-run",
          }),
        { once: true },
      );
      return done;
    },
  });
  return {
    manager,
    controller,
    execution,
    tool,
    requests,
    ready,
    finish,
    signal: () => childSignal,
    cleanup: async () => {
      await manager.close("test cleanup");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const input = {
  subagent_type: "explore",
  description: "find evidence",
  ownership: ["."],
  completion_criteria: "return source paths",
};

it("前台Task随父signal退出，只有一次持久派发，无后台通知重复消费", async () => {
  const f = await fixture();
  try {
    const pending = f.tool.execute(input, f.execution);
    await f.ready;
    f.controller.abort("parent stopped");
    expect(await pending).toMatchObject({
      status: "canceled",
      summary: "stop",
    });
    expect(
      await f.manager.consumeNotifications(f.execution.taskWorkContext!),
    ).toEqual([]);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({
      parentSessionId: f.execution.sessionId,
      approvalCeiling: "build",
      detached: false,
    });
  } finally {
    await f.cleanup();
  }
});

it("后台Task不随父停止，重放返回同一child identity，完整输出引用保留", async () => {
  const f = await fixture();
  try {
    const dispatched = (await f.tool.execute(
      { ...input, run_in_background: true },
      f.execution,
    )) as { taskId: string; childSessionId: string };
    await f.ready;
    const replay = await f.tool.execute(
      { ...input, run_in_background: true },
      f.execution,
    );
    expect(replay).toMatchObject({
      taskId: dispatched.taskId,
      childSessionId: dispatched.childSessionId,
    });
    f.controller.abort("parent stopped");
    expect(f.signal()?.aborted).toBe(false);
    f.finish({
      status: "completed",
      summary: "full child evidence",
      outputRef: "/logs/full-result",
      outputStats: { retainedBytes: 19, totalBytes: 19, discardedBytes: 0 },
      childSessionId: dispatched.childSessionId,
      childRunId: "child-run",
    });
    const terminal = new Promise<unknown>((resolve) => {
      const off = f.manager.onChanged(async (record) => {
        if (record.id === dispatched.taskId && record.status !== "running") {
          off();
          resolve(record);
        }
      });
    });
    expect(await terminal).toMatchObject({
      summary: "full",
      outputRef: "/logs/full-result",
      detached: true,
      consumed: false,
    });
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

it("只读派生不能通过Task创建worker，深度限制来自宿主配置", async () => {
  const f = await fixture();
  try {
    await expect(
      f.tool.execute(
        { ...input, subagent_type: "worker" },
        {
          ...f.execution,
          scopeHandle: f.execution.scopeHandle!.derive("review"),
        },
      ),
    ).rejects.toThrow(/只读父/);
    await expect(
      f.tool.execute(input, { ...f.execution, delegationDepth: 2 }),
    ).rejects.toThrow(/深度/);
    expect(f.requests).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
