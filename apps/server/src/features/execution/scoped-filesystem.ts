import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeExecutionScope,
} from "@kenfutwork/shared";
import type { BackendProtocolV2, FileInfo, ReadRawResult } from "deepagents";
import { observeBinary as observeBinaryFile } from "../code-tools/file-bytes.js";
import {
  errorText,
  ScopedFileController,
} from "../code-tools/file-controller.js";
import {
  readBinary,
  readMedia as readMediaFile,
} from "../code-tools/file-media.js";
import { createFileMutations } from "../code-tools/file-mutations.js";
import { runFileOperation } from "../code-tools/file-operations.js";
import { isTextDecodeFailure } from "../code-tools/file-read.js";
import { commitBatch as restoreBatch } from "../code-tools/file-restore.js";
import {
  grepPage as findContent,
  globPage as findFiles,
  listDirectory,
} from "../code-tools/file-search.js";
import type {
  BinaryObservation,
  EditCommit,
  EditFileInput,
  FileBatchResult,
  FileCommit,
  FileLimits,
  FileRestoreChange,
  GlobPage,
  GlobPageInput,
  GrepPage,
  GrepPageInput,
  MediaFile,
  MediaReadInput,
  PatchInput,
  PatchResult,
  ReadPageInput,
  TextPage,
  WriteFileInput,
} from "../code-tools/file-types.js";

export { forgetTaskFileState } from "../code-tools/file-controller.js";
export {
  acquireTaskFileRestoreBarrier,
  revokeTaskFileOperations,
  type TaskFileRestoreLease,
} from "../code-tools/file-operations.js";

export interface ScopedFilesystemScope {
  describe(): CodeExecutionScope;
  readonly role: "main" | "explore" | "review" | "worker";
  readonly agentId: string;
  resolvePath(path: string, operation: "read" | "write"): Promise<string>;
}

export interface ScopedBackend extends BackendProtocolV2 {
  listDirectory(path: string, signal?: AbortSignal): Promise<FileInfo[]>;
  observeBinary(path: string): Promise<BinaryObservation>;
  commitBatch<T extends ScopedFilesystemScope>(
    changes: FileRestoreChange[],
    beforeCommit: () => Promise<T>,
  ): Promise<FileBatchResult<T>>;
  readPage(input: ReadPageInput): Promise<TextPage>;
  writeFile(input: WriteFileInput): Promise<FileCommit>;
  editFile(input: EditFileInput): Promise<EditCommit>;
  applyPatch(input: PatchInput): Promise<PatchResult>;
  globPage(input: GlobPageInput): Promise<GlobPage>;
  grepPage(input: GrepPageInput): Promise<GrepPage>;
  readMedia(input: MediaReadInput): Promise<MediaFile>;
  readRaw(path: string, signal?: AbortSignal): Promise<ReadRawResult>;
  readonly limits: FileLimits;
}

