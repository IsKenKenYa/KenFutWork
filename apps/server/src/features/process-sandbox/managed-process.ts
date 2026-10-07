import type {
  ManagedProcessSnapshot,
  ProcessExit,
  ProcessOutput,
  ProcessOutputStream,
} from "./types.js";

export interface ProcessOwner {
  readonly ready: { promise: Promise<void> };
  readonly scope: import("@kenfutwork/shared").CodeExecutionScope;
  snapshot(): ManagedProcessSnapshot;
  output(
    offset: number,
    maxBytes: number,
    stream?: ProcessOutputStream,
  ): ProcessOutput;
  stdin(data: string): Promise<void>;
  resize?(cols: number, rows: number): Promise<void>;
  acknowledgeOutput?(
    sequence: number,
    stream?: ProcessOutputStream,
  ): void | Promise<void>;
  setOutputReader?(
    active: boolean,
    stream?: ProcessOutputStream,
  ): void | Promise<void>;
  endStdin(): Promise<void>;
  stop(reason: string): Promise<ProcessExit>;
  wait(): Promise<ProcessExit>;
}
