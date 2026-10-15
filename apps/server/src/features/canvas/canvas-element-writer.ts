// apps/server/src/features/canvas/canvas-element-writer.ts

import { createHash } from "node:crypto";
import type { CanvasContent } from "@kenfutwork/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CanvasElement = Record<string, unknown>;

type ImageInsertOpts = {
  insertionId?: string;
  canvasId: string;
  objectPath: string; // Storage path for oss:// marker (already uploaded by worker)
  width: number;
  height: number;
  mimeType: string;
  title?: string;
};

type VideoInsertOpts = {
  insertionId?: string;
  canvasId: string;
  assetId?: string;
  relativePath?: string;
  assetVersion?: string;
  signedUrl: string; // Public URL for embeddable link
  width: number;
  height: number;
  mimeType: string;
  durationSeconds?: number;
  title?: string;
  prompt?: string;
};

type Placement = { x: number; y: number; width: number; height: number };

type InsertResult = { elementId: string };

/**
 * 画布内容读写缝（由 canvas 服务的实现绑定工作区作用域）。
 * 取代原先 duck-typed 的 Supabase client 参数——写入器因此不再接触供应商 SDK。
 */
export type CanvasContentStore = {
  readContent(canvasId: string): Promise<CanvasContent | null>;
  /**
   * 文档发布屏障内原子追加元素/文件。
   * 落画布只能走这里，不能「读-改-写」：并发任务同时落图时后者会覆盖前者，**丢元素**。
   */
  appendContent(
    canvasId: string,
    input: {
      elements: readonly CanvasElement[];
      files?: Record<string, Record<string, unknown>> | undefined;
    },
  ): Promise<void>;
};

// ---------------------------------------------------------------------------
// Placement calculation (ported from apps/web/src/lib/canvas-elements.ts)
// ---------------------------------------------------------------------------

