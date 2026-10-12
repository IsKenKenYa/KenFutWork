import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CanvasContent, CanvasDetail } from "@kenfutwork/shared";
import { canvasContentSchema } from "@kenfutwork/shared";
import type { BlobStore } from "../blob/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ProjectFileService } from "../project-files/types.js";
import { ProjectFileError } from "../project-files/types.js";
import type { ProjectService } from "../projects/project-service.js";
import { resolveProjectWorkDirectory } from "../projects/work-dir.js";
import {
  type CanvasContentStore,
  insertImageElement,
  insertVideoElement,
} from "./canvas-element-writer.js";
import { CanvasFileStoreError, createCanvasFileStore } from "./file-store.js";
import type { CanvasRepository } from "./repository.js";

export class CanvasServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "canvas_not_found"
    | "canvas_save_failed"
    | "canvas_file_missing";

  constructor(
    code: "canvas_not_found" | "canvas_save_failed" | "canvas_file_missing",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "CanvasServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type ImageInsertRequest = {
  canvasId: string;
  objectPath: string;
  width: number;
  height: number;
  mimeType: string;
  title?: string;
  placement?: { x: number; y: number; width: number; height: number };
};

export type VideoInsertRequest = {
  canvasId: string;
  assetId?: string;
  signedUrl: string;
  width: number;
  height: number;
  mimeType: string;
  durationSeconds?: number;
  title?: string;
  prompt?: string;
  placement?: { x: number; y: number; width: number; height: number };
};

export type CanvasService = {
  /** 服务端消费者读取权威布局，保留素材逻辑URI，不解析下载或签名URL。 */
  readCanvasContent(
    actor: LocalActor,
    canvasId: string,
  ): Promise<CanvasContent>;
  getCanvas(actor: LocalActor, canvasId: string): Promise<CanvasDetail>;
  saveCanvasContent(
    actor: LocalActor,
    canvasId: string,
    content: CanvasContent,
    expectedRevision: string | null,
    beforePublish?: () => Promise<void>,
  ): Promise<{ revision: string; fileReferences: Record<string, string> }>;
  /** 生成物落画布：读-改-写内容并追加元素（工作区作用域由服务解析）。 */
  insertImageElement(
    actor: LocalActor,
    request: ImageInsertRequest,
  ): Promise<{ elementId: string }>;
  insertVideoElement(
    actor: LocalActor,
    request: VideoInsertRequest,
  ): Promise<{ elementId: string }>;
};

