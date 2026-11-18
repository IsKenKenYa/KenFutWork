import type { ToolExecutionContext } from "../../kernel/types.js";

export interface ContextArchivePage {
  /** Serialized native message JSON; offsets and limits count UTF-16 code units, never tokens. */
  text: string;
  nextOffset: number | null;
  totalCodeUnits: number;
}

export interface ContextHistoryRead {
  uri: string;
  offset?: number;
  limit?: number;
}
export type ContextHistoryArchiveReader = (
  input: ContextHistoryRead & { signal?: AbortSignal },
) => Promise<ContextArchivePage>;
/** Actual Run registers its readonly native archive; opaque references confer no Task authority. */
export interface ContextHistoryArchiveBindings {
  bind(
    owner: ToolExecutionContext,
    read: ContextHistoryArchiveReader,
  ): () => void;
  read(
    input: ContextHistoryRead,
    execution: ToolExecutionContext,
  ): Promise<ContextArchivePage>;
}
