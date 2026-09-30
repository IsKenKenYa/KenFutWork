/**
 * zcode 照搬：`@/store/zcodeSessionStoreNavigation.ts`（references/zcode/packages/ui/src/store/zcodeSessionStoreNavigation.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
/**
 * ZCode Session Store 导航切片 —— 任务前进/后退历史管理
 *
 * 从 zcodeSessionStore.ts 拆分出来，封装所有任务导航相关的初始状态和 action。
 * 通过 createNavigationSlice(set, get) 返回可直接展开到 store 的对象。
 */
import {
  type AutomationsNavigationTab,
  createTaskNavigationHistory,
  goBack as navGoBack,
  goForward as navGoForward,
  pushAutomationsNavEntry,
  pushPluginStoreNavEntry,
  removeTaskFromHistory,
  type WorkspaceNavEntry,
} from "@zui/lib/taskNavigationHistory";
import type { ZCodeSessionStoreState } from "@zui/store/zcodeSessionStoreTypes";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((
        state: ZCodeSessionStoreState,
      ) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;
type GetFn = () => ZCodeSessionStoreState;

/**
 * 创建导航切片，供 store creator 展开使用：
 * `...createNavigationSlice(set, get)`
 */
export function createNavigationSlice(set: SetFn, get: GetFn) {
  return {
    taskNavHistory: createTaskNavigationHistory(),

    taskNavPushAutomations: (
      workspacePath: string,
      workspaceIdentity?: string,
      automationId?: string,
      automationTab?: AutomationsNavigationTab,
    ) => {
      set((state) => ({
        taskNavHistory: pushAutomationsNavEntry(
          state.taskNavHistory,
          workspacePath,
          workspaceIdentity,
          automationId,
          automationTab,
        ),
      }));
    },

    taskNavPushPluginStore: (
      workspacePath: string,
      workspaceIdentity?: string,
    ) => {
      set((state) => ({
        taskNavHistory: pushPluginStoreNavEntry(
          state.taskNavHistory,
          workspacePath,
          workspaceIdentity,
        ),
      }));
    },

    taskNavGoBack: (): WorkspaceNavEntry | null => {
      const state = get();
      const result = navGoBack(state.taskNavHistory);
      if (!result) {
        return null;
      }

      set({ taskNavHistory: result.history });
      return result.entry;
    },

    taskNavGoForward: (): WorkspaceNavEntry | null => {
      const state = get();
      const result = navGoForward(state.taskNavHistory);
      if (!result) {
        return null;
      }

      set({ taskNavHistory: result.history });
      return result.entry;
    },

    removeTaskFromNavHistory: (taskId: string) => {
      set((state) => ({
        taskNavHistory: removeTaskFromHistory(state.taskNavHistory, taskId),
      }));
    },
  };
}