/** Stable blob-namespace reference for a registered project file. */
const OSS_MARKER_PREFIX = "oss://";
const PROJECT_FILE_BUCKET = "project-assets";
const PROJECT_FILE_ASSET_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export function createCanvasService(options: {
  /** Canvas asset metadata and project-relative paths. */
  blob: BlobStore;
  repository: CanvasRepository;
  localInstance: LocalInstanceService;
  projects: Pick<ProjectService, "getProject">;
  projectFiles: ProjectFileService;
}): CanvasService {
  const { repository, localInstance, projects } = options;
  const owned = async (actor: LocalActor, canvasId: string) => {
    const instance = await localInstance.resolve(actor);
    const row = await repository.findById(instance.instanceId, canvasId);
    if (!row)
      throw new CanvasServiceError(
        "canvas_not_found",
        "画布不存在或已删除。",
        404,
      );
    const project = await projects.getProject(actor, row.project_id);
    const projectRoot = await repository.claimRoot(
      instance.instanceId,
      canvasId,
      (workDir) =>
        resolveProjectWorkDirectory({
          instanceId: instance.instanceId,
          projectId: row.project_id,
          sandboxRoot: join(instance.dataDir, "sandbox"),
          workDir,
        }),
    );
    return { instanceId: instance.instanceId, row, project, projectRoot };
  };
  const load = async (
    actor: LocalActor,
    canvasId: string,
    beforePublish?: () => Promise<void>,
  ) => {
    await beforePublish?.();
    const location = await owned(actor, canvasId);
    const store = createCanvasFileStore({
      projectRoot: location.projectRoot,
      beforePublish: async () => {
        await beforePublish?.();
        const current = await owned(actor, canvasId);
        if (current.projectRoot !== location.projectRoot)
          throw new CanvasFileStoreError(
            "revision_conflict",
            "项目目录已改变，请重新加载画布。",
          );
      },
    });
    let snapshot = await store.read(canvasId);
    const indexed =
      (location.row.content as { storage?: string } | null)?.storage ===
      "project-files";
    if (!snapshot && indexed)
      throw new CanvasServiceError(
        "canvas_file_missing",
        "画布文件缺失，请恢复项目中的画布文件。",
        409,
      );
    if (!snapshot && !indexed) {
      const legacy = await extractFilesToStorage(
        options.blob,
        options.projectFiles,
        actor,
        location.row.project_id,
        canvasId,
        toCanvasContent(location.row.content),
      );
      try {
        snapshot = await store.save(canvasId, legacy, null);
      } catch (error) {
        if (
          !(error instanceof CanvasFileStoreError) ||
          error.code !== "revision_conflict"
        )
          throw error;
        snapshot = await store.read(canvasId);
        if (!snapshot) throw error;
      }
    }
    if (!snapshot && indexed)
      throw new CanvasServiceError(
        "canvas_file_missing",
        "画布文件缺失，请恢复项目中的画布文件。",
        409,
      );
    if (!snapshot)
      throw new CanvasServiceError(
        "canvas_file_missing",
        "画布文件缺失，请恢复项目中的画布文件。",
        409,
      );
    let migrated: CanvasContent;
    try {
      migrated = await extractFilesToStorage(
        options.blob,
        options.projectFiles,
        actor,
        location.row.project_id,
        canvasId,
        snapshot.content,
        undefined,
        true,
      );
    } catch (error) {
      if (!missingRegisteredFile(error)) throw error;
      // 布局仍可打开并显式重新关联；不猜测文件、不改写缺失引用。
      migrated = snapshot.content;
    }
    migrated = await refreshVideoReferences(
      options.projectFiles,
      actor,
      migrated,
      true,
    );
    if (JSON.stringify(migrated) !== JSON.stringify(snapshot.content)) {
      snapshot = await store.save(canvasId, migrated, snapshot.revision);
    }
    if (!indexed) {
      await owned(actor, canvasId);
      if (!(await repository.recordFileIndex(location.instanceId, canvasId)))
        throw new CanvasServiceError(
          "canvas_not_found",
          "画布已删除，导入未登记。",
          404,
        );
    }
    return { ...location, store, snapshot };
  };
  const contentStore = (actor: LocalActor): CanvasContentStore => ({
    readContent: async (canvasId) =>
      (await load(actor, canvasId)).snapshot.content,
    appendContent: async (canvasId, input) => {
      const { store, snapshot, row } = await load(actor, canvasId);
      const prepared = await extractFilesToStorage(
        options.blob,
        options.projectFiles,
        actor,
        row.project_id,
        canvasId,
        { elements: [], appState: {}, files: input.files ?? {} },
        snapshot.content,
      );
      await store.appendLatest(canvasId, {
        ...input,
        files: prepared.files,
      });
    },
  });
  return {
    readCanvasContent: async (actor, canvasId) =>
      (await load(actor, canvasId)).snapshot.content,
    async getCanvas(actor, canvasId) {
      const { row, snapshot } = await load(actor, canvasId);
      return {
        id: row.id,
        name: row.name,
        projectId: row.project_id,
        content: await resolveFilesFromStorage(
          options.blob,
          options.projectFiles,
          actor,
          snapshot.content,
        ),
        revision: snapshot.revision,
      };
    },
    async saveCanvasContent(
      actor,
      canvasId,
      content,
      expectedRevision,
      beforePublish,
    ) {
      const { store, snapshot, row } = await load(
        actor,
        canvasId,
        beforePublish,
      );
      if (snapshot.revision !== expectedRevision)
        throw new CanvasFileStoreError(
          "revision_conflict",
          "画布文件已改变，请重新加载后保存。",
        );
      const extracted = await extractFilesToStorage(
        options.blob,
        options.projectFiles,
        actor,
        row.project_id,
        canvasId,
        content,
        snapshot.content,
      );
      const lean = await refreshVideoReferences(
        options.projectFiles,
        actor,
        extracted,
        false,
      );
      const saved = await store.save(canvasId, lean, expectedRevision);
      return {
        revision: saved.revision,
        fileReferences: Object.fromEntries(
          Object.entries(saved.content.files).flatMap(([id, file]) =>
            typeof file.storageRef === "string" &&
            file.storageRef.startsWith(OSS_MARKER_PREFIX)
              ? [[id, file.storageRef]]
              : [],
          ),
        ),
      };
    },
    insertImageElement: (actor, request) =>
      insertImageElement(contentStore(actor), request, request.placement),
    insertVideoElement: async (actor, request) => {
      if (!request.assetId)
        return insertVideoElement(
          contentStore(actor),
          request,
          request.placement,
        );
      const { row } = await owned(actor, request.canvasId);
      const location = await options.projectFiles.inspect(
        actor,
        request.assetId,
      );
      if (location.projectId !== row.project_id)
        throw new CanvasServiceError(
          "canvas_save_failed",
          "视频文件不属于当前画布项目。",
          409,
        );
      return insertVideoElement(
        contentStore(actor),
        {
          ...request,
          signedUrl: await options.blob
            .bucket(location.bucket)
            .resolveUrl(location.objectPath),
          relativePath: location.relativePath,
          assetVersion: location.version,
        },
        request.placement,
      );
    },
  };
}

