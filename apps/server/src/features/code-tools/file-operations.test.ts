import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import {
  acquireTaskFileRestoreBarrier,
  hasTaskFileOperations,
  registerTaskFileOperationParticipant,
  revokeTaskFileOperations,
  runFileOperation,
  type TaskFileRestoreLease,
} from "./file-operations.js";

interface PendingWrite {
  instanceId: string;
  taskId: string;
  writeRoots: string[];
}

interface Participant {
  pendingWrites(): Promise<PendingWrite[]>;
  revoke(instanceId: string, taskId: string): Promise<void>;
}

const directories: string[] = [];
const leases: TaskFileRestoreLease[] = [];
const disposers: Array<() => void> = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.release();
  for (const dispose of disposers.splice(0)) dispose();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function register(participant: Participant) {
  const dispose = registerTaskFileOperationParticipant(participant);
  disposers.push(dispose);
  return dispose;
}

async function acquire(scope: ScopedFilesystemScope) {
  const lease = await acquireTaskFileRestoreBarrier(scope, [
    scope.describe().rootDirectory,
  ]);
  leases.push(lease);
  return lease;
}

async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "task-file-participant-")),
  );
  directories.push(directory);
  const rootDirectory = join(directory, "project");
  const adjacentDirectory = join(directory, "project-other");
  await Promise.all([
    mkdir(adjacentDirectory),
    mkdir(join(rootDirectory, "nested"), { recursive: true }),
  ]);
  const instanceId = randomUUID();
  const projectId = randomUUID();
  function scope(
    taskId = randomUUID(),
    root = rootDirectory,
    instance = instanceId,
  ): ScopedFilesystemScope {
    return {
      role: "main",
      agentId: "main",
      describe: () => ({
        instanceId: instance,
        projectId,
        taskId,
        generation: 1,
        rootDirectory: root,
        additionalDirectories: [],
        sandboxMode: "workspace-write",
      }),
      resolvePath: async (path) => {
        const absolute = resolve(root, path);
        if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
          throw new Error("目录未授权");
        return absolute;
      },
    };
  }
  const writer = scope();
  const restoring = scope();
  return {
    directory,
    rootDirectory,
    adjacentDirectory,
    instanceId,
    scope,
    writer,
    restoring,
  };
}

it("现有active回调在abort后仍等待清理，回调拒绝不阻止撤销完成", async () => {
  const { writer } = await fixture();
  const entered = deferred();
  const cleanup = deferred();
  let aborted = false;
  const running = runFileOperation(
    writer,
    undefined,
    async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      entered.resolve();
      await cleanup.promise;
      signal.throwIfAborted();
    },
    "write",
  ).then(
    () => "completed",
    () => "aborted",
  );
  await entered.promise;
  const identity = writer.describe();
  let stopped = false;
  const stopping = revokeTaskFileOperations(
    identity.instanceId,
    identity.taskId,
  ).then(() => {
    stopped = true;
  });
  try {
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(hasTaskFileOperations(identity.instanceId, identity.taskId)).toBe(
      true,
    );
    await expect(
      runFileOperation(writer, undefined, async () => "late", "write"),
    ).rejects.toThrow(/撤销/);
  } finally {
    cleanup.resolve();
    await stopping;
    await running;
  }
  expect(await running).toBe("aborted");
  expect(hasTaskFileOperations(identity.instanceId, identity.taskId)).toBe(
    false,
  );
  await expect(
    runFileOperation(writer, undefined, async () => "new", "write"),
  ).resolves.toBe("new");
});

it("现有其它Task的active写入仍阻止相交恢复，完成后允许恢复", async () => {
  const { writer, restoring } = await fixture();
  const entered = deferred();
  const finish = deferred();
  const running = runFileOperation(
    writer,
    undefined,
    async () => {
      entered.resolve();
      await finish.promise;
    },
    "write",
  );
  await entered.promise;
  try {
    await expect(acquire(restoring)).rejects.toMatchObject({
      code: "restore_busy",
    });
  } finally {
    finish.resolve();
    await running;
  }
  const lease = await acquire(restoring);
  await lease.release();
});

