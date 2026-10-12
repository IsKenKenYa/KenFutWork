import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BlobStore } from "../blob/types.js";
import { generateLocalAccessToken } from "../local-access/desktop-token.js";
import type { LocalAccessService } from "../local-access/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ProjectFileService } from "../project-files/types.js";
import type { ProjectService } from "../projects/project-service.js";
import { resolveProjectWorkDirectory } from "../projects/work-dir.js";
import {
  createFlowDocumentStore,
  FlowDocumentStoreError,
  type FlowLayoutSnapshot,
} from "./document-store.js";

const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROJECT_FILE_BYTES = 250 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
function validMimeType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 120 &&
    value.includes("/") &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

export class FlowProjectFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "FlowProjectFileError";
  }
}

export type FlowProjectFileReceipt = {
  assetId: string;
  relativePath: string;
  version: string;
};
export type FlowProjectFileMetadata = FlowProjectFileReceipt & {
  mimeType: string;
  sizeBytes: number;
};

export interface FlowProjectFiles {
  issue(
    actor: LocalActor,
    projectId: string,
  ): Promise<{
    version: "v1";
    projectId: string;
    generation: number;
    bindingToken: string;
  }>;
  upload(
    bindingToken: string,
    input: {
      assetId: string;
      relativePath: string;
      mimeType: string;
      writeFingerprint: string;
    },
    bytes: Uint8Array,
  ): Promise<FlowProjectFileReceipt>;
  metadata(
    bindingToken: string,
    assetId: string,
  ): Promise<FlowProjectFileMetadata>;
  read(
    bindingToken: string,
    assetId: string,
    version: string,
  ): Promise<Uint8Array>;
  move(
    bindingToken: string,
    assetId: string,
    input: {
      relativePath: string;
      expectedRelativePath: string;
      expectedVersion: string;
    },
  ): Promise<FlowProjectFileReceipt>;
  remove(bindingToken: string, assetId: string, version: string): Promise<void>;
  readLayout(
    bindingToken: string,
    workflowId: string,
  ): Promise<FlowLayoutSnapshot | null>;
  saveLayout(
    bindingToken: string,
    workflowId: string,
    input: { content: unknown; expectedVersion: string | null },
  ): Promise<FlowLayoutSnapshot>;
  dispose(): void;
}

type Binding = {
  actor: LocalActor;
  projectId: string;
  projectRoot: string;
  generation: number;
  expiresAt: number;
  documents: ReturnType<typeof createFlowDocumentStore>;
};
type BindingHandle = { hash: string; value: Binding };

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function invalidBinding() {
  return new FlowProjectFileError(
    "flow_file_binding_invalid",
    "Flow 项目文件授权无效、已撤销或已过期。",
    401,
  );
}

function versionConflict() {
  return new FlowProjectFileError(
    "flow_file_version_conflict",
    "项目文件版本已改变，请重新加载。",
    409,
  );
}

function assetNotFound() {
  return new FlowProjectFileError(
    "flow_file_not_found",
    "Flow 项目文件不存在。",
    404,
  );
}

function requireUuid(value: string) {
  if (!UUID.test(value))
    throw new FlowProjectFileError(
      "flow_file_invalid_request",
      "Flow 项目标识无效。",
      400,
    );
}

function requireVersion(value: string) {
  if (!SHA256.test(value)) throw versionConflict();
}