function missingRegisteredFile(error: unknown): boolean {
  return (
    error instanceof ProjectFileError &&
    (error.code === "file_missing" || error.code === "not_found")
  );
}

async function refreshVideoReferences(
  projectFiles: ProjectFileService,
  actor: LocalActor,
  content: CanvasContent,
  allowMissing: boolean,
): Promise<CanvasContent> {
  const elements = await Promise.all(
    content.elements.map(async (element) => {
      const custom = element.customData;
      if (
        !custom ||
        typeof custom !== "object" ||
        Array.isArray(custom) ||
        !("isVideo" in custom) ||
        custom.isVideo !== true ||
        !("assetId" in custom) ||
        typeof custom.assetId !== "string"
      )
        return element;
      if (allowMissing && canonicalReference(custom)) return element;
      if (!PROJECT_FILE_ASSET_ID.test(custom.assetId))
        throw new CanvasServiceError(
          "canvas_save_failed",
          "视频素材标识无效。",
          409,
        );
      try {
        const receipt = await projectFiles.describe(actor, custom.assetId);
        if (
          canonicalReference(custom) &&
          (receipt.relativePath !== custom.relativePath ||
            receipt.version !== custom.version)
        )
          throw new ProjectFileError(
            "file_conflict",
            "素材索引与布局不同，请恢复素材索引",
          );
        if (
          receipt.assetId !== custom.assetId ||
          receipt.bucket !== PROJECT_FILE_BUCKET ||
          receipt.objectPath !==
            `${actor.instanceId}/project-files/${custom.assetId}`
        )
          throw new CanvasServiceError(
            "canvas_save_failed",
            "视频素材登记信息与画布引用不匹配。",
            409,
          );
        return {
          ...element,
          customData: {
            ...custom,
            relativePath: receipt.relativePath,
            ...(receipt.version ? { version: receipt.version } : {}),
          },
        };
      } catch (error) {
        if (!allowMissing || !missingRegisteredFile(error)) throw error;
        return element;
      }
    }),
  );
  return { ...content, elements };
}

function toCanvasContent(value: unknown): CanvasContent {
  return canvasContentSchema.parse(value ?? {});
}

