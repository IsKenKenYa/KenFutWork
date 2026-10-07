"use client";

import { useCallback, useState } from "react";

import { useToast } from "@/components/toast";
import { getServerBaseUrl } from "@/lib/env";

export type FlowEngineInstallState = "idle" | "installing" | "ready" | "error";

/**
 * 引擎栈托管安装（FORM-11）：侧栏快捷按钮与「引擎」信息页**共用同一份**——
 * POST 安装 → 轮询到 ready / error / 超时；toast 与状态都在这里管，两个入口行为一致
 * （从哪边点安装，两边的状态都跟着走）。
 */
export function useFlowEngineInstall(accessToken: string | null | undefined): {
  state: FlowEngineInstallState;
  install: () => Promise<void>;
} {
  const { toast } = useToast();
  const [state, setState] = useState<FlowEngineInstallState>("idle");

  const install = useCallback(async () => {
    const token = accessToken;
    if (!token || state === "installing") return;
    setState("installing");
    try {
      const base = getServerBaseUrl();
      const start = await fetch(`${base}/api/flow/host/engine/install`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!start.ok && start.status !== 409) {
        throw new Error(
          (await start.json().catch(() => ({})))?.error?.message ??
            `HTTP ${start.status}`,
        );
      }
      // 轮询安装状态（拉镜像分钟级；上限 30 分钟防挂死）
      const deadline = Date.now() + 30 * 60 * 1000;
      let snapshot: { state: string; error?: string } = { state: "installing" };
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const response = await fetch(
          `${base}/api/flow/host/engine/install/status`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!response.ok) continue;
        snapshot = (await response.json()) as {
          state: string;
          error?: string;
        };
        if (snapshot.state === "ready" || snapshot.state === "error") break;
      }
      if (snapshot.state === "ready") {
        toast("引擎栈已就绪（Dify 无头栈运行中）");
        setState("ready");
      } else if (snapshot.state === "error") {
        toast(`引擎栈安装失败：${snapshot.error ?? "详见服务端日志"}`, "error");
        setState("error");
      } else {
        toast("引擎栈安装超时，请稍后重试或查看服务端日志", "error");
        setState("error");
      }
    } catch (error) {
      toast(
        `引擎栈安装失败：${
          error instanceof Error ? error.message : "未知错误"
        }`,
        "error",
      );
      setState("error");
    }
  }, [accessToken, state, toast]);

  return { state, install };
}
