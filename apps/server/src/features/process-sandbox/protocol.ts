import type {
  ManagedProcessSnapshot,
  ProcessExit,
  ProcessOutput,
  ProcessOutputStream,
  ProcessSandboxOptions,
  ProcessSpawnRequest,
  TerminalOutputCursor,
} from "./types.js";

export interface PtyOutputFrame extends TerminalOutputCursor {
  event: "pty-output";
  processId: string;
  sequence: number;
  data: string;
}

export interface StdioOutputFrame extends TerminalOutputCursor {
  event: "stdio-output";
  processId: string;
  stream: ProcessOutputStream;
  data: string;
}
export type HelperOutputFrame = PtyOutputFrame | StdioOutputFrame;

export type HelperRequest =
  | {
      id: string;
      method: "initialize";
      taskId: string;
      options: Pick<
        ProcessSandboxOptions,
        "captureRoot" | "network" | "runtimeReadRoots" | "windowsBrokerPath"
      >;
      initial: ProcessSpawnRequest;
    }
  | {
      id: string;
      method: "spawn";
      request: ProcessSpawnRequest;
      internalWriteRoots: readonly string[];
    }
  | {
      id: string;
      method: "output";
      processId: string;
      offset: number;
      maxBytes: number;
      stream?: ProcessOutputStream;
    }
  | { id: string; method: "stdin"; processId: string; data: string }
  | {
      id: string;
      method: "outputack";
      processId: string;
      sequence: number;
      stream?: ProcessOutputStream;
    }
  | {
      id: string;
      method: "outputreader";
      processId: string;
      active: boolean;
      stream?: ProcessOutputStream;
    }
  | {
      id: string;
      method: "resize";
      processId: string;
      cols: number;
      rows: number;
    }
  | { id: string; method: "endstdin"; processId: string }
  | { id: string; method: "stop"; processId: string; reason: string }
  | { id: string; method: "wait"; processId: string }
  | { id: string; method: "revoke"; generation: number; reason: string }
  | {
      id: string;
      method: "scopechange";
      next: import("@kenfutwork/shared").CodeExecutionScope;
      reason: string;
    }
  | { id: string; method: "close"; reason: string };

export type HelperResponse =
  | {
      id: string;
      ok: true;
      value: ManagedProcessSnapshot | ProcessOutput | ProcessExit | null;
    }
  | { id: string; ok: false; error: { code: string; message: string } }
  | { event: "snapshot"; snapshot: ManagedProcessSnapshot }
  | HelperOutputFrame;
