"use client";

import { FolderOpen, Layers, X } from "lucide-react";
import { useState } from "react";
import {
  CanvasFilesPanel,
  type CanvasFilesPanelProps,
} from "./canvas-files-panel";
import { CanvasLayersPanel } from "./canvas-layers-panel";

/** 画布自己的图层与素材控件；与会话状态无关。 */
export function CanvasInspector(props: Omit<CanvasFilesPanelProps, "active">) {
  const [tab, setTab] = useState<"layers" | "files" | null>(null);
  return (
    <>
      <div className="absolute top-3 right-3 z-20 flex gap-1 rounded-lg border border-border bg-card p-1 shadow-sm">
        <button
          type="button"
          aria-label="图层"
          aria-pressed={tab === "layers"}
          aria-controls="canvas-inspector"
          className="rounded-md p-1.5 hover:bg-muted aria-pressed:bg-muted"
          onClick={() =>
            setTab((current) => (current === "layers" ? null : "layers"))
          }
        >
          <Layers className="size-4" />
        </button>
        <button
          type="button"
          aria-label="素材"
          aria-pressed={tab === "files"}
          aria-controls="canvas-inspector"
          className="rounded-md p-1.5 hover:bg-muted aria-pressed:bg-muted"
          onClick={() =>
            setTab((current) => (current === "files" ? null : "files"))
          }
        >
          <FolderOpen className="size-4" />
        </button>
        {tab && (
          <button
            type="button"
            aria-label="收起"
            className="rounded-md p-1.5 hover:bg-muted"
            onClick={() => setTab(null)}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <aside
        id="canvas-inspector"
        aria-label={tab === "layers" ? "图层" : "素材"}
        hidden={tab === null}
        inert={tab === null}
        className="absolute inset-y-0 right-0 z-10 flex w-72 max-w-[80vw] flex-col border-l border-border bg-card pt-14 shadow-sm [&[hidden]]:hidden"
      >
        <div
          hidden={tab !== "layers"}
          inert={tab !== "layers"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
        >
          <CanvasLayersPanel
            excalidrawApi={props.excalidrawApi}
            active={tab === "layers"}
          />
        </div>
        <div
          hidden={tab !== "files"}
          inert={tab !== "files"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
        >
          <CanvasFilesPanel {...props} active={tab === "files"} />
        </div>
      </aside>
    </>
  );
}
