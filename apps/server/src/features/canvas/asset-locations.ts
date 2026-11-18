import { extname, join } from "node:path";
import type { CanvasContent } from "@kenfutwork/shared";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import {
  fingerprintOf,
  validateRelativePath,
} from "../project-files/filesystem.js";
import {
  ProjectFileError,
  type ProjectFileService,
} from "../project-files/types.js";
import type { ProjectService } from "../projects/project-service.js";
import { resolveProjectWorkDirectory } from "../projects/work-dir.js";
import { canvasArchive } from "./export-archive.js";
import { createCanvasFileStore } from "./file-store.js";
import type { CanvasRepository } from "./repository.js";

export interface CanvasAssetLocations {
  move(
    actor: LocalActor,
    canvasId: string,
    assetId: string,
    input: {
      relativePath: string;
      expectedRelativePath: string;
      expectedVersion: string;
      expectedRevision: string;
    },
    beforePublish?: () => Promise<void>,
  ): Promise<import("../project-files/types.js").ProjectFileReceipt>;
  export(
    actor: LocalActor,
    canvasId: string,
    expectedRevision: string,
    beforePublish?: () => Promise<void>,
  ): Promise<{ filename: string; bytes: Uint8Array; revision: string }>;
  restoreReferences(
    actor: LocalActor,
    canvasId: string,
    expectedRevision: string,
    beforePublish?: () => Promise<void>,
  ): Promise<{ revision: string; assetIds: string[] }>;
}
const conflict = () =>
  new ProjectFileError("file_conflict", "画布布局已改变，请重新加载");
const fileIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const knownVideo = (actor: LocalActor, link: unknown) => {
  const prefix = `oss://project-assets/${actor.instanceId}/project-files/`;
  if (
    typeof link !== "string" ||
    !link.startsWith(prefix) ||
    !fileIdPattern.test(link.slice(prefix.length))
  )
    throw new ProjectFileError(
      "file_missing",
      "视频没有已登记的本地素材，请重新关联",
    );
  return link.slice(prefix.length);
};
export function createCanvasAssetLocations(deps: {
  canvases: Pick<
    CanvasRepository,
    "findById" | "claimRoot" | "withDocumentLock" | "notifyChanged"
  >;
  localInstance: Pick<LocalInstanceService, "resolve">;
  projects: Pick<ProjectService, "getProject">;
  exportMaxBytes(actor: LocalActor): Promise<number>;
  projectFiles: Pick<
    ProjectFileService,
    "inspect" | "read" | "restoreIndex" | "move"
  >;
}): CanvasAssetLocations {
  async function snapshot(
    actor: LocalActor,
    canvasId: string,
    expectedRevision: string,
    beforePublish?: () => Promise<void>,
  ) {
    await beforePublish?.();
    const instance = await deps.localInstance.resolve(actor);
    const row = await deps.canvases.findById(actor.instanceId, canvasId);
    if (!row) throw new ProjectFileError("not_found", "画布不存在", 404);
    await deps.projects.getProject(actor, row.project_id);
    const root = await deps.canvases.claimRoot(
      actor.instanceId,
      canvasId,
      (workDir) =>
        resolveProjectWorkDirectory({
          instanceId: instance.instanceId,
          projectId: row.project_id,
          sandboxRoot: join(instance.dataDir, "sandbox"),
          workDir,
        }),
    );
    const stored = await createCanvasFileStore({ projectRoot: root }).read(
      canvasId,
    );
    if (!stored)
      throw new ProjectFileError(
        "file_missing",
        "画布布局文件缺失，请恢复已登记的布局",
      );
    if (stored.revision !== expectedRevision) throw conflict();
    await beforePublish?.();
    return { content: stored.content, projectId: row.project_id, root };
  }
  async function unchanged(
    actor: LocalActor,
    canvasId: string,
    revision: string,
  ) {
    await snapshot(actor, canvasId, revision);
  }
  const service: CanvasAssetLocations = {
    async move(actor, canvasId, assetId, input, beforePublish) {
      const { content, projectId, root } = await snapshot(
        actor,
        canvasId,
        input.expectedRevision,
        beforePublish,
      );
      const location = await deps.projectFiles.inspect(actor, assetId);
      if (
        location.projectId !== projectId ||
        location.relativePath !== input.expectedRelativePath ||
        location.version !== input.expectedVersion ||
        (location.canvasId != null && location.canvasId !== canvasId)
      )
        throw new ProjectFileError(
          "file_conflict",
          "素材归属、位置或版本已改变，请重新加载",
        );

      let references = 0;
      const files = { ...content.files };
      for (const [fileId, file] of Object.entries(files)) {
        if (file.assetId !== assetId) continue;
        if (
          file.relativePath !== input.expectedRelativePath ||
          file.version !== input.expectedVersion
        )
          throw new ProjectFileError(
            "file_conflict",
            "画布中的素材位置或版本已改变，请重新加载",
          );
        files[fileId] = { ...file, relativePath: input.relativePath };
        references++;
      }

      const elements = content.elements.map((element) => {
        const custom = element.customData as
          | Record<string, unknown>
          | undefined;
        if (custom?.assetId !== assetId) return element;
        if (
          custom.isVideo !== true ||
          knownVideo(actor, element.link) !== assetId ||
          custom.relativePath !== input.expectedRelativePath ||
          custom.version !== input.expectedVersion
        )
          throw new ProjectFileError(
            "file_conflict",
            "画布中的视频素材位置或版本已改变，请重新加载",
          );
        references++;
        return {
          ...element,
          customData: { ...custom, relativePath: input.relativePath },
        };
      });
      if (references === 0)
        throw new ProjectFileError("file_missing", "该素材不在当前画布中");

      let moved = false;
      try {
        await createCanvasFileStore({
          projectRoot: root,
          ...(beforePublish ? { beforePublish } : {}),
        }).update(
          canvasId,
          { ...content, files, elements },
          input.expectedRevision,
          async () => {
            await beforePublish?.();
            await deps.projectFiles.move(
              actor,
              assetId,
              input.relativePath,
              {
                expectedRelativePath: input.expectedRelativePath,
                expectedVersion: input.expectedVersion,
              },
              beforePublish,
            );
            moved = true;
          },
        );
      } catch (error) {
        if (!moved) throw error;
        try {
          await deps.projectFiles.move(
            actor,
            assetId,
            input.expectedRelativePath,
            {
              expectedRelativePath: input.relativePath,
              expectedVersion: input.expectedVersion,
            },
          );
        } catch {
          throw new ProjectFileError(
            "file_repair_required",
            `画布布局更新失败，素材可能位于「${input.relativePath}」，原路径为「${input.expectedRelativePath}」，请重新关联。`,
          );
        }
        throw error;
      }
      return deps.projectFiles.inspect(actor, assetId);
    },
    async export(actor, canvasId, expectedRevision, beforePublish) {
      const { content, projectId } = await snapshot(
        actor,
        canvasId,
        expectedRevision,
        beforePublish,
      );
      const maximum = await deps.exportMaxBytes(actor);
      let archiveSize = 1024; // ustar 以两个512字节块结束。
      const oversized = () =>
        new ProjectFileError(
          "file_conflict",
          "导出超过预算，请在设置中调整",
          413,
        );
      if (archiveSize > maximum) throw oversized();
      const files: CanvasContent["files"] = {};
      const assets = new Map<string, { path: string; bytes: Uint8Array }>();
      async function asset(assetId: string, expectedVersion?: unknown) {
        const location = await deps.projectFiles.inspect(actor, assetId);
        if (
          location.projectId !== projectId ||
          (typeof expectedVersion === "string" &&
            expectedVersion !== location.version)
        )
          throw new ProjectFileError(
            "file_conflict",
            "画布素材归属或版本已改变",
          );
        if (!assets.has(assetId)) {
          const remaining = maximum - archiveSize - 512; // 每个文件的ustar头。
          if (remaining < 0) throw oversized();
          const bytes = await deps.projectFiles.read(actor, assetId, {
            maxBytes: remaining,
          });
          archiveSize += 512 + Math.ceil(bytes.byteLength / 512) * 512;
          if (archiveSize > maximum) throw oversized();
          if (fingerprintOf(bytes) !== location.version)
            throw new ProjectFileError(
              "file_conflict",
              "素材文件已改变，请确认该版本",
            );
          const extension = extname(location.relativePath);
          const path = `assets/${assetId}${/^\.[a-zA-Z0-9]{1,10}$/u.test(extension) ? extension : ""}`;
          assets.set(assetId, { path, bytes });
        }
        return { ...location, archivePath: assets.get(assetId)!.path };
      }
      for (const [fileId, file] of Object.entries(content.files)) {
        if (typeof file.assetId !== "string")
          throw new ProjectFileError(
            "file_missing",
            "画布素材没有已登记的本地文件，请重新关联",
          );
        const location = await asset(file.assetId, file.version);
        const {
          dataURL: _data,
          storageRef: _ref,
          storageUrl: _url,
          ...metadata
        } = file;
        files[fileId] = {
          ...metadata,
          assetId: location.assetId,
          version: location.version,
          relativePath: location.archivePath,
          dataURL: location.archivePath,
        };
      }
      const elements: CanvasContent["elements"] = [];
      for (const element of content.elements) {
        const custom = element.customData as
          | Record<string, unknown>
          | undefined;
        if (custom?.isVideo === true) {
          const location = await asset(
            knownVideo(actor, element.link),
            custom.version,
          );
          elements.push({
            ...element,
            link: location.archivePath,
            customData: {
              ...custom,
              assetId: location.assetId,
              version: location.version,
            },
          });
        } else elements.push(element);
      }
      await unchanged(actor, canvasId, expectedRevision);
      await beforePublish?.();
      const layout = Buffer.from(
        JSON.stringify({ ...content, elements, files }),
      );
      archiveSize += 512 + Math.ceil(layout.byteLength / 512) * 512;
      if (archiveSize > maximum) throw oversized();
      return {
        filename: `${canvasId}.tar`,
        revision: expectedRevision,
        bytes: canvasArchive([
          { path: "layout.json", bytes: layout },
          ...assets.values(),
        ]),
      };
    },
    async restoreReferences(actor, canvasId, expectedRevision, beforePublish) {
      const { content, projectId } = await snapshot(
        actor,
        canvasId,
        expectedRevision,
        beforePublish,
      );
      const references = Object.values(content.files).map((file) => {
        if (
          typeof file.assetId !== "string" ||
          typeof file.relativePath !== "string"
        )
          throw new ProjectFileError(
            "file_missing",
            "布局缺少素材身份或确切路径",
          );
        validateRelativePath(file.relativePath);
        return {
          assetId: file.assetId,
          relativePath: file.relativePath,
          ...(typeof file.version === "string"
            ? { version: file.version }
            : {}),
        };
      });
      for (const element of content.elements) {
        const custom = element.customData as
          | Record<string, unknown>
          | undefined;
        if (custom?.isVideo !== true) continue;
        const assetId = knownVideo(actor, element.link);
        if (
          custom.assetId !== assetId ||
          typeof custom.relativePath !== "string"
        )
          throw new ProjectFileError(
            "file_missing",
            "视频布局缺少已登记素材的确切路径",
          );
        validateRelativePath(custom.relativePath);
        references.push({
          assetId,
          relativePath: custom.relativePath,
          ...(typeof custom.version === "string"
            ? { version: custom.version }
            : {}),
        });
      }
      const restored = await deps.projectFiles.restoreIndex(
        actor,
        projectId,
        references,
        async () => {
          await beforePublish?.();
          await unchanged(actor, canvasId, expectedRevision);
        },
        canvasId,
      );
      await unchanged(actor, canvasId, expectedRevision);
      await beforePublish?.();
      return {
        revision: expectedRevision,
        assetIds: [...new Set(restored.map((file) => file.assetId))],
      };
    },
  };
  const locked = <T>(
    actor: LocalActor,
    canvasId: string,
    guard: (() => Promise<void>) | undefined,
    operation: (authorize: () => Promise<void>) => Promise<T>,
  ) =>
    deps.canvases.withDocumentLock(actor.instanceId, canvasId, (signal) =>
      operation(async () => {
        signal.throwIfAborted();
        await guard?.();
        signal.throwIfAborted();
      }),
    );
  return {
    move: (actor, id, assetId, input, guard) =>
      locked(actor, id, guard, async (authorize) => {
        const moved = await service.move(actor, id, assetId, input, authorize);
        if (input.relativePath !== input.expectedRelativePath)
          await deps.canvases.notifyChanged(actor.instanceId, id);
        return moved;
      }),
    export: (actor, id, revision, guard) =>
      locked(actor, id, guard, (authorize) =>
        service.export(actor, id, revision, authorize),
      ),
    restoreReferences: (actor, id, revision, guard) =>
      locked(actor, id, guard, async (authorize) => {
        const restored = await service.restoreReferences(
          actor,
          id,
          revision,
          authorize,
        );
        if (restored.assetIds.length)
          await deps.canvases.notifyChanged(actor.instanceId, id);
        return restored;
      }),
  };
}
