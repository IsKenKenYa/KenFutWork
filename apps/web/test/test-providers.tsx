"use client";

import type { ReactNode } from "react";

import { ToastProvider } from "../src/components/toast";

/**
 * 测试用「应用外壳」：把被测组件包在**全局 provider** 里。
 *
 * 为什么需要：右栏面板的动作结果（如「打开调试工具」）走全站 toast，`useToast()` 在
 * provider 外会直接抛——测试若不包就会以「useToast must be used within a ToastProvider」
 * 失败，看起来像组件坏了（真机踩到过三次，故收敛到这一处）。
 */
export function withAppProviders(node: ReactNode): ReactNode {
  return <ToastProvider>{node}</ToastProvider>;
}
