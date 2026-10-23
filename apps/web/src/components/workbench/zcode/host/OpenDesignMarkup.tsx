import type {
  DesignReviewAnnotation,
  DesignReviewComment,
} from "@kenfutwork/shared";
import { useEffect, useRef, useState } from "react";
import {
  type FrameMetrics,
  frameRectToOverlay,
  normalizedToOverlay,
  type OverlayBox,
  overlayToNormalized,
} from "./openDesignMarkupGeometry.js";
import type { OpenDesignMovePosition } from "./openDesignSourceEdit.js";
import type { OpenDesignHit } from "./openDesignRuntime.js";

/** 一条新标注落笔后的最小信息（作用域由面板补齐）。 */
export interface OpenDesignDraftAnnotation {
  points: [number, number][];
  kind: "pen" | "rect" | "text" | "mark";
  text?: string;
}

type HandleId = "nw" | "ne" | "sw" | "se";

type NormalizedPoint = [number, number];

interface NormalizedBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface DragState {
  id: string;
  mode: "move" | "scale";
  handle: HandleId | null;
  startPointer: NormalizedPoint;
  pointer: NormalizedPoint;
  original: NormalizedPoint[];
  draft: NormalizedPoint[];
  box: NormalizedBox;
  changed: boolean;
}

/** 选中框的最小可缩放尺寸（归一化），防止缩成一条看不见的线。 */
const MIN_SCALE_SIZE = 0.02;

/** 拖放时「放进容器」的标签集合；其余目标按相对位置插到前后。 */
const CONTAINER_TAGS = new Set([
  "body",
  "main",
  "section",
  "article",
  "div",
  "aside",
  "header",
  "footer",
  "nav",
  "ul",
  "ol",
  "li",
  "table",
  "tbody",
  "tr",
  "td",
  "th",
  "form",
  "figure",
  "details",
  "dialog",
  "label",
  "blockquote",
  "fieldset",
]);