// ---------------------------------------------------------------------------
// File extraction (save path): base64 or legacy blob → project-file reference
// ---------------------------------------------------------------------------

type CanvasFileRecord = Record<string, Record<string, unknown>>;
function canonicalReference(file: Record<string, unknown>): file is Record<
  string,
  unknown
> & {
  assetId: string;
  relativePath: string;
  version: string;
} {
  return (
    typeof file.assetId === "string" &&
    typeof file.relativePath === "string" &&
    typeof file.version === "string"
  );
}

async function extractFilesToStorage(
  blob: BlobStore,
  projectFiles: ProjectFileService,
  actor: LocalActor,
  projectId: string,
  canvasId: string,
  content: CanvasContent,
  previous?: CanvasContent,
  preserveCanonical = false,
): Promise<CanvasContent> {
  const files = (content as { files?: CanvasFileRecord }).files;
  if (!files || Object.keys(files).length === 0) return content;

  const updatedFiles: CanvasFileRecord = {};
  await Promise.all(
    Object.entries(files).map(async ([fileId, incoming]) => {
      const previousFile = previous?.files[fileId] ?? {};
      const fileData = { ...previousFile, ...incoming };
      if (preserveCanonical && canonicalReference(fileData)) {
        updatedFiles[fileId] = fileData;
        return;
      }
      const knownStorageRef =
        typeof fileData.storageRef === "string" &&
        fileData.storageRef.startsWith(OSS_MARKER_PREFIX)
          ? fileData.storageRef
          : typeof fileData.dataURL === "string" &&
              fileData.dataURL.startsWith(OSS_MARKER_PREFIX)
            ? fileData.dataURL
            : undefined;
      if (typeof fileData.assetId === "string") {
        updatedFiles[fileId] = await describeProjectFileReference(
          projectFiles,
          actor,
          fileData,
          fileData.assetId,
          knownStorageRef,
        );
        return;
      }

      const storageRef =
        typeof fileData.storageRef === "string" &&
        fileData.storageRef.startsWith(OSS_MARKER_PREFIX)
          ? fileData.storageRef
          : undefined;
      const dataURL =
        typeof fileData.dataURL === "string" ? fileData.dataURL : undefined;
      if (storageRef || dataURL?.startsWith(OSS_MARKER_PREFIX)) {
        const migrated = await migrateLegacyBlobReference(
          blob,
          projectFiles,
          actor,
          projectId,
          canvasId,
          fileData,
          storageRef ?? dataURL!,
        );
        updatedFiles[fileId] = migrated;
        return;
      }

      if (dataURL?.startsWith("data:")) {
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(fileId))
          throw new CanvasServiceError(
            "canvas_save_failed",
            "素材标识无效，请重新添加素材。",
            400,
          );
        const { buffer, mimeType } = parseDataURL(dataURL);
        updatedFiles[fileId] = await writeProjectFile(
          blob,
          projectFiles,
          actor,
          projectId,
          canvasId,
          fileData,
          buffer,
          mimeType,
        );
        return;
      }
      updatedFiles[fileId] = fileData;
    }),
  );
  return { ...content, files: updatedFiles } as CanvasContent;
}

async function migrateLegacyBlobReference(
  blob: BlobStore,
  projectFiles: ProjectFileService,
  actor: LocalActor,
  projectId: string,
  canvasId: string,
  fileData: Record<string, unknown>,
  storageRef: string,
) {
  const { bucket, objectPath } = parseStorageRef(storageRef);
  const namespacePrefix = `${actor.instanceId}/project-files/`;
  if (
    bucket === PROJECT_FILE_BUCKET &&
    objectPath.startsWith(namespacePrefix)
  ) {
    const assetId = objectPath.slice(namespacePrefix.length);
    if (
      !PROJECT_FILE_ASSET_ID.test(assetId) ||
      objectPath !== `${namespacePrefix}${assetId}`
    )
      throw new CanvasServiceError(
        "canvas_save_failed",
        "项目素材引用无效，无法读取登记信息。",
        409,
      );
    return describeProjectFileReference(
      projectFiles,
      actor,
      fileData,
      assetId,
      storageRef,
    );
  }
  const bytes = await blob.bucket(bucket).download(objectPath);
  const mimeType =
    typeof fileData.mimeType === "string"
      ? fileData.mimeType
      : "application/octet-stream";
  return writeProjectFile(
    blob,
    projectFiles,
    actor,
    projectId,
    canvasId,
    fileData,
    Buffer.from(bytes),
    mimeType,
  );
}

