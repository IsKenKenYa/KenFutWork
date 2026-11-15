import { type RefObject, useEffect, useState } from "react";
import { getWorkDirectory } from "./workProjectDirectory.js";

type EditorSaveMessage = {
  type?: string;
  saveId?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
  bytes?: unknown;
  message?: unknown;
};

type SaveFeedback = { kind: "success" | "error"; text: string };
type PendingSave = { id: string; workDir: string | null };

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function editorSaveTarget(fileName: string, deliveryId: string) {
  const project = getWorkDirectory();
  const name = fileName.split(/[\\/]/u).pop()?.trim();
  if (!project?.workDir || !name || name === "." || name === "..") return null;
  return {
    workDir: project.workDir,
    fields: { projectId: project.id, assetId: deliveryId, relativePath: name },
  };
}

function savedLocation(
  workDir: string | null,
  relativePath: unknown,
  path: unknown,
): string | null {
  if (workDir && typeof relativePath === "string") {
    const separator = workDir.includes("\\") ? "\\" : "/";
    return `${workDir.replace(/[\\/]+$/u, "")}${separator}${relativePath.split("/").join(separator)}`;
  }
  return typeof path === "string" && path ? path : null;
}

/** 关联原编辑器的保存、父页交付和当前提示，旧回执只结束自身操作。 */
export function useWorkEditorSave(
  frame: RefObject<HTMLIFrameElement | null>,
  src: string,
  onReady: (ready: boolean) => void,
): SaveFeedback | null {
  const [feedback, setFeedback] = useState<SaveFeedback | null>(null);
  useEffect(() => {
    const expectedOrigin = new URL(src).origin;
    const seenEditorIds = new Set<string>();
    let pending: PendingSave | null = null;

    const onEditorMessage = (event: MessageEvent) => {
      if (
        event.origin !== expectedOrigin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      const data = event.data as EditorSaveMessage | null;
      if (data?.type === "kenfutwork:editor-ready") {
        onReady(true);
        return;
      }
      if (data?.type === "kenfutwork:editor-save-error") {
        pending = null;
        setFeedback({
          kind: "error",
          text:
            typeof data.message === "string"
              ? data.message
              : "读取保存内容失败",
        });
        return;
      }
      if (
        data?.type !== "kenfutwork:editor-save" ||
        typeof data.saveId !== "string" ||
        typeof data.fileName !== "string" ||
        !isArrayBuffer(data.bytes) ||
        seenEditorIds.has(data.saveId)
      )
        return;

      seenEditorIds.add(data.saveId);
      // 编辑器的序号只在自己的文档内有效，发往父页时生成独立交付编号。
      const id = crypto.randomUUID();
      const target = editorSaveTarget(data.fileName, id);
      pending = { id, workDir: target?.workDir ?? null };
      setFeedback(null);
      window.parent.postMessage(
        {
          type: "kenfutwork:work-save",
          saveId: id,
          fileName: data.fileName,
          mimeType: data.mimeType,
          bytes: data.bytes,
          ...target?.fields,
        },
        window.location.origin,
        [data.bytes],
      );
    };

    const onResult = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.origin !== window.location.origin ||
        !pending
      )
        return;
      const data = event.data as {
        type?: string;
        saveId?: unknown;
        ok?: unknown;
        error?: unknown;
        path?: unknown;
        relativePath?: unknown;
      } | null;
      if (
        data?.type !== "kenfutwork:work-save-result" ||
        data.saveId !== pending.id ||
        typeof data.ok !== "boolean"
      )
        return;
      const { workDir } = pending;
      pending = null;
      if (!data.ok) {
        const reason = typeof data.error === "string" ? data.error : "未知错误";
        setFeedback({ kind: "error", text: `保存失败：${reason}` });
        return;
      }
      const path = savedLocation(workDir, data.relativePath, data.path);
      setFeedback({
        kind: "success",
        text: path ? `已保存 ${path}` : "已保存",
      });
    };

    window.addEventListener("message", onEditorMessage);
    window.addEventListener("message", onResult);
    return () => {
      window.removeEventListener("message", onEditorMessage);
      window.removeEventListener("message", onResult);
    };
  }, [frame, onReady, src]);
  return feedback;
}
