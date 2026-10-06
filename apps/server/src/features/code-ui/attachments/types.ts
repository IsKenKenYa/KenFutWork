import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { BlobStore } from "../../blob/types.js";
import type { LocalActor } from "../../local-instance/types.js";
import type { InstanceSqlClient } from "../../persistence/types.js";

export class CodeAttachmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "CodeAttachmentError";
  }
}

/** Identity comes from the owned Code Task, never a renderer path or a Canvas. */
export interface CodeAttachmentSession {
  instanceId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  createdByClientId: string | null;
  scopeGeneration: number;
  branchGeneration: number;
  revision: number;
  canUpload: boolean;
}

export interface CodeAttachmentLimits {
  maxBytes: number;
  chunkMaxBytes: number;
  maxChunks: number;
  maxConcurrent: number;
  stagedMaxBytes: number;
  uploadTtlMs: number;
  maxPerInput: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface CodeAttachmentPlan {
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
  fingerprint: string;
  expiresAt: number;
  chunkMaxBytes: number;
}

interface AttachmentIdentity extends CodeAttachmentSession {
  key: string;
}
export type CodeAttachmentRecord =
  | (AttachmentIdentity &
      CodeAttachmentPlan & {
        status: "staging";
        connectionId: string;
        runtimeId: string;
      })
  | (AttachmentIdentity &
      CodeAttachmentPlan & {
        status: "committed";
        ref: string;
        objectPath: string;
      })
  | {
      status: "aborted";
      key: string;
      instanceId: string;
      projectId: string;
      taskId: string;
      sessionId: string;
      createdByClientId: string | null;
    };

/** The provider locks the upload key and checks the real Task generations in its transaction. */
export interface CodeAttachmentTransaction {
  record: CodeAttachmentRecord | null;
  assertWritable(expected: CodeAttachmentSession): Promise<void>;
  save(record: CodeAttachmentRecord): Promise<void>;
}

export interface CodeAttachmentRepository {
  /** 宿主已准备私有Blob；在创建目标根Task的同一事务关联其committed事实。 */
  publishHistoryCopies(
    scoped: InstanceSqlClient,
    target: CodeAttachmentSession,
    records: readonly Extract<CodeAttachmentRecord, { status: "committed" }>[],
  ): Promise<void>;
  transact<T>(
    session: CodeAttachmentSession,
    key: string,
    operation: (transaction: CodeAttachmentTransaction) => Promise<T>,
  ): Promise<T>;
  findCommitted(
    session: CodeAttachmentSession,
    ref: string,
  ): Promise<Extract<CodeAttachmentRecord, { status: "committed" }> | null>;
  interruptStaging(runtimeId: string): Promise<void>;
  abortConnection(
    instanceId: string,
    connectionId: string,
    runtimeId: string,
  ): Promise<void>;
  releaseTask(
    instanceId: string,
    taskId: string,
    runtimeId: string,
  ): Promise<void>;
  purgeTask(
    session: CodeAttachmentSession,
    expectedScopeGeneration: number,
    batchSize: number,
    remove: (
      records: ReadonlyArray<
        Extract<CodeAttachmentRecord, { status: "committed" }>
      >,
    ) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface CodeAttachmentHistoryCopy {
  /** source ref→目标Task自己的正规附件，重复引用共享同一目标对象。 */
  attachments: ReadonlyMap<string, protocol.AttachmentRef>;
  publish(scoped: InstanceSqlClient): Promise<void>;
  release(): void;
  discard(): Promise<void>;
}

export interface CodeAttachmentRowRequest {
  sessionId: string;
  ref: string;
  target?: protocol.ConversationRowTarget | undefined;
  attachmentIndex?: number | undefined;
  purpose: "preview" | "share";
}

export interface CodeAttachmentsDeps {
  blob: BlobStore;
  repository: CodeAttachmentRepository;
  authorizeSession(
    actor: LocalActor,
    sessionId: string,
  ): Promise<CodeAttachmentSession>;
  /** Returns only the canonical attachment of an authorized userInput row. */
  authorizeRow(
    actor: LocalActor,
    request: CodeAttachmentRowRequest,
  ): Promise<protocol.AttachmentRef>;
  limits(actor: LocalActor, instanceId: string): Promise<CodeAttachmentLimits>;
  clock?: (() => number) | undefined;
  authorizeInstance?: ((actor: LocalActor) => Promise<string>) | undefined;
}

export interface CodeAttachmentsService {
  prepareHistory(
    actor: LocalActor,
    sourceSessionId: string,
    target: CodeAttachmentSession,
    attachments: readonly protocol.AttachmentRef[],
  ): Promise<CodeAttachmentHistoryCopy>;
  initialize(): Promise<void>;
  budget(actor: LocalActor, sessionId?: string): Promise<CodeAttachmentLimits>;
  close(): Promise<void>;
  begin(
    actor: LocalActor,
    input: protocol.V4AttachmentBeginParams,
    chunkFrameMaxBytes?: number,
  ): Promise<protocol.V4AttachmentBeginResult>;
  chunk(
    actor: LocalActor,
    input: protocol.V4AttachmentChunkParams,
  ): Promise<protocol.V4AttachmentChunkResult>;
  commit(
    actor: LocalActor,
    input: protocol.V4AttachmentCommitParams,
  ): Promise<protocol.V4AttachmentCommitResult>;
  abort(
    actor: LocalActor,
    input: protocol.V4AttachmentAbortParams,
  ): Promise<void>;
  releaseConnection(instanceId: string, connectionId: string): Promise<void>;
  releaseTask(instanceId: string, taskId: string): Promise<void>;
  /** Caller first closes real execution resources; revoking + exact generation is rechecked in SQL. */
  purgeTask(
    actor: LocalActor,
    taskId: string,
    expectedScopeGeneration: number,
  ): Promise<void>;
  read(
    actor: LocalActor,
    input: protocol.V4AttachmentReadParams,
    purpose?: "preview" | "share",
  ): Promise<protocol.V4AttachmentReadResult>;
  stat(
    actor: LocalActor,
    input: protocol.V4ConversationAttachmentStatParams,
  ): Promise<protocol.V4ConversationAttachmentStatResult>;
  previewSource(
    actor: LocalActor,
    input: protocol.V4AttachmentPreviewSourceParams,
  ): Promise<protocol.V4AttachmentPreviewSourceResult>;
  readForInput(
    actor: LocalActor,
    sessionId: string,
    attachments: readonly protocol.AttachmentRef[],
  ): Promise<Array<{ attachment: protocol.AttachmentRef; bytes: Uint8Array }>>;
}
