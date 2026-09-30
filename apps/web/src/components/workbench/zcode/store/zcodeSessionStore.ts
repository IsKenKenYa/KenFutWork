/**
 * zcode 宿主适配 stub：`@/store/zcodeSessionStore` 的最小等价。
 * 来源：references/zcode/packages/ui/src/store/zcodeSessionStore.ts
 *
 * zcode 的会话 store 由 Agent RPC 运行时驱动（任务/草稿/模型切换/导航历史等全套状态与 setter）。
 * 本仓无该运行时，故只提供照搬件实际消费的**读取面**：workspaces 恒空桶，任何 workspace 查询
 * 经 zcodeSessionStoreSelectors 的原版 `getWorkspaceState` 落到默认 workspace 状态（provider、
 * 任务缓存等全为默认值）；全部 setter 为空操作（无数据源可写）。
 * 消费面：v4/activeTaskProvider（当前任务 provider 解析）、hooks/useSlashCommands stub 等。
 * 后续接通 agent 运行时状态源时替换本实现即可，照搬组件零改动。
 * 适配注记：导出签名与原文件一致；读恒默认态、写恒空操作（stub 降级）。
 */
"use client";

import { selectWorkspaceZCodeState } from "@zui/store/zcodeSessionStoreSelectors";
import type { ZCodeSessionStoreState } from "@zui/store/zcodeSessionStoreTypes";
import { getDefaultWorkspaceState } from "@zui/store/zcodeSessionStoreTypes";
import { create } from "zustand";

/** 空操作集合：类型对齐 ZCodeSessionStoreState 的全部 setter；无数据源可写。 */
const noop = () => {};

export const useZCodeSessionStore = create<ZCodeSessionStoreState>()(() => ({
  workspaces: {},
  getWorkspaceState: () => getDefaultWorkspaceState(),
  setActiveTaskId: noop,
  promoteGroupedDraftTask: noop,
  clearPromotedGroupedDraftTask: noop,
  setDraftSessionId: noop,
  invalidateDraftRuntime: noop,
  requestComposerTextInsert: () => 0,
  clearComposerTextInsertRequest: noop,
  requestTimelineBottom: () => 0,
  clearTimelineBottomRequest: noop,
  startDraft: noop,
  clearGroupedDraftTask: noop,
  bindRuntimeProvider: noop,
  setModelSelectionResolution: noop,
  setWorkspaceInitState: noop,
  setWorkspaceInitAttempts: noop,
  setTaskState: noop,
  setTaskRuntimeState: noop,
  setTaskUsage: noop,
  setTaskContextWindow: noop,
  setTaskApiRetryStatus: noop,
  setTaskPermissionRequest: noop,
  removeTaskPermissionRequest: noop,
  setTaskElicitationRequest: noop,
  removeTaskElicitationRequest: noop,
  setTaskElicitationFormDraft: noop,
  removeTaskElicitationFormDraft: noop,
  setTaskError: noop,
  setDraftError: noop,
  startModelSwitch: noop,
  updateModelSwitchStage: noop,
  finishModelSwitch: noop,
  setTaskConfigOptions: noop,
  initializeBackgroundTaskRuntime: noop,
  upsertOptimisticTaskListItem: noop,
  removeOptimisticTaskListItem: noop,
  removeTaskState: noop,
  setConfigOptions: noop,
  setConfigOptionsStatus: noop,
  setSlashCommands: noop,
  setCurrentModeId: noop,
  bumpTaskListVersion: noop,
  setTaskListCache: noop,
  setTaskUnreadIndicator: noop,
  taskNavHistory: { entries: [], cursor: -1 },
  taskNavPushAutomations: noop,
  taskNavPushPluginStore: noop,
  taskNavGoBack: () => null,
  taskNavGoForward: () => null,
  removeTaskFromNavHistory: noop,
}));

/** 选择器与原文件同源（zcodeSessionStoreSelectors）；照搬件从 store 模块面导入。 */
export { selectWorkspaceZCodeState };
