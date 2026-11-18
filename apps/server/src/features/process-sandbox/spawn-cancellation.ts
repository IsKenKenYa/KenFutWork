import { processInvocationFingerprint } from "./invocation-identity.js";
import type { HelperRequest } from "./protocol.js";
import type { ManagedProcessSnapshot, ProcessSpawnRequest } from "./types.js";
import { ProcessSandboxError } from "./types.js";

type SpawnRpc =
  | Omit<Extract<HelperRequest, { method: "spawn" }>, "id">
  | Omit<Extract<HelperRequest, { method: "cancelspawn" }>, "id">;
interface SpawnConnection {
  rpc(input: SpawnRpc): Promise<unknown>;
}

/** 只用于派发前等待；取消某个调用不取消同 Task 共享的初始化/权限证明。 */
export async function waitForSpawnAdmission<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function cancellationReceipt(
  value: unknown,
  request: ProcessSpawnRequest,
): ManagedProcessSnapshot | null {
  if (value === null) return null;
  const snapshot = value as ManagedProcessSnapshot | undefined;
  if (
    !snapshot ||
    typeof snapshot.id !== "string" ||
    snapshot.ownerTaskId !== request.scope.taskId ||
    snapshot.generation !== request.scope.generation ||
    snapshot.agentId !== request.agentId ||
    snapshot.invocationId !== request.invocationId ||
    !snapshot.finishedAt ||
    snapshot.exit?.rangeEmpty !== true
  )
    throw new ProcessSandboxError("stop_unconfirmed", "命令取消尚未确认退出。");
  return snapshot;
}

async function requestCancellation(
  connection: SpawnConnection,
  request: ProcessSpawnRequest,
  roots: readonly string[],
): Promise<ManagedProcessSnapshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const receipt = await Promise.race([
      connection.rpc({
        method: "cancelspawn",
        taskId: request.scope.taskId,
        generation: request.scope.generation,
        invocationId: request.invocationId,
        fingerprint: processInvocationFingerprint(request, roots),
        reason: "spawn_cancelled",
      }),
      new Promise<never>((_, reject) => {
        // 停止含冻结、TERM/CONT、再次冻结和KILL；ACK超时只保留未知，不当成已退出。
        timer = setTimeout(
          () => reject(new Error("取消回执超时。")),
          request.limits.killGraceMs * 8,
        );
      }),
    ]);
    return cancellationReceipt(receipt, request);
  } catch (error) {
    throw new ProcessSandboxError(
      "stop_unconfirmed",
      "命令取消尚未得到停止确认。",
      { cause: error },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 派发之后不能仅 race 一个 AbortError：先取得匹配调用的取消/清空回执。 */
export async function spawnWithCancellation(
  connection: SpawnConnection,
  request: ProcessSpawnRequest,
  internalWriteRoots: readonly string[],
  signal: AbortSignal | undefined,
  confirmed: (snapshot: ManagedProcessSnapshot | null) => void,
): Promise<ManagedProcessSnapshot> {
  signal?.throwIfAborted();
  const launching = connection.rpc({
    method: "spawn",
    request,
    internalWriteRoots,
  });
  if (!signal) return (await launching) as ManagedProcessSnapshot;
  let rejectCancelled!: (error: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  let cancellation: Promise<never> | undefined;
  const abort = () => {
    if (cancellation) return;
    cancellation = (async () => {
      const receipt = await requestCancellation(
        connection,
        request,
        internalWriteRoots,
      );
      confirmed(receipt);
      throw signal.reason;
    })();
    void cancellation.catch(rejectCancelled);
  };
  // 原 spawn RPC 已同步送入同一连接；取消不能先于它签发，更不能另找新连接。
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const snapshot = await Promise.race([launching, cancelled]);
    if (signal.aborted) {
      abort();
      await cancellation;
    }
    return snapshot as ManagedProcessSnapshot;
  } catch (error) {
    if (cancellation) return await cancellation;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
