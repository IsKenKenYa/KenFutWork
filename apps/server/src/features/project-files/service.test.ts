import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ScopedFileController } from "../code-tools/file-controller.js";
import {
  acquireTaskFileRestoreBarrier,
  hasTaskFileOperations,
  revokeTaskFileOperations,
} from "../code-tools/file-operations.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import * as projectFilesystem from "./filesystem.js";
import { createProjectFileService } from "./service.js";
import type { ProjectFileRecord, ProjectFileRepository } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const bytes = Buffer.from("ordinary-project-file");
const fingerprint = createHash("sha256").update(bytes).digest("hex");

function holdTaskPublish() {
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = ScopedFileController.prototype.resolveWrite;
  let signal: AbortSignal | undefined;
  const spy = vi
    .spyOn(ScopedFileController.prototype, "resolveWrite")
    .mockImplementation(async function (this: ScopedFileController, ...args) {
      const files = await readdir(dirname(args[0])).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      // 原Controller已经写完并sync真实临时文件，在最终发布检查处暂停。
      if (
        files.some(
          (name) => name.startsWith(".kenfutwork-") && name.endsWith(".tmp"),
        )
      ) {
        signal = args[1];
        entered();
        await held;
      }
      return original.apply(this, args);
    });
  return {
    started,
    release,
    signal: () => signal,
    restore: () => spy.mockRestore(),
  };
}

it("真实Task二进制发布加入撤权屏障，等待资源结束且迟到操作不重放", async () => {
  const f = await fixture();
  f.useCode();
  const receipt = await f.service.prepareWrite(f.actor, {
    ...f.input,
    target: { kind: "task", taskId: f.taskId },
  });
  const gate = holdTaskPublish();
  const result = f.service.namespaceProvider
    .upload(receipt.objectPath, bytes)
    .then(
      () => null,
      (error: unknown) => error,
    );
  let closing: Promise<void> | undefined;
  try {
    await gate.started;
    expect(hasTaskFileOperations(f.actor.instanceId, f.taskId)).toBe(true);
    expect(
      (await readdir(join(f.taskRoot, "assets"))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toHaveLength(1);
    f.revoke();
    let closed = false;
    closing = revokeTaskFileOperations(f.actor.instanceId, f.taskId).then(
      () => {
        closed = true;
      },
    );
    await Promise.resolve();
    expect(gate.signal()?.aborted).toBe(true);
    expect(closed).toBe(false);
    gate.release();
    expect(await result).toMatchObject({ name: "AbortError" });
    await closing;
    expect(hasTaskFileOperations(f.actor.instanceId, f.taskId)).toBe(false);
    expect(f.rows.get(receipt.assetId)?.file_state).toBe("pending");
    expect(await readdir(join(f.taskRoot, "assets"))).toEqual([]);
    await expect(
      readFile(join(f.taskRoot, receipt.relativePath)),
    ).rejects.toThrow();
    await expect(
      f.service.namespaceProvider.upload(receipt.objectPath, bytes),
    ).rejects.toMatchObject({ code: "scope_changed" });
  } finally {
    gate.release();
    await result;
    await closing;
    gate.restore();
  }
});

it("held发布可被同Task恢复等待，相交其他Task恢复拒绝；屏障内新资产不写入", async () => {
  const f = await fixture();
  f.useCode();
  const receipt = await f.service.prepareWrite(f.actor, {
    ...f.input,
    target: { kind: "task", taskId: f.taskId },
  });
  const owner = await f.executionScopes.openTask(f.actor, f.taskId);
  const other = await f.anotherTask();
  const gate = holdTaskPublish();
  const result = f.service.namespaceProvider
    .upload(receipt.objectPath, bytes)
    .then(
      () => null,
      (error: unknown) => error,
    );
  let lease:
    | Awaited<ReturnType<typeof acquireTaskFileRestoreBarrier>>
    | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await gate.started;
    await expect(
      acquireTaskFileRestoreBarrier(other, [f.taskRoot]),
    ).rejects.toMatchObject({ code: "restore_busy" });
    lease = await acquireTaskFileRestoreBarrier(owner, [f.taskRoot]);
    let stopped = false;
    stopping = revokeTaskFileOperations(f.actor.instanceId, f.taskId).then(
      () => {
        stopped = true;
      },
    );
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.release();
    expect(await result).toMatchObject({ name: "AbortError" });
    await stopping;
    const next = await f.service.prepareWrite(f.actor, {
      ...f.input,
      assetId: randomUUID(),
      relativePath: "assets/next.bin",
      target: { kind: "task", taskId: f.taskId },
    });
    await expect(
      f.service.namespaceProvider.upload(next.objectPath, bytes),
    ).rejects.toMatchObject({ code: "restore_busy" });
    await expect(
      readFile(join(f.taskRoot, next.relativePath)),
    ).rejects.toThrow();
  } finally {
    gate.release();
    await result;
    await stopping;
    await lease?.release();
    gate.restore();
  }
});

it("describe只返回ready精确索引，素材字节读取不可用时仍能直接引用", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await expect(
    f.service.describe(f.actor, receipt.assetId),
  ).rejects.toMatchObject({ code: "file_pending" });
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  const before = structuredClone([...f.rows.values()]);
  const unavailable = vi
    .spyOn(projectFilesystem, "readProjectFile")
    .mockRejectedValue(new Error("描述素材不能下载字节"));
  try {
    expect(await f.service.describe(f.actor, receipt.assetId)).toEqual(receipt);
    expect([...f.rows.values()]).toEqual(before);
  } finally {
    unavailable.mockRestore();
  }
  await rm(join(f.root, receipt.relativePath));
  await expect(
    f.service.describe(f.actor, receipt.assetId),
  ).rejects.toMatchObject({ code: "file_missing" });
  await expect(
    f.service.describe(
      { ...f.actor, instanceId: randomUUID() },
      receipt.assetId,
    ),
  ).rejects.toThrow();
});

