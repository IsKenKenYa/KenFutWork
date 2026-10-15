import type { BlobNamespaceProvider } from "../blob/types.js";
import type { LocalActor } from "../local-instance/types.js";

export type ProjectFileTarget =
  | { kind: "project"; projectId: string }
  | { kind: "canvas"; projectId: string; canvasId: string }
  | { kind: "task"; taskId: string };
export type ProjectFileWrite = {
  target: ProjectFileTarget;
  assetId: string;
  relativePath: string;
  mimeType: string;
  /** 要发布的原始字节SHA256，同时作为相同assetId的写入幂等指纹。 */
  writeFingerprint: string;
};
export type ProjectFileReceipt = {
  assetId: string;
  version?: string;
  bucket: "project-assets";
  objectPath: string;
  relativePath: string;
};
export type ProjectFileLocation = ProjectFileReceipt & {
  projectId: string;
  taskId: string | null;
  canvasId?: string | null;
  version: string;
};
export type ProjectFileExpected = {
  expectedRelativePath: string;
  expectedVersion: string;
};
export type ProjectFileMutationGuard = () => Promise<void>;
export type ProjectFileRemoveExpected = {
  projectId: string;
  expectedVersion: string;
};
export type ProjectFileRelink = ProjectFileExpected & {
  relativePath: string;
  fileVersion: string;
  canvasId?: string;
};
export interface ProjectFileService {
  restoreIndex(
    actor: LocalActor,
    projectId: string,
    references: { assetId: string; relativePath: string; version?: string }[],
    beforePublish: () => Promise<void>,
    canvasId?: string,
  ): Promise<ProjectFileLocation[]>;
  inspect(actor: LocalActor, assetId: string): Promise<ProjectFileLocation>;
  relink(
    actor: LocalActor,
    assetId: string,
    input: ProjectFileRelink,
  ): Promise<ProjectFileLocation>;
  /** 仅返回已发布资产的精确位置，不读取素材字节或创建新资产。 */
  describe(actor: LocalActor, assetId: string): Promise<ProjectFileReceipt>;
  prepareWrite(
    actor: LocalActor,
    input: ProjectFileWrite,
  ): Promise<ProjectFileReceipt>;
  /** Prepares and publishes through the same indexed namespace implementation. */
  publish(
    actor: LocalActor,
    input: ProjectFileWrite,
    bytes: Uint8Array,
    beforePublish?: ProjectFileMutationGuard,
  ): Promise<ProjectFileReceipt>;
  read(
    actor: LocalActor,
    assetId: string,
    options?: { maxBytes: number },
  ): Promise<Uint8Array>;
  move(
    actor: LocalActor,
    assetId: string,
    relativePath: string,
    expected?: ProjectFileExpected,
    beforePublish?: ProjectFileMutationGuard,
  ): Promise<ProjectFileReceipt>;
  /** Conditional project-owned deletion; a missing file is idempotent after record proof. */
  remove(
    actor: LocalActor,
    assetId: string,
    expected: ProjectFileRemoveExpected,
    beforeDelete?: ProjectFileMutationGuard,
  ): Promise<void>;
  namespaceProvider: BlobNamespaceProvider;
}
export class ProjectFileError extends Error {
  constructor(
    readonly code:
      | "invalid_path"
      | "file_conflict"
      | "file_missing"
      | "file_pending"
      | "file_repair_required"
      | "scope_changed"
      | "not_found",
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
export type ProjectFileRecord = {
  id: string;
  instance_id: string;
  project_id: string;
  task_id: string | null;
  canvas_id?: string | null;
  task_kind: "code" | "design" | null;
  /** 退役Design的只读存储位置，不签发执行权限。 */
  legacy_design_root?: string | null;
  legacy_design_canvas_id?: string | null;
  relative_path: string;
  pending_relative_path: string | null;
  write_fingerprint: string;
  scope_generation: number | null;
  file_state: "pending" | "ready";
  mime_type: string;
  byte_size: number | null;
};
export interface ProjectFileRepository {
  relinkBatch(
    instanceId: string,
    entries: { assetId: string; input: ProjectFileRelink; byteSize: number }[],
  ): Promise<void>;
  relink(
    instanceId: string,
    assetId: string,
    input: ProjectFileRelink,
    byteSize: number,
  ): Promise<void>;
  find(instanceId: string, assetId: string): Promise<ProjectFileRecord | null>;
  prepare(
    record: ProjectFileRecord,
    accessClientId: string | null,
  ): Promise<ProjectFileRecord>;
  complete(
    instanceId: string,
    assetId: string,
    fingerprint: string,
    byteSize: number,
  ): Promise<void>;
  beginMove(
    instanceId: string,
    assetId: string,
    previousPath: string,
    nextPath: string,
  ): Promise<void>;
  finishMove(
    instanceId: string,
    assetId: string,
    previousPath: string,
    nextPath: string,
  ): Promise<void>;
}
