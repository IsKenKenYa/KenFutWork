import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { CanvasContent } from "@kenfutwork/shared";
import { serverFetch } from "./local-access";

/** 文件全部可用后才接纳远端场景；失败由编辑器保留当前草稿。 */
export async function resolveCanvasSnapshotFiles(
  files: CanvasContent["files"],
): Promise<BinaryFileData[]> {
  const resolved = await Promise.all(
    Object.entries(files).map(async ([fileId, value]) => {
      if (typeof value.storageUrl !== "string" || !value.storageUrl)
        return typeof value.dataURL === "string"
          ? (value as unknown as BinaryFileData)
          : null;
      const response = await serverFetch(value.storageUrl);
      if (!response.ok) throw new Error(`文件 ${fileId} 加载失败`);
      const blob = await response.blob();
      const dataURL = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      return {
        id: (typeof value.id === "string"
          ? value.id
          : fileId) as BinaryFileData["id"],
        mimeType: (typeof value.mimeType === "string"
          ? value.mimeType
          : blob.type) as BinaryFileData["mimeType"],
        created: typeof value.created === "number" ? value.created : Date.now(),
        dataURL: dataURL as BinaryFileData["dataURL"],
      };
    }),
  );
  return resolved.filter((file): file is BinaryFileData => file !== null);
}
