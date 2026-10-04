import type { CodeExecutionScope } from "@kenfutwork/shared";

export interface ProcessLimits {
  maxOutputBytes: number;
  previewMaxChars: number;
  yieldMs: number;
  killGraceMs: number;
}

export interface ProcessEnforcement {
  backend: "srt-seatbelt" | "srt-bwrap" | "windows-task-broker";
  filesystem: "enforced";
  processRange: "pid-namespace" | "process-group" | "job-object";
  permissionsGeneration: number;
}

export interface ProcessSpawnRequest {
  scope: CodeExecutionScope;
  /** 仅真实 PTY；不会以 pipes 降级。 */
  pty?: { cols: number; rows: number };
  /** 精确 argv 的完整双向协议 pipes；不使用 PTY。 */
  stdio?: "stream";
  agentId: string;
  invocationId: string;
  command?: string;
  argv?: { executable: string; args: readonly string[] };
  cwd?: string;
  shell?: string;
  background: boolean;
  timeoutMs?: number | null;
  limits: ProcessLimits;
  /** 用户显式执行环境；不从服务端 process.env 批量继承。 */
  env?: Readonly<Record<string, string>>;
}

export type ProcessPtySpawnRequest = Omit<
  ProcessSpawnRequest,
  "command" | "shell" | "argv" | "pty" | "stdio"
> & {
  argv: { executable: string; args: readonly string[] };
  pty: { cols: number; rows: number };
};

export type ProcessStdioSpawnRequest = Omit<
  ProcessSpawnRequest,
  "command" | "shell" | "argv" | "pty" | "stdio"
> & {
  argv: { executable: string; args: readonly string[] };
};

export type ManagedProcessState =
  | "starting"
  | "running"
  | "exited"
  | "stopped"
  | "failed";

export interface ProcessExit {
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  stopped: boolean;
  rangeEmpty: boolean;
}

export type ProcessOutputStream = "stdout" | "stderr";

export interface ProcessOutput {
  data: string;
  offset: number;
  nextOffset: number;
  retainedBytes: number;
  totalBytes: number;
  discardedBytes: number;
  truncated: boolean;
  done: boolean;
}

export interface ManagedProcessSnapshot {
  id: string;
  ownerTaskId: string;
  agentId: string;
  invocationId: string;
  generation: number;
  state: ManagedProcessState;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  enforcement: ProcessEnforcement | null;
  exit: ProcessExit | null;
  retainedBytes: number;
  totalBytes: number;
  discardedBytes: number;
  /** 私有日志文件引用；消费方仍须按 ownerTaskId 鉴权。 */
  outputPath: string;
}

export interface ManagedProcess {
  readonly id: string;
  readOutput(input: {
    offset: number;
    maxBytes: number;
    stream?: ProcessOutputStream;
  }): Promise<ProcessOutput>;
  writeStdin(data: string): Promise<void>;
  endStdin(): Promise<void>;
  stop(reason: string): Promise<ProcessExit>;
  waitForExit(): Promise<ProcessExit>;
  snapshot(): ManagedProcessSnapshot;
}

export interface TerminalOutputCursor {
  sequence: number;
  /** 全量送达 UTF8 字节游标，与 retained capture 的截断独立。 */
  offset: number;
  nextOffset: number;
}
export type TerminalOutputListener = (
  data: string,
  cursor: TerminalOutputCursor,
) => void | Promise<void>;

export interface ManagedTerminalProcess extends ManagedProcess {
  /** 原始 PTY 流；Promise 完成才 ACK，与有界历史 capture 独立。 */
  onOutput(listener: TerminalOutputListener): () => void;
  resize(cols: number, rows: number): Promise<void>;
}

export interface ManagedStdioProcess extends ManagedProcess {
  onStdout(listener: TerminalOutputListener): () => void;
  onStderr(listener: TerminalOutputListener): () => void;
}

export interface ProcessSandbox {
  /** requestedScope只读时保证用户目录只读且无网；依赖缺失fail closed，不表示probe已就绪。 */
  readonly readonlyExecution?: boolean;
  acquireRestoreBarrier(
    scope: CodeExecutionScope,
    roots: readonly string[],
  ): Promise<{ release(): void | Promise<void> }>;
  spawn(request: ProcessSpawnRequest): Promise<ManagedProcess>;
  spawnPty(request: ProcessPtySpawnRequest): Promise<ManagedTerminalProcess>;
  spawnStdio(request: ProcessStdioSpawnRequest): Promise<ManagedStdioProcess>;
  /** 仅系统 checkpoint consumer 使用；私有根由 Profile 解析，模型输入不能签发。 */
  spawnCheckpoint(request: ProcessSpawnRequest): Promise<ManagedProcess>;
  applyScopeChange(
    previous: CodeExecutionScope,
    next: CodeExecutionScope,
    reason: string,
  ): Promise<void>;
  /** 新 generation 是收紧后的版本；屏障完成之前所有新命令/stdin 均拒绝。 */
  revokeTask(taskId: string, generation: number, reason: string): Promise<void>;
  closeTask(taskId: string, reason: string, generation?: number): Promise<void>;
  close(reason: string): Promise<void>;
}

export interface ProcessSandboxOptions {
  captureRoot: string;
  nodePath?: string;
  helperPath?: string;
  helperExecArgv?: string[];
  windowsBrokerPath?: string;
  network: {
    allowedDomains: readonly string[];
    deniedDomains: readonly string[];
  };
  /** Workspace 设置在每 Task helper 启动时解析，不轮换宿主进程 SRT 单例。 */
  resolveNetwork?: (scope: CodeExecutionScope) => Promise<{
    allowedDomains: readonly string[];
    deniedDomains: readonly string[];
  }>;
  resolveInternalWriteRoots?: (
    scope: CodeExecutionScope,
    purpose: "checkpoint",
  ) => Promise<readonly string[]>;
  /** 宿主运行时只读目录（Node/动态库/系统命令），由 profile 按实际安装路径供给。 */
  runtimeReadRoots?: readonly string[];
  onSnapshot?: (snapshot: ManagedProcessSnapshot) => void;
}

export class ProcessSandboxError extends Error {
  constructor(
    readonly code:
      | "restore_conflict"
      | "scope_revoked"
      | "enforcement_unavailable"
      | "spawn_failed"
      | "process_closed"
      | "stop_unconfirmed"
      | "invalid_process_request"
      | "output_failed",
    message: string,
  ) {
    super(message);
    this.name = "ProcessSandboxError";
  }
}
