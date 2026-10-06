export interface CommitLossEvidence {
  commitConfirmed: true;
  replySuppressed: true;
  commandId: string;
}
export function createCommitResponseLossProxy(connectionString: string): Promise<{
  connectionString: string;
  arm(commandId: string): void;
  waitForInjected(): Promise<CommitLossEvidence>;
  evidence(): { injected?: CommitLossEvidence; observerError?: string };
  close(): Promise<void>;
}>;
