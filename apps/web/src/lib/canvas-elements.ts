import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type {
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ImageArtifact, VideoArtifact } from "@kenfutwork/shared";
import { serverFetch } from "@/lib/local-access";

import { getServerBaseUrl } from "./env";

/** Video file extensions recognized for inline playback on canvas. */
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".ogg", ".mov"];

/**
 * 传给 `convertToExcalidrawElements` 的视频嵌入骨架：只声明本处提供的字段，
 * 其余（id/颜色/版本号…）由它补全。
 */
type VideoEmbeddableSkeleton = {
  type: "embeddable";
  link: string;
  x: number;
  y: number;
  width: number;
  height: number;
  customData: {
    isVideo: true;
    mimeType: string;
    durationSeconds: number | undefined;
    title: string | undefined;
    prompt: string | undefined;
  };
};

/**
 * Check if a URL points to a video file based on extension or customData hint.
 * Used by canvas-editor (renderEmbeddable) and canvas-tool-menu (selection detection).
 */
export function isVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    // Strip query params/hash for extension check
    const pathname = new URL(url, "https://placeholder").pathname.toLowerCase();
    return VIDEO_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    // Fallback: raw string check
    const lower = url.toLowerCase();
    return VIDEO_EXTENSIONS.some((ext) => lower.includes(ext));
  }
}

/**
 * Scale dimensions to fit within maxSize while preserving aspect ratio.
 */
export function scaleToFit(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  if (width <= maxSize && height <= maxSize) {
    return { width, height };
  }
  const ratio = Math.min(maxSize / width, maxSize / height);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

/**
 * Compute the center of the current Excalidraw viewport.
 */
export function getViewportCenter(appState: {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  zoom: { value: number };
}): { x: number; y: number } {
  const zoom = appState.zoom?.value ?? 1;
  return {
    x: -appState.scrollX + appState.width / (2 * zoom),
    y: -appState.scrollY + appState.height / (2 * zoom),
  };
}

/**
 * Create an Excalidraw image element with all required fields.
 */
export function createExcalidrawImageElement(opts: {
  fileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title?: string;
  source?: "generated" | "uploaded";
  storageUrl?: string;
}): ExcalidrawImageElement {
  const customData =
    opts.title || opts.source || opts.storageUrl
      ? {
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.source ? { source: opts.source } : {}),
          ...(opts.storageUrl ? { storageUrl: opts.storageUrl } : {}),
        }
      : null;

  return {
    type: "image",
    id: generateId(),
    x: opts.x,
    y: opts.y,
    width: opts.width,
    height: opts.height,
    angle: 0,
    // fileId 在 Excalidraw 类型里是品牌字符串，来源是本函数调用方的自有 id，故在边界处断言。
    fileId: opts.fileId as FileId,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
    status: "saved",
    scale: [1, 1],
    crop: null,
    ...(customData ? { customData } : {}),
  };
}

/**
 * Fetch an image URL and convert it to a data URL string.
 * Routes through the server proxy to bypass browser CORS restrictions.
 */