it("describe按当前只读授权描述ready素材，Task撤销后拒绝", async () => {
  const f = await fixture();
  f.useCode();
  const receipt = await f.service.prepareWrite(f.actor, {
    ...f.input,
    target: { kind: "task", taskId: f.taskId },
  });
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  expect(await f.service.describe(f.actor, receipt.assetId)).toEqual(receipt);
  f.readOnly();
  expect(await f.service.describe(f.actor, receipt.assetId)).toEqual(receipt);
  f.removeTask();
  await expect(
    f.service.describe(f.actor, receipt.assetId),
  ).rejects.toMatchObject({ code: "task_not_found" });
  expect(f.rows.size).toBe(1);
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "project-file-")));
  roots.push(root);
  const taskRoot = await realpath(await mkdtemp(join(tmpdir(), "task-file-")));
  roots.push(taskRoot);
  const instanceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const actor = { instanceId, accessClientId: null };
  const rows = new Map<string, ProjectFileRecord>();
  let generation = 1;
  let readonly = false;
  let taskExists = true;
  const taskIds = new Set<string>([taskId]);
  let failComplete = false;
  let failMove = false;
  let afterMove: (() => Promise<void>) | undefined;
  let kind = "design";
  const repository: ProjectFileRepository = {
    find: async (instance, id) =>
      rows.get(id)?.instance_id === instance
        ? structuredClone(rows.get(id)!)
        : null,
    relinkBatch: async (_instance, entries) => {
      for (const entry of entries) {
        const row = rows.get(entry.assetId)!;
        if (
          row.relative_path !== entry.input.expectedRelativePath ||
          row.write_fingerprint !== entry.input.expectedVersion
        )
          throw new Error("index conflict");
      }
      for (const entry of entries) {
        const row = rows.get(entry.assetId)!;
        row.relative_path = entry.input.relativePath;
        row.write_fingerprint = entry.input.fileVersion;
      }
    },
    relink: async (_instance, id, input) => {
      const row = rows.get(id)!;
      if (
        row.relative_path !== input.expectedRelativePath ||
        row.write_fingerprint !== input.expectedVersion
      )
        throw new Error("index conflict");
      row.relative_path = input.relativePath;
      row.write_fingerprint = input.fileVersion;
    },
    prepare: async (record) => {
      if (!rows.has(record.id)) rows.set(record.id, structuredClone(record));
      return structuredClone(rows.get(record.id)!);
    },
    complete: async (_instance, id, _fingerprint, byteSize) => {
      if (failComplete) throw new Error("metadata unavailable");
      rows.get(id)!.file_state = "ready";
      rows.get(id)!.byte_size = byteSize;
    },
    beginMove: async (_instance, id, _previous, next) => {
      rows.get(id)!.pending_relative_path = next;
    },
    finishMove: async (_instance, id, _previous, next) => {
      if (failMove) throw new Error("move metadata unavailable");
      rows.get(id)!.relative_path = next;
      rows.get(id)!.pending_relative_path = null;
      await afterMove?.();
    },
  };
  const localInstance = {
    resolve: async (value: typeof actor) => {
      if (value.instanceId !== instanceId) throw new Error("foreign instance");
      return { instanceId, dataDir: root };
    },
    serviceActor: async () => actor,
  } as unknown as Parameters<
    typeof createProjectFileService
  >[0]["localInstance"];
  const executionScopes = createExecutionScopes({
    localInstance,
    repository: {
      load: async (instance, id) => {
        if (instance !== instanceId || !taskExists || !taskIds.has(id))
          return null;
        return {
          preset: "code",
          state: "ready",
          branchGeneration: 1,
          scope: {
            instanceId,
            projectId,
            taskId: id,
            rootDirectory: taskRoot,
            additionalDirectories: [],
            generation,
            sandboxMode: readonly ? "read-only" : "workspace-write",
          },
        };
      },
    },
  });
  const deps = {
    repository,
    localInstance,
    executionScopes,
    projects: {
      getProject: async () => ({
        id: projectId,
        kind,
        enabled_modes: [kind],
        work_dir: root,
      }),
    },
  } as unknown as Parameters<typeof createProjectFileService>[0];
  const service = createProjectFileService(deps);
  const input = {
    target: { kind: "project" as const, projectId },
    assetId: randomUUID(),
    relativePath: "assets/image.bin",
    mimeType: "application/octet-stream",
    writeFingerprint: fingerprint,
  };
  return {
    root,
    taskRoot,
    taskId,
    executionScopes,
    anotherTask: async () => {
      const id = randomUUID();
      taskIds.add(id);
      return executionScopes.openTask(actor, id);
    },
    actor,
    service,
    input,
    rows,
    useCode: () => {
      kind = "code";
    },
    readOnly: () => {
      generation++;
      readonly = true;
    },
    removeTask: () => {
      taskExists = false;
    },
    revoke: () => {
      generation++;
    },
    failComplete: (value: boolean) => {
      failComplete = value;
    },
    afterMove: (callback: () => Promise<void>) => {
      afterMove = callback;
    },
    failMove: (value: boolean) => {
      failMove = value;
    },
  };
}
it("prepare发布到真实项目普通路径，相同指纹幂等且不同指纹冲突", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  expect(await readFile(join(f.root, f.input.relativePath))).toEqual(bytes);
  expect(await f.service.prepareWrite(f.actor, f.input)).toEqual(receipt);
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  await expect(
    f.service.prepareWrite(f.actor, {
      ...f.input,
      writeFingerprint: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "file_conflict" });
});
it("Code使用固定Task根而不是Project默认根，撤权代际拒绝迟到上传", async () => {
  const f = await fixture();
  f.useCode();
  const receipt = await f.service.prepareWrite(f.actor, {
    ...f.input,
    target: { kind: "task", taskId: f.taskId },
  });
  f.revoke();
  await expect(
    f.service.namespaceProvider.upload(receipt.objectPath, bytes),
  ).rejects.toMatchObject({ code: "scope_changed" });
  const next = await f.service.prepareWrite(f.actor, {
    ...f.input,
    assetId: randomUUID(),
    relativePath: "assets/second.bin",
    target: { kind: "task", taskId: f.taskId },
  });
  await f.service.namespaceProvider.upload(next.objectPath, bytes);
  expect(await readFile(join(f.taskRoot, "assets/second.bin"))).toEqual(bytes);
  await expect(readFile(join(f.root, "assets/second.bin"))).rejects.toThrow();
});
it("跨实例与路径逃逸在文件或索引写入前拒绝", async () => {
  const f = await fixture();
  await expect(
    f.service.prepareWrite({ ...f.actor, instanceId: randomUUID() }, f.input),
  ).rejects.toThrow();
  await expect(
    f.service.prepareWrite(f.actor, { ...f.input, relativePath: "../escape" }),
  ).rejects.toMatchObject({ code: "invalid_path" });
  expect(f.rows.size).toBe(0);
  await expect(
    f.service.namespaceProvider.upload(
      `${randomUUID()}/project-files/${f.input.assetId}`,
      bytes,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
});
it("元数据失败后保留已发布文件，通过精确pending索引恢复，不全盘扫描", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  f.failComplete(true);
  await expect(
    f.service.namespaceProvider.upload(receipt.objectPath, bytes),
  ).rejects.toThrow("metadata unavailable");
  expect(await readFile(join(f.root, f.input.relativePath))).toEqual(bytes);
  f.failComplete(false);
  expect(await f.service.read(f.actor, receipt.assetId)).toEqual(bytes);
  expect(f.rows.get(receipt.assetId)?.file_state).toBe("ready");
});
it("稳定assetId重命名只更新精确路径，缺失文件不猜测或创建", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  const moved = await f.service.move(
    f.actor,
    receipt.assetId,
    "assets/renamed.bin",
  );
  expect(moved.objectPath).toBe(receipt.objectPath);
  expect(await f.service.read(f.actor, receipt.assetId)).toEqual(bytes);
  await rm(join(f.root, moved.relativePath));
  await expect(f.service.read(f.actor, receipt.assetId)).rejects.toMatchObject({
    code: "file_missing",
  });
  await expect(
    f.service.move(f.actor, receipt.assetId, moved.relativePath),
  ).rejects.toMatchObject({ code: "file_missing" });
  await expect(
    f.service.namespaceProvider.upload(moved.objectPath, bytes),
  ).rejects.toMatchObject({ code: "file_missing" });
});
it("rename索引提交失败可从唯一pending目标恢复，原路径在确认前保留", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  f.failMove(true);
  await expect(
    f.service.move(f.actor, receipt.assetId, "assets/new.bin"),
  ).rejects.toThrow("move metadata unavailable");
  expect(await readFile(join(f.root, f.input.relativePath))).toEqual(bytes);
  expect(f.rows.get(receipt.assetId)?.pending_relative_path).toBe(
    "assets/new.bin",
  );
  f.failMove(false);
  expect(await f.service.read(f.actor, receipt.assetId)).toEqual(bytes);
  expect(f.rows.get(receipt.assetId)?.relative_path).toBe("assets/new.bin");
  expect(f.rows.get(receipt.assetId)?.pending_relative_path).toBeNull();
});
it("项目内symlink不允许写出真实根", async () => {
  const f = await fixture();
  await symlink(f.taskRoot, join(f.root, "assets"));
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await expect(
    f.service.namespaceProvider.upload(receipt.objectPath, bytes),
  ).rejects.toMatchObject({ code: "invalid_path" });
});

