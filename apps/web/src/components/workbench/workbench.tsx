"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { lazy, Suspense, useCallback } from "react";
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
  const mode =
    requested === "design" || requested === "flow" ? requested : "code";
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