export async function fetchAsDataURL(url: string): Promise<string> {
  const proxyUrl = `${getServerBaseUrl()}/api/proxy-image?url=${encodeURIComponent(url)}`;

  const response = await serverFetch(proxyUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(new Error("Failed to convert image to data URL"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Insert an image artifact onto the Excalidraw canvas.
 */
export async function insertImageOnCanvas(
  api: ExcalidrawImperativeAPI,
  artifact: ImageArtifact,
): Promise<void> {
  const dataURL = await fetchAsDataURL(artifact.url);
  const fileId = generateId();

  api.addFiles([
    {
      // id/dataURL/mimeType 在 Excalidraw 类型里是品牌字符串，这里的数据是生成结果与
      // 服务端代理产物，与组件侧的 addFiles 同口径：在边界处断言。
      id: fileId as BinaryFileData["id"],
      dataURL: dataURL as BinaryFileData["dataURL"],
      mimeType: artifact.mimeType as BinaryFileData["mimeType"],
      created: Date.now(),
    },
  ]);

  let x: number;
  let y: number;
  let width: number;
  let height: number;

  if (artifact.placement) {
    // Agent-controlled placement
    x = artifact.placement.x;
    y = artifact.placement.y;
    width = artifact.placement.width;
    height = artifact.placement.height;
  } else {
    // Smart auto-placement: viewport center if empty, next to elements if not
    const scaled = scaleToFit(artifact.width, artifact.height, 600);
    width = scaled.width;
    height = scaled.height;

    const elements = api.getSceneElements().filter((el) => !el.isDeleted);

    if (elements.length === 0) {
      // Empty canvas → viewport center
      const center = getViewportCenter(api.getAppState());
      x = center.x - width / 2;
      y = center.y - height / 2;
    } else {
      // Has elements → place to the right of the rightmost element with gap
      const GAP = 40;
      let maxRight = -Infinity;
      let rightEdgeY = 0;

      for (const el of elements) {
        const elRight = (el.x ?? 0) + (el.width ?? 0);
        if (elRight > maxRight) {
          maxRight = elRight;
          // Vertically align center of new image with center of rightmost element
          rightEdgeY = (el.y ?? 0) + (el.height ?? 0) / 2;
        }
      }

      x = maxRight + GAP;
      y = rightEdgeY - height / 2;
    }
  }

  const element = createExcalidrawImageElement({
    fileId,
    x,
    y,
    width,
    height,
    ...(artifact.title ? { title: artifact.title } : {}),
    source: "generated",
    storageUrl: artifact.url,
  });

  api.updateScene({
    elements: [...api.getSceneElements(), element],
    captureUpdate: "IMMEDIATELY",
  });
}

/**
 * Insert a video artifact onto the Excalidraw canvas as an embeddable element.
 * Uses Excalidraw's native embeddable type with renderEmbeddable callback for inline playback.
 * No poster frame extraction needed -- the video plays directly on canvas.
 */
export async function insertVideoOnCanvas(
  api: ExcalidrawImperativeAPI,
  artifact: VideoArtifact,
): Promise<void> {
  // Dynamic import — excalidraw is client-only and cannot be imported at module level
  const { convertToExcalidrawElements } = await import(
    "@excalidraw/excalidraw"
  );

  let x: number;
  let y: number;
  let width: number;
  let height: number;

  if (artifact.placement) {
    x = artifact.placement.x;
    y = artifact.placement.y;
    width = artifact.placement.width;
    height = artifact.placement.height;
  } else {
    // Use 800px max for video elements (larger than images since video benefits from more screen area)
    const scaled = scaleToFit(artifact.width, artifact.height, 800);
    width = scaled.width;
    height = scaled.height;

    const elements = api.getSceneElements().filter((el) => !el.isDeleted);

    if (elements.length === 0) {
      // Empty canvas -- place at viewport center
      const center = getViewportCenter(api.getAppState());
      x = center.x - width / 2;
      y = center.y - height / 2;
    } else {
      // Has elements -- place to the right of the rightmost element with gap
      const GAP = 40;
      let maxRight = -Infinity;
      let rightEdgeY = 0;
      for (const el of elements) {
        const elRight = (el.x ?? 0) + (el.width ?? 0);
        if (elRight > maxRight) {
          maxRight = elRight;
          rightEdgeY = (el.y ?? 0) + (el.height ?? 0) / 2;
        }
      }
      x = maxRight + GAP;
      y = rightEdgeY - height / 2;
    }
  }

  // 视频嵌入元素的部分骨架：只给必要字段，其余（id/颜色/版本号…）由
  // convertToExcalidrawElements 补全。
  const skeleton: VideoEmbeddableSkeleton = {
    type: "embeddable",
    link: artifact.url,
    x,
    y,
    width,
    height,
    customData: {
      isVideo: true,
      mimeType: artifact.mimeType,
      durationSeconds: artifact.durationSeconds,
      title: artifact.title?.slice(0, 60),
      prompt: artifact.title,
    },
  };

  const newElements = convertToExcalidrawElements([
    // ExcalidrawElementSkeleton 是「完整元素」口径，装不下只给部分字段的骨架
    // （缺失字段由它补全），故在这一处官方边界上收窄。
    skeleton as unknown as ExcalidrawElementSkeleton,
  ]);

  const existing = api.getSceneElements();
  api.updateScene({
    elements: [...existing, ...newElements],
    captureUpdate: "IMMEDIATELY",
  });
}

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  ).slice(0, 20);
}