it("move expected version rejects stale callers without changing bytes or index", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  await expect(
    f.service.move(f.actor, f.input.assetId, "moved.bin", {
      expectedRelativePath: f.input.relativePath,
      expectedVersion: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "file_conflict" });
  expect(await readFile(join(f.root, f.input.relativePath))).toEqual(bytes);
  expect(f.rows.get(f.input.assetId)?.relative_path).toBe(f.input.relativePath);
});
it("relink only follows exact user path and confirmed bytes while stable assetId stays", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  await rename(join(f.root, f.input.relativePath), join(f.root, "chosen.bin"));
  const result = await f.service.relink(f.actor, f.input.assetId, {
    relativePath: "chosen.bin",
    expectedRelativePath: f.input.relativePath,
    expectedVersion: fingerprint,
    fileVersion: fingerprint,
  });
  expect(result.assetId).toBe(f.input.assetId);
  expect(result.relativePath).toBe("chosen.bin");
  expect(await f.service.read(f.actor, f.input.assetId)).toEqual(bytes);
  await expect(
    f.service.relink(f.actor, f.input.assetId, {
      relativePath: "other.bin",
      expectedRelativePath: f.input.relativePath,
      expectedVersion: fingerprint,
      fileVersion: fingerprint,
    }),
  ).rejects.toMatchObject({ code: "file_conflict" });
});
it("explicit restored bytes require their exact hash, missing paths are not searched", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  await writeFile(join(f.root, "chosen.bin"), "different");
  const input = {
    relativePath: "chosen.bin",
    expectedRelativePath: f.input.relativePath,
    expectedVersion: fingerprint,
    fileVersion: fingerprint,
  };
  await expect(
    f.service.relink(f.actor, f.input.assetId, input),
  ).rejects.toMatchObject({ code: "file_conflict" });
  await expect(
    f.service.relink(f.actor, f.input.assetId, {
      ...input,
      relativePath: "missing.bin",
    }),
  ).rejects.toMatchObject({ code: "file_missing" });
  expect(f.rows.get(f.input.assetId)?.relative_path).toBe(f.input.relativePath);
});
it("restoreIndex prevalidates every exact reference before publishing any index row", async () => {
  const f = await fixture();
  const first = await f.service.prepareWrite(f.actor, f.input);
  await f.service.namespaceProvider.upload(first.objectPath, bytes);
  const secondInput = {
    ...f.input,
    assetId: randomUUID(),
    relativePath: "assets/second.bin",
  };
  const second = await f.service.prepareWrite(f.actor, secondInput);
  await f.service.namespaceProvider.upload(second.objectPath, bytes);
  await rename(
    join(f.root, f.input.relativePath),
    join(f.root, "chosen-first.bin"),
  );
  await expect(
    f.service.restoreIndex(
      f.actor,
      f.input.target.projectId,
      [
        {
          assetId: f.input.assetId,
          relativePath: "chosen-first.bin",
          version: fingerprint,
        },
        {
          assetId: secondInput.assetId,
          relativePath: "missing-second.bin",
          version: fingerprint,
        },
      ],
      async () => {},
    ),
  ).rejects.toMatchObject({ code: "file_missing" });
  expect(f.rows.get(f.input.assetId)?.relative_path).toBe(f.input.relativePath);
  expect(f.rows.get(secondInput.assetId)?.relative_path).toBe(
    secondInput.relativePath,
  );
});
it("old layout without version cannot adopt externally modified bytes", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  await writeFile(join(f.root, "restored.bin"), "different-history");
  await expect(
    f.service.restoreIndex(
      f.actor,
      f.input.target.projectId,
      [{ assetId: f.input.assetId, relativePath: "restored.bin" }],
      async () => {},
    ),
  ).rejects.toMatchObject({ code: "file_conflict" });
  expect(f.rows.get(f.input.assetId)?.write_fingerprint).toBe(fingerprint);
});
it("layout CAS failure aborts exact-reference restore before index publication", async () => {
  const f = await fixture();
  const receipt = await f.service.prepareWrite(f.actor, f.input);
  await f.service.namespaceProvider.upload(receipt.objectPath, bytes);
  await rename(
    join(f.root, f.input.relativePath),
    join(f.root, "restored.bin"),
  );
  await expect(
    f.service.restoreIndex(
      f.actor,
      f.input.target.projectId,
      [
        {
          assetId: f.input.assetId,
          relativePath: "restored.bin",
          version: fingerprint,
        },
      ],
      async () => {
        throw new Error("layout changed");
      },
    ),
  ).rejects.toThrow("layout changed");
  expect(f.rows.get(f.input.assetId)?.relative_path).toBe(f.input.relativePath);
});

