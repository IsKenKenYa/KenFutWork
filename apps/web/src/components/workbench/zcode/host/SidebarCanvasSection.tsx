import {
  canvasGetResponseSchema,
  canvasListResponseSchema,
} from "@kenfutwork/shared";
import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CANVAS_DOCUMENT_UPDATED_EVENT } from "./canvasDocumentNavigation.js";
import { requestCanvasDocumentOpen } from "./conversationWorkContext.js";
import { surfaceJson } from "./surfaceApi.js";

type CanvasSummary = { id: string; name: string; isPrimary: boolean };

/**
 * 改名：先读回画布拿 revision，再带 expectedName/expectedRevision 提交。
 * 两个守卫都是服务端契约要求的乐观锁——列表里的 name 可能已经不是最新的了。
 */
async function renameCanvas(
  projectId: string,
  canvasId: string,
  expectedName: string,
  nextName: string,
): Promise<void> {
  const current = canvasGetResponseSchema.safeParse(
    await surfaceJson<unknown>(`/api/canvases/${encodeURIComponent(canvasId)}`),
  );
  if (!current.success || current.data.canvas.projectId !== projectId)
    throw new Error("画布信息已变化，请重试");
  const renamed = canvasGetResponseSchema.safeParse(
    await surfaceJson(`/api/canvases/${encodeURIComponent(canvasId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: nextName,
        expectedName,
        expectedRevision: current.data.canvas.revision,
      }),
    }),
  );
  if (!renamed.success || renamed.data.canvas.id !== canvasId)
    throw new Error("画布改名失败，请重试");
}

/** 画布行：点开作为常驻文档标签；hover 出行内重命名。 */
function CanvasRow({
  projectId,
  canvas,
  onRenamed,
}: {
  projectId: string;
  canvas: CanvasSummary;
  onRenamed: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(canvas.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    setDraft(canvas.name);
    setError(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing, canvas.name]);
  const commit = () => {
    const next = draft.trim();
    if (!next || next === canvas.name || saving) {
      setEditing(false);
      return;
    }
    setSaving(true);
    void renameCanvas(projectId, canvas.id, canvas.name, next)
      .then(() => {
        onRenamed(canvas.id, next);
        // 让已打开的画布标签跟着刷新标题与列表（同一份契约，不各拉一次）。
        window.dispatchEvent(
          new CustomEvent(CANVAS_DOCUMENT_UPDATED_EVENT, {
            detail: { projectId, canvasId: canvas.id },
          }),
        );
        setEditing(false);
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "画布改名失败");
      })
      .finally(() => setSaving(false));
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <input
          ref={inputRef}
          aria-label="重命名"
          value={draft}
          disabled={saving}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => !saving && setEditing(false)}
          onKeyDown={(event) => {
            // 中文输入法回车是上屏确认，不是提交改名（与 editable-canvas-name 同一坑）
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              setEditing(false);
            }
          }}
          className="w-full rounded-md border bg-background px-2 py-1 text-ui-base outline-none"
        />
        {error ? (
          <p role="alert" className="text-ui-caption text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="group/row relative flex items-center rounded-lg hover:bg-surface-hover">
      <button
        type="button"
        onClick={() =>
          requestCanvasDocumentOpen({
            projectId,
            documentId: canvas.id,
            title: canvas.name,
          })
        }
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-base text-foreground-subtle transition-colors hover:text-foreground"
      >
        <span className="min-w-0 flex-1 truncate">{canvas.name}</span>
        {canvas.isPrimary ? (
          <span className="shrink-0 text-ui-caption text-foreground-subtle">
            主画布
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`重命名 ${canvas.name}`}
        onClick={() => setEditing(true)}
        className="absolute right-1 hidden rounded p-1 text-foreground-subtle hover:bg-background hover:text-foreground group-hover/row:flex"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}

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
        未打开项目
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
      <p className="px-3 py-2 text-ui-base text-foreground-subtle">暂无画布</p>
    );
  return (
    <ul className="flex flex-col gap-0.5" aria-label="画布">
      {canvases.map((canvas) => (
        <li key={canvas.id}>
          <CanvasRow
            projectId={projectId}
            canvas={canvas}
            onRenamed={(id, name) =>
              setCanvases((items) =>
                items.map((item) => (item.id === id ? { ...item, name } : item)),
              )
            }
          />
        </li>
      ))}
    </ul>
  );
}
