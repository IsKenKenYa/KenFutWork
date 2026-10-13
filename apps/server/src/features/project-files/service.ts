import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasRepository } from "../canvas/repository.js";
import { observeBinary } from "../code-tools/file-bytes.js";
import { ScopedFileController } from "../code-tools/file-controller.js";
import { runFileOperation } from "../code-tools/file-operations.js";
import type {
  ExecutionScopeHandle,
  ExecutionScopes,
} from "../execution/scope-service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ProjectService } from "../projects/project-service.js";
import { resolveProjectWorkDirectory } from "../projects/work-dir.js";
import {
  assertProjectFileExists,
  checkedFilePath,
  fingerprintOf,
  publishFile,
  readProjectFile,
  validateRelativePath,
} from "./filesystem.js";
import {
  ProjectFileError,
  type ProjectFileExpected,
  type ProjectFileLocation,
  type ProjectFileMutationGuard,
  type ProjectFileReceipt,
  type ProjectFileRecord,
  type ProjectFileRepository,
  type ProjectFileService,
  type ProjectFileTarget,
} from "./types.js";

const validAssetId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id);
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
const receipt = (record: ProjectFileRecord): ProjectFileReceipt => ({
  assetId: record.id,
  version: record.write_fingerprint,
  bucket: "project-assets",
  objectPath: `${record.instance_id}/project-files/${record.id}`,
  relativePath: record.relative_path,
});

