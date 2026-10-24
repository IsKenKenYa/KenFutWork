export interface CommitLossEvidence {
  commitConfirmed: boolean;
  replySuppressed: true;
  commandId: string;
  readbackSuppressed?: boolean;
  targetTaskId?: string;
  targetThreadId?: string;
  taskProjectMovePrepare?: true;
  taskArchivePrepare?: true;
  taskArchiveCompletion?: true;
  taskUnread?: true;
  targetUnreadAt?: number | null;
  targetLastUnreadAt?: number;
  targetArchived?: boolean;
  taskGroupSave?: true;
  taskGroupUngroup?: true;
  taskGroupPlacement?: true;
  taskGroupMove?: true;
  nodeType?: "group" | "task";
  nodeId?: string;
  targetGroupId?: string;
  createFirstInput?: true;
  projectCreation?: true;
  projectEditorSave?: true;
  creationId?: string;
  targetProjectId?: string;
  expectedProjectRevision?: number;
  targetProjectRevision?: number;
}
export function createCommitResponseLossProxy(
  connectionString: string,
): Promise<{
  connectionString: string;
  arm(
    commandId: string,
    options?: {
      blackoutAfterCommit?: boolean;
      rollbackBeforeCommit?: boolean;
      mediaInstall?: boolean;
      taskProjectMovePrepare?: boolean;
      taskArchivePrepare?: boolean;
      taskArchiveCompletion?: boolean;
      taskUnread?: boolean;
      taskGroupSave?: boolean;
      taskGroupUngroup?: boolean;
      taskGroupPlacement?: boolean;
      taskGroupMove?: boolean;
      createFirstInput?: boolean;
      projectCreation?: boolean;
      projectEditorSave?: boolean;
      loseCreationReadbackOnce?: boolean;
    },
  ): void;
  restore(): void;
  waitForInjected(): Promise<CommitLossEvidence>;
  evidence(): { injected?: CommitLossEvidence; observerError?: string };
  close(): Promise<void>;
}>;
