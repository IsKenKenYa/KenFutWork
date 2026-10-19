import { canvasListResponseSchema } from "@kenfutwork/shared";
import { useEffect, useState } from "react";
import { requestCanvasDocumentOpen } from "./conversationWorkContext.js";
import { surfaceJson } from "./surfaceApi.js";

type CanvasSummary = { id: string; name: string; isPrimary: boolean };

/**
 * Design 侧栏「画布」页：列出当前项目的画布文档，点开即作为常驻文档标签打开。
 * 与画布标签内的切换器共用同一契约（`/api/projects/<id>/canvases`），不另立数据源。
 */
export function SidebarCanvasSection({
  projectId,
}: {
  projectId: string | null;
}) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!projectId) {
      setCanvases([]);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    void (async () => {
      try {
        const parsed = canvasListResponseSchema.safeParse(
          await surfaceJson<unknown>(
            `/api/projects/${encodeURIComponent(projectId)}/canvases`,
          ),
        );
        if (!parsed.success)
          throw new Error("画布列表不可用，请重新打开项目。");
        if (!current) return;
        setCanvases(parsed.data.canvases as CanvasSummary[]);
        setError(null);
      } catch (failure) {
        if (!current) return;
        setError(
          failure instanceof Error ? failure.message : "画布列表读取失败。",
        );
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [projectId]);
  if (!projectId)
    return (
      <p className="px-3 py-2 text-ui-base text-foreground-subtle">
        没有打开的项目。
      </p>
    );
  if (error)
    return (
      <p role="alert" className="px-3 py-2 text-ui-base text-destructive">
        {error}
      </p>
    );
  if (loading && canvases.length === 0)
    return (
      <p className="px-3 py-2 text-ui-base text-foreground-subtle">加载中</p>
    );
  if (canvases.length === 0)
    return (
      <p className="px-3 py-2 text-ui-base text-foreground-subtle">
        还没有画布。
      </p>
    );
  return (
    <ul className="flex flex-col gap-0.5" aria-label="画布">
      {canvases.map((canvas) => (
        <li key={canvas.id}>
          <button
            type="button"
            onClick={() =>
              requestCanvasDocumentOpen({
                projectId,
                documentId: canvas.id,
                title: canvas.name,
              })
            }
            className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-base text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <span className="min-w-0 flex-1 truncate">{canvas.name}</span>
            {canvas.isPrimary ? (
              <span className="shrink-0 text-ui-caption text-foreground-subtle">
                主画布
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