export function createProjectFileService(deps: {
  repository: ProjectFileRepository;
  localInstance: LocalInstanceService;
  projects: Pick<ProjectService, "getProject">;
  executionScopes: Pick<ExecutionScopes, "openTask">;
  canvases?: Pick<CanvasRepository, "findById" | "claimRoot">;
}): ProjectFileService {
  const resolve = async (
    actor: LocalActor,
    target: ProjectFileTarget,
    path: string,
    operation: "read" | "write",
  ) => {
    const instance = await deps.localInstance.resolve(actor);
    validateRelativePath(path);
    if (target.kind === "task") {
      const handle = await deps.executionScopes.openTask(actor, target.taskId);
      let scope = handle.describe();
      const project = await deps.projects.getProject(actor, scope.projectId);
      if (
        scope.instanceId !== instance.instanceId ||
        scope.taskId !== target.taskId ||
        project.kind !== handle.preset
      )
        throw new ProjectFileError(
          "scope_changed",
          "Task文件工作域不匹配。",
          403,
        );
      await handle.resolvePath(path, operation);
      scope = handle.describe();
      return {
        root: scope.rootDirectory,
        projectId: scope.projectId,
        generation: scope.generation,
        taskKind: handle.preset,
        handle,
      };
    }
    const project = await deps.projects.getProject(actor, target.projectId);
    if (project.kind === "code")
      throw new ProjectFileError(
        "scope_changed",
        "Code素材必须绑定真实Task工作域。",
        403,
      );
    if (target.kind === "canvas") {
      if (!deps.canvases)
        throw new ProjectFileError(
          "scope_changed",
          "画布文件目录服务未接通。",
          503,
        );
      const canvas = await deps.canvases.findById(
        actor.instanceId,
        target.canvasId,
      );
      if (
        !canvas ||
        canvas.project_id !== target.projectId ||
        (project.kind !== "design" && project.kind !== "flow")
      )
        throw new ProjectFileError(
          "scope_changed",
          "画布文件归属不匹配。",
          403,
        );
      const root = await deps.canvases.claimRoot(
        actor.instanceId,
        target.canvasId,
        (workDir) =>
          resolveProjectWorkDirectory({
            instanceId: instance.instanceId,
            projectId: target.projectId,
            sandboxRoot: join(instance.dataDir, "sandbox"),
            workDir,
          }),
      );
      return {
        root,
        projectId: target.projectId,
        generation: null,
        taskKind: null,
        handle: undefined,
      };
    }
    return {
      root: await resolveProjectWorkDirectory({
        instanceId: instance.instanceId,
        projectId: target.projectId,
        sandboxRoot: join(instance.dataDir, "sandbox"),
        workDir: project.work_dir,
      }),
      projectId: target.projectId,
      generation: null,
      taskKind: null,
      handle: undefined,
    };
  };
  const find = async (actor: LocalActor, id: string) => {
    await deps.localInstance.resolve(actor);
    if (!validAssetId(id))
      throw new ProjectFileError("not_found", "项目素材引用无效。", 404);
    const record = await deps.repository.find(actor.instanceId, id);
    if (!record)
      throw new ProjectFileError("not_found", "项目素材不存在或已删除。", 404);
    return record;
  };
  const location = async (
    actor: LocalActor,
    record: ProjectFileRecord,
    path: string,
    operation: "read" | "write",
  ) => {
    const target: ProjectFileTarget = record.task_id
      ? { kind: "task", taskId: record.task_id }
      : record.canvas_id
        ? {
            kind: "canvas",
            canvasId: record.canvas_id,
            projectId: record.project_id,
          }
        : { kind: "project", projectId: record.project_id };
    const current = await resolve(actor, target, path, operation);
    if (
      current.projectId !== record.project_id ||
      current.taskKind !== record.task_kind ||
      (record.file_state === "pending" &&
        current.generation !== record.scope_generation)
    )
      throw new ProjectFileError(
        "scope_changed",
        "素材授权已改变，请重新提交。",
        403,
      );
    return current;
  };
  type Location = Awaited<ReturnType<typeof location>>;
  type Operation = {
    signal: AbortSignal | undefined;
    controller: ScopedFileController | undefined;
    handle: ExecutionScopeHandle | undefined;
  };
  const operate = async <T>(
    current: Location,
    paths: string[],
    kind: "read" | "write",
    action: (operation: Operation) => Promise<T>,
  ): Promise<T> => {
    const handle = current.handle;
    if (!handle)
      return action({
        signal: undefined,
        controller: undefined,
        handle: undefined,
      });
    return runFileOperation(
      handle,
      undefined,
      async (signal) => {
        const controller = new ScopedFileController(
          handle,
          handle.backend.limits,
        );
        const canonical = await Promise.all(
          paths.map((path) =>
            kind === "write"
              ? controller.resolveWrite(path, signal)
              : handle.resolvePath(path, "read"),
          ),
        );
        return controller.withLocks(
          canonical,
          () => action({ signal, controller, handle }),
          signal,
        );
      },
      kind,
    );
  };
  const publish = async (
    operation: Operation,
    path: string,
    bytes: Uint8Array,
    beforePublish: () => Promise<void>,
  ) => {
    operation.signal?.throwIfAborted();
    if (!operation.controller || !operation.handle)
      return publishFile(path, bytes, beforePublish);
    await beforePublish();
    operation.signal?.throwIfAborted();
    const observed = await observeBinary(
      operation.handle,
      path,
      operation.signal,
    );
    if (observed.version !== null) {
      if (
        fingerprintOf(
          await readProjectFile(path, undefined, operation.signal),
        ) !== fingerprintOf(bytes)
      )
        throw new ProjectFileError(
          "file_conflict",
          "目标文件已存在且内容不同，不会覆盖。",
        );
      return;
    }
    await operation.controller.publishBytes(
      path,
      bytes,
      null,
      0o600,
      operation.signal,
    );
  };
  const completeRead = async (
    actor: LocalActor,
    record: ProjectFileRecord,
    maxBytes?: number,
  ) => {
    const path = record.pending_relative_path ?? record.relative_path;
    const current = await location(actor, record, path, "read");
    if (
      maxBytes !== undefined &&
      record.byte_size !== null &&
      record.byte_size > maxBytes
    )
      throw new ProjectFileError(
        "file_conflict",
        "素材超过读取预算，请在设置中调整",
        413,
      );
    return operate(current, [path], "read", async ({ signal }) => {
      const absolute = await checkedFilePath(current.root, path, false);
      const bytes = await readProjectFile(absolute, maxBytes, signal);
      signal?.throwIfAborted();
      if (record.file_state === "pending" || record.pending_relative_path) {
        if (fingerprintOf(bytes) !== record.write_fingerprint)
          throw new ProjectFileError(
            "file_conflict",
            "待登记素材与已发布内容不同，请检查该文件。",
          );
        if (record.pending_relative_path)
          await deps.repository.finishMove(
            actor.instanceId,
            record.id,
            record.relative_path,
            path,
          );
        else
          await deps.repository.complete(
            actor.instanceId,
            record.id,
            record.write_fingerprint,
            bytes.byteLength,
          );
      }
      signal?.throwIfAborted();
      return bytes;
    });
  };
  const actorForPath = async (path: string) => {
    const actor = await deps.localInstance.serviceActor();
    const parts = path.split("/");
    if (
      parts.length !== 3 ||
      parts[0] !== actor.instanceId ||
      parts[1] !== "project-files" ||
      !validAssetId(parts[2] ?? "")
    )
      throw new ProjectFileError("not_found", "项目素材引用无效。", 404);
    const assetId = parts[2];
    if (!assetId)
      throw new ProjectFileError("not_found", "项目素材引用无效。", 404);
    return { actor, assetId };
  };
  const uploadPrepared = async (
    actor: LocalActor,
    assetId: string,
    bytes: Uint8Array,
    beforePublish?: ProjectFileMutationGuard,
  ) =>
    locked(`${actor.instanceId}/${assetId}`, async () => {
      const record = await find(actor, assetId);
      if (
        record.pending_relative_path ||
        fingerprintOf(bytes) !== record.write_fingerprint
      )
        throw new ProjectFileError(
          "file_conflict",
          "素材内容与准备写入的指纹不同。",
        );
      const current = await location(
        actor,
        record,
        record.relative_path,
        "write",
      );
      return operate(
        current,
        [record.relative_path],
        "write",
        async (operation) => {
          if (record.file_state === "ready") {
            const existing = await readProjectFile(
              await checkedFilePath(current.root, record.relative_path, false),
              undefined,
              operation.signal,
            );
            if (fingerprintOf(existing) !== record.write_fingerprint)
              throw new ProjectFileError(
                "file_conflict",
                "素材文件已改变，不会重放覆盖。",
              );
            await beforePublish?.();
            return;
          }
          const target = await checkedFilePath(
            current.root,
            record.relative_path,
            true,
          );
          await publish(operation, target, bytes, async () => {
            const latest = await find(actor, assetId);
            const authorized = await location(
              actor,
              latest,
              record.relative_path,
              "write",
            );
            if (
              authorized.root !== current.root ||
              authorized.generation !== current.generation ||
              latest.relative_path !== record.relative_path ||
              latest.write_fingerprint !== record.write_fingerprint
            )
              throw new ProjectFileError(
                "scope_changed",
                "写入期间素材授权或路径已改变。",
                403,
              );
            await checkedFilePath(authorized.root, record.relative_path, false);
            await beforePublish?.();
          });
          operation.signal?.throwIfAborted();
          await deps.repository.complete(
            actor.instanceId,
            assetId,
            record.write_fingerprint,
            bytes.byteLength,
          );
          operation.signal?.throwIfAborted();
        },
      );
    });
  const inspectRecord = (record: ProjectFileRecord): ProjectFileLocation => ({
    ...receipt(record),
    projectId: record.project_id,
    taskId: record.task_id,
    canvasId: record.canvas_id ?? null,
    version: record.write_fingerprint,
  });
  const assertExpected = (
    record: ProjectFileRecord,
    expected?: ProjectFileExpected,
  ) => {
    if (
      expected &&
      (record.relative_path !== expected.expectedRelativePath ||
        record.write_fingerprint !== expected.expectedVersion)
    )
      throw new ProjectFileError(
        "file_conflict",
        "素材位置或版本已改变，请重新加载",
      );
  };
  const prepareRestoredFile = async (
    actor: LocalActor,
    projectId: string,
    ref: { assetId: string; relativePath: string; version?: string },
    canvasId?: string,
  ) => {
    const record = await find(actor, ref.assetId);
    if (
      record.project_id !== projectId ||
      record.file_state !== "ready" ||
      record.pending_relative_path
    )
      throw new ProjectFileError("file_conflict", "素材归属或操作状态不匹配");
    if (canvasId && record.canvas_id && record.canvas_id !== canvasId)
      throw new ProjectFileError("file_conflict", "素材不属于当前画布");
    const restored =
      canvasId && !record.task_id ? { ...record, canvas_id: canvasId } : record;
    const current = await location(actor, restored, ref.relativePath, "read");
    const bytes = await operate(
      current,
      [ref.relativePath],
      "read",
      async ({ signal }) =>
        readProjectFile(
          await checkedFilePath(current.root, ref.relativePath, false),
          undefined,
          signal,
        ),
    );
    const version = ref.version ?? record.write_fingerprint;
    if (fingerprintOf(bytes) !== version)
      throw new ProjectFileError("file_conflict", "布局引用素材与确切版本不同");
    return {
      observation: {
        record: restored,
        path: ref.relativePath,
        root: current.root,
        generation: current.generation,
      },
      entry: {
        assetId: ref.assetId,
        input: {
          relativePath: ref.relativePath,
          expectedRelativePath: record.relative_path,
          expectedVersion: record.write_fingerprint,
          fileVersion: version,
          ...(canvasId && !record.task_id ? { canvasId } : {}),
        },
        byteSize: bytes.byteLength,
      },
      receipt: inspectRecord({
        ...restored,
        relative_path: ref.relativePath,
        write_fingerprint: version,
      }),
    };
  };
  const service: ProjectFileService = {
    async restoreIndex(actor, projectId, references, beforePublish, canvasId) {
      const unique = new Map<string, (typeof references)[number]>();
      for (const ref of references) {
        const previous = unique.get(ref.assetId);
        if (
          previous &&
          (previous.relativePath !== ref.relativePath ||
            previous.version !== ref.version)
        )
          throw new ProjectFileError(
            "file_conflict",
            "同一素材在布局中引用了不同位置或版本",
          );
        unique.set(ref.assetId, ref);
      }
      const ids = [...unique.keys()].sort();
      async function allLocked(index: number): Promise<ProjectFileLocation[]> {
        if (index < ids.length)
          return locked(`${actor.instanceId}/${ids[index]}`, () =>
            allLocked(index + 1),
          );
        const entries = [];
        const results = [];
        const observations: {
          record: ProjectFileRecord;
          path: string;
          root: string;
          generation: number | null;
        }[] = [];
        for (const ref of unique.values()) {
          const prepared = await prepareRestoredFile(
            actor,
            projectId,
            ref,
            canvasId,
          );
          observations.push(prepared.observation);
          entries.push(prepared.entry);
          results.push(prepared.receipt);
        }
        await beforePublish();
        for (const observed of observations) {
          const latest = await location(
            actor,
            observed.record,
            observed.path,
            "read",
          );
          if (
            latest.root !== observed.root ||
            latest.generation !== observed.generation
          )
            throw new ProjectFileError(
              "scope_changed",
              "恢复期间素材授权已改变",
              403,
            );
        }
        await deps.repository.relinkBatch(actor.instanceId, entries);
        return results;
      }
      return allLocked(0);
    },
    inspect: (actor, id) =>
      locked(`${actor.instanceId}/${id}`, async () => {
        const record = await find(actor, id);
        if (record.file_state !== "ready" || record.pending_relative_path)
          throw new ProjectFileError("file_pending", "素材操作尚未完成");
        await location(actor, record, record.relative_path, "read");
        return inspectRecord(record);
      }),
    relink: (actor, id, input) =>
      locked(`${actor.instanceId}/${id}`, async () => {
        validateRelativePath(input.relativePath);
        const record = await find(actor, id);
        assertExpected(record, input);
        if (record.file_state !== "ready" || record.pending_relative_path)
          throw new ProjectFileError("file_pending", "素材操作尚未完成");
        if (!/^[a-f0-9]{64}$/u.test(input.fileVersion))
          throw new ProjectFileError("file_conflict", "素材版本无效", 400);
        const current = await location(
          actor,
          record,
          input.relativePath,
          "read",
        );
        return operate(
          current,
          [input.relativePath],
          "read",
          async ({ signal }) => {
            const bytes = await readProjectFile(
              await checkedFilePath(current.root, input.relativePath, false),
              undefined,
              signal,
            );
            if (fingerprintOf(bytes) !== input.fileVersion)
              throw new ProjectFileError(
                "file_conflict",
                "指定文件与确认版本不同",
              );
            const latest = await location(
              actor,
              record,
              input.relativePath,
              "read",
            );
            if (
              latest.root !== current.root ||
              latest.generation !== current.generation
            )
              throw new ProjectFileError(
                "scope_changed",
                "素材授权已改变",
                403,
              );
            signal?.throwIfAborted();
            await deps.repository.relink(
              actor.instanceId,
              id,
              input,
              bytes.byteLength,
            );
            return inspectRecord({
              ...record,
              relative_path: input.relativePath,
              write_fingerprint: input.fileVersion,
            });
          },
        );
      }),
    describe: (actor, id) =>
      locked(`${actor.instanceId}/${id}`, async () => {
        const record = await find(actor, id);
        if (record.file_state !== "ready" || record.pending_relative_path)
          throw new ProjectFileError(
            "file_pending",
            "素材写入或移动尚未完成，请先恢复该操作。",
          );
        const current = await location(
          actor,
          record,
          record.relative_path,
          "read",
        );
        return operate(
          current,
          [record.relative_path],
          "read",
          async ({ signal }) => {
            signal?.throwIfAborted();
            await assertProjectFileExists(
              await checkedFilePath(current.root, record.relative_path, false),
            );
            signal?.throwIfAborted();
            return receipt(record);
          },
        );
      }),
    prepareWrite: (actor, input) =>
      locked(`${actor.instanceId}/${input.assetId}`, async () => {
        validateRelativePath(input.relativePath);
        if (
          !validAssetId(input.assetId) ||
          !/^[a-f0-9]{64}$/u.test(input.writeFingerprint)
        )
          throw new ProjectFileError(
            "file_conflict",
            "素材身份或写入指纹无效。",
            400,
          );
        const current = await resolve(
          actor,
          input.target,
          input.relativePath,
          "write",
        );
        const record: ProjectFileRecord = {
          id: input.assetId,
          instance_id: actor.instanceId,
          project_id: current.projectId,
          task_id: input.target.kind === "task" ? input.target.taskId : null,
          canvas_id:
            input.target.kind === "canvas" ? input.target.canvasId : null,
          task_kind: current.taskKind,
          relative_path: input.relativePath,
          pending_relative_path: null,
          write_fingerprint: input.writeFingerprint,
          scope_generation: current.generation,
          file_state: "pending",
          mime_type: input.mimeType,
          byte_size: null,
        };
        const stored = await deps.repository.prepare(
          record,
          actor.accessClientId,
        );
        if (
          stored.instance_id !== record.instance_id ||
          stored.project_id !== record.project_id ||
          stored.task_id !== record.task_id ||
          (stored.canvas_id ?? null) !== (record.canvas_id ?? null) ||
          stored.task_kind !== record.task_kind ||
          stored.relative_path !== record.relative_path ||
          stored.write_fingerprint !== record.write_fingerprint ||
          stored.mime_type !== record.mime_type ||
          stored.pending_relative_path ||
          (stored.file_state === "pending" &&
            stored.scope_generation !== record.scope_generation)
        )
          throw new ProjectFileError(
            "file_conflict",
            "同一素材身份已绑定不同写入，请使用新的素材身份。",
          );
        return receipt(stored);
      }),
    async publish(actor, input, bytes, beforePublish) {
      if (fingerprintOf(bytes) !== input.writeFingerprint)
        throw new ProjectFileError(
          "file_conflict",
          "素材内容与准备写入的指纹不同。",
        );
      const prepared = await service.prepareWrite(actor, input);
      await uploadPrepared(actor, input.assetId, bytes, beforePublish);
      return prepared;
    },
    read: (actor, id, options) =>
      locked(`${actor.instanceId}/${id}`, async () =>
        completeRead(actor, await find(actor, id), options?.maxBytes),
      ),
    move: (actor, id, nextPath, expected, beforePublish) =>
      locked(`${actor.instanceId}/${id}`, async () => {
        validateRelativePath(nextPath);
        const record = await find(actor, id);
        assertExpected(record, expected);
        if (
          record.file_state !== "ready" ||
          (record.pending_relative_path &&
            record.pending_relative_path !== nextPath)
        )
          throw new ProjectFileError(
            "file_pending",
            "素材写入或移动尚未完成，请先恢复该操作。",
          );
        const old = await location(
          actor,
          record,
          record.relative_path,
          "write",
        );
        return operate(
          old,
          [record.relative_path, nextPath],
          "write",
          async (operation) => {
            const bytes = await readProjectFile(
              await checkedFilePath(old.root, record.relative_path, false),
              undefined,
              operation.signal,
            );
            if (fingerprintOf(bytes) !== record.write_fingerprint)
              throw new ProjectFileError(
                "file_conflict",
                "素材文件已在外部改变，请先确认该版本。",
              );
            if (record.relative_path === nextPath) return receipt(record);
            const target = await checkedFilePath(old.root, nextPath, true);
            try {
              if (
                fingerprintOf(
                  await readProjectFile(target, undefined, operation.signal),
                ) !== record.write_fingerprint
              )
                throw new ProjectFileError(
                  "file_conflict",
                  "目标文件已存在且内容不同，不会覆盖",
                );
            } catch (error) {
              if (
                !(error instanceof ProjectFileError) ||
                error.code !== "file_missing"
              )
                throw error;
            }
            operation.signal?.throwIfAborted();
            await deps.repository.beginMove(
              actor.instanceId,
              id,
              record.relative_path,
              nextPath,
            );
            await publish(operation, target, bytes, async () => {
              const current = await location(actor, record, nextPath, "write");
              if (
                current.root !== old.root ||
                current.generation !== old.generation
              )
                throw new ProjectFileError(
                  "scope_changed",
                  "移动期间素材授权已改变。",
                  403,
                );
              await checkedFilePath(current.root, nextPath, false);
              await beforePublish?.();
            });
            operation.signal?.throwIfAborted();
            await deps.repository.finishMove(
              actor.instanceId,
              id,
              record.relative_path,
              nextPath,
            );
            // finishMove 是移动提交点；旧副本清理失败不能推翻已发布的新位置。
            try {
              operation.signal?.throwIfAborted();
              // 元数据已经切换后才清理本次旧位置；legacy Blob源不在此删除。
              if (operation.controller)
                await operation.controller.resolveWrite(
                  record.relative_path,
                  operation.signal,
                );
              operation.signal?.throwIfAborted();
              const oldPath = await checkedFilePath(
                old.root,
                record.relative_path,
                false,
              );
              if (
                fingerprintOf(
                  await readProjectFile(oldPath, undefined, operation.signal),
                ) !== record.write_fingerprint
              )
                throw new ProjectFileError(
                  "file_conflict",
                  "旧位置文件已改变，已保留该文件",
                );
              await unlink(oldPath);
            } catch {
              // 授权撤销、文件锁或外部编辑均保留旧副本，receipt仍指向已提交位置。
            }
            return receipt({
              ...record,
              relative_path: nextPath,
              pending_relative_path: null,
            });
          },
        );
      }),
    remove: (actor, id, expected, beforeDelete) =>
      locked(`${actor.instanceId}/${id}`, async () => {
        const record = await find(actor, id);
        if (
          record.project_id !== expected.projectId ||
          record.write_fingerprint !== expected.expectedVersion ||
          record.file_state !== "ready" ||
          record.pending_relative_path
        )
          throw new ProjectFileError(
            "file_conflict",
            "素材项目、位置或版本已改变。",
          );
        const current = await location(
          actor,
          record,
          record.relative_path,
          "write",
        );
        await operate(
          current,
          [record.relative_path],
          "write",
          async ({ signal, controller }) => {
            signal?.throwIfAborted();
            const absolute = await checkedFilePath(
              current.root,
              record.relative_path,
              false,
            ).catch((error: unknown) => {
              if (
                error instanceof ProjectFileError &&
                error.code === "file_missing"
              )
                return null;
              throw error;
            });
            const readIfPresent = async () =>
              absolute
                ? readProjectFile(absolute, undefined, signal).catch(
                    (error: unknown) => {
                      if (
                        error instanceof ProjectFileError &&
                        error.code === "file_missing"
                      )
                        return null;
                      throw error;
                    },
                  )
                : null;
            const initialBytes = await readIfPresent();
            if (initialBytes && controller)
              await controller.resolveWrite(record.relative_path, signal);
            if (
              initialBytes &&
              fingerprintOf(initialBytes) !== expected.expectedVersion
            )
              throw new ProjectFileError(
                "file_conflict",
                "素材文件已在外部改变，不会删除。",
              );
            await beforeDelete?.();
            signal?.throwIfAborted();
            const latest = await find(actor, id);
            if (
              latest.project_id !== expected.projectId ||
              latest.write_fingerprint !== expected.expectedVersion ||
              latest.file_state !== "ready" ||
              latest.pending_relative_path
            )
              throw new ProjectFileError(
                "file_conflict",
                "素材项目、位置或版本已改变。",
              );
            if (!absolute) return;
            const finalBytes = await readIfPresent();
            if (
              finalBytes &&
              fingerprintOf(finalBytes) !== expected.expectedVersion
            )
              throw new ProjectFileError(
                "file_conflict",
                "素材文件已在外部改变，不会删除。",
              );
            if (!finalBytes) return;
            await beforeDelete?.();
            signal?.throwIfAborted();
            await unlink(absolute).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            });
          },
        );
      }),
    namespaceProvider: {
      async upload(path, bytes) {
        const { actor, assetId } = await actorForPath(path);
        await uploadPrepared(actor, assetId, bytes);
      },
      async download(path, options) {
        const { actor, assetId } = await actorForPath(path);
        return service.read(actor, assetId, options);
      },
      async contentType(path) {
        const { actor, assetId } = await actorForPath(path);
        return (await find(actor, assetId)).mime_type;
      },
      async copy(from, to) {
        await service.namespaceProvider.upload(
          to,
          await service.namespaceProvider.download(from),
        );
      },
      async remove(paths) {
        for (const path of paths) {
          const { actor, assetId } = await actorForPath(path);
          await locked(`${actor.instanceId}/${assetId}`, async () => {
            const record = await find(actor, assetId);
            const current = await location(
              actor,
              record,
              record.relative_path,
              "write",
            );
            await operate(
              current,
              [record.relative_path],
              "write",
              async ({ signal, controller }) => {
                signal?.throwIfAborted();
                const absolute = await checkedFilePath(
                  current.root,
                  record.relative_path,
                  false,
                );
                if (controller)
                  await controller.resolveWrite(record.relative_path, signal);
                signal?.throwIfAborted();
                await unlink(absolute).catch((error: unknown) => {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
                });
                signal?.throwIfAborted();
              },
            );
          });
        }
      },
    },
  };
  return service;
}
