"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { lazy, Suspense, useCallback, useState } from "react";
import { useFlowHostEntry } from "@/hooks/use-flow-host";
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
  const { entry: flowEntry } = useFlowHostEntry(requested === "flow");
  const mode =
    requested === "design"
      ? "design"
      : requested === "flow" && flowEntry?.available
        ? "flow"
        : "code";
  const pendingFlow = requested === "flow" && flowEntry === null;
  const [visited, setVisited] = useState<WorkbenchMode[]>([]);
  if (!pendingFlow && !visited.includes(mode)) setVisited([...visited, mode]);
  const navigate = useCallback(
    (next: WorkbenchMode) => {
      router.replace(
        next === "code" ? "/workbench" : `/workbench?mode=${next}`,
      );
    },
    [router],
  );
  return (
    <>
      {visited.map((workspaceMode) => (
        <div
          key={workspaceMode}
          data-workbench-mode={workspaceMode}
          hidden={pendingFlow || mode !== workspaceMode}
          inert={pendingFlow || mode !== workspaceMode}
          aria-hidden={pendingFlow || mode !== workspaceMode}
        >
          {workspaceMode === "code" ? (
            <CodeWorkbenchFrame
              active={!pendingFlow && mode === workspaceMode}
              onModeChange={navigate}
            />
          ) : (
            <CanvasWorkbench
              mode={workspaceMode}
              active={!pendingFlow && mode === workspaceMode}
              onModeChange={navigate}
            />
          )}
        </div>
      ))}
      {pendingFlow ? <div role="status">加载中</div> : null}
    </>
  );
}

/** 已访问文档持续挂载，模式导航只改变活动面，不结束Task或画布运行。 */
export function Workbench() {
  return (
    <Suspense>
      <WorkbenchModeSurface />
    </Suspense>
  );
}