it("committed move survives old-file cleanup failure and keeps the original copy", async () => {
  const f = await fixture();
  const receipt = await f.service.publish(f.actor, f.input, bytes);
  const originalRead = projectFilesystem.readProjectFile;
  let cleanupRead: { mockRestore(): void } | undefined;
  f.afterMove(async () => {
    cleanupRead = vi
      .spyOn(projectFilesystem, "readProjectFile")
      .mockImplementation(async (path, ...args) => {
        if (path === join(f.root, f.input.relativePath))
          throw Object.assign(new Error("old file is locked"), {
            code: "EPERM",
          });
        return originalRead(path, ...args);
      });
  });
  try {
    await expect(
      f.service.move(f.actor, receipt.assetId, "assets/new.bin"),
    ).resolves.toMatchObject({
      assetId: receipt.assetId,
      objectPath: receipt.objectPath,
      relativePath: "assets/new.bin",
    });
    expect(f.rows.get(receipt.assetId)?.relative_path).toBe("assets/new.bin");
    expect(f.rows.get(receipt.assetId)?.pending_relative_path).toBeNull();
    expect(await readFile(join(f.root, f.input.relativePath))).toEqual(bytes);
    expect(await readFile(join(f.root, "assets/new.bin"))).toEqual(bytes);
  } finally {
    cleanupRead?.mockRestore();
  }
});

