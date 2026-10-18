import type { InstalledPlugin } from "@kenfutwork/shared";

/** 仅由可信宿主插件注册；市场 bundle 的 CompatContext 不暴露此能力。 */
export const PLUGIN_STATE_LIFECYCLE_CAPABILITY = "plugin-state-lifecycle";

export type PluginStateRevocationReason =
  | "disable"
  | "uninstall"
  | "replace"
  | "shutdown";

export interface PluginStateRevokingEvent {
  readonly reason: PluginStateRevocationReason;
  readonly previous: Readonly<InstalledPlugin>;
  /** shutdown 不删除安装记录，因此 current 与 previous 相同。 */
  readonly current: Readonly<InstalledPlugin> | null;
}

export interface PluginStateChangedEvent {
  readonly reason:
    | PluginStateRevocationReason
    | "install"
    | "enable"
    | "restore";
  readonly previous: Readonly<InstalledPlugin> | null;
  readonly current: Readonly<InstalledPlugin> | null;
}

export interface PluginStateLifecycle {
  /** 同步夹紧准入，再等待在途资源退出；失败阻止后续卸载与状态写入。 */
  onStateRevoking?(event: PluginStateRevokingEvent): void | Promise<void>;
  /** 状态已提交；消费方以本次激活生成自己的 epoch，不依赖 installedAt。 */
  afterStateChanged?(event: PluginStateChangedEvent): void;
}
