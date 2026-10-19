import type { CanvasContent } from "@kenfutwork/shared";

const stringFields = [
  "id",
  "type",
  "text",
  "textAlign",
  "strokeColor",
  "backgroundColor",
  "fileId",
];
const numberFields = [
  "x",
  "y",
  "width",
  "height",
  "angle",
  "version",
  "fontSize",
  "fontFamily",
  "opacity",
];

/** 文件表签发素材引用；元素ID与文件ID不当作素材身份。 */
export function withCanvasAssetReference(
  element: Record<string, unknown>,
  files: CanvasContent["files"],
) {
  const file =
    typeof element.fileId === "string" ? files[element.fileId] : undefined;
  if (!file || typeof file.assetId !== "string") return element;
  return {
    ...element,
    customData: {
      ...(element.customData as Record<string, unknown> | undefined),
      assetId: file.assetId,
      ...(typeof file.version === "string"
        ? { assetVersion: file.version }
        : {}),
      ...(typeof file.mimeType === "string" ? { mimeType: file.mimeType } : {}),
    },
  };
}

/** 持久选区仅保留几何/文字与真实引用，排除data URI、下载URL和编辑器私有状态。 */
export function selectedCanvasElement(
  element: Record<string, unknown>,
  files: CanvasContent["files"],
) {
  const source = withCanvasAssetReference(element, files);
  const selected: Record<string, unknown> = Object.fromEntries([
    ...stringFields.flatMap((key) =>
      typeof source[key] === "string" ? [[key, source[key]]] : [],
    ),
    ...numberFields.flatMap((key) =>
      typeof source[key] === "number" && Number.isFinite(source[key])
        ? [[key, source[key]]]
        : [],
    ),
  ]);
  if (Array.isArray(source.groupIds))
    selected.groupIds = source.groupIds.filter((id) => typeof id === "string");
  if (
    Array.isArray(source.points) &&
    source.points.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ),
    )
  )
    selected.points = structuredClone(source.points);
  const metadata = source.customData as Record<string, unknown> | undefined;
  if (metadata) {
    const reference: Record<string, unknown> = Object.fromEntries(
      ["assetId", "assetVersion", "mimeType"].flatMap((key) =>
        typeof metadata[key] === "string" ? [[key, metadata[key]]] : [],
      ),
    );
    if (metadata.isVideo === true) {
      reference.isVideo = true;
      if (typeof metadata.version === "string")
        reference.assetVersion = metadata.version;
    }
    if (Object.keys(reference).length) selected.customData = reference;
  }
  return selected;
}
