import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import type {
  ScopeRepository,
  StoredExecutionScope,
} from "./scope-repository.js";
import {
  createExecutionScopes,
  type ExecutionScopes,
} from "./scope-service.js";

it("Task 工作域拒绝越界和符号链接逃逸，只读角色不能提升父目录授权", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "code-scope-")));
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), "code-outside-")),
  );
  try {
    await mkdir(join(root, "reference"));
    await symlink(outside, join(root, "escape"));
    const snapshot: CodeExecutionScope = {
      workspaceId: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
      projectId: "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5",
      taskId: "0432143f-e2b8-4ea6-adea-01f706f537d3",
      generation: 0,
      rootDirectory: root,
      additionalDirectories: [
        { path: join(root, "reference"), access: "read-only" },
      ],
      sandboxMode: "workspace-write",
    };
    const scopes = createExecutionScopes({
      repository: {
        load: async () => ({
          scope: snapshot,
          state: "ready" as const,
          branchGeneration: 1,
        }),
      },
      viewerService: {
        resolveWorkspace: async () => ({
          id: snapshot.workspaceId,
          name: "工作区",
          type: "personal" as const,
          ownerUserId: "user",
        }),
      },
    });
    const main = await scopes.openTask(
      {
        id: "user",
        email: "user@example.com",
        accessToken: "secret",
        userMetadata: {},
      },
      snapshot.taskId,
    );
    expect(await main.resolvePath("new.txt", "write")).toBe(
      join(root, "new.txt"),
    );
    await expect(main.resolvePath("../outside.txt", "read")).rejects.toThrow(
      "授权目录",
    );
    await expect(
      main.resolvePath("escape/private.txt", "read"),
    ).rejects.toThrow("授权目录");
    await expect(
      main.resolvePath("reference/new.txt", "write"),
    ).rejects.toThrow("只读");
    const worker = main.derive("review", "reviewer").derive("worker", "child");
    await expect(worker.resolvePath("new.txt", "write")).rejects.toThrow(
      "只读",
    );
    expect(worker.describe()).not.toHaveProperty("accessToken");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

const actor = {
  id: "user",
  email: "user@example.com",
  accessToken: "secret",
  userMetadata: {},
};

async function withTaskScope(
  run: (fixture: {
    scopes: ExecutionScopes;
    root: string;
    extra: string;
    taskId: string;
    changeBranch(): void;
  }) => Promise<void>,
  sandboxMode: CodeExecutionScope["sandboxMode"] = "workspace-write",
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "code-policy-")));
  const extra = await realpath(await mkdtemp(join(tmpdir(), "code-extra-")));
  let current: StoredExecutionScope = {
    state: "ready",
    branchGeneration: 1,
    scope: {
      workspaceId: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
      projectId: "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5",
      taskId: "0432143f-e2b8-4ea6-adea-01f706f537d3",
      generation: 0,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode,
    },
  };
  const repository: ScopeRepository = {
    async load(workspaceId, taskId) {
      return workspaceId === current.scope.workspaceId &&
        taskId === current.scope.taskId
        ? structuredClone(current)
        : null;
    },
    async beginUpdate(scope, patch) {
      if (
        scope.generation !== current.scope.generation ||
        current.state === "revoking"
      )
        return null;
      current = {
        state: "revoking",
        branchGeneration: current.branchGeneration,
        scope: {
          ...current.scope,
          additionalDirectories:
            patch.additionalDirectories ?? current.scope.additionalDirectories,
          sandboxMode: patch.sandboxMode ?? current.scope.sandboxMode,
          generation: current.scope.generation + 1,
        },
      };
      return structuredClone(current);
    },
    async finishUpdate(scope, state) {
      if (
        scope.generation !== current.scope.generation ||
        current.state !== "revoking"
      )
        return false;
      current = { ...current, state };
      return true;
    },
  };
  const scopes = createExecutionScopes({
    repository,
    viewerService: {
      resolveWorkspace: async (user) => ({
        id:
          user.id === actor.id
            ? current.scope.workspaceId
            : "951bd6ce-d728-4b7e-9035-4c0f1a315071",
        name: "工作区",
        type: "personal",
        ownerUserId: user.id,
      }),
    },
  });
  try {
    await run({
      scopes,
      root,
      extra,
      taskId: current.scope.taskId,
      changeBranch: () => {
        current = {
          ...current,
          branchGeneration: current.branchGeneration + 1,
        };
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(extra, { recursive: true, force: true });
  }
}

it("收紧授权先拒绝新操作，真实撤销完成后既有句柄保持只读", async () => {
  await withTaskScope(async ({ scopes, root, taskId }) => {
    const main = await scopes.openTask(actor, taskId);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const exited = new Promise<void>((resolve) => {
      release = resolve;
    });
    scopes.onRevoke(async () => {
      entered();
      await exited;
    });
    const changed = scopes.updateTask(actor, taskId, {
      sandboxMode: "read-only",
    });
    await started;
    await expect(main.resolvePath("late.txt", "write")).rejects.toThrow(
      "正在撤销",
    );
    release();
    expect((await changed).generation).toBe(1);
    await expect(main.resolvePath("late.txt", "write")).rejects.toThrow("只读");
    expect(await main.resolvePath("late.txt", "read")).toBe(
      join(root, "late.txt"),
    );
  });
});

it("撤销器停止失败时不报告ready，也不允许继续执行", async () => {
  await withTaskScope(async ({ scopes, taskId }) => {
    scopes.onRevoke(async () => {
      throw new Error("真实进程未退出");
    });
    await expect(
      scopes.updateTask(actor, taskId, { sandboxMode: "read-only" }),
    ).rejects.toThrow("真实进程未退出");
    await expect(scopes.openTask(actor, taskId)).rejects.toThrow("撤销失败");
  });
});

it("Task 扩权只影响新句柄，旧worker不能获得新增可写目录或沙箱写权限", async () => {
  await withTaskScope(async ({ scopes, root, extra, taskId }) => {
    const worker = (await scopes.openTask(actor, taskId)).derive(
      "worker",
      "existing-worker",
    );
    scopes.onRevoke(async () => {});
    await scopes.updateTask(actor, taskId, {
      sandboxMode: "workspace-write",
      additionalDirectories: [{ path: extra, access: "read-write" }],
    });
    await expect(worker.resolvePath("edit.txt", "write")).rejects.toThrow(
      "只读",
    );
    await expect(
      worker.resolvePath(join(extra, "edit.txt"), "read"),
    ).rejects.toThrow("授权目录");
    const current = await scopes.openTask(actor, taskId);
    expect(await current.resolvePath("edit.txt", "write")).toBe(
      join(root, "edit.txt"),
    );
    expect(await current.resolvePath(join(extra, "edit.txt"), "write")).toBe(
      join(extra, "edit.txt"),
    );
    expect(worker.describe().generation).toBe(1);
  }, "read-only");
});

it("撤销器未装配时拒绝授权变更，原Task授权不被静默替换", async () => {
  await withTaskScope(async ({ scopes, taskId }) => {
    await expect(
      scopes.updateTask(actor, taskId, { sandboxMode: "read-only" }),
    ).rejects.toMatchObject({ code: "revoker_unavailable", statusCode: 503 });
    expect((await scopes.openTask(actor, taskId)).describe().sandboxMode).toBe(
      "workspace-write",
    );
  });
});

it("另一个工作区的身份不能打开已知Task或变更其目录授权", async () => {
  await withTaskScope(async ({ scopes, taskId }) => {
    const foreign = { ...actor, id: "other-user" };
    await expect(scopes.openTask(foreign, taskId)).rejects.toMatchObject({
      code: "task_not_found",
      statusCode: 404,
    });
    await expect(
      scopes.updateTask(foreign, taskId, { sandboxMode: "read-only" }),
    ).rejects.toMatchObject({ code: "task_not_found", statusCode: 404 });
  });
});

it("权限ready之后的通知监听失败不回滚已完成撤销，也不把Task标为failed", async () => {
  await withTaskScope(async ({ scopes, taskId }) => {
    scopes.onRevoke(async () => {});
    scopes.onUpdated(async () => {
      throw new Error("通知接收方暂不可用");
    });
    await expect(
      scopes.updateTask(actor, taskId, { sandboxMode: "read-only" }),
    ).resolves.toMatchObject({ sandboxMode: "read-only", generation: 1 });
    expect((await scopes.openTask(actor, taskId)).describe().sandboxMode).toBe(
      "read-only",
    );
  });
});

it("分支重绕后旧主/子句柄均不可写，新句柄才可在同一目录继续工作", async () => {
  await withTaskScope(async ({ scopes, root, taskId, changeBranch }) => {
    const main = await scopes.openTask(actor, taskId);
    const worker = main.derive("worker", "before-rewind");
    changeBranch();
    await expect(main.resolvePath("late.txt", "write")).rejects.toMatchObject({
      code: "branch_changed",
    });
    await expect(worker.resolvePath("late.txt", "write")).rejects.toMatchObject(
      { code: "branch_changed" },
    );
    expect(
      await (await scopes.openTask(actor, taskId)).resolvePath(
        "late.txt",
        "write",
      ),
    ).toBe(join(root, "late.txt"));
  });
});

it("恢复期间普通Run打不开工作域，私有恢复句柄仅在精确代际和revoking内有效", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "code-restoring-")));
  const identity: CodeExecutionScope = {
    workspaceId: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
    projectId: "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5",
    taskId: "0432143f-e2b8-4ea6-adea-01f706f537d3",
    generation: 2,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  let state: StoredExecutionScope["state"] = "revoking";
  const scopes = createExecutionScopes({
    repository: {
      load: async () => ({ scope: identity, state, branchGeneration: 2 }),
    },
    viewerService: {
      resolveWorkspace: async () => ({ id: identity.workspaceId }) as never,
    },
  });
  try {
    await expect(scopes.openTask(actor, identity.taskId)).rejects.toMatchObject(
      { code: "scope_unavailable" },
    );
    await expect(
      scopes.openRestoringTask(actor, identity.taskId, 1),
    ).rejects.toMatchObject({ code: "scope_unavailable" });
    const restoring = await scopes.openRestoringTask(actor, identity.taskId, 2);
    expect(await restoring.resolvePath("restored.txt", "write")).toBe(
      join(root, "restored.txt"),
    );
    state = "ready";
    await expect(
      restoring.resolvePath("late.txt", "write"),
    ).rejects.toMatchObject({ code: "scope_unavailable" });
    expect(
      await (await scopes.openTask(actor, identity.taskId)).resolvePath(
        "new.txt",
        "write",
      ),
    ).toBe(join(root, "new.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("附加引用目录失效后仍可操作主目录，并可显式移除失效引用", async () => {
  await withTaskScope(async ({ scopes, root, extra, taskId }) => {
    scopes.onRevoke(async () => {});
    await scopes.updateTask(actor, taskId, {
      additionalDirectories: [{ path: extra, access: "read-only" }],
    });
    await rm(extra, { recursive: true, force: true });
    expect(
      await (await scopes.openTask(actor, taskId)).resolvePath(
        "main.txt",
        "write",
      ),
    ).toBe(join(root, "main.txt"));
    const next = await scopes.updateTask(actor, taskId, {
      additionalDirectories: [],
    });
    expect(next.additionalDirectories).toEqual([]);
    expect(next.generation).toBe(2);
  });
});

it("固定目录被symlink替换时新句柄不得静默跟随到未授权位置", async () => {
  await withTaskScope(async ({ scopes, root, extra, taskId }) => {
    const saved = `${root}-original`;
    await rename(root, saved);
    try {
      await symlink(extra, root);
      await expect(scopes.openTask(actor, taskId)).rejects.toMatchObject({
        code: "scope_changed",
      });
    } finally {
      await rm(root, { force: true });
      await rename(saved, root);
    }
  });
});
