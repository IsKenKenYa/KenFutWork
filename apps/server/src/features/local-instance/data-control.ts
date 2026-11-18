import type {
  LocalAccessRequest,
  LocalAccessService,
} from "../local-access/types.js";
import { validateDataLocationMove } from "./data-location.js";
import type { LocalActor, LocalInstanceService } from "./types.js";

/** 宿主生命周期桥：仅拥有本机API/worker/数据库生命周期的进程可注册。 */
export interface DataLocationBridge {
  canMove: boolean;
  waitUntilIdle(): Promise<void>;
  /** HTTP响应已发送；生产宿主应在成功或失败后分别以0/1退出进程。 */
  shutdown(): Promise<void>;
}

export class DataLocationControlError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "forbidden"
      | "invalid_input"
      | "service_unavailable",
    message: string,
    readonly statusCode: 400 | 401 | 403 | 503,
  ) {
    super(message);
    this.name = "DataLocationControlError";
  }
}

const bridges = new WeakMap<LocalInstanceService, DataLocationBridge>();

/** 沿现有localInstance能力绑定宿主，不增加第二个内核服务key。 */
export function registerDataLocationControl(
  instance: LocalInstanceService,
  bridge: DataLocationBridge,
): () => void {
  if (bridges.has(instance))
    throw new Error("本机数据目录生命周期桥已经注册。");
  bridges.set(instance, bridge);
  return () => {
    if (bridges.get(instance) === bridge) {
      instance.cancelMaintenance();
      bridges.delete(instance);
    }
  };
}

export interface DataLocationController {
  describe(actor: LocalActor): Promise<{ dataDir: string; canMove: boolean }>;
  prepare(
    request: LocalAccessRequest,
    input: { dataDir: string },
    signal?: AbortSignal,
  ): Promise<{ ready: true }>;
  /** 验证并占用一次停机；返回回调交给HTTP响应finish之后执行。 */
  armShutdown(request: LocalAccessRequest): Promise<() => Promise<void>>;
  cancelPreparation(): void;
}

function unavailable(message: string): DataLocationControlError {
  return new DataLocationControlError("service_unavailable", message, 503);
}

function awaitOrAbort(
  promise: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(unavailable("数据目录迁移准备已取消。"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable("数据目录迁移准备已取消。"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createDataLocationController(options: {
  localInstance: LocalInstanceService;
  localAccess: Pick<LocalAccessService, "authenticate" | "listClients">;
  pointerFile: string;
}): DataLocationController {
  const instance = options.localInstance;
  let generation = 0;
  let preparation:
    | {
        target: string;
        generation: number;
        ready: boolean;
        promise: Promise<void>;
        bridge: DataLocationBridge;
      }
    | undefined;
  let shutdownArmed = false;

  const requireDesktop = async (
    request: LocalAccessRequest,
  ): Promise<LocalActor> => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor)
      throw new DataLocationControlError(
        "unauthorized",
        "本机连接凭据缺失或已失效。",
        401,
      );
    await instance.resolve(actor);
    const clients = await options.localAccess.listClients(request);
    if (
      !clients.some(
        (client) =>
          client.id === actor.accessClientId && client.kind === "desktop",
      )
    ) {
      throw new DataLocationControlError(
        "forbidden",
        "数据目录生命周期只能由桌面宿主控制。",
        403,
      );
    }
    return actor;
  };

  const managedBridge = (): DataLocationBridge => {
    const bridge = bridges.get(instance);
    if (!bridge)
      throw unavailable("桌面生命周期桥尚未就绪，不能停库移动数据。");
    if (!bridge.canMove)
      throw new DataLocationControlError(
        "forbidden",
        "当前数据库由外部进程管理，不能通过此实例移动。",
        403,
      );
    return bridge;
  };

  const cancelPreparation = () => {
    generation += 1;
    preparation = undefined;
    shutdownArmed = false;
    instance.cancelMaintenance();
  };

  return {
    cancelPreparation,
    async describe(actor) {
      const context = await instance.resolve(actor);
      return {
        dataDir: context.dataDir,
        canMove: bridges.get(instance)?.canMove === true,
      };
    },
    async prepare(request, input, signal) {
      await requireDesktop(request);
      const bridge = managedBridge();
      const context = await instance.getContext();
      let target: string;
      try {
        target = (
          await validateDataLocationMove({
            source: context.dataDir,
            target: input.dataDir,
            pointerFile: options.pointerFile,
          })
        ).target;
      } catch {
        throw new DataLocationControlError(
          "invalid_input",
          "目标目录必须是当前数据根之外的绝对空目录，且不得包含系统配置指针。",
          400,
        );
      }
      if (signal?.aborted) throw unavailable("数据目录迁移准备已取消。");
      if (shutdownArmed || (preparation && preparation.target !== target)) {
        throw unavailable("另一个数据目录迁移操作正在进行。");
      }
      if (!preparation) {
        instance.assertReady();
        const current = {
          target,
          generation: ++generation,
          ready: false,
          promise: instance.beginMaintenance(() => bridge.waitUntilIdle()),
          bridge,
        };
        preparation = current;
        current.promise = current.promise
          .then(() => {
            if (
              preparation !== current ||
              !instance.isDraining() ||
              bridges.get(instance) !== bridge
            ) {
              throw unavailable("数据目录迁移准备已取消或宿主已关闭。");
            }
            current.ready = true;
          })
          .catch((error: unknown) => {
            if (preparation === current) cancelPreparation();
            throw error;
          });
      }
      const current = preparation;
      try {
        await awaitOrAbort(current.promise, signal);
        await requireDesktop(request); // 等待期间撤权不能留下可执行停机授权。
        if (preparation !== current || !instance.isDraining() || !current.ready)
          throw unavailable("数据目录迁移准备已取消。");
        return { ready: true };
      } catch (error) {
        if (preparation === current) cancelPreparation();
        throw error;
      }
    },
    async armShutdown(request) {
      await requireDesktop(request);
      const bridge = managedBridge();
      const current = preparation;
      if (
        !current?.ready ||
        !instance.isDraining() ||
        current.bridge !== bridge ||
        shutdownArmed
      ) {
        throw unavailable(
          "请先完成数据目录迁移准备，等待在途工作结束后再停机。",
        );
      }
      shutdownArmed = true;
      return async () => {
        try {
          if (
            preparation !== current ||
            current.generation !== generation ||
            !instance.isDraining()
          )
            throw unavailable("停机准备已取消。");
          await bridge.shutdown();
        } catch (error) {
          if (preparation === current) cancelPreparation();
          throw error;
        }
      };
    },
  };
}
