"use client";

import { useCallback, useState } from "react";

import { getServerBaseUrl } from "@/lib/env";

export type FlowEngineInstallState = "idle" | "installing" | "ready" | "error";

/**
 * 引擎栈托管安装（FORM-11）：「引擎」信息页与侧栏共用同一份——
 * POST 安装 → 轮询到 ready / error / 超时。
 *
 * 鉴权走本机接入（cookie 会话，`credentials: "include"`）——与 CanvasWorkbench 其余
 * 数据面同一口径（合并后的 localAccess 模型），不用 Bearer 令牌。
 *
 * 不弹 toast：CanvasWorkbench 的树里没有 ToastProvider（也不该为一个安装动作给整树
 * 加 Provider）；失败/超时原因经 `notice` 返回，由「引擎」页内联展示（状态胶囊就在旁边）。
 */
export function useFlowEngineInstall(): {
  state: FlowEngineInstallState;
  /** 失败 / 超时的可读原因；成功与进行中为 null。 */
  notice: string | null;
  install: () => Promise<void>;
} {
  const [state, setState] = useState<FlowEngineInstallState>("idle");
  const [notice, setNotice] = useState<string | null>(null);

  const install = useCallback(async () => {
    if (state === "installing") return;
    setState("installing");
    setNotice(null);
    try {
      const base = getServerBaseUrl();
      const start = await fetch(`${base}/api/flow/host/engine/install`, {
        method: "POST",
        credentials: "include",
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
          { credentials: "include" },
        );
        if (!response.ok) continue;
        snapshot = (await response.json()) as {
          state: string;
          error?: string;
        };
        if (snapshot.state === "ready" || snapshot.state === "error") break;
      }
      if (snapshot.state === "ready") {
        setState("ready");
      } else if (snapshot.state === "error") {
        setNotice(`安装失败：${snapshot.error ?? "详见服务端日志"}`);
        setState("error");
      } else {
        setNotice("安装超时，请稍后重试或查看服务端日志");
        setState("error");
      }
    } catch (error) {
      setNotice(
        `安装失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
      setState("error");
    }
  }, [state]);

  return { state, notice, install };
}