it("committed move preserves an externally changed old copy and reports the committed target", async () => {
  const f = await fixture();
  const receipt = await f.service.publish(f.actor, f.input, bytes);
  const external = Buffer.from("external edit after move commit");
  f.afterMove(async () => {
    await writeFile(join(f.root, f.input.relativePath), external);
  });
  await expect(
    f.service.move(f.actor, receipt.assetId, "assets/new.bin"),
  ).resolves.toMatchObject({
    relativePath: "assets/new.bin",
  });
  expect(await readFile(join(f.root, f.input.relativePath))).toEqual(external);
  expect(await f.service.read(f.actor, receipt.assetId)).toEqual(bytes);
});

it("Task revocation after metadata commit retains the source without rejecting the committed move", async () => {
  const f = await fixture();
  f.useCode();
  const receipt = await f.service.publish(
    f.actor,
    {
      ...f.input,
      target: { kind: "task", taskId: f.taskId },
    },
    bytes,
  );
  let closing: Promise<void> | undefined;
  f.afterMove(async () => {
    f.revoke();
    closing = revokeTaskFileOperations(f.actor.instanceId, f.taskId);
  });
  try {
    await expect(
      f.service.move(f.actor, receipt.assetId, "assets/new.bin"),
    ).resolves.toMatchObject({
      relativePath: "assets/new.bin",
    });
    await closing;
    expect(hasTaskFileOperations(f.actor.instanceId, f.taskId)).toBe(false);
    expect(f.rows.get(receipt.assetId)?.relative_path).toBe("assets/new.bin");
    expect(await readFile(join(f.taskRoot, f.input.relativePath))).toEqual(
      bytes,
    );
    expect(await readFile(join(f.taskRoot, "assets/new.bin"))).toEqual(bytes);
  } finally {
    await closing;
  }
});

it("registered bytes exceeding a read budget are rejected before allocation", async () => {
  const f = await fixture();
  const receipt = await f.service.publish(f.actor, f.input, bytes);
  const read = vi.spyOn(projectFilesystem, "readProjectFile");
  try {
    await expect(
      f.service.read(f.actor, receipt.assetId, {
        maxBytes: bytes.byteLength - 1,
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(read).not.toHaveBeenCalled();
    expect(
      await f.service.read(f.actor, receipt.assetId, {
        maxBytes: bytes.byteLength,
      }),
    ).toEqual(bytes);
  } finally {
    read.mockRestore();
  }
});
