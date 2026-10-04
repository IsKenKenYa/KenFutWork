import type { InstanceContext } from "@kenfutwork/shared";

export type { InstanceContext } from "@kenfutwork/shared";

/** 稳定实例归属与接入客户端分开；后台服务没有接入客户端。 */
export type LocalActor = Readonly<{
  instanceId: string;
  accessClientId: string | null;
}>;

export interface LocalInstanceRepository {
  ensure(): Promise<string>;
}

export interface LocalInstanceService {
  getContext(): Promise<InstanceContext>;
  resolve(actor: LocalActor): Promise<InstanceContext>;
  serviceActor(): Promise<LocalActor>;
  isDraining(): boolean;
  assertReady(): void;
  /** 同步认领新工作准入；必须在它持久化或交给运行表后释放。 */
  beginAdmission(): () => void;
  activeAdmissionCount(): number;
  beginMaintenance(waitUntilIdle: () => Promise<void>): Promise<void>;
  cancelMaintenance(): void;
}
