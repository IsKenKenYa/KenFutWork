"use client";

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import {
  Copy,
  Download,
  ImagePlus,
  Maximize2,
  Menu,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCreateProject } from "@/hooks/use-create-project";
import {
  createExcalidrawImageElement,
  getViewportCenter,
  scaleToFit,
} from "@/lib/canvas-elements";
import { deleteProject } from "@/lib/server-api";

interface CanvasLogoMenuProps {
  accessToken: string;
  projectId: string;
  canvasId: string;
  /** 项目名——导出画布时用作文件名（缺省回落到 canvas）。 */
  projectName?: string | undefined;
  excalidrawApi: ExcalidrawImperativeAPI | null;
}

function dispatchKeyToExcalidraw(
  key: string,
  opts: { metaKey?: boolean; shiftKey?: boolean } = {},
) {
  const el = document.querySelector(".excalidraw-container");
  if (!el) return;
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: `Key${key.toUpperCase()}`,
      metaKey: opts.metaKey ?? false,
      ctrlKey: opts.metaKey ?? false,
      shiftKey: opts.shiftKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function generateFileId(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

export function CanvasLogoMenu({
  accessToken,
  projectId,
  projectName,
  excalidrawApi,
}: CanvasLogoMenuProps) {
  const { error: toastError } = useToast();
  const { create: createNewProject } = useCreateProject();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const handleDuplicateElements = useCallback(() => {
    if (!excalidrawApi) return;
    const appState = excalidrawApi.getAppState();
    const selectedIds: Record<string, boolean> =
      appState.selectedElementIds ?? {};
    const allElements = excalidrawApi.getSceneElements();
    const selected = allElements.filter(
      (el) => selectedIds[el.id] && !el.isDeleted,
    );

    if (!selected.length) return;

    const OFFSET = 10;
    const newSelectedIds: Record<string, true> = {};
    const clones = selected.map((el) => {
      const newId = generateFileId();
      newSelectedIds[newId] = true;
      return { ...el, id: newId, x: el.x + OFFSET, y: el.y + OFFSET };
    });

    excalidrawApi.updateScene({
      // 克隆体由原场景元素展开而来，仍是同一批元素类型，故按元素类型收窄。
      elements: [...allElements, ...clones] as ExcalidrawElement[],
      appState: { selectedElementIds: newSelectedIds },
      captureUpdate: "IMMEDIATELY",
    });
  }, [excalidrawApi]);

  /**
   * 导出画布：用 Excalidraw 官方的 `serializeAsJSON` 产出 **.excalidraw 原生文件**
   * （就是本项目画布组件的存储格式：type/version/source/elements/appState/files），
   * 下载到本地后可以直接拖回 Excalidraw / 本画布继续编辑。
   *
   * 注意与「保存画布」的区别：保存是写服务端数据库（Ctrl+S），导出是落一个可带走、
   * 可再导入的文件——用户要的「保存成 ex 啥的文件」说的是后者。
   */
  const handleExportCanvas = useCallback(async () => {
    if (!excalidrawApi) return;
    try {
      const { serializeAsJSON } = await import("@excalidraw/excalidraw");
      const json = serializeAsJSON(
        excalidrawApi.getSceneElements(),
        excalidrawApi.getAppState(),
        excalidrawApi.getFiles(),
        "local",
      );
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${projectName || "canvas"}.excalidraw`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("Export canvas failed:", err);
      toastError("导出画布失败");
    }
  }, [excalidrawApi, projectName, toastError]);

  const handleDeleteProject = useCallback(async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    try {
      await deleteProject(accessToken, projectId);
      if (window.parent !== window) {
        // 嵌入工作台 iframe：回传宿主清选中并刷新项目列表
        window.parent.postMessage(
          { type: "workbench:project-deleted", projectId },
          window.location.origin,
        );
      } else {
        window.location.replace("/workbench");
      }
    } catch (err) {
      console.warn("Failed to delete project:", err);
      toastError("项目删除失败");
    } finally {
      setConfirmingDelete(false);
    }
  }, [accessToken, projectId, confirmingDelete, toastError]);

  const handleFileImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !excalidrawApi) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataURL = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const fileId = generateFileId();

          excalidrawApi.addFiles([
            {
              // id/dataURL/mimeType 在 Excalidraw 类型里是品牌字符串，这里的数据源是
              // 本地文件与 FileReader 产物，故在边界处断言。
              id: fileId as BinaryFileData["id"],
              dataURL: dataURL as BinaryFileData["dataURL"],
              mimeType: (file.type ||
                "image/png") as BinaryFileData["mimeType"],
              created: Date.now(),
            },
          ]);

          const scaled = scaleToFit(img.width, img.height, 600);
          const center = getViewportCenter(excalidrawApi.getAppState());
          const x = center.x - scaled.width / 2;
          const y = center.y - scaled.height / 2;

          const element = createExcalidrawImageElement({
            fileId,
            x,
            y,
            width: scaled.width,
            height: scaled.height,
            title: file.name,
          });

          excalidrawApi.updateScene({
            // lib 生成器产出的是不透明记录（服务端契约口径），入场景时按官方元素类型收窄
            elements: [
              ...excalidrawApi.getSceneElements(),
              element as unknown as ExcalidrawElement,
            ],
            captureUpdate: "IMMEDIATELY",
          });
        };
        img.src = dataURL;
      };
      reader.readAsDataURL(file);

      // Reset input so the same file can be selected again
      e.target.value = "";
    },
    [excalidrawApi],
  );

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setConfirmingDelete(false);
        }}
      >
        <DropdownMenuTrigger
          className="flex items-center justify-center size-8 rounded-xl bg-card shadow-sm border border-border hover:bg-card transition-colors cursor-pointer outline-none"
          aria-label="菜单"
        >
          <Menu className="size-4 text-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" sideOffset={6} className="w-56">
          {/* Group 1 — Project actions */}
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => createNewProject()}>
              <Plus className="size-4" />
              新建项目
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              closeOnClick={false}
              onClick={() => {
                if (!confirmingDelete) {
                  setConfirmingDelete(true);
                  return;
                }
                setMenuOpen(false);
                void handleDeleteProject();
              }}
            >
              <Trash2 className="size-4" />
              {confirmingDelete ? "确认删除?" : "删除当前项目"}
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          {/* Group 2 — Canvas import / export */}
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
              <ImagePlus className="size-4" />
              导入图片
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleExportCanvas()}>
              <Download className="size-4" />
              导出画布
              <DropdownMenuShortcut>.excalidraw</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          {/* Group 3 — Edit operations */}
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => dispatchKeyToExcalidraw("z", { metaKey: true })}
            >
              <Undo2 className="size-4" />
              撤销
              <DropdownMenuShortcut>⌘Z</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                dispatchKeyToExcalidraw("z", {
                  metaKey: true,
                  shiftKey: true,
                })
              }
            >
              <Redo2 className="size-4" />
              重做
              <DropdownMenuShortcut>⇧⌘Z</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDuplicateElements}>
              <Copy className="size-4" />
              复制对象
              <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          {/* Group 4 — View controls */}
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => excalidrawApi?.scrollToContent()}>
              <Maximize2 className="size-4" />
              显示画布所有元素
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileImport}
      />
    </>
  );
}
