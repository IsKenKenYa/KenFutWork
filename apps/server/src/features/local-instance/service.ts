import { resolve } from "node:path";

import type { InstanceContext } from "@kenfutwork/shared";
import type {
  LocalActor,
  LocalInstanceRepository,
  LocalInstanceService,
} from "./types.js";

export class LocalInstanceError extends Error {
  readonly code = "instance_forbidden";
  readonly statusCode = 403;

  constructor() {
    super("调用上下文不属于当前本地实例。");
  }
}

export class LocalInstanceMaintenanceError extends Error {
  readonly code = "instance_draining";
  readonly statusCode = 503;
  constructor() {
    super("本地实例正在准备数据目录迁移，暂不接收新任务。");
  }
}

export function createLocalInstanceService(options: {
  repository: LocalInstanceRepository;
  dataDir: string;
  /** 启动时把已复制的应用路径绑定到可信native数据根，完成前不暴露上下文。 */
  bindRoot?: (instanceId: string, dataDir: string) => Promise<string>;
}): LocalInstanceService {
  let pending: Promise<InstanceContext> | undefined;
  let draining = false;
  let admissions = 0;
  let maintenance: Promise<void> | undefined;
  let maintenanceGeneration = 0;
  const dataDir = resolve(options.dataDir);

  function getContext(): Promise<InstanceContext> {
    pending ??= options.repository
      .ensure()
      .then(async (instanceId) =>
        Object.freeze({
          instanceId,
          dataDir: options.bindRoot
            ? await options.bindRoot(instanceId, dataDir)
            : dataDir,
        }),
      )
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    return pending;
  }

  return {
    getContext,
    isDraining: () => draining,
    activeAdmissionCount: () => admissions,
    beginAdmission() {
      this.assertReady();
      admissions += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        admissions -= 1;
      };
    },
    assertReady() {
      if (draining) {
        throw new LocalInstanceMaintenanceError();
      }
    },
    beginMaintenance(waitUntilIdle) {
      if (maintenance) return maintenance;
      draining = true;
      const generation = ++maintenanceGeneration;
      maintenance = Promise.resolve()
        .then(waitUntilIdle)
        .catch((error: unknown) => {
          if (generation === maintenanceGeneration) {
            draining = false;
            maintenance = undefined;
          }
          throw error;
        });
      return maintenance;
    },
    cancelMaintenance() {
      maintenanceGeneration += 1;
      draining = false;
      maintenance = undefined;
    },
    async resolve(actor) {
      const context = await getContext();
      if (actor.instanceId !== context.instanceId) {
        throw new LocalInstanceError();
      }
      return context;
    },
    async serviceActor(): Promise<LocalActor> {
      const { instanceId } = await getContext();
      return Object.freeze({ instanceId, accessClientId: null });
    },
  };
}