function scaleToFit(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  if (width <= maxSize && height <= maxSize) return { width, height };
  const ratio = Math.min(maxSize / width, maxSize / height);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

function calculateAutoPlacement(
  elements: CanvasElement[],
  assetWidth: number,
  assetHeight: number,
  maxSize: number,
): Placement {
  const scaled = scaleToFit(assetWidth, assetHeight, maxSize);
  const visible = elements.filter((el) => !el.isDeleted);

  if (visible.length === 0) {
    // Empty canvas: center around origin
    return {
      x: -scaled.width / 2,
      y: -scaled.height / 2,
      width: scaled.width,
      height: scaled.height,
    };
  }

  // Place right of the rightmost element with 40px gap
  const GAP = 40;
  let maxRight = -Infinity;
  let rightEdgeY = 0;
  for (const el of visible) {
    const elRight = (Number(el.x) || 0) + (Number(el.width) || 0);
    if (elRight > maxRight) {
      maxRight = elRight;
      rightEdgeY = (Number(el.y) || 0) + (Number(el.height) || 0) / 2;
    }
  }
  return {
    x: maxRight + GAP,
    y: rightEdgeY - scaled.height / 2,
    width: scaled.width,
    height: scaled.height,
  };
}

// ---------------------------------------------------------------------------
// Element builders
// ---------------------------------------------------------------------------

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

function buildImageElement(
  fileId: string,
  placement: Placement,
  opts: ImageInsertOpts,
): CanvasElement {
  return {
    type: "image",
    id: generateId(),
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    fileId,
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
    customData: {
      ...(opts.title ? { title: opts.title } : {}),
      source: "generated" as const,
    },
  };
}

function buildVideoElement(
  placement: Placement,
  opts: VideoInsertOpts,
): CanvasElement {
  return {
    type: "embeddable",
    id: generateId(),
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
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
    link: opts.signedUrl,
    locked: false,
    customData: {
      isVideo: true,
      ...(opts.assetId ? { assetId: opts.assetId } : {}),
      ...(opts.relativePath ? { relativePath: opts.relativePath } : {}),
      ...(opts.assetVersion ? { version: opts.assetVersion } : {}),
      mimeType: opts.mimeType,
      ...(opts.durationSeconds != null
        ? { durationSeconds: opts.durationSeconds }
        : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API — Read-Modify-Write canvas content
// ---------------------------------------------------------------------------

const IMAGE_MAX_SIZE = 600;
const VIDEO_MAX_SIZE = 800;

function readElements(content: CanvasContent | null): CanvasElement[] {
  return ((content as { elements?: CanvasElement[] } | null)?.elements ??
    []) as CanvasElement[];
}

function insertionIdentity(
  canvasId: string,
  insertionId: string | undefined,
  kind: "image" | "video",
  source: unknown,
) {
  if (!insertionId) return null;
  const id = createHash("sha256")
    .update(`${canvasId}/${kind}/${insertionId}`)
    .digest("hex")
    .slice(0, 20);
  return {
    id,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(source))
      .digest("hex"),
  };
}
function existingInsertion(
  elements: CanvasElement[],
  identity: ReturnType<typeof insertionIdentity>,
) {
  if (!identity) return undefined;
  const previous = elements.find((element) => element.id === identity.id);
  if (!previous) return undefined;
  const metadata = previous.customData as Record<string, unknown> | undefined;
  if (metadata?.generationFingerprint !== identity.fingerprint)
    throw new Error("生成结果发布身份冲突，请重新生成。");
  return { elementId: identity.id };
}
function freezeGeneratedElement(
  element: CanvasElement,
  identity: NonNullable<ReturnType<typeof insertionIdentity>>,
) {
  element.id = identity.id;
  element.seed = Number.parseInt(identity.id.slice(0, 7), 16);
  element.versionNonce = element.seed;
  element.updated = 0;
  element.customData = {
    ...(element.customData as Record<string, unknown>),
    generationFingerprint: identity.fingerprint,
  };
}

/**
 * Insert an image element into a canvas. Reads current content, appends element
 * with auto-placement (or explicit placement), writes it back.
 *
 * The image file is already in object storage (uploaded by worker executor).
 * We download it and embed as base64 dataURL in the canvas files map so
 * Excalidraw can render it natively (consistent with frontend-inserted images).
 */
export async function insertImageElement(
  store: CanvasContentStore,
  opts: ImageInsertOpts,
  explicitPlacement?: Placement,
): Promise<InsertResult> {
  const dataURL = `oss://project-assets/${opts.objectPath}`;

  // 2. Read canvas
  const content = await store.readContent(opts.canvasId);
  if (!content) {
    throw new Error(`Canvas not found: ${opts.canvasId}`);
  }

  const elements = readElements(content);
  const identity = insertionIdentity(opts.canvasId, opts.insertionId, "image", {
    objectPath: opts.objectPath,
    width: opts.width,
    height: opts.height,
    mimeType: opts.mimeType,
    title: opts.title,
    placement: explicitPlacement,
  });
  const existing = existingInsertion(elements, identity);
  if (existing) return existing;
  // 3. Placement
  const placement =
    explicitPlacement ??
    calculateAutoPlacement(elements, opts.width, opts.height, IMAGE_MAX_SIZE);

  // 4. Build element + files entry with base64 dataURL
  const fileId = identity ? `file-${identity.id}` : generateId();
  const element = buildImageElement(fileId, placement, opts);
  if (identity) freezeGeneratedElement(element, identity);

  // 5. Write：文件锁内追加（不能整份覆盖写——并发落图会互相覆盖）
  await store.appendContent(opts.canvasId, {
    elements: [element],
    files: {
      [fileId]: {
        id: fileId,
        dataURL,
        mimeType: opts.mimeType,
        created: identity ? 0 : Date.now(),
      },
    },
  });

  console.log(
    `[canvas-element-writer] image inserted canvasId=${opts.canvasId} elementId=${element.id}`,
  );
  return { elementId: element.id as string };
}

/**
 * Insert a video element into a canvas. Videos use Excalidraw's `embeddable`
 * type with a link URL — no files map entry needed.
 */
export async function insertVideoElement(
  store: CanvasContentStore,
  opts: VideoInsertOpts,
  explicitPlacement?: Placement,
): Promise<InsertResult> {
  // 1. Read
  const content = await store.readContent(opts.canvasId);
  if (!content) {
    throw new Error(`Canvas not found: ${opts.canvasId}`);
  }

  const elements = readElements(content);
  const identity = insertionIdentity(opts.canvasId, opts.insertionId, "video", {
    source: opts.assetId ?? opts.signedUrl,
    width: opts.width,
    height: opts.height,
    mimeType: opts.mimeType,
    title: opts.title,
    prompt: opts.prompt,
    durationSeconds: opts.durationSeconds,
    placement: explicitPlacement,
  });
  const existing = existingInsertion(elements, identity);
  if (existing) return existing;

  // 2. Placement
  const placement =
    explicitPlacement ??
    calculateAutoPlacement(elements, opts.width, opts.height, VIDEO_MAX_SIZE);

  // 3. Build element
  const element = buildVideoElement(placement, opts);
  if (identity) freezeGeneratedElement(element, identity);

  // 4. Write：文件锁内追加（理由同图片路径）
  await store.appendContent(opts.canvasId, { elements: [element] });

  console.log(
    `[canvas-element-writer] video inserted canvasId=${opts.canvasId} elementId=${element.id}`,
  );
  return { elementId: element.id as string };
}