async function describeProjectFileReference(
  projectFiles: ProjectFileService,
  actor: LocalActor,
  fileData: Record<string, unknown>,
  assetId: string,
  expectedStorageRef?: string,
) {
  if (
    !PROJECT_FILE_ASSET_ID.test(assetId) ||
    (typeof fileData.assetId === "string" && fileData.assetId !== assetId)
  )
    throw new CanvasServiceError(
      "canvas_save_failed",
      "项目素材标识无效，无法读取登记信息。",
      409,
    );
  const receipt = await projectFiles.describe(actor, assetId);
  if (
    canonicalReference(fileData) &&
    (receipt.relativePath !== fileData.relativePath ||
      receipt.version !== fileData.version)
  )
    throw new ProjectFileError(
      "file_conflict",
      "素材索引与布局不同，请恢复素材索引",
    );
  const objectPath = `${actor.instanceId}/project-files/${assetId}`;
  const storageRef = `${OSS_MARKER_PREFIX}${PROJECT_FILE_BUCKET}/${objectPath}`;
  if (
    receipt.assetId !== assetId ||
    receipt.bucket !== PROJECT_FILE_BUCKET ||
    receipt.objectPath !== objectPath ||
    (expectedStorageRef !== undefined && expectedStorageRef !== storageRef)
  )
    throw new CanvasServiceError(
      "canvas_save_failed",
      "项目素材登记信息与画布引用不匹配。",
      409,
    );
  return projectFileMarkerRecord(
    {
      ...fileData,
      assetId: receipt.assetId,
      relativePath: receipt.relativePath,
      ...(receipt.version ? { version: receipt.version } : {}),
    },
    storageRef,
  );
}

async function writeProjectFile(
  blob: BlobStore,
  projectFiles: ProjectFileService,
  actor: LocalActor,
  projectId: string,
  canvasId: string,
  fileData: Record<string, unknown>,
  bytes: Uint8Array,
  mimeType: string,
) {
  const assetId = randomUUID();
  const relativePath = `canvas-${assetId}.${mimeToExt(mimeType)}`;
  const writeFingerprint = createHash("sha256").update(bytes).digest("hex");
  const receipt = await projectFiles.prepareWrite(actor, {
    target: { kind: "canvas", projectId, canvasId },
    assetId,
    relativePath,
    mimeType,
    writeFingerprint,
  });
  if (receipt.assetId !== assetId || receipt.relativePath !== relativePath)
    throw new CanvasServiceError(
      "canvas_save_failed",
      "项目素材登记结果不匹配。",
      409,
    );
  await blob.bucket(receipt.bucket).upload(receipt.objectPath, bytes, {
    contentType: mimeType,
    upsert: true,
  });
  const verified = await projectFiles.read(actor, receipt.assetId, {
    maxBytes: bytes.byteLength + 1,
  });
  if (createHash("sha256").update(verified).digest("hex") !== writeFingerprint)
    throw new CanvasServiceError(
      "canvas_save_failed",
      "项目素材校验失败，画布未保存。",
      409,
    );
  const storageRef = `${OSS_MARKER_PREFIX}${receipt.bucket}/${receipt.objectPath}`;
  return projectFileMarkerRecord(
    {
      ...fileData,
      assetId: receipt.assetId,
      relativePath: receipt.relativePath,
      ...(receipt.version ? { version: receipt.version } : {}),
      mimeType,
    },
    storageRef,
  );
}

