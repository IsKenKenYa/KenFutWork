export interface CommitLossEvidence {
  commitConfirmed: boolean;
  replySuppressed: true;
  commandId: string;
  readbackSuppressed?: boolean;
  targetTaskId?: string;
  targetThreadId?: string;
  taskProjectMovePrepare?: true;
  createFirstInput?: true;
}
export function createCommitResponseLossProxy(connectionString: string): Promise<{
  connectionString: string;
  arm(commandId: string, options?: { blackoutAfterCommit?: boolean; rollbackBeforeCommit?: boolean; mediaInstall?: boolean; taskProjectMovePrepare?: boolean; createFirstInput?: boolean; loseCreationReadbackOnce?: boolean }): void;
  restore(): void;
  waitForInjected(): Promise<CommitLossEvidence>;
  evidence(): { injected?: CommitLossEvidence; observerError?: string };
  close(): Promise<void>;
}>;