function bboxOf(points: NormalizedPoint[]): NormalizedBox {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function movePoints(
  drag: DragState,
  pointer: NormalizedPoint,
): NormalizedPoint[] {
  const { box } = drag;
  const dx = clamp(
    pointer[0] - drag.startPointer[0],
    -box.minX,
    1 - box.maxX,
  );
  const dy = clamp(
    pointer[1] - drag.startPointer[1],
    -box.minY,
    1 - box.maxY,
  );
  return drag.original.map(
    ([x, y]) => [x + dx, y + dy] as NormalizedPoint,
  );
}

/**
 * 以「对角」为锚点缩放：锚点固定、被拖的角跟着指针走。
 * 每个轴单独求比例并夹在合法区间里（最小尺寸 / 不越出画布）。
 */
function scalePoints(
  drag: DragState,
  pointer: NormalizedPoint,
): NormalizedPoint[] {
  const { box } = drag;
  const handle = drag.handle ?? "se";
  const anchorX = handle === "nw" || handle === "sw" ? box.maxX : box.minX;
  const anchorY = handle === "nw" || handle === "ne" ? box.maxY : box.minY;
  const cornerX = handle === "nw" || handle === "sw" ? box.minX : box.maxX;
  const cornerY = handle === "nw" || handle === "ne" ? box.minY : box.maxY;
  const spanX = cornerX - anchorX;
  const spanY = cornerY - anchorY;
  const scaleAxis = (
    span: number,
    anchor: number,
    pointerValue: number,
  ): number => {
    if (Math.abs(span) < 1e-6) return 1;
    const raw = (pointerValue - anchor) / span;
    // 不翻面、不缩成线、不越出画布：raw 始终夹在 [最小尺寸, 可用空间] / |span|。
    const minScale = MIN_SCALE_SIZE / Math.abs(span);
    const maxScale = (span > 0 ? 1 - anchor : anchor) / Math.abs(span);
    return clamp(raw, Math.min(minScale, maxScale), Math.max(minScale, maxScale));
  };
  const sx = scaleAxis(spanX, anchorX, pointer[0]);
  const sy = scaleAxis(spanY, anchorY, pointer[1]);
  return drag.original.map(
    ([x, y]) =>
      [
        clamp(anchorX + (x - anchorX) * sx, 0, 1),
        clamp(anchorY + (y - anchorY) * sy, 0, 1),
      ] as NormalizedPoint,
  );
}

/**
 * 画布上的评审覆盖层：评论图钉 + 标注笔迹。
 *
 * 它浮在 iframe 之上、按桥回传的矩形换算落点，因此图钉与笔迹贴的是**设计内容**
 * 而不是屏幕：缩放、换设备视口、文档内滚动都跟得上。
 * 非标注/擦除/调整态整层 `pointer-events:none`，不挡画布自己的交互。
 */
export function OpenDesignMarkup({
  comments,
  annotations,
  rects,
  box,
  metrics,
  drawing,
  erasing = false,
  adjusting = false,
  elementSelecting = false,
  annotationKind = "pen",
  color,
  hitTest,
  onPickComment,
  onCreateAnnotation,
  onDeleteAnnotation,
  onUpdateAnnotation,
  onMoveElement,
}: {
  comments: DesignReviewComment[];
  annotations: DesignReviewAnnotation[];
  /** 路径 → 那一侧的视口矩形；null = 这个锚点在当前正文里已经找不到了。 */
  rects: Record<string, { h: number; w: number; x: number; y: number } | null>;
  box: OverlayBox;
  metrics: FrameMetrics;
  /** 标注态才吃鼠标事件。 */
  drawing: boolean;
  /** 橡皮擦：点已有笔迹即删除。 */
  erasing?: boolean;
  /** 选择调整（批注）：点选标注后可拖动移动、拖角缩放。 */
  adjusting?: boolean;
  /** 元素选择：点选页面元素后拖动换位置/换容器。 */
  elementSelecting?: boolean;
  annotationKind?: "pen" | "rect" | "text" | "mark";
  color: string;
  /** 父页发起的命中测试（iframe 视口坐标）；元素选择拖放用。 */
  hitTest?: (x: number, y: number) => Promise<OpenDesignHit | null>;
  onPickComment: (commentId: string) => void;
  onCreateAnnotation: (draft: OpenDesignDraftAnnotation) => void;
  onDeleteAnnotation: (id: string) => void;
  onUpdateAnnotation: (id: string, points: [number, number][]) => void;
  onMoveElement: (
    path: string,
    targetPath: string,
    position: OpenDesignMovePosition,
  ) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [stroke, setStroke] = useState<[number, number][] | null>(null);
  const [textAt, setTextAt] = useState<{
    x: number;
    y: number;
    px: number;
    py: number;
  } | null>(null);
  const [textValue, setTextValue] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** 元素选择：当前选中元素、拖动状态与拖放候选目标。 */
  const [elementSel, setElementSel] = useState<OpenDesignHit | null>(null);
  const [elementDrag, setElementDrag] = useState<{
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    moved: boolean;
  } | null>(null);
  const [elementTarget, setElementTarget] = useState<OpenDesignHit | null>(
    null,
  );
  const lastHitAt = useRef(0);

  useEffect(() => {
    if (drawing) return;
    setTextAt(null);
    setTextValue("");
  }, [drawing]);

  useEffect(() => {
    if (!adjusting) {
      setSelectedId(null);
      setDrag(null);
    }
  }, [adjusting]);

  useEffect(() => {
    if (elementSelecting) return;
    setElementSel(null);
    setElementDrag(null);
    setElementTarget(null);
  }, [elementSelecting]);

  function pointOf(event: React.PointerEvent): [number, number] {
    const rect = svgRef.current?.getBoundingClientRect();
    // 覆盖层坐标系：以覆盖层自身左上角为原点（`box` 也在这个坐标系里）。
    return overlayToNormalized(
      {
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      },
      box,
      metrics,
    );
  }

  /** 覆盖层指针 → iframe 视口坐标（桥的 hit 用视口 CSS px）。 */
  function viewportPointOf(event: React.PointerEvent): { x: number; y: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    const scaleX = box.width / (metrics.vw || 1);
    const scaleY = box.height / (metrics.vh || 1);
    return {
      x: (event.clientX - (rect?.left ?? 0) - box.left) / (scaleX || 1),
      y: (event.clientY - (rect?.top ?? 0) - box.top) / (scaleY || 1),
    };
  }

  function startElementPointerDown(event: React.PointerEvent) {
    if (!hitTest) return;
    const point = viewportPointOf(event);
    svgRef.current?.setPointerCapture?.(event.pointerId);
    void hitTest(point.x, point.y).then((hit) => {
      if (!hit) {
        setElementSel(null);
        setElementDrag(null);
        setElementTarget(null);
        return;
      }
      const overlay = svgRef.current?.getBoundingClientRect();
      setElementSel(hit);
      setElementDrag({
        startX: event.clientX - (overlay?.left ?? 0),
        startY: event.clientY - (overlay?.top ?? 0),
        dx: 0,
        dy: 0,
        moved: false,
      });
      setElementTarget(null);
    });
  }

  function moveElementPointerMove(event: React.PointerEvent) {
    if (!elementDrag || !hitTest) return;
    const rect = svgRef.current?.getBoundingClientRect();
    const x = event.clientX - (rect?.left ?? 0);
    const y = event.clientY - (rect?.top ?? 0);
    const dx = x - elementDrag.startX;
    const dy = y - elementDrag.startY;
    const moved = elementDrag.moved || Math.abs(dx) + Math.abs(dy) > 6;
    setElementDrag({ ...elementDrag, dx, dy, moved });
    if (!moved) return;
    const now = Date.now();
    if (now - lastHitAt.current < 90) return;
    lastHitAt.current = now;
    const point = viewportPointOf(event);
    void hitTest(point.x, point.y).then((hit) => {
      setElementTarget(
        hit && hit.path !== elementSel?.path ? hit : null,
      );
    });
  }

  function endElementDrag(event: React.PointerEvent) {
    const current = elementDrag;
    setElementDrag(null);
    setElementTarget(null);
    if (!current?.moved || !elementSel || !elementTarget) return;
    const rect = svgRef.current?.getBoundingClientRect();
    const x = event.clientX - (rect?.left ?? 0);
    const targetBox = frameRectToOverlay(elementTarget.rect, box, metrics);
    const targetCenterX = targetBox.left + targetBox.width / 2;
    const position: OpenDesignMovePosition = CONTAINER_TAGS.has(
      elementTarget.tag,
    )
      ? "inside"
      : x < targetCenterX
        ? "before"
        : "after";
    onMoveElement(elementSel.path, elementTarget.path, position);
    setElementSel(null);
  }

  function startDrag(
    annotation: DesignReviewAnnotation,
    event: React.PointerEvent,
    mode: "move" | "scale",
    handle: HandleId | null,
  ) {
    event.stopPropagation();
    const pointer = pointOf(event);
    svgRef.current?.setPointerCapture?.(event.pointerId);
    setSelectedId(annotation.id);
    setDrag({
      id: annotation.id,
      mode,
      handle,
      startPointer: pointer,
      pointer,
      original: annotation.points.map(([x, y]) => [x, y]),
      draft: annotation.points.map(([x, y]) => [x, y]),
      box: bboxOf(annotation.points),
      changed: false,
    });
  }

  const selected = annotations.find((item) => item.id === selectedId) ?? null;
  const selectedPoints = selected
    ? (drag?.id === selected.id ? drag.draft : selected.points)
    : [];
  const selectedOverlay = selected
    ? (() => {
        if (selected.kind === "text") {
          const point = normalizedToOverlay(
            selectedPoints[0]?.[0] ?? 0,
            selectedPoints[0]?.[1] ?? 0,
            box,
            metrics,
          );
          const lines = (selected.text ?? "").split(/\r?\n/u);
          const width = Math.max(
            60,
            Math.max(1, ...lines.map((line) => line.length)) * 8,
          );
          const height = Math.max(20, lines.length * 16);
          return {
            x: point.px - 6,
            y: point.py - 18,
            width: width + 8,
            height: height + 8,
          };
        }
        if (selected.kind === "mark") {
          const point = normalizedToOverlay(
            selectedPoints[0]?.[0] ?? 0,
            selectedPoints[0]?.[1] ?? 0,
            box,
            metrics,
          );
          return {
            x: point.px - 14,
            y: point.py - 14,
            width: 28,
            height: 28,
          };
        }
        const boxNorm = bboxOf(selectedPoints as NormalizedPoint[]);
        const min = normalizedToOverlay(boxNorm.minX, boxNorm.minY, box, metrics);
        const max = normalizedToOverlay(boxNorm.maxX, boxNorm.maxY, box, metrics);
        return {
          x: min.px - 4,
          y: min.py - 4,
          width: Math.max(16, max.px - min.px + 8),
          height: Math.max(16, max.py - min.py + 8),
        };
      })()
    : null;
  const canScale = selected?.kind === "pen" || selected?.kind === "rect";
  const elementSelOverlay = elementSel
    ? (() => {
        const r = frameRectToOverlay(elementSel.rect, box, metrics);
        const dx = elementDrag?.moved ? elementDrag.dx : 0;
        const dy = elementDrag?.moved ? elementDrag.dy : 0;
        return {
          x: r.left + dx,
          y: r.top + dy,
          width: r.width,
          height: r.height,
        };
      })()
    : null;
  const elementTargetOverlay = elementTarget
    ? (() => {
        const r = frameRectToOverlay(elementTarget.rect, box, metrics);
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      })()
    : null;

  return (
    <div
      data-testid="open-design-markup"
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      <svg
        ref={svgRef}
        className={`absolute inset-0 size-full ${
          drawing
            ? "pointer-events-auto cursor-crosshair"
            : elementSelecting
              ? "pointer-events-auto cursor-default"
              : adjusting || erasing
                ? "pointer-events-auto"
                : ""
        }`}
        onPointerDown={
          drawing
            ? (event) => {
                if (annotationKind === "text") {
                  const point = pointOf(event);
                  const overlay = normalizedToOverlay(
                    point[0],
                    point[1],
                    box,
                    metrics,
                  );
                  setTextAt({
                    x: point[0],
                    y: point[1],
                    px: overlay.px,
                    py: overlay.py,
                  });
                  setTextValue("");
                  return;
                }
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setStroke([pointOf(event)]);
              }
            : elementSelecting
              ? (event) => {
                  if (event.target !== event.currentTarget) return;
                  startElementPointerDown(event);
                }
              : adjusting
              ? (event) => {
                  // 空白处点击 = 取消选中；标注自身的手势已 stopPropagation。
                  if (event.target === event.currentTarget) {
                    setSelectedId(null);
                    setDrag(null);
                  }
                }
              : undefined
        }
        onPointerMove={
          drawing
            ? (event) => {
                const point = pointOf(event);
                setStroke((current) =>
                  current
                    ? annotationKind === "rect"
                      ? [current[0] as [number, number], point]
                      : [...current, point]
                    : current,
                );
              }
            : elementSelecting
              ? moveElementPointerMove
              : adjusting
              ? (event) => {
                  if (!drag) return;
                  const pointer = pointOf(event);
                  const draft =
                    drag.mode === "scale"
                      ? scalePoints(drag, pointer)
                      : movePoints(drag, pointer);
                  const moved =
                    Math.abs(pointer[0] - drag.startPointer[0]) > 1e-4 ||
                    Math.abs(pointer[1] - drag.startPointer[1]) > 1e-4;
                  setDrag({ ...drag, pointer, draft, changed: drag.changed || moved });
                }
              : undefined
        }
        onPointerUp={
          drawing
            ? () => {
                const points = stroke ?? [];
                setStroke(null);
                if (annotationKind === "mark") {
                  if (points.length >= 1) {
                    onCreateAnnotation({
                      kind: "mark",
                      points: [
                        points[0] as [number, number],
                        points[0] as [number, number],
                      ],
                    });
                  }
                  return;
                }
                if (annotationKind === "rect") {
                  if (points.length >= 2) {
                    onCreateAnnotation({
                      kind: "rect",
                      points: [
                        points[0] as [number, number],
                        points[points.length - 1] as [number, number],
                      ],
                    });
                  }
                  return;
                }
                if (points.length > 1)
                  onCreateAnnotation({ kind: "pen", points });
              }
            : elementSelecting
              ? endElementDrag
              : adjusting
              ? () => {
                  if (drag?.changed) {
                    onUpdateAnnotation(drag.id, drag.draft);
                  }
                  setDrag(null);
                }
              : undefined
        }
        onPointerCancel={
          elementSelecting
            ? () => {
                setElementDrag(null);
                setElementTarget(null);
              }
            : adjusting
              ? () => {
                  setDrag(null);
                }
              : undefined
        }
      >
        {annotations.map((annotation, index) => (
          <AnnotationShape
            key={annotation.id}
            annotation={annotation}
            points={
              drag?.id === annotation.id ? drag.draft : annotation.points
            }
            box={box}
            metrics={metrics}
            eraseMode={erasing}
            adjustMode={adjusting}
            markIndex={
              annotation.kind === "mark"
                ? annotations
                    .slice(0, index + 1)
                    .filter((item) => item.kind === "mark").length
                : 0
            }
            onErase={onDeleteAnnotation}
            onStartDrag={(event) =>
              startDrag(annotation, event, "move", null)
            }
          />
        ))}
        {stroke && stroke.length > 1 ? (
          annotationKind === "rect" ? (
            <rect
              {...(() => {
                const first = normalizedToOverlay(
                  ...(stroke[0] as [number, number]),
                  box,
                  metrics,
                );
                const last = normalizedToOverlay(
                  ...(stroke[stroke.length - 1] as [number, number]),
                  box,
                  metrics,
                );
                return {
                  x: Math.min(first.px, last.px),
                  y: Math.min(first.py, last.py),
                  width: Math.abs(last.px - first.px),
                  height: Math.abs(last.py - first.py),
                };
              })()}
              fill="none"
              stroke={color}
              strokeWidth={3}
            />
          ) : (
            <polyline
              points={stroke
                .map(([x, y]) => {
                  const p = normalizedToOverlay(x, y, box, metrics);
                  return `${p.px},${p.py}`;
                })
                .join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )
        ) : null}
        {selected && selectedOverlay ? (
          <g data-testid="open-design-annotation-selection">
            <rect
              {...selectedOverlay}
              fill="none"
              stroke="#2563eb"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              pointerEvents="none"
            />
            {canScale
              ? (
                  [
                    ["nw", selectedOverlay.x, selectedOverlay.y, "nwse-resize"],
                    [
                      "ne",
                      selectedOverlay.x + selectedOverlay.width,
                      selectedOverlay.y,
                      "nesw-resize",
                    ],
                    [
                      "sw",
                      selectedOverlay.x,
                      selectedOverlay.y + selectedOverlay.height,
                      "nesw-resize",
                    ],
                    [
                      "se",
                      selectedOverlay.x + selectedOverlay.width,
                      selectedOverlay.y + selectedOverlay.height,
                      "nwse-resize",
                    ],
                  ] as Array<[HandleId, number, number, string]>
                ).map(([handle, cx, cy, cursor]) => (
                  <circle
                    key={handle}
                    data-annotation-handle={handle}
                    cx={cx}
                    cy={cy}
                    r={5}
                    fill="#fff"
                    stroke="#2563eb"
                    strokeWidth={1.5}
                    pointerEvents="all"
                    style={{ cursor }}
                    onPointerDown={(event) => {
                      if (selected) startDrag(selected, event, "scale", handle);
                    }}
                  />
                ))
              : null}
          </g>
        ) : null}
        {elementTargetOverlay ? (
          <rect
            data-testid="open-design-element-target"
            {...elementTargetOverlay}
            fill="rgba(34,197,94,.10)"
            stroke="#22c55e"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            pointerEvents="none"
          />
        ) : null}
        {elementSelOverlay ? (
          <rect
            data-testid="open-design-element-selection"
            {...elementSelOverlay}
            fill="rgba(37,99,235,.08)"
            stroke="#2563eb"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        ) : null}
      </svg>
      {textAt ? (
        <div
          className="pointer-events-auto absolute z-20 flex w-56 flex-col gap-1 rounded-md border border-border bg-background p-2 shadow-lg"
          style={{ left: textAt.px, top: textAt.py }}
          data-testid="open-design-text-annotation"
        >
          <textarea
            autoFocus
            aria-label="标注文本"
            value={textValue}
            rows={2}
            maxLength={500}
            onChange={(event) => setTextValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const text = textValue.trim();
                if (text) {
                  onCreateAnnotation({
                    kind: "text",
                    text,
                    points: [
                      [textAt.x, textAt.y],
                      [textAt.x, textAt.y],
                    ],
                  });
                  setTextAt(null);
                  setTextValue("");
                }
              } else if (event.key === "Escape") {
                setTextAt(null);
                setTextValue("");
              }
            }}
            className="w-full resize-none rounded border border-border bg-surface p-1.5 text-ui-caption outline-none"
          />
          <div className="flex justify-end gap-1">
            <button
              type="button"
              className="rounded px-2 py-1 text-ui-caption text-foreground-subtle hover:bg-hover"
              onClick={() => {
                setTextAt(null);
                setTextValue("");
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded bg-primary px-2 py-1 text-ui-caption text-primary-foreground disabled:opacity-50"
              disabled={!textValue.trim()}
              onClick={() => {
                const text = textValue.trim();
                if (!text) return;
                onCreateAnnotation({
                  kind: "text",
                  text,
                  points: [
                    [textAt.x, textAt.y],
                    [textAt.x, textAt.y],
                  ],
                });
                setTextAt(null);
                setTextValue("");
              }}
            >
              添加
            </button>
          </div>
        </div>
      ) : null}
      {comments
        .filter((comment) => comment.status === "open")
        .map((comment, index) => {
          const live = rects[comment.anchor.path];
          // 存的矩形是文档坐标；锚点失效时按当前滚动量折算回视口位置。
          const source = live ?? {
            ...comment.anchor.rect,
            x: comment.anchor.rect.x - metrics.sx,
            y: comment.anchor.rect.y - metrics.sy,
          };
          const spot = frameRectToOverlay(source, box, metrics);
          return (
            <button
              key={comment.id}
              type="button"
              data-design-comment-pin={comment.id}
              title={live ? comment.body : `${comment.body} · 锚点已失效`}
              onClick={() => onPickComment(comment.id)}
              className="pointer-events-auto absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full rounded-bl-none bg-primary text-ui-caption font-semibold text-primary-foreground shadow-md"
              style={{ left: spot.left, top: spot.top + spot.height / 2 }}
            >
              {index + 1}
            </button>
          );
        })}
    </div>
  );
}

function AnnotationShape({
  annotation,
  points: sourcePoints,
  box,
  metrics,
  eraseMode,
  adjustMode,
  markIndex,
  onErase,
  onStartDrag,
}: {
  annotation: DesignReviewAnnotation;
  points: Array<[number, number]>;
  box: OverlayBox;
  metrics: FrameMetrics;
  eraseMode: boolean;
  adjustMode: boolean;
  markIndex: number;
  onErase: (id: string) => void;
  onStartDrag: (event: React.PointerEvent) => void;
}) {
  const pts = sourcePoints.map(([x, y]) =>
    normalizedToOverlay(x, y, box, metrics),
  );
  // 笔迹本身只有 1px 命中面；补一条透明的粗线专门吃点击。
  const hit = eraseMode
    ? {
        onPointerDown: (event: React.PointerEvent) => {
          event.stopPropagation();
          onErase(annotation.id);
        },
        stroke: "transparent",
        strokeWidth: 12,
        style: { cursor: "pointer" as const },
      }
    : adjustMode
      ? {
          onPointerDown: onStartDrag,
          stroke: "transparent",
          strokeWidth: 12,
          style: { cursor: "move" as const },
        }
      : {};
  const hitEnabled = eraseMode || adjustMode;
  if (annotation.kind === "mark" && pts.length >= 1) {
    const point = pts[0] as { px: number; py: number };
    return (
      <g>
        <circle
          cx={point.px}
          cy={point.py}
          r={10}
          fill={annotation.color}
          stroke="#fff"
          strokeWidth={2}
        />
        <text
          x={point.px}
          y={point.py}
          fill="#fff"
          fontSize={11}
          textAnchor="middle"
          dominantBaseline="central"
          fontWeight={600}
        >
          {markIndex}
        </text>
        <circle
          data-annotation-hit={annotation.id}
          cx={point.px}
          cy={point.py}
          r={12}
          fill="transparent"
          pointerEvents={hitEnabled ? "all" : "none"}
          style={hitEnabled ? { cursor: eraseMode ? "pointer" : "move" } : undefined}
          onPointerDown={hitEnabled ? hit.onPointerDown : undefined}
        />
      </g>
    );
  }
  if (annotation.kind === "text" && pts.length >= 1) {
    const point = pts[0] as { px: number; py: number };
    const lines = (annotation.text ?? "").split(/\r?\n/u);
    return (
      <g>
        <text
          x={point.px}
          y={point.py}
          fill={annotation.color}
          fontSize={14}
          fontFamily="system-ui, sans-serif"
          style={{ paintOrder: "stroke", stroke: "#fff", strokeWidth: 4 }}
        >
          {lines.map((line, index) => (
            <tspan key={index} x={point.px} dy={index === 0 ? 0 : 16}>
              {line}
            </tspan>
          ))}
        </text>
        <rect
          data-annotation-hit={annotation.id}
          x={point.px - 2}
          y={point.py - 14}
          width={Math.max(
            60,
            Math.max(...lines.map((line) => line.length)) * 8,
          )}
          height={Math.max(20, lines.length * 16)}
          fill="transparent"
          pointerEvents={hitEnabled ? "all" : "none"}
          style={hitEnabled ? { cursor: eraseMode ? "pointer" : "move" } : undefined}
          onPointerDown={hitEnabled ? hit.onPointerDown : undefined}
        />
      </g>
    );
  }
  if (annotation.kind === "rect" && pts.length >= 2) {
    const first = pts[0] as { px: number; py: number };
    const last = pts[pts.length - 1] as { px: number; py: number };
    const frame = {
      x: Math.min(first.px, last.px),
      y: Math.min(first.py, last.py),
      width: Math.abs(last.px - first.px),
      height: Math.abs(last.py - first.py),
    };
    return (
      <g>
        <rect
          {...frame}
          fill="none"
          stroke={annotation.color}
          strokeWidth={annotation.strokeWidth}
        />
        <rect
          data-annotation-hit={annotation.id}
          {...frame}
          fill="none"
          pointerEvents={hitEnabled ? "stroke" : "none"}
          {...hit}
        />
      </g>
    );
  }
  const points = pts.map((p) => `${p.px},${p.py}`).join(" ");
  return (
    <g>
      <polyline
        points={points}
        fill="none"
        stroke={annotation.color}
        strokeWidth={annotation.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        data-annotation-hit={annotation.id}
        points={points}
        fill="none"
        pointerEvents={hitEnabled ? "stroke" : "none"}
        {...hit}
      />
    </g>
  );
}