function projectFileMarkerRecord(
  fileData: Record<string, unknown>,
  storageRef: string,
) {
  const { storageUrl: _url, ...rest } = fileData;
  return { ...rest, dataURL: storageRef, storageRef };
}

function parseStorageRef(storageRef: string) {
  const ref = storageRef.slice(OSS_MARKER_PREFIX.length);
  const slashIdx = ref.indexOf("/");
  if (slashIdx < 1 || slashIdx === ref.length - 1)
    throw new CanvasServiceError(
      "canvas_save_failed",
      "素材引用无效，无法迁移到项目文件。",
      409,
    );
  return {
    bucket: ref.slice(0, slashIdx),
    objectPath: ref.slice(slashIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// File resolution (load path): project-file reference → accessible URL
// ---------------------------------------------------------------------------

async function resolveFilesFromStorage(
  blob: BlobStore,
  projectFiles: ProjectFileService,
  actor: LocalActor,
  content: CanvasContent,
): Promise<CanvasContent> {
  const files = (content as { files?: CanvasFileRecord }).files;
  const updatedFiles: CanvasFileRecord = {};
  async function matches(file: Record<string, unknown>): Promise<boolean> {
    if (!canonicalReference(file)) return true;
    if (!PROJECT_FILE_ASSET_ID.test(file.assetId)) return false;
    try {
      const receipt = await projectFiles.describe(actor, String(file.assetId));
      return (
        receipt.assetId === file.assetId &&
        receipt.bucket === PROJECT_FILE_BUCKET &&
        receipt.objectPath ===
          `${actor.instanceId}/project-files/${file.assetId}` &&
        (file.storageRef === undefined ||
          file.storageRef ===
            `${OSS_MARKER_PREFIX}${PROJECT_FILE_BUCKET}/${receipt.objectPath}`) &&
        receipt.relativePath === file.relativePath &&
        receipt.version === file.version
      );
    } catch (error) {
      if (missingRegisteredFile(error)) return false;
      throw error;
    }
  }
  for (const [fileId, fileData] of Object.entries(files ?? {})) {
    if (!(await matches(fileData))) {
      const { storageUrl: _url, ...reference } = fileData;
      updatedFiles[fileId] = { ...reference, assetError: "请恢复素材索引" };
      continue;
    }
    const storageRef =
      typeof fileData.storageRef === "string"
        ? fileData.storageRef
        : typeof fileData.dataURL === "string" &&
            fileData.dataURL.startsWith(OSS_MARKER_PREFIX)
          ? fileData.dataURL
          : undefined;
    if (!storageRef) {
      updatedFiles[fileId] = fileData;
      continue;
    }
    const { bucket, objectPath } = parseStorageRef(storageRef);
    const storageUrl = await blob.bucket(bucket).resolveUrl(objectPath);
    updatedFiles[fileId] = {
      ...fileData,
      dataURL: undefined,
      storageUrl,
      storageRef,
    };
  }
  const elements = await Promise.all(
    content.elements.map(async (element) => {
      const custom = element.customData;
      if (
        !custom ||
        typeof custom !== "object" ||
        Array.isArray(custom) ||
        !("isVideo" in custom) ||
        custom.isVideo !== true ||
        (await matches(custom))
      )
        return element;
      return {
        ...element,
        link: null,
        customData: { ...custom, assetError: "请恢复素材索引" },
      };
    }),
  );
  return { ...content, files: updatedFiles, elements } as CanvasContent;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseDataURL(dataURL: string): { buffer: Buffer; mimeType: string } {
  const match = dataURL.match(/^data:([^;]+);base64,(.+)$/s);
  if (
    !match ||
    !match[1] ||
    !match[2] ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      match[2],
    )
  )
    throw new CanvasServiceError(
      "canvas_save_failed",
      "素材内容无效，请重新添加素材。",
      400,
    );
  return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") };
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}