class ScopedBackendAdapter implements ScopedBackend {
  private readonly controller: ScopedFileController;
  private readonly mutations: ReturnType<typeof createFileMutations>;
  constructor(
    private readonly scope: ScopedFilesystemScope,
    readonly limits: FileLimits,
  ) {
    this.controller = new ScopedFileController(scope, limits);
    this.mutations = createFileMutations(this.controller, limits);
  }
  readPage(input: ReadPageInput) {
    return runFileOperation(this.scope, input.signal, (signal) =>
      this.controller.readPage({ ...input, signal }),
    );
  }
  listDirectory(path: string, parentSignal?: AbortSignal) {
    return runFileOperation(this.scope, parentSignal, (signal) =>
      listDirectory(this.scope, path, signal),
    );
  }
  observeBinary(path: string) {
    return runFileOperation(this.scope, undefined, (signal) =>
      observeBinaryFile(this.scope, path, signal),
    );
  }
  commitBatch<T extends ScopedFilesystemScope>(
    changes: FileRestoreChange[],
    beforeCommit: () => Promise<T>,
  ) {
    return restoreBatch(this.scope, this.limits, changes, beforeCommit);
  }
  writeFile(input: WriteFileInput) {
    return runFileOperation(
      this.scope,
      input.signal,
      (signal) => this.mutations.writeFile({ ...input, signal }),
      "write",
    );
  }
  editFile(input: EditFileInput) {
    return runFileOperation(
      this.scope,
      input.signal,
      (signal) => this.mutations.editFile({ ...input, signal }),
      "write",
    );
  }
  applyPatch(input: PatchInput) {
    return runFileOperation(
      this.scope,
      input.signal,
      (signal) => this.mutations.applyPatch({ ...input, signal }),
      "write",
    );
  }
  globPage(input: GlobPageInput) {
    return runFileOperation(this.scope, input.signal, (signal) =>
      findFiles(this.scope, this.limits, { ...input, signal }),
    );
  }
  grepPage(input: GrepPageInput) {
    return runFileOperation(this.scope, input.signal, (signal) =>
      findContent(this.scope, this.limits, { ...input, signal }),
    );
  }
  readMedia(input: MediaReadInput) {
    return runFileOperation(this.scope, input.signal, (signal) =>
      readMediaFile(this.scope, this.limits, { ...input, signal }),
    );
  }
  async read(path: string, offset?: number, limit?: number) {
    return runFileOperation(this.scope, undefined, (signal) =>
      this.readResult(path, offset, limit, signal),
    ).catch((error) => ({ error: errorText(error) }));
  }
  private async readResult(
    path: string,
    offset: number | undefined,
    limit: number | undefined,
    signal: AbortSignal,
  ) {
    try {
      const page = await this.controller.readPage({
        signal,
        path,
        ...(offset !== undefined ? { line: offset + 1 } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return {
        ...page,
        mimeType: "text/plain",
        ...(page.continuation
          ? { nextOffset: page.continuation.line - 1 }
          : {}),
      };
    } catch (error) {
      if (isTextDecodeFailure(error)) {
        try {
          const binary = await readBinary(
            this.scope,
            path,
            this.limits.codeReadMaxBytes,
            signal,
          );
          return {
            content: new Uint8Array(binary.bytes),
            mimeType: binary.mimeType,
          };
        } catch (failure) {
          return { error: errorText(failure) };
        }
      }
      return { error: errorText(error) };
    }
  }
  async readRaw(path: string, parentSignal?: AbortSignal) {
    return runFileOperation(this.scope, parentSignal, (signal) =>
      this.readRawResult(path, signal),
    ).catch((error) => ({ error: errorText(error) }));
  }
  private async readRawResult(path: string, signal: AbortSignal) {
    try {
      const snapshot = await this.controller.readSnapshot(path, signal);
      return {
        data: {
          content: snapshot.text,
          mimeType: "text/plain",
          created_at: snapshot.createdAt,
          modified_at: snapshot.modifiedAt,
        },
      };
    } catch (error) {
      if (isTextDecodeFailure(error)) {
        try {
          const binary = await readBinary(
            this.scope,
            path,
            this.limits.codeReadMaxBytes,
            signal,
          );
          return {
            data: {
              content: new Uint8Array(binary.bytes),
              mimeType: binary.mimeType,
              created_at: binary.createdAt,
              modified_at: binary.modifiedAt,
            },
          };
        } catch (failure) {
          return { error: errorText(failure) };
        }
      }
      return { error: errorText(error) };
    }
  }
  async write(path: string, content: string) {
    try {
      const result = await this.writeFile({ path, content });
      return {
        path: result.filePath,
        filesUpdate: null,
        metadata: { ...result },
      };
    } catch (error) {
      return { error: errorText(error) };
    }
  }
  async edit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ) {
    try {
      const result = await this.editFile({
        path,
        oldString,
        newString,
        ...(replaceAll !== undefined ? { replaceAll } : {}),
      });
      return {
        path: result.filePath,
        occurrences: result.occurrences,
        filesUpdate: null,
        metadata: { ...result },
      };
    } catch (error) {
      return { error: errorText(error) };
    }
  }
  async ls(path: string) {
    try {
      return await runFileOperation(this.scope, undefined, async (signal) => ({
        files: await listDirectory(this.scope, path, signal),
      }));
    } catch (error) {
      return { error: errorText(error) };
    }
  }
  async glob(pattern: string, path?: string) {
    try {
      return await this.globPage({ pattern, ...(path ? { path } : {}) });
    } catch (error) {
      return { error: errorText(error) };
    }
  }
  async grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
    maxCount?: number | null,
  ) {
    try {
      return await this.grepPage({
        pattern: pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ...(path ? { path } : {}),
        ...(glob ? { glob } : {}),
        ...(maxCount !== undefined && maxCount !== null
          ? { limit: maxCount }
          : {}),
      });
    } catch (error) {
      return { error: errorText(error) };
    }
  }
}

export function createScopedBackend(
  scope: ScopedFilesystemScope,
  options: { limits?: FileLimits } = {},
): ScopedBackend {
  return new ScopedBackendAdapter(
    scope,
    options.limits ?? AGENT_GOVERNANCE_DEFAULTS,
  );
}
