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
  targetArchived?: boolean;
  taskGroupSave?: true;
  taskGroupUngroup?: true;
  taskGroupPlacement?: true;
  targetGroupId?: string;
  createFirstInput?: true;
  projectCreation?: true;
  creationId?: string;
  targetProjectId?: string;
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
      taskGroupSave?: boolean;
      taskGroupUngroup?: boolean;
      taskGroupPlacement?: boolean;
      createFirstInput?: boolean;
      projectCreation?: boolean;
      loseCreationReadbackOnce?: boolean;
    },
  ): void;
  restore(): void;
  waitForInjected(): Promise<CommitLossEvidence>;
  evidence(): { injected?: CommitLossEvidence; observerError?: string };
  close(): Promise<void>;
}>;
