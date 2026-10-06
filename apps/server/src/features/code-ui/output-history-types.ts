import {
  type zcodeUiProtocol as protocol,
  taskWorkStateSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import type { AgentContextResourceBinding } from "../../agent/context-history.js";
import type { LocalActor } from "../local-instance/types.js";
import type { ProcessOutput } from "../process-sandbox/types.js";
import type { TaskWorkContext, TaskWorkStatus } from "../task-work/types.js";
import type { CodeUiSessionRecord } from "./repository.js";

export const historyOutputStatsSchema = z
  .object({
    retainedBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe(),
    discardedBytes: z.number().int().nonnegative().safe(),
  })
  .strict()
  .refine(
    (stats) =>
      stats.totalBytes >= stats.retainedBytes &&
      stats.discardedBytes === stats.totalBytes - stats.retainedBytes,
    "完整输出的保留、总计及丢弃字节事实不一致。",
  );

/** TaskOutput的已持久列表投影；普通工作不提供私有读取引用。 */
export const historyOutputListSchema = z.array(
  z
    .object({
      taskId: z.string().min(1),
      kind: taskWorkStateSchema.shape.kind,
      label: z.string(),
      status: taskWorkStateSchema.shape.status,
      readOnly: z.boolean().optional(),
    })
    .passthrough(),
);

/** 当前Task的只读副本；source只溯源，不参与读取或控制授权。 */
export const ownedHistoryOutputSchema = z
  .object({
    id: z.uuid(),
    owner: z
      .object({ instanceId: z.uuid(), projectId: z.uuid(), taskId: z.uuid() })
      .strict(),
    ref: z.string().min(1),
    objectPath: z.string().min(1),
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    outputStats: historyOutputStatsSchema,
    statisticsComplete: z.boolean(),
    kind: z.enum(["command", "subagent"]),
    label: z.string(),
    status: z.enum(["completed", "failed", "canceled", "interrupted"]),
    summary: z.string().optional(),
    childSessionId: z.uuid().optional(),
    visibleSessions: z.array(z.uuid()),
    source: z
      .object({
        taskId: z.uuid(),
        id: z.string().min(1),
        outputRef: z.string().min(1),
        childSessionId: z.uuid().optional(),
      })
      .strict(),
  })
  .strict();

export type OwnedHistoryOutput = z.infer<typeof ownedHistoryOutputSchema>;
export type HistoryOutputStats = z.infer<typeof historyOutputStatsSchema>;
/** 真实宿主已捕获的日志元数据；它不是执行过的Task Work记录。 */
export interface CapturedOutputSource {
  instanceId: string;
  taskId: string;
  kind: OwnedHistoryOutput["kind"];
  outputRef: string;
  outputStats: HistoryOutputStats;
  status: OwnedHistoryOutput["status"];
  childSessionId?: string;
}
export interface CodeUiOutputTarget {
  instanceId: string;
  projectId: string;
  taskId: string;
  childSessionIds: ReadonlyMap<string, string>;
}
export interface CodeUiOutputCopy {
  records: OwnedHistoryOutput[];
  bindings: AgentContextResourceBinding[];
  release(): void;
  discard(): Promise<void>;
}
export interface CodeUiHistoryOutputRead {
  id: string;
  kind: OwnedHistoryOutput["kind"];
  label: string;
  status: OwnedHistoryOutput["status"];
  summary?: string;
  outputRef: string;
  output: ProcessOutput;
  statisticsComplete: boolean;
}
export interface CodeUiOutputHistory {
  readView(
    actor: LocalActor,
    root: CodeUiSessionRecord,
    id: string,
    input: { offset: number; maxBytes: number; tail: boolean },
  ): Promise<{
    id: string;
    kind: OwnedHistoryOutput["kind"];
    status: TaskWorkStatus;
    outputRef: string;
    bytes: Uint8Array;
    offset: number;
    retainedBytes: number;
    totalBytes: number;
    discardedBytes: number;
  } | null>;
  prepare(
    actor: LocalActor,
    sourceRoot: CodeUiSessionRecord,
    target: CodeUiOutputTarget,
    rows: readonly protocol.ConversationRow[],
  ): Promise<CodeUiOutputCopy>;
  read(
    context: TaskWorkContext,
    id: string,
    offset: number,
    maxBytes: number,
  ): Promise<CodeUiHistoryOutputRead | null>;
  manifest(context: TaskWorkContext): Promise<OwnedHistoryOutput[]>;
  purge(
    actor: LocalActor,
    root: CodeUiSessionRecord,
    expectedScopeGeneration: number,
  ): Promise<void>;
}
