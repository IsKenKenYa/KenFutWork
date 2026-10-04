import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  AGENT_GOVERNANCE_LIMITS,
  type CodeExecutionScope,
  zcodeUiProtocol as protocol,
  type StreamEvent,
  toolCompletedEventSchema,
} from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import type { AuthenticatedUser } from "../auth/types.js";
import { createCheckpointService } from "../checkpoints/checkpoint-service.js";
import { createInMemoryCheckpointRepository } from "../checkpoints/repository.js";
import {
  createShadowGitClient,
  type ExecShadowGit,
} from "../checkpoints/shadow-git-client.js";
import { fileDiffDisplay } from "../code-tools/file-display.js";
import type { ScopeState } from "../execution/scope-repository.js";
import {
  createExecutionScopes,
  type ExecutionScopeHandle,
} from "../execution/scope-service.js";
import {
  acquireTaskFileRestoreBarrier,
  revokeTaskFileOperations,
} from "../execution/scoped-filesystem.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import { createCodeUiConversation } from "./conversation.js";
import {
  applyFileRewind,
  type FileRewindCapture,
  prepareFileRewind,
} from "./file-rewind.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const actor: AuthenticatedUser = {
  id: "rewind-owner",
  email: "rewind@example.test",
  accessToken: "private",
  userMetadata: {},
};
// Git持久化边界用真实Git对象；ProcessSandbox屏障仍消费真实生产provider。
const exec: ExecShadowGit = async (args, directory, input) => {
  try {
    return {
      code: 0,
      stderr: "",
      stdout: execFileSync("git", ["--no-optional-locks", ...args], {
        cwd: directory.workTree,
        env: {
          ...process.env,
          GIT_DIR: directory.gitDir,
          GIT_WORK_TREE: directory.workTree,
        },
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer };
    return {
      code: failure.status ?? 1,
      stdout: "",
      stderr: failure.stderr?.toString() ?? "Git失败",
    };
  }
};
async function world(
  codePatchMaxBytes: number = AGENT_GOVERNANCE_DEFAULTS.codePatchMaxBytes,
) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-file-rewind-")),
  );
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(root);
  let identity: CodeExecutionScope = {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    generation: 0,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  let branch = 1;
  let state: ScopeState = "ready";
  const scopes = createExecutionScopes({
    repository: {
      load: async (workspace, task) =>
        workspace === identity.workspaceId && task === identity.taskId
          ? { scope: identity, state, branchGeneration: branch }
          : null,
    },
    viewerService: {
      resolveWorkspace: async () => ({ id: identity.workspaceId }) as never,
    },
    resolveFileLimits: async () => ({
      ...AGENT_GOVERNANCE_DEFAULTS,
      codePatchMaxBytes,
    }),
  });
  const scope = await scopes.openTask(actor, identity.taskId);
  const processSandbox = createProcessSandbox({
    captureRoot: join(base, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => processSandbox.close("test_cleanup"));
  const beginRestore = async () => {
    state = "revoking";
    branch++;
    const old = identity;
    identity = { ...identity, generation: identity.generation + 1 };
    await processSandbox.closeTask(old.taskId, "file_rewind", old.generation);
    await revokeTaskFileOperations(old.workspaceId, old.taskId);
    return scopes.openRestoringTask(
      actor,
      identity.taskId,
      identity.generation,
    );
  };
  const finishRestore = async (
    _scope: ExecutionScopeHandle,
    _actor: AuthenticatedUser,
    success: boolean,
  ) => {
    state = success ? "ready" : "failed";
  };
  const checkpointRoot = join(base, "checkpoints");
  const checkpoints = createCheckpointService({
    repository: createInMemoryCheckpointRepository(),
    gitForScope: async () =>
      createShadowGitClient({
        exec,
        writeTextFile: (path, text) => writeFile(path, text, "utf8"),
      }),
    gitSource: "system",
    checkpointRoot,
    files: {
      observe: (handle, path) => handle.backend.observeBinary(path),
      commit: async (handle, entries, before) => {
        const result = await handle.backend.commitBatch(entries, before);
        if (!result.complete || !result.newScope)
          throw new Error("检查点提交失败");
        return result.newScope;
      },
    },
    acquireRestoreBarrier: acquireTaskFileRestoreBarrier,
    onBeforeRestore: beginRestore,
    onAfterRestore: finishRestore,
  });
  const runId = randomUUID();
  const host = createCodeUiConversation({
    sessionId: identity.taskId,
    workspacePath: root,
    config: {
      provider: "zcode",
      model: "fixture",
      thought: "",
      followupMode: "queue",
    },
  });
  host.startTurn({ runId, commandId: randomUUID(), text: "修改后仅回退文件" });
  const events: StreamEvent[] = [];
  const record = (
    toolName: string,
    output: unknown,
    toolCallId: string = randomUUID(),
    status: "success" | "error" = "success",
  ) => {
    const timestamp = new Date().toISOString();
    host.recordEvent({
      type: "tool.started",
      runId,
      toolName,
      toolCallId,
      timestamp,
    });
    const event = toolCompletedEventSchema.parse({
      type: "tool.completed",
      runId,
      toolName,
      toolCallId,
      output,
      status,
      timestamp,
    });
    events.push(event);
    host.recordEvent(event);
  };
  const captures: FileRewindCapture[] = [];
  const pre = async () => {
    const captured = await checkpoints.captureTurnBoundary({
      scope,
      actor,
      runId,
      phase: "pre",
    });
    captures.push({
      runId,
      preCheckpointId: captured.effective?.id ?? null,
      postCheckpointId: null,
    });
  };
  const post = async () => {
    const captured = await checkpoints.captureTurnBoundary({
      scope,
      actor,
      runId,
      phase: "post",
    });
    const boundary = captures.find((entry) => entry.runId === runId);
    if (!boundary) throw new Error("夹具缺少本次Run pre引用");
    boundary.postCheckpointId = captured.effective?.id ?? null;
  };
  const prepareInput = () => {
    const snapshot = protocol.conversationSnapshotSchema.parse(
      host.getSnapshot(),
    );
    const header = snapshot.rows.window.find(
      (row) => row.kind === "turnHeader",
    );
    if (!header?.entityId) throw new Error("真实轮次身份缺失");
    return {
      scope,
      actor,
      snapshot,
      params: {
        sessionId: identity.taskId,
        target: { rowId: header.rowId, entityId: header.entityId },
        baseRevision: snapshot.revision,
        baseLogEpoch: snapshot.logEpoch,
      },
      events,
      captures,
      checkpoints,
    };
  };
  const prepare = () => prepareFileRewind(prepareInput());
  const applyInput = {
    scope,
    actor,
    processSandbox,
    beginRestore,
    finishRestore,
  };
  return {
    root,
    runId,
    scope,
    scopes,
    host,
    checkpoints,
    events,
    captures,
    record,
    pre,
    post,
    prepareInput,
    prepare,
    applyInput,
    apply: (plan: Awaited<ReturnType<typeof prepare>>) =>
      applyFileRewind(plan, applyInput),
  };
}

it("精确pre字节恢复UTF16 BOM原文件，仅回退真实native提交且聊天保留", async () => {
  const fixture = await world();
  const path = join(fixture.root, "encoded.txt");
  const original = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("before\n", "utf16le"),
  ]);
  await writeFile(path, original);
  await chmod(path, 0o755);
  const shellOnly = join(fixture.root, "shell-only.txt");
  await writeFile(shellOnly, "shell-before\n");
  await fixture.pre();
  await fixture.scope.backend.readPage({ path });
  const committed = await fixture.scope.backend.editFile({
    path,
    oldString: "before",
    newString: "after",
  });
  fixture.record("Edit", committed);
  await writeFile(shellOnly, "shell-after\n");
  await fixture.post();
  const chat = fixture.host.exportState();
  const plan = await fixture.prepare();
  expect(plan.preview).toEqual({
    canApply: true,
    safeFiles: [
      { path, action: "restore", operationCount: 1, toolNames: ["Edit"] },
    ],
    unsafeFiles: [],
    ignoredFiles: [],
  });
  await fixture.apply(plan);
  expect(await readFile(path)).toEqual(original);
  expect((await stat(path)).mode & 0o777).toBe(0o755);
  expect(await readFile(shellOnly, "utf8")).toBe("shell-after\n");
  expect(fixture.host.exportState()).toEqual(chat);
  const reopened = await fixture.scopes.openTask(
    actor,
    fixture.scope.describe().taskId,
  );
  expect(reopened.describe().generation).toBe(1);
});

it("现存0600文件的真实Edit回退保留0600，不把Git材料化0644当完整原权限", async () => {
  const fixture = await world();
  const path = join(fixture.root, "private.txt");
  await writeFile(path, "private-before\n", { mode: 0o600 });
  await fixture.pre();
  await fixture.scope.backend.readPage({ path });
  fixture.record(
    "Edit",
    await fixture.scope.backend.editFile({
      path,
      oldString: "private-before",
      newString: "private-after",
    }),
  );
  await fixture.post();
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await fixture.apply(await fixture.prepare());
  expect(await readFile(path, "utf8")).toBe("private-before\n");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("已删除可执行文件恢复为owner0700，仅继承Git执行位而不恢复group/other访问", async () => {
  const fixture = await world();
  const path = join(fixture.root, "executable.sh");
  const original = "#!/bin/sh\nprintf before\n";
  await writeFile(path, original);
  await chmod(path, 0o755);
  await fixture.pre();
  await fixture.scope.backend.readPage({ path });
  fixture.record(
    "ApplyPatch",
    await fixture.scope.backend.applyPatch({
      patchText:
        "*** Begin Patch\n*** Delete File: executable.sh\n*** End Patch",
    }),
  );
  await fixture.post();
  await fixture.apply(await fixture.prepare());
  expect(await readFile(path, "utf8")).toBe(original);
  expect((await stat(path)).mode & 0o777).toBe(0o700);
});

async function edited() {
  const fixture = await world();
  const path = join(fixture.root, "edited.txt");
  await writeFile(path, "before\n");
  await fixture.pre();
  await fixture.scope.backend.readPage({ path });
  fixture.record(
    "Edit",
    await fixture.scope.backend.editFile({
      path,
      oldString: "before",
      newString: "after",
    }),
  );
  await fixture.post();
  return { ...fixture, path };
}

it("同路径shell在第一次native之前混入也不能恢复精确pre旧字节", async () => {
  const fixture = await world();
  const path = join(fixture.root, "mixed.txt");
  await writeFile(path, "before\n");
  await fixture.pre();
  await writeFile(path, "shell\n");
  await fixture.scope.backend.readPage({ path });
  fixture.record(
    "Edit",
    await fixture.scope.backend.editFile({
      path,
      oldString: "shell",
      newString: "after",
    }),
  );
  await fixture.post();
  const plan = await fixture.prepare();
  expect(plan.preview).toMatchObject({
    canApply: false,
    safeFiles: [],
    unsafeFiles: [{ path, reason: "external_modified" }],
  });
  await expect(fixture.apply(plan)).rejects.toThrow("不可执行");
  expect(await readFile(path, "utf8")).toBe("after\n");
});

it("同路径shell在native之后进入post的变更不能被最后native版本掩盖", async () => {
  const fixture = await edited();
  await writeFile(fixture.path, "shell-after\n");
  await fixture.post();
  const plan = await fixture.prepare();
  expect(plan.preview).toMatchObject({
    canApply: false,
    unsafeFiles: [{ path: fixture.path, reason: "external_modified" }],
  });
  expect(await readFile(fixture.path, "utf8")).toBe("shell-after\n");
});

it("post之后外部修改与预览后竞争都拒绝执行，失败前不撤销Task或遗留barrier", async () => {
  const fixture = await edited();
  const plan = await fixture.prepare();
  await writeFile(fixture.path, "external\n");
  await expect(fixture.apply(plan)).rejects.toThrow("预览后变化");
  const refreshed = await fixture.prepare();
  expect(refreshed.preview).toMatchObject({
    canApply: false,
    unsafeFiles: [{ path: fixture.path, reason: "external_modified" }],
  });
  const stillReady = await fixture.scopes.openTask(
    actor,
    fixture.scope.describe().taskId,
  );
  expect(stillReady.describe().generation).toBe(0);
  await stillReady.backend.readPage({ path: fixture.path });
  await stillReady.backend.editFile({
    path: fixture.path,
    oldString: "external",
    newString: "continued",
  });
  expect(await readFile(fixture.path, "utf8")).toBe("continued\n");
});

it("缺失精确pre/post引用返回闭集checkpoint_missing，日志缺失或重复均明确拒绝", async () => {
  const fixture = await edited();
  const input = fixture.prepareInput();
  const plan = await prepareFileRewind({ ...input, captures: null });
  expect(plan.preview).toMatchObject({
    canApply: false,
    unsafeFiles: [{ path: fixture.path, reason: "checkpoint_missing" }],
  });
  await expect(prepareFileRewind({ ...input, events: [] })).rejects.toThrow(
    "日志缺失或重复",
  );
  await expect(
    prepareFileRewind({ ...input, events: [...input.events, ...input.events] }),
  ).rejects.toThrow("日志缺失或重复");
  expect(await readFile(fixture.path, "utf8")).toBe("after\n");
});

it("原生提交日志缺少版本时不能静默当无文件变更，完整canonical必须明确拒绝", async () => {
  const fixture = await edited();
  const input = fixture.prepareInput();
  const events = input.events.map((event) =>
    event.type === "tool.completed"
      ? { ...event, output: { ...event.output, version: undefined } }
      : event,
  );
  await expect(prepareFileRewind({ ...input, events })).rejects.toThrow(
    "canonical日志不完整",
  );
  expect(await readFile(fixture.path, "utf8")).toBe("after\n");
});

it("成功native行缺少整个canonical也明确拒绝，不冒充没有文件提交", async () => {
  const fixture = await edited();
  const input = fixture.prepareInput();
  const events = input.events.map((event) =>
    event.type === "tool.completed" ? { ...event, output: {} } : event,
  );
  await expect(prepareFileRewind({ ...input, events })).rejects.toThrow(
    "canonical日志不完整",
  );
});

it("实体/CAS/根Task/只读角色不能签发恢复计划", async () => {
  const fixture = await edited();
  const input = fixture.prepareInput();
  await expect(
    prepareFileRewind({
      ...input,
      params: {
        ...input.params,
        target: { ...input.params.target, entityId: "forged" },
      },
    }),
  ).rejects.toThrow("身份不匹配");
  await expect(
    prepareFileRewind({
      ...input,
      params: { ...input.params, baseRevision: input.params.baseRevision - 1 },
    }),
  ).rejects.toThrow("会话已更新");
  await expect(
    prepareFileRewind({
      ...input,
      params: { ...input.params, sessionId: randomUUID() },
    }),
  ).rejects.toThrow("根Task");
  await expect(
    prepareFileRewind({
      ...input,
      scope: fixture.scope.derive("review", "read-only"),
    }),
  ).rejects.toThrow("根Task");
  expect(await readFile(fixture.path, "utf8")).toBe("after\n");
});

it("成功move缺少源与目标完整提交证据时unsupported，不损坏任何一端", async () => {
  const fixture = await world();
  const source = join(fixture.root, "source.txt");
  const target = join(fixture.root, "target.txt");
  await writeFile(source, "before\n");
  await fixture.pre();
  await fixture.scope.backend.readPage({ path: source });
  const result = await fixture.scope.backend.applyPatch({
    patchText:
      "*** Begin Patch\n*** Update File: source.txt\n*** Move to: target.txt\n@@\n-before\n+after\n*** End Patch",
  });
  expect(result.files).toMatchObject([
    { filePath: source, type: "move", movePath: target },
  ]);
  fixture.record("ApplyPatch", result);
  await fixture.post();
  const plan = await fixture.prepare();
  expect(plan.preview).toMatchObject({
    canApply: false,
    unsafeFiles: [{ path: source, reason: "unsupported_checkpoint" }],
  });
  await expect(fixture.apply(plan)).rejects.toThrow("不可执行");
  expect(await readFile(target, "utf8")).toBe("after\n");
  await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it("有界display截断时仍从完整canonical重建两项native变更，按精确pre恢复", async () => {
  const fixture = await world(AGENT_GOVERNANCE_LIMITS.codePatchMaxBytes.min);
  const path = join(fixture.root, "bounded.txt");
  const original = `first${"x".repeat(300)}\nsame\nsame\nsame\nfirst${"x".repeat(300)}\n`;
  await writeFile(path, original);
  await fixture.pre();
  await fixture.scope.backend.readPage({ path });
  const committed = await fixture.scope.backend.editFile({
    path,
    oldString: "first",
    newString: "second",
    replaceAll: true,
  });
  const display = fileDiffDisplay(
    committed,
    fixture.scope.backend.limits.codePatchMaxBytes,
  );
  expect(display.structuredPatch).toHaveLength(1);
  expect(committed.structuredPatch).toHaveLength(2);
  fixture.record("Edit", { ...committed, display });
  await fixture.post();
  const plan = await fixture.prepare();
  expect(plan.preview).toMatchObject({
    canApply: true,
    safeFiles: [{ path, action: "restore" }],
  });
  await fixture.apply(plan);
  expect(await readFile(path, "utf8")).toBe(original);
});

const processLimits = {
  maxOutputBytes: AGENT_GOVERNANCE_DEFAULTS.processMaxOutputBytes,
  previewMaxChars: AGENT_GOVERNANCE_DEFAULTS.processPreviewMaxChars,
  yieldMs: AGENT_GOVERNANCE_DEFAULTS.processYieldMs,
  killGraceMs: AGENT_GOVERNANCE_DEFAULTS.processKillGraceMs,
};

it("Write新建后再次Edit仍只回退该真实路径，完整两次提交聚合后删除新文件", async () => {
  const fixture = await world();
  await writeFile(join(fixture.root, "anchor.txt"), "existing\n");
  await fixture.pre();
  const path = join(fixture.root, "created.txt");
  fixture.record(
    "Write",
    await fixture.scope.backend.writeFile({
      path,
      content: "first\n",
      createOnly: true,
    }),
  );
  await fixture.scope.backend.readPage({ path });
  fixture.record(
    "Edit",
    await fixture.scope.backend.editFile({
      path,
      oldString: "first",
      newString: "second",
    }),
  );
  await fixture.post();
  const plan = await fixture.prepare();
  expect(plan.preview).toEqual({
    canApply: true,
    safeFiles: [
      {
        path,
        action: "delete",
        operationCount: 2,
        toolNames: ["Write", "Edit"],
      },
    ],
    unsafeFiles: [],
    ignoredFiles: [],
  });
  await fixture.apply(plan);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(fixture.root, "anchor.txt"), "utf8")).toBe(
    "existing\n",
  );
});

it("同路径native按真实完成日志重建，工具启动行顺序不同也可安全回退", async () => {
  const fixture = await world();
  const path = join(fixture.root, "completion-order.txt");
  await writeFile(path, "before\n");
  await fixture.pre();
  const timestamp = new Date().toISOString();
  fixture.host.recordEvent({
    type: "tool.started",
    runId: fixture.runId,
    toolName: "Edit",
    toolCallId: "finishes-second",
    timestamp,
  });
  fixture.host.recordEvent({
    type: "tool.started",
    runId: fixture.runId,
    toolName: "Edit",
    toolCallId: "finishes-first",
    timestamp,
  });
  await fixture.scope.backend.readPage({ path });
  fixture.record(
    "Edit",
    await fixture.scope.backend.editFile({
      path,
      oldString: "before",
      newString: "middle",
    }),
    "finishes-first",
  );
  await fixture.scope.backend.readPage({ path });
  fixture.record(
    "Edit",
    await fixture.scope.backend.editFile({
      path,
      oldString: "middle",
      newString: "after",
    }),
    "finishes-second",
  );
  await fixture.post();
  const plan = await fixture.prepare();
  expect(plan.preview).toEqual({
    canApply: true,
    safeFiles: [
      { path, action: "restore", operationCount: 2, toolNames: ["Edit"] },
    ],
    unsafeFiles: [],
    ignoredFiles: [],
  });
  await fixture.apply(plan);
  expect(await readFile(path, "utf8")).toBe("before\n");
});

it("多文件精确原字节总量超过治理预算时明确拒绝，不只按单文件大小放行", async () => {
  const fixture = await world(AGENT_GOVERNANCE_LIMITS.codePatchMaxBytes.min);
  const paths = ["a.txt", "b.txt", "c.txt"].map((name) =>
    join(fixture.root, name),
  );
  for (const path of paths) await writeFile(path, `before${"x".repeat(400)}\n`);
  await fixture.pre();
  for (const path of paths) {
    await fixture.scope.backend.readPage({ path });
    fixture.record(
      "Edit",
      await fixture.scope.backend.editFile({
        path,
        oldString: "before",
        newString: "after",
      }),
    );
  }
  await fixture.post();
  await expect(fixture.prepare()).rejects.toThrow("超过工作区补丁字节预算");
  for (const path of paths)
    expect(await readFile(path, "utf8")).toBe(`after${"x".repeat(400)}\n`);
});

it("不可读精确checkpoint或非绝对native路径均fail closed，不回退其它文件", async () => {
  const fixture = await edited();
  const input = fixture.prepareInput();
  const missing = await prepareFileRewind({
    ...input,
    captures: [
      {
        runId: input.captures[0]?.runId ?? "missing",
        preCheckpointId: randomUUID(),
        postCheckpointId: input.captures[0]?.postCheckpointId ?? null,
      },
    ],
  });
  expect(missing.preview).toMatchObject({
    canApply: false,
    unsafeFiles: [{ path: fixture.path, reason: "checkpoint_unreadable" }],
  });
  const events = input.events.map((event) =>
    event.type === "tool.completed"
      ? { ...event, output: { ...event.output, filePath: "../outside.txt" } }
      : event,
  );
  const denied = await prepareFileRewind({ ...input, events });
  expect(denied.preview).toMatchObject({
    canApply: false,
    unsafeFiles: [{ path: "../outside.txt", reason: "unsupported_checkpoint" }],
  });
  expect(await readFile(fixture.path, "utf8")).toBe("after\n");
});
it("实际同Task进程确认rangeEmpty且文件barrier释放后才允许宿主finish，聊天不截断", async () => {
  const fixture = await edited();
  const plan = await fixture.prepare();
  const sandbox = fixture.applyInput.processSandbox;
  const child = await sandbox.spawn({
    scope: fixture.scope.describe(),
    agentId: "main",
    invocationId: randomUUID(),
    argv: {
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("alive");setInterval(()=>{},1000)'],
    },
    background: true,
    timeoutMs: null,
    limits: processLimits,
  });
  await expect
    .poll(
      async () =>
        (
          await child.readOutput({
            offset: 0,
            maxBytes: processLimits.maxOutputBytes,
          })
        ).data,
    )
    .toContain("alive");
  await applyFileRewind(plan, {
    ...fixture.applyInput,
    finishRestore: async (scope, owner, success) => {
      expect(await child.waitForExit()).toMatchObject({
        rangeEmpty: true,
        stopped: true,
      });
      await expect(
        fixture.scopes.openTask(actor, scope.describe().taskId),
      ).rejects.toMatchObject({ code: "scope_unavailable" });
      expect(await readFile(fixture.path, "utf8")).toBe("before\n");
      await fixture.applyInput.finishRestore(scope, owner, success);
    },
  });
  expect(
    (
      await fixture.scopes.openTask(actor, fixture.scope.describe().taskId)
    ).describe().generation,
  ).toBe(1);
});

it("实际其它Task相交RW进程阻止回退且不被自动停止，显式停止后同计划可安全执行", async () => {
  const fixture = await edited();
  const plan = await fixture.prepare();
  const child = await fixture.applyInput.processSandbox.spawn({
    scope: { ...fixture.scope.describe(), taskId: randomUUID() },
    agentId: "main",
    invocationId: randomUUID(),
    argv: {
      executable: process.execPath,
      args: [
        "-e",
        'process.stdout.write("foreign-alive");setInterval(()=>{},1000)',
      ],
    },
    background: true,
    timeoutMs: null,
    limits: processLimits,
  });
  await expect
    .poll(
      async () =>
        (
          await child.readOutput({
            offset: 0,
            maxBytes: processLimits.maxOutputBytes,
          })
        ).data,
    )
    .toContain("foreign-alive");
  await expect(fixture.apply(plan)).rejects.toMatchObject({
    code: "restore_conflict",
  });
  expect(child.snapshot().state).toBe("running");
  expect(await readFile(fixture.path, "utf8")).toBe("after\n");
  await child.stop("explicit_test_stop");
  await fixture.apply(plan);
  expect(await readFile(fixture.path, "utf8")).toBe("before\n");
});

it("ApplyPatch部分提交仅回退真实更新/新建/删除，失败项不进入计划且delete期望当前缺失", async () => {
  const fixture = await world();
  const updated = join(fixture.root, "update.txt");
  const removed = join(fixture.root, "removed.txt");
  const created = join(fixture.root, "created.txt");
  await writeFile(updated, "before\n");
  await writeFile(removed, "delete-me\n");
  await fixture.pre();
  await fixture.scope.backend.readPage({ path: updated });
  await fixture.scope.backend.readPage({ path: removed });
  const result = await fixture.scope.backend.applyPatch({
    patchText:
      "*** Begin Patch\n*** Update File: update.txt\n@@\n-before\n+after\n*** Add File: created.txt\n+created\n*** Delete File: removed.txt\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch",
  });
  expect(result.failures).toMatchObject([{ filePath: "missing.txt" }]);
  fixture.record("ApplyPatch", result, randomUUID(), "error");
  await fixture.post();
  const plan = await fixture.prepare();
  expect(plan.preview).toEqual({
    canApply: true,
    unsafeFiles: [],
    ignoredFiles: [],
    safeFiles: [
      {
        path: updated,
        action: "restore",
        operationCount: 1,
        toolNames: ["ApplyPatch"],
      },
      {
        path: created,
        action: "delete",
        operationCount: 1,
        toolNames: ["ApplyPatch"],
      },
      {
        path: removed,
        action: "restore",
        operationCount: 1,
        toolNames: ["ApplyPatch"],
      },
    ],
  });
  await fixture.apply(plan);
  expect(await readFile(updated, "utf8")).toBe("before\n");
  expect(await readFile(removed, "utf8")).toBe("delete-me\n");
  expect((await stat(removed)).mode & 0o777).toBe(0o600);
  await expect(readFile(created)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(join(fixture.root, "missing.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
