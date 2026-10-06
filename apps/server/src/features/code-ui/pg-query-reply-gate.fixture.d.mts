export interface PgQueryGateEvidence {
  matched: boolean;
  serverReadyForQuery: boolean;
  replyHeld: boolean;
  readCompleted: boolean;
  queryFailed: boolean;
  released: boolean;
  connectionClosed: boolean;
  sql: string | undefined;
  values: unknown[];
  commandTag: string | undefined;
  transactionStatus: string | undefined;
  observerError: string | undefined;
}

export function createPgQueryReplyGate(connectionString: string): Promise<{
  connectionString: string;
  arm(): void;
  entered: Promise<PgQueryGateEvidence>;
  release(): void;
  evidence(): PgQueryGateEvidence;
  close(): Promise<void>;
}>;
