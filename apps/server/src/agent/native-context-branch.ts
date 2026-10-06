import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  BaseCheckpointSaver,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type {
  AgentContextBranchBoundary,
  AgentContextBranchCloneInput,
  AgentContextBranchHistoryCloneInput,
  AgentContextBranchHistoryCloneResult,
  AgentContextBranchService,
  AgentContextBranchTargetInput,
  AgentContextHistoryReference,
} from "./context-history.js";
import {
  decodeNativeContextReference,
  encodeNativeContextReference,
} from "./native-context-reference.js";
import type { AgentPersistenceService } from "./persistence/index.js";

type BranchLease = {
  checkpointer: BaseCheckpointSaver;
  reference: AgentContextHistoryReference | null;
  writeAttempted: boolean;
};
type NativeCheckpointTuple = CheckpointTuple & { metadata: CheckpointMetadata };

function sourceConfig(input: AgentContextBranchCloneInput) {
  if (!input.sourceThreadId.trim() || !input.targetThreadId.trim())
    throw new Error("上下文分支必须指定源thread与全新目标thread。");
  if (input.sourceThreadId === input.targetThreadId)
    throw new Error("上下文分支不能覆盖源thread。");
  if (input.reference === null) return null;
  const decoded = decodeNativeContextReference(input.reference);
  if (decoded.threadId !== input.sourceThreadId)
    throw new Error("上下文引用不属于指定的源thread。");
  // 普通Code Run从root读取；禁止把非root引用克到不可见的namespace。
  if (decoded.namespace !== "")
    throw new Error("上下文分支仅支持root namespace轮次边界。");
  if (!decoded.checkpointId) throw new Error("上下文引用缺少checkpoint身份。");
  return {
    configurable: {
      thread_id: decoded.threadId,
      checkpoint_ns: "",
      checkpoint_id: decoded.checkpointId,
    },
  } satisfies RunnableConfig;
}

function assertSourceConfig(config: RunnableConfig, sourceThreadId: string) {
  const checkpointId = config.configurable?.checkpoint_id;
  if (
    config.configurable?.thread_id !== sourceThreadId ||
    config.configurable?.checkpoint_ns !== "" ||
    typeof checkpointId !== "string" ||
    !checkpointId
  )
    throw new Error("原生上下文祖先引用超出源thread或root namespace。");
  return checkpointId;
}

async function readBranch(
  checkpointer: BaseCheckpointSaver,
  config: RunnableConfig,
  sourceThreadId: string,
) {
  const branch: NativeCheckpointTuple[] = [];
  const visited = new Set<string>();
  let current: RunnableConfig | undefined = config;
  while (current) {
    const checkpointId = assertSourceConfig(current, sourceThreadId);
    if (visited.has(checkpointId))
      throw new Error("原生上下文祖先链存在循环。");
    visited.add(checkpointId);
    const tuple = await checkpointer.getTuple(current);
    if (!tuple) throw new Error("原生上下文checkpoint或祖先不存在。");
    assertSourceConfig(tuple.config, sourceThreadId);
    if (tuple.checkpoint.id !== checkpointId || !tuple.metadata)
      throw new Error("原生上下文checkpoint身份或元数据不完整。");
    branch.push({ ...tuple, metadata: tuple.metadata });
    current = tuple.parentConfig;
  }
  return branch.reverse();
}

async function assertNewTarget(
  checkpointer: BaseCheckpointSaver,
  targetThreadId: string,
) {
  // 一条即可证明占用，是存在性查询而非可调运行批量上限；不限定namespace。
  for await (const _tuple of checkpointer.list(
    { configurable: { thread_id: targetThreadId } },
    { limit: 1 },
  ))
    throw new Error("上下文目标thread已存在，不能覆盖。");
}

function rebaseBoundaries(
  input: AgentContextBranchHistoryCloneInput,
  branch: NativeCheckpointTuple[],
): AgentContextBranchBoundary[] {
  const checkpointIds = new Set(branch.map((tuple) => tuple.checkpoint.id));
  const boundaryIds = new Set<string>();
  return input.boundaries.map((boundary) => {
    if (!boundary.id.trim()) throw new Error("上下文历史边界id不能为空。");
    if (boundaryIds.has(boundary.id))
      throw new Error("上下文历史边界id不能重复。");
    boundaryIds.add(boundary.id);
    if (boundary.reference === null) return { ...boundary };
    const config = sourceConfig({ ...input, reference: boundary.reference });
    if (!config) throw new Error("非空上下文历史边界缺少原生引用。");
    const checkpointId = assertSourceConfig(config, input.sourceThreadId);
    if (!checkpointIds.has(checkpointId))
      throw new Error("上下文历史边界不在所选上下文的祖先链。");
    const reference = encodeNativeContextReference(input.targetThreadId, {
      configurable: {
        thread_id: input.targetThreadId,
        checkpoint_ns: "",
        checkpoint_id: checkpointId,
      },
    });
    if (!reference) throw new Error("上下文历史边界无法重绑定到目标thread。");
    return { id: boundary.id, reference };
  });
}

