import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, expect, test, vi } from "vitest";
import { createCadGuiCopyPublisher } from "./gui-copy-publication.js";
import { cadGuiCopyDocumentReceiptSchema } from "./gui-document-copy-contracts.js";
import { createCadGuiOperationStore } from "./gui-operation-store.js";
import { createCadTestContext } from "./test-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  mode: CodeExecutionScope["sandboxMode"] = "workspace-write",
  options: { outside?: boolean; bytes?: Buffer } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-cad-publication-")),
  );
  roots.push(root);
  const taskRoot = join(root, "task");
  await mkdir(taskRoot);
  const task = await createCadTestContext(taskRoot, mode);
  const store = createCadGuiOperationStore({
    rootDirectory: join(root, "instance"),
  });
  const operationId = randomUUID();
  const record = await store.prepare({
    operationId,
    binding: {
      instanceId: task.scope.instanceId,
      projectId: task.scope.projectId,
      taskId: task.scope.taskId,
      scopeGeneration: 1,
      branchGeneration: 1,
      runId: task.context.runId ?? "",
      toolCallId: task.context.toolCallId ?? "",
    },
    payload: {
      operation: "save-copy",
      operationId,
      application: { pid: 1234 },
      outputPath: options.outside
        ? join(root, "outside/副本.FCStd")
        : "exports/副本.FCStd",
    },
    buildMacro: () => "# fixed source fixture\n",
  });
  // 该层验证已确认native副本的二进制一致性；ZIP验证由固定source/原生集成覆盖。
  const bytes =
    options.bytes ?? Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x81]);
  const receipt = cadGuiCopyDocumentReceiptSchema.parse({
    protocol: "kfw-cad-gui-copy/1",
    operationId,
    fingerprint: record.fingerprint,
    pid: 1234,
    guiThread: true,
    completed: true,
    outcome: "copied",
    copyStarted: true,
    statePreserved: true,
    artifact: {
      name: "document.FCStd",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      hasGuiDocument: true,
    },
  });
  await writeFile(join(record.directory, "document.FCStd"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(record.receiptPath, JSON.stringify(receipt), {
    flag: "wx",
    mode: 0o600,
  });
  const handle = task.context.scopeHandle;
  if (!handle) throw new Error("夹具缺少真实目录句柄");
  return {
    root,
    taskRoot,
    task,
    store,
    record,
    bytes,
    handle,
    publisher: createCadGuiCopyPublisher({ store }),
  };
}

test("原生副本通过Task二进制发布并持久记录，保留全部字节", async () => {
  const f = await fixture();
  const result = await f.publisher.publish(
    f.record,
    f.handle,
    f.task.controller.signal,
  );
  expect(result).toMatchObject({
    operationId: f.record.operationId,
    outcome: "published",
    outputPath: join(f.taskRoot, "exports/副本.FCStd"),
    sizeBytes: f.bytes.length,
  });
  if (!result.outputPath) throw new Error("发布回执缺少输出路径");
  expect(await readFile(result.outputPath)).toEqual(f.bytes);
  expect(
    await createCadGuiCopyPublisher({
      store: createCadGuiOperationStore({
        rootDirectory: join(f.root, "instance"),
      }),
    }).status(f.record),
  ).toEqual(result);
});

test("数MB二进制不套用进程文本输出或工作区字节预算", async () => {
  const bytes = Buffer.alloc(12 * 1024 * 1024 + 7, 0x81);
  const f = await fixture("workspace-write", { bytes });
  const result = await f.publisher.publish(
    f.record,
    f.handle,
    f.task.controller.signal,
  );
  expect(result).toMatchObject({
    outcome: "published",
    sizeBytes: bytes.length,
  });
  if (!result.outputPath) throw new Error("缺少二进制输出路径");
  expect(
    createHash("sha256")
      .update(await readFile(result.outputPath))
      .digest("hex"),
  ).toBe(createHash("sha256").update(bytes).digest("hex"));
});

test("发布后的用户删除不被同编号重放重新创建", async () => {
  const f = await fixture();
  const first = await f.publisher.publish(
    f.record,
    f.handle,
    f.task.controller.signal,
  );
  if (!first.outputPath) throw new Error("缺少发布路径");
  await rm(first.outputPath);
  expect(
    await f.publisher.publish(f.record, f.handle, f.task.controller.signal),
  ).toEqual(first);
  await expect(access(first.outputPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("同编号并发先发布目标时，后来者返回持久事实而非未发布", async () => {
  for (const receiptLost of [false, true]) {
    const f = await fixture();
    const readState = f.store.readState.bind(f.store);
    if (receiptLost)
      vi.spyOn(f.store, "completePublication").mockRejectedValue(
        new Error("fixture receipt failure"),
      );
    vi.spyOn(f.store, "readState").mockImplementationOnce(async (record) => {
      await createCadGuiCopyPublisher({ store: f.store }).publish(
        f.record,
        f.handle,
        f.task.controller.signal,
      );
      return readState(record);
    });
    const result = await f.publisher.publish(
      f.record,
      f.handle,
      f.task.controller.signal,
    );
    expect(result).toEqual(await f.publisher.status(f.record));
    expect(result.outcome).toBe(receiptLost ? "unknown" : "published");
    expect(await readFile(join(f.taskRoot, "exports/副本.FCStd"))).toEqual(
      f.bytes,
    );
  }
});

test("既有文件与认领后的并行写入均不覆盖", async () => {
  const existing = await fixture();
  const output = join(existing.taskRoot, "exports/副本.FCStd");
  await mkdir(join(existing.taskRoot, "exports"));
  await writeFile(output, "用户文件");
  expect(
    await existing.publisher.publish(
      existing.record,
      existing.handle,
      existing.task.controller.signal,
    ),
  ).toMatchObject({ outcome: "not_published", reason: "output_exists" });
  expect(await readFile(output, "utf8")).toBe("用户文件");
  expect(await existing.store.readPublication(existing.record)).toEqual({});
  const race = await fixture();
  const claim = race.store.claimPublication.bind(race.store);
  vi.spyOn(race.store, "claimPublication").mockImplementation(
    async (record, data) => {
      const won = await claim(record, data);
      await mkdir(join(race.taskRoot, "exports"));
      await writeFile(join(race.taskRoot, "exports/副本.FCStd"), "并行新文件");
      return won;
    },
  );
  expect(
    await race.publisher.publish(
      race.record,
      race.handle,
      race.task.controller.signal,
    ),
  ).toMatchObject({ outcome: "unknown" });
  expect(
    await readFile(join(race.taskRoot, "exports/副本.FCStd"), "utf8"),
  ).toBe("并行新文件");
});

test("claim后取消或回执写失败保留unknown，重放不重新发布", async () => {
  const cancelled = await fixture();
  const claim = cancelled.store.claimPublication.bind(cancelled.store);
  vi.spyOn(cancelled.store, "claimPublication").mockImplementation(
    async (record, data) => {
      const won = await claim(record, data);
      cancelled.task.controller.abort();
      return won;
    },
  );
  expect(
    await cancelled.publisher.publish(
      cancelled.record,
      cancelled.handle,
      cancelled.task.controller.signal,
    ),
  ).toMatchObject({ outcome: "unknown", reason: "cancelled" });
  const freshSignal = new AbortController().signal;
  expect(
    await cancelled.publisher.publish(
      cancelled.record,
      cancelled.handle,
      freshSignal,
    ),
  ).toMatchObject({ outcome: "unknown" });
  await expect(
    access(join(cancelled.taskRoot, "exports/副本.FCStd")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const receiptFailure = await fixture();
  vi.spyOn(receiptFailure.store, "completePublication").mockRejectedValue(
    new Error("disk full"),
  );
  expect(
    await receiptFailure.publisher.publish(
      receiptFailure.record,
      receiptFailure.handle,
      receiptFailure.task.controller.signal,
    ),
  ).toMatchObject({ outcome: "unknown" });
  const created = join(receiptFailure.taskRoot, "exports/副本.FCStd");
  expect(await readFile(created)).toEqual(receiptFailure.bytes);
  await rm(created);
  expect(
    await receiptFailure.publisher.publish(
      receiptFailure.record,
      receiptFailure.handle,
      receiptFailure.task.controller.signal,
    ),
  ).toMatchObject({ outcome: "unknown" });
  await expect(access(created)).rejects.toMatchObject({ code: "ENOENT" });
});

test("复制文件被替换或指向符号链接时不认领发布", async () => {
  for (const kind of ["changed", "symlink"] as const) {
    const f = await fixture();
    const source = join(f.record.directory, "document.FCStd");
    if (kind === "changed")
      await writeFile(source, Buffer.alloc(f.bytes.length, 0x82));
    else {
      await rm(source);
      const unrelated = join(f.root, "unrelated.FCStd");
      await writeFile(unrelated, f.bytes);
      await symlink(unrelated, source);
    }
    expect(
      await f.publisher.publish(f.record, f.handle, f.task.controller.signal),
    ).toMatchObject({ outcome: "not_published" });
    expect(await f.store.readPublication(f.record)).toEqual({});
    await expect(
      access(join(f.taskRoot, "exports/副本.FCStd")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("目录权限和代际仍由真实Task持有，完全访问可发布额外绝对路径", async () => {
  const readonly = await fixture("read-only");
  expect(
    await readonly.publisher.publish(
      readonly.record,
      readonly.handle,
      readonly.task.controller.signal,
    ),
  ).toMatchObject({ outcome: "not_published", reason: "forbidden" });
  const outside = await fixture("workspace-write", { outside: true });
  expect(
    await outside.publisher.publish(
      outside.record,
      outside.handle,
      outside.task.controller.signal,
    ),
  ).toMatchObject({ outcome: "not_published" });
  await expect(
    access(join(outside.root, "outside/副本.FCStd")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const full = await fixture("danger-full-access", { outside: true });
  expect(
    await full.publisher.publish(
      full.record,
      full.handle,
      full.task.controller.signal,
    ),
  ).toMatchObject({
    outcome: "published",
    outputPath: join(full.root, "outside/副本.FCStd"),
  });
  const revoked = await fixture();
  const claim = revoked.store.claimPublication.bind(revoked.store);
  vi.spyOn(revoked.store, "claimPublication").mockImplementation(
    async (record, data) => {
      const won = await claim(record, data);
      revoked.task.stored.scope.generation++;
      return won;
    },
  );
  expect(
    await revoked.publisher.publish(
      revoked.record,
      revoked.handle,
      revoked.task.controller.signal,
    ),
  ).toMatchObject({ outcome: "unknown", reason: "scope_changed" });
  await expect(
    access(join(revoked.taskRoot, "exports/副本.FCStd")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const foreign = await fixture("danger-full-access");
  const otherTask = await foreign.store.prepare({
    operationId: randomUUID(),
    binding: { ...foreign.record.binding, taskId: randomUUID() },
    payload: foreign.record.payload,
    buildMacro: () => "pass\n",
  });
  expect(
    await foreign.publisher.publish(
      otherTask,
      foreign.handle,
      foreign.task.controller.signal,
    ),
  ).toMatchObject({ outcome: "not_published", reason: "scope_changed" });
  expect(await foreign.store.readPublication(otherTask)).toEqual({});
});