it("回调已结束且参与者冷重建后，磁盘pending仍阻止其它Task恢复", async () => {
  const f = await fixture();
  const path = join(f.directory, "pending.json");
  const pending: PendingWrite[] = [
    {
      instanceId: f.instanceId,
      taskId: f.writer.describe().taskId,
      writeRoots: [f.rootDirectory],
    },
  ];
  await writeFile(path, JSON.stringify(pending));
  const participant = (): Participant => ({
    pendingWrites: async () => JSON.parse(await readFile(path, "utf8")),
    revoke: async () => {},
  });
  const dispose = register(participant());
  await runFileOperation(f.writer, undefined, async () => "unknown", "write");
  expect(hasTaskFileOperations(f.instanceId, f.writer.describe().taskId)).toBe(
    false,
  );
  await expect(acquire(f.restoring)).rejects.toMatchObject({
    code: "restore_busy",
  });

  dispose();
  register(participant());
  await expect(acquire(f.restoring)).rejects.toMatchObject({
    code: "restore_busy",
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(pending);

  await writeFile(path, "[]");
  const lease = await acquire(f.restoring);
  await lease.release();
});

it.each(["parent", "child"])(
  "其它Task的%s写域与恢复目录相交时拒绝且不取消对方",
  async (direction) => {
    const f = await fixture();
    let revoked = false;
    register({
      pendingWrites: async () => [
        {
          instanceId: f.instanceId,
          taskId: f.writer.describe().taskId,
          writeRoots: [
            direction === "parent"
              ? f.directory
              : join(f.rootDirectory, "nested"),
          ],
        },
      ],
      revoke: async () => {
        revoked = true;
      },
    });
    await expect(acquire(f.restoring)).rejects.toMatchObject({
      code: "restore_busy",
    });
    expect(revoked).toBe(false);
  },
);

it("仅共享路径前缀的不相交持久写域不阻止恢复", async () => {
  const f = await fixture();
  register({
    pendingWrites: async () => [
      {
        instanceId: f.instanceId,
        taskId: f.writer.describe().taskId,
        writeRoots: [f.adjacentDirectory],
      },
    ],
    revoke: async () => {},
  });
  const lease = await acquire(f.restoring);
  await lease.release();
});

it("相同Task编号但不同实例的相交持久写域仍属于其它Task", async () => {
  const f = await fixture();
  register({
    pendingWrites: async () => [
      {
        instanceId: randomUUID(),
        taskId: f.restoring.describe().taskId,
        writeRoots: [f.rootDirectory],
      },
    ],
    revoke: async () => {},
  });
  await expect(acquire(f.restoring)).rejects.toMatchObject({
    code: "restore_busy",
  });
});

it("同Task由revoke排空，unknown向上传播且仍等待active清理，可信结束后才放行", async () => {
  const f = await fixture();
  const unknown = Object.assign(new Error("原生保存结束尚未确认"), {
    code: "stop_unconfirmed",
  });
  let pending = true;
  register({
    pendingWrites: async () =>
      pending
        ? [
            {
              instanceId: f.instanceId,
              taskId: f.writer.describe().taskId,
              writeRoots: [f.rootDirectory],
            },
          ]
        : [],
    revoke: async (instanceId, taskId) => {
      if (
        instanceId === f.instanceId &&
        taskId === f.writer.describe().taskId &&
        pending
      )
        throw unknown;
    },
  });
  const entered = deferred();
  const cleanup = deferred();
  const running = runFileOperation(
    f.writer,
    undefined,
    async (signal) => {
      entered.resolve();
      await cleanup.promise;
      signal.throwIfAborted();
    },
    "write",
  ).catch(() => {});
  await entered.promise;
  let lease: TaskFileRestoreLease | undefined;
  let stopping: Promise<unknown> | undefined;
  try {
    lease = await acquire(f.writer);
    let stopped = false;
    stopping = revokeTaskFileOperations(
      f.instanceId,
      f.writer.describe().taskId,
    ).then(
      () => {
        stopped = true;
        return undefined;
      },
      (error: unknown) => {
        stopped = true;
        return error;
      },
    );
    await Promise.resolve();
    expect(stopped).toBe(false);
    cleanup.resolve();
    await running;
    expect(await stopping).toBe(unknown);
    await lease.release();
    lease = undefined;
    await expect(acquire(f.restoring)).rejects.toMatchObject({
      code: "restore_busy",
    });

    pending = false;
    await expect(
      revokeTaskFileOperations(f.instanceId, f.writer.describe().taskId),
    ).resolves.toBeUndefined();
    const released = await acquire(f.restoring);
    await released.release();
  } finally {
    cleanup.resolve();
    await running;
    await stopping;
    await lease?.release();
  }
});

it("外部扫描尚未完成时已禁止相交写入与第二个恢复，读取保持可用", async () => {
  const f = await fixture();
  const scanning = deferred();
  const finishScan = deferred();
  register({
    pendingWrites: async () => {
      scanning.resolve();
      await finishScan.promise;
      return [];
    },
    revoke: async () => {},
  });
  const acquiring = acquire(f.restoring);
  await scanning.promise;
  try {
    await expect(
      runFileOperation(f.writer, undefined, async () => "unsafe", "write"),
    ).rejects.toMatchObject({ code: "restore_busy" });
    await expect(acquire(f.scope())).rejects.toMatchObject({
      code: "restore_busy",
    });
    await expect(
      runFileOperation(f.writer, undefined, async () => "read"),
    ).resolves.toBe("read");
  } finally {
    finishScan.resolve();
    await (await acquiring).release();
  }
  await expect(
    runFileOperation(f.writer, undefined, async () => "safe", "write"),
  ).resolves.toBe("safe");
});

it("持久写域冲突释放临时恢复屏障，但失败不删除参与者的pending事实", async () => {
  const f = await fixture();
  const pending: PendingWrite[] = [
    {
      instanceId: f.instanceId,
      taskId: f.writer.describe().taskId,
      writeRoots: [f.rootDirectory],
    },
  ];
  register({ pendingWrites: async () => pending, revoke: async () => {} });
  await expect(acquire(f.restoring)).rejects.toMatchObject({
    code: "restore_busy",
  });
  await expect(
    runFileOperation(f.writer, undefined, async () => "cleanup", "write"),
  ).resolves.toBe("cleanup");
  await expect(acquire(f.restoring)).rejects.toMatchObject({
    code: "restore_busy",
  });
});

it("外部扫描失败释放临时恢复屏障，恢复扫描后仍按持久pending拒绝", async () => {
  const f = await fixture();
  const scanFailure = new Error("持久保存记录暂不可读");
  let readable = false;
  register({
    pendingWrites: async () => {
      if (!readable) throw scanFailure;
      return [
        {
          instanceId: f.instanceId,
          taskId: f.writer.describe().taskId,
          writeRoots: [f.rootDirectory],
        },
      ];
    },
    revoke: async () => {},
  });
  await expect(acquire(f.restoring)).rejects.toBe(scanFailure);
  await expect(
    runFileOperation(f.writer, undefined, async () => "cleanup", "write"),
  ).resolves.toBe("cleanup");
  readable = true;
  await expect(acquire(f.restoring)).rejects.toMatchObject({
    code: "restore_busy",
  });
});