async function copyPendingWrites(
  checkpointer: BaseCheckpointSaver,
  config: RunnableConfig,
  tuple: CheckpointTuple,
) {
  const writesByTask = new Map<string, PendingWrite[]>();
  for (const [taskId, channel, value] of tuple.pendingWrites ?? []) {
    const writes = writesByTask.get(taskId) ?? [];
    writes.push([channel, value]);
    writesByTask.set(taskId, writes);
  }
  for (const [taskId, writes] of writesByTask)
    await checkpointer.putWrites(config, writes, taskId);
}

async function writeBranch(
  branch: NativeCheckpointTuple[],
  targetThreadId: string,
  lease: BranchLease,
) {
  let config: RunnableConfig = {
    configurable: { thread_id: targetThreadId, checkpoint_ns: "" },
  };
  for (const tuple of branch) {
    lease.writeAttempted = true;
    config = await lease.checkpointer.put(
      config,
      // checkpoint/task IDs仅在thread内寻址；保留它们及全部native通道/对象。
      tuple.checkpoint,
      {
        ...tuple.metadata,
        ...(tuple === branch.at(-1) ? { source: "fork" as const } : {}),
      },
      tuple.checkpoint.channel_versions,
    );
    // DeltaChannel恢复依赖完整parent链及每步writes，不能只复制leaf或消息DTO。
    await copyPendingWrites(lease.checkpointer, config, tuple);
  }
  const reference = encodeNativeContextReference(targetThreadId, config);
  if (!reference || !(await lease.checkpointer.getTuple(config)))
    throw new Error("原生上下文分支持久化后不可读取。");
  return reference;
}

function sameReference(
  actual: AgentContextHistoryReference | null,
  expected: AgentContextHistoryReference | null,
) {
  return actual === null || expected === null
    ? actual === expected
    : actual.adapter === expected.adapter && actual.key === expected.key;
}

/** 默认adapter；消费者独占生成新thread ID，saver公开接口不提供跨进程CAS。 */
export function createNativeContextBranchService(options: {
  agentPersistenceService: Pick<AgentPersistenceService, "getPersistence">;
}): AgentContextBranchService {
  const cloning = new Set<string>();
  const leases = new Map<string, BranchLease>();
  const ownedLease = (input: AgentContextBranchTargetInput) => {
    const lease = leases.get(input.targetThreadId);
    if (
      cloning.has(input.targetThreadId) ||
      !lease ||
      !sameReference(lease.reference, input.reference)
    )
      throw new Error("目标不属于本次尚未发布的上下文分支。");
    return lease;
  };
  const cloneHistory = async (
    input: AgentContextBranchHistoryCloneInput,
  ): Promise<AgentContextBranchHistoryCloneResult> => {
    const source = sourceConfig(input);
    if (cloning.has(input.targetThreadId) || leases.has(input.targetThreadId))
      throw new Error("上下文目标thread正在使用，不能重复克隆。");
    cloning.add(input.targetThreadId);
    let lease: BranchLease | undefined;
    try {
      const persistence =
        await options.agentPersistenceService.getPersistence();
      if (!persistence) throw new Error("原生上下文持久化能力未装配。");
      const branch = source
        ? await readBranch(
            persistence.checkpointer,
            source,
            input.sourceThreadId,
          )
        : [];
      // 全部引用在复制前验证；每个边界只重绑定key，不再次复制其prefix。
      const boundaries = rebaseBoundaries(input, branch);
      await assertNewTarget(persistence.checkpointer, input.targetThreadId);
      lease = {
        checkpointer: persistence.checkpointer,
        reference: null,
        writeAttempted: false,
      };
      leases.set(input.targetThreadId, lease);
      if (source) {
        const reference = await writeBranch(
          branch,
          input.targetThreadId,
          lease,
        );
        lease.reference = { ...reference };
        return { reference, boundaries };
      }
      return { reference: null, boundaries };
    } catch (error) {
      if (lease) {
        try {
          if (lease.writeAttempted)
            await lease.checkpointer.deleteThread(input.targetThreadId);
          leases.delete(input.targetThreadId);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "上下文分支创建失败，私有目标清理也失败。",
          );
        }
      }
      throw error;
    } finally {
      cloning.delete(input.targetThreadId);
    }
  };
  return {
    async clone(input) {
      return (await cloneHistory({ ...input, boundaries: [] })).reference;
    },
    cloneHistory,
    async discard(input) {
      const lease = ownedLease(input);
      cloning.add(input.targetThreadId);
      try {
        if (lease.writeAttempted) {
          const current = await lease.checkpointer.getTuple({
            configurable: {
              thread_id: input.targetThreadId,
              checkpoint_ns: "",
            },
          });
          const reference = current
            ? encodeNativeContextReference(input.targetThreadId, current.config)
            : null;
          if (current && !sameReference(reference, input.reference))
            throw new Error("目标上下文已被继续使用，不能丢弃。");
          await lease.checkpointer.deleteThread(input.targetThreadId);
        }
        leases.delete(input.targetThreadId);
      } finally {
        cloning.delete(input.targetThreadId);
      }
    },
    release(input) {
      ownedLease(input);
      leases.delete(input.targetThreadId);
    },
  };
}
