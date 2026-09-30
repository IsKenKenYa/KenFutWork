/**
 * zcode 移植层宿主适配：`@/store/StoreProvider` 的最小等价。
 * 来源：references/zcode/packages/ui/src/store/StoreProvider.tsx
 *
 * zcode 的全局 zustand store 承载 theme/codePreviewSettings 等偏好。我们照搬组件
 * 只经 `useZCodeStoreWithDefault` 容错读取（无 Provider 时回退 defaultValue），
 * 故这里不建真实 store：永远走 defaultValue 分支。
 * theme / codePreviewSettings 由宿主组件（workbench 装配处）以 props 注入。
 * 适配注记：P2 追加 `interfaceMode` 占位字段——照搬件 hooks/useInterfaceMode.ts 的
 * selector 触及 `state.interfaceMode`；本仓恒非 office 模式，仍恒走 defaultValue=false。
 */
"use client";

import { createContext, type ReactNode, useContext } from "react";

/** zcode ZCodeState 的最小占位：照搬组件 selector 可能触及的字段在此登记。 */
export interface ZCodeStatePlaceholder {
  /** 占位：真实偏好经 props 注入，不经 store。 */
  readonly __placeholder?: never;
  /**
   * 占位：zcode ZCodeState.interfaceMode（"office" | 其他）；宿主恒非 office，
   * useInterfaceMode 的 selector 触及此字段，恒走 defaultValue=false 分支。
   */
  readonly interfaceMode?: string;
}

export type ZCodeStorePlaceholder = {
  getState(): ZCodeStatePlaceholder;
  subscribe(onStoreChange: () => void): () => void;
};

const StoreContext = createContext<ZCodeStorePlaceholder | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  return <StoreContext.Provider value={null}>{children}</StoreContext.Provider>;
}

/**
 * 与 zcode 同签名；无真实 store，selector 不可达——调用即说明宿主该走 WithDefault。
 */
export function useZCodeStore<T>(
  _selector: (state: ZCodeStatePlaceholder) => T,
): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useZCodeStore 必须在 StoreProvider 内使用");
  }
  return _selector(store.getState());
}

/**
 * 带默认值的容错版：无 Provider / 无真实 store 时恒返回 defaultValue（引用稳定）。
 */
export function useZCodeStoreWithDefault<T>(
  _selector: (state: ZCodeStatePlaceholder) => T,
  defaultValue: T,
): T {
  return defaultValue;
}
