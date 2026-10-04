"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { lazy, Suspense, useCallback } from "react";
import { useFlowHostEntry } from "@/hooks/use-flow-host";
import { useAuth } from "@/lib/auth-context";
import type { WorkbenchMode } from "@/lib/workbench-surface";
import { CodeWorkbenchFrame } from "./code-workbench-frame";

const CanvasWorkbench = lazy(() =>
  import("./canvas-workbench").then((module) => ({
    default: module.CanvasWorkbench,
  })),
);

function WorkbenchModeSurface() {
  const search = useSearchParams();
  const router = useRouter();
  const requested = search.get("mode");
  const { session } = useAuth();
  const { entry: flowEntry } = useFlowHostEntry(
    requested === "flow" ? (session?.access_token ?? null) : null,
  );
  const mode =
    requested === "design"
      ? "design"
      : requested === "flow" && flowEntry?.available
        ? "flow"
        : "code";
  const navigate = useCallback(
    (next: WorkbenchMode) => {
      router.replace(
        next === "code" ? "/workbench" : `/workbench?mode=${next}`,
      );
    },
    [router],
  );
  return mode === "code" ? (
    <CodeWorkbenchFrame onModeChange={navigate} />
  ) : (
    <CanvasWorkbench mode={mode} onModeChange={navigate} />
  );
}

/** Code 的原文档与画布工作台按客户端导航分别挂载。 */
export function Workbench() {
  return (
    <Suspense>
      <WorkbenchModeSurface />
    </Suspense>
  );
}