export function createFlowProjectFiles(deps: {
  localInstance: LocalInstanceService;
  localAccess: Pick<LocalAccessService, "onRevoked">;
  projects: Pick<ProjectService, "getProject">;
  projectFiles: ProjectFileService;
  blob: BlobStore;
  projectControl: {
    snapshot(
      actor: LocalActor,
      projectId: string,
    ): Promise<{ generation: number; draining: boolean }>;
  };
  now?: () => number;
}): FlowProjectFiles {
  const now = deps.now ?? Date.now;
  const bindings = new Map<string, Binding>();
  const revokedClients = new Set<string>();
  let disposed = false;

  const unsubscribe = deps.localAccess.onRevoked((clientId) => {
    revokedClients.add(clientId);
    for (const [hash, binding] of bindings)
      if (binding.actor.accessClientId === clientId) bindings.delete(hash);
  });

  const purgeExpired = () => {
    const timestamp = now();
    for (const [hash, binding] of bindings)
      if (binding.expiresAt <= timestamp) bindings.delete(hash);
  };

  const resolveRoot = async (actor: LocalActor, projectId: string) => {
    const instance = await deps.localInstance.resolve(actor);
    if (instance.instanceId !== actor.instanceId)
      throw new FlowProjectFileError(
        "flow_file_project_changed",
        "Flow 项目归属已改变。",
        403,
      );
    const project = await deps.projects.getProject(actor, projectId);
    if (project.kind !== "flow")
      throw new FlowProjectFileError(
        "flow_file_project_changed",
        "文件绑定不属于 Flow 项目。",
        403,
      );
    try {
      return await resolveProjectWorkDirectory({
        instanceId: actor.instanceId,
        projectId,
        sandboxRoot: join(instance.dataDir, "sandbox"),
        workDir: project.work_dir,
      });
    } catch {
      throw new FlowProjectFileError(
        "flow_file_project_changed",
        "Flow 项目目录不可用或已改变。",
        409,
      );
    }
  };

  const assertCurrent = async (handle: BindingHandle) => {
    if (
      disposed ||
      bindings.get(handle.hash) !== handle.value ||
      handle.value.expiresAt <= now() ||
      (handle.value.actor.accessClientId !== null &&
        revokedClients.has(handle.value.actor.accessClientId))
    ) {
      bindings.delete(handle.hash);
      throw invalidBinding();
    }
    const gate = await deps.projectControl.snapshot(
      handle.value.actor,
      handle.value.projectId,
    );
    if (gate.draining || gate.generation !== handle.value.generation) {
      bindings.delete(handle.hash);
      throw invalidBinding();
    }
    const root = await resolveRoot(handle.value.actor, handle.value.projectId);
    if (root !== handle.value.projectRoot)
      throw new FlowProjectFileError(
        "flow_file_project_changed",
        "Flow 项目目录已改变，请重新建立文件连接。",
        409,
      );
    if (
      disposed ||
      bindings.get(handle.hash) !== handle.value ||
      handle.value.expiresAt <= now() ||
      (handle.value.actor.accessClientId !== null &&
        revokedClients.has(handle.value.actor.accessClientId))
    ) {
      bindings.delete(handle.hash);
      throw invalidBinding();
    }
  };

  const withBinding = async <T>(
    token: string,
    run: (handle: BindingHandle) => Promise<T>,
  ): Promise<T> => {
    const release = deps.localInstance.beginAdmission();
    try {
      purgeExpired();
      if (disposed || !token || token.length > 2048) throw invalidBinding();
      const hash = sha256(token);
      const value = bindings.get(hash);
      if (!value) throw invalidBinding();
      const handle = { hash, value };
      await assertCurrent(handle);
      return await run(handle);
    } finally {
      release();
    }
  };

  const guard = (handle: BindingHandle) => () => assertCurrent(handle);
  const ownedAsset = async (handle: BindingHandle, assetId: string) => {
    requireUuid(assetId);
    const location = await deps.projectFiles.inspect(
      handle.value.actor,
      assetId,
    );
    if (location.projectId !== handle.value.projectId) throw assetNotFound();
    return location;
  };
  const receipt = (location: {
    assetId: string;
    relativePath: string;
    version?: string;
  }): FlowProjectFileReceipt => {
    if (!location.version)
      throw new FlowProjectFileError(
        "flow_file_invalid_request",
        "项目文件缺少版本标识。",
        500,
      );
    return {
      assetId: location.assetId,
      relativePath: location.relativePath,
      version: location.version,
    };
  };

  return {
    async issue(actor, projectId) {
      const release = deps.localInstance.beginAdmission();
      try {
        purgeExpired();
        if (disposed)
          throw new FlowProjectFileError(
            "flow_file_unavailable",
            "Flow 项目文件服务已关闭。",
            503,
          );
        requireUuid(projectId);
        const startedAt = now();
        const gate = await deps.projectControl.snapshot(actor, projectId);
        if (gate.draining) throw invalidBinding();
        const projectRoot = await resolveRoot(actor, projectId);
        if (
          actor.accessClientId !== null &&
          revokedClients.has(actor.accessClientId)
        )
          throw invalidBinding();
        const token = generateLocalAccessToken();
        const hash = sha256(token);
        const expiresAt = startedAt + BINDING_TTL_MS;
        const value: Binding = {
          actor: { ...actor },
          projectId,
          projectRoot,
          generation: gate.generation,
          expiresAt,
          documents: createFlowDocumentStore(projectRoot),
        };
        bindings.set(hash, value);
        if (
          disposed ||
          (actor.accessClientId !== null &&
            revokedClients.has(actor.accessClientId))
        ) {
          bindings.delete(hash);
          throw invalidBinding();
        }
        await assertCurrent({ hash, value });
        return {
          version: "v1",
          projectId,
          generation: gate.generation,
          bindingToken: token,
        };
      } finally {
        release();
      }
    },
    upload: (token, input, bytes) =>
      withBinding(token, async (handle) => {
        requireUuid(input.assetId);
        requireVersion(input.writeFingerprint);
        if (!validMimeType(input.mimeType))
          throw new FlowProjectFileError(
            "flow_file_invalid_request",
            "项目文件类型无效。",
            400,
          );
        if (sha256(bytes) !== input.writeFingerprint) throw versionConflict();
        const published = await deps.projectFiles.publish(
          handle.value.actor,
          {
            target: { kind: "project", projectId: handle.value.projectId },
            assetId: input.assetId,
            relativePath: input.relativePath,
            mimeType: input.mimeType,
            writeFingerprint: input.writeFingerprint,
          },
          bytes,
          guard(handle),
        );
        await assertCurrent(handle);
        return receipt(published);
      }),
    metadata: (token, assetId) =>
      withBinding(token, async (handle) => {
        const location = await ownedAsset(handle, assetId);
        const namespace = deps.blob.resolveNamespace(
          location.bucket,
          location.objectPath,
        );
        if (
          !namespace ||
          namespace.namespace !== "project-files" ||
          !namespace.provider.contentType
        )
          throw new FlowProjectFileError(
            "flow_file_unavailable",
            "项目文件元数据Provider未装配。",
            503,
          );
        const [bytes, mimeType] = await Promise.all([
          deps.projectFiles.read(handle.value.actor, assetId, {
            maxBytes: MAX_PROJECT_FILE_BYTES,
          }),
          namespace.provider.contentType(location.objectPath),
        ]);
        if (sha256(bytes) !== location.version) throw versionConflict();
        await assertCurrent(handle);
        const latest = await ownedAsset(handle, assetId);
        if (
          latest.relativePath !== location.relativePath ||
          latest.version !== location.version
        )
          throw versionConflict();
        if (!validMimeType(mimeType))
          throw new FlowProjectFileError(
            "flow_file_unavailable",
            "项目文件类型不可用。",
            503,
          );
        return { ...receipt(location), mimeType, sizeBytes: bytes.byteLength };
      }),
    read: (token, assetId, version) =>
      withBinding(token, async (handle) => {
        requireVersion(version);
        const location = await ownedAsset(handle, assetId);
        if (location.version !== version) throw versionConflict();
        const bytes = await deps.projectFiles.read(
          handle.value.actor,
          assetId,
          {
            maxBytes: MAX_PROJECT_FILE_BYTES,
          },
        );
        if (sha256(bytes) !== version) throw versionConflict();
        await assertCurrent(handle);
        const latest = await ownedAsset(handle, assetId);
        if (
          latest.relativePath !== location.relativePath ||
          latest.version !== location.version
        )
          throw versionConflict();
        return bytes;
      }),
    move: (token, assetId, input) =>
      withBinding(token, async (handle) => {
        requireUuid(assetId);
        requireVersion(input.expectedVersion);
        const current = await ownedAsset(handle, assetId);
        if (
          current.relativePath !== input.expectedRelativePath ||
          current.version !== input.expectedVersion
        )
          throw versionConflict();
        await deps.projectFiles.move(
          handle.value.actor,
          assetId,
          input.relativePath,
          {
            expectedRelativePath: input.expectedRelativePath,
            expectedVersion: input.expectedVersion,
          },
          guard(handle),
        );
        const moved = await ownedAsset(handle, assetId);
        await assertCurrent(handle);
        if (moved.relativePath !== input.relativePath) throw versionConflict();
        return receipt(moved);
      }),
    remove: async (token, assetId, version) =>
      withBinding(token, async (handle) => {
        requireUuid(assetId);
        requireVersion(version);
        await deps.projectFiles.remove(
          handle.value.actor,
          assetId,
          { projectId: handle.value.projectId, expectedVersion: version },
          guard(handle),
        );
        await assertCurrent(handle);
      }),
    readLayout: (token, workflowId) =>
      withBinding(token, async (handle) => {
        requireUuid(workflowId);
        try {
          const result = await handle.value.documents.read(workflowId);
          await assertCurrent(handle);
          return result;
        } catch (error) {
          if (error instanceof FlowDocumentStoreError)
            throw new FlowProjectFileError(
              error.code,
              error.message,
              error.statusCode,
            );
          throw error;
        }
      }),
    saveLayout: (token, workflowId, input) =>
      withBinding(token, async (handle) => {
        requireUuid(workflowId);
        if (
          !input.content ||
          typeof input.content !== "object" ||
          Array.isArray(input.content)
        )
          throw new FlowProjectFileError(
            "flow_layout_invalid_content",
            "工作流内容必须是JSON对象。",
            400,
          );
        if (
          input.expectedVersion !== null &&
          !SHA256.test(input.expectedVersion)
        )
          throw versionConflict();
        try {
          const saved = await handle.value.documents.save(
            workflowId,
            input.content as Record<string, unknown>,
            input.expectedVersion,
            guard(handle),
          );
          await assertCurrent(handle);
          return saved;
        } catch (error) {
          if (error instanceof FlowDocumentStoreError)
            throw new FlowProjectFileError(
              error.code,
              error.message,
              error.statusCode,
            );
          throw error;
        }
      }),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      bindings.clear();
    },
  };
}
