import type { TerminalShellId } from "../code-git/terminal-runner.js";
import type { LocalActor } from "../local-instance/types.js";
import type {
  ProcessExit,
  TerminalOutputCursor,
} from "../process-sandbox/types.js";

export interface TerminalSubscriber {
  output(data: string, cursor: TerminalOutputCursor): Promise<void>;
  exit(value: ProcessExit): Promise<void>;
}

export interface TerminalOpenRequest {
  taskId: string;
  sessionId?: string | undefined;
  cwd?: string | undefined;
  shell?: TerminalShellId | undefined;
  cols: number;
  rows: number;
}
export interface TerminalOpenResult {
  id: string;
  taskId: string;
  shell: TerminalShellId;
  executable: string;
  tty: true;
  reused?: boolean;
}
export interface CodeTerminalService {
  create(
    actor: LocalActor,
    connectionId: string,
    request: TerminalOpenRequest,
  ): Promise<TerminalOpenResult>;
  write(
    actor: LocalActor,
    connectionId: string,
    id: string,
    data: string,
  ): Promise<void>;
  resize(
    actor: LocalActor,
    connectionId: string,
    id: string,
    cols: number,
    rows: number,
  ): Promise<void>;
  /** 创建只保留首帧；消费方装好 data/exit 监听后显式激活。 */
  subscribe(
    actor: LocalActor,
    connectionId: string,
    id: string,
    subscriber: TerminalSubscriber,
  ): Promise<void>;
  stop(
    actor: LocalActor,
    connectionId: string,
    id: string,
    reason: string,
  ): Promise<void>;
  closeConnection(
    instanceId: string,
    connectionId: string,
    reason: string,
  ): Promise<void>;
  closeTask(instanceId: string, taskId: string, reason: string): Promise<void>;
  close(reason: string): Promise<void>;
}
