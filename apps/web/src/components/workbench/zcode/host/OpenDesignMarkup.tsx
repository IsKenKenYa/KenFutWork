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

/** 一条新标注落笔后的最小信息（作用域由面板补齐）。 */
export interface OpenDesignDraftAnnotation {
  points: [number, number][];
  kind: "pen" | "rect" | "text" | "mark";
  text?: string;
}

/**
 * 画布上的评审覆盖层：评论图钉 + 标注笔迹。
 *
 * 它浮在 iframe 之上、按桥回传的矩形换算落点，因此图钉与笔迹贴的是**设计内容**
 * 而不是屏幕：缩放、换设备视口、文档内滚动都跟得上。
 * 非标注态整层 `pointer-events:none`，不挡画布自己的交互。
 */
export function OpenDesignMarkup({
  comments,
  annotations,
  rects,
  box,
  metrics,
  drawing,
  annotationKind = "pen",
  color,
  onPickComment,
  onCreateAnnotation,
  onDeleteAnnotation,
}: {
  comments: DesignReviewComment[];
  annotations: DesignReviewAnnotation[];
  /** 路径 → 那一侧的视口矩形；null = 这个锚点在当前正文里已经找不到了。 */
  rects: Record<string, { h: number; w: number; x: number; y: number } | null>;
  box: OverlayBox;
  metrics: FrameMetrics;
  /** 标注态才吃鼠标事件。 */
  drawing: boolean;
  annotationKind?: "pen" | "rect" | "text" | "mark";
  color: string;
  onPickComment: (commentId: string) => void;
  onCreateAnnotation: (draft: OpenDesignDraftAnnotation) => void;
  /** 标注态下点已有笔迹即擦除——不留一个「清空标注」的大按钮误伤别人的笔迹。 */
  onDeleteAnnotation: (id: string) => void;
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

  useEffect(() => {
    if (drawing) return;
    setTextAt(null);
    setTextValue("");
  }, [drawing]);

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

  return (
    <div
      data-testid="open-design-markup"
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      <svg
        ref={svgRef}
        className={`absolute inset-0 size-full ${
          drawing ? "pointer-events-auto cursor-crosshair" : ""
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
            : undefined
        }
      >
        {annotations.map((annotation, index) => (
          <AnnotationShape
            key={annotation.id}
            annotation={annotation}
            box={box}
            metrics={metrics}
            erasable={drawing}
            markIndex={
              annotation.kind === "mark"
                ? annotations
                    .slice(0, index + 1)
                    .filter((item) => item.kind === "mark").length
                : 0
            }
            onDelete={onDeleteAnnotation}
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
  box,
  metrics,
  erasable,
  markIndex,
  onDelete,
}: {
  annotation: DesignReviewAnnotation;
  box: OverlayBox;
  metrics: FrameMetrics;
  erasable: boolean;
  markIndex: number;
  onDelete: (id: string) => void;
}) {
  const pts = annotation.points.map(([x, y]) =>
    normalizedToOverlay(x, y, box, metrics),
  );
  // 笔迹本身只有 1px 命中面；补一条透明的粗线专门吃点击。
  const eraser = erasable
    ? {
        onPointerDown: (event: React.PointerEvent) => {
          event.stopPropagation();
          onDelete(annotation.id);
        },
        stroke: "transparent",
        strokeWidth: 12,
        style: { cursor: "pointer" as const },
      }
    : {};
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
          cx={point.px}
          cy={point.py}
          r={12}
          fill="transparent"
          pointerEvents={erasable ? "all" : "none"}
          style={{ cursor: erasable ? "pointer" : undefined }}
          onPointerDown={erasable ? eraser.onPointerDown : undefined}
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
          x={point.px - 2}
          y={point.py - 14}
          width={Math.max(
            60,
            Math.max(...lines.map((line) => line.length)) * 8,
          )}
          height={Math.max(20, lines.length * 16)}
          fill="transparent"
          pointerEvents={erasable ? "all" : "none"}
          style={{ cursor: erasable ? "pointer" : undefined }}
          onPointerDown={erasable ? eraser.onPointerDown : undefined}
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
          {...frame}
          fill="none"
          pointerEvents={erasable ? "stroke" : "none"}
          {...eraser}
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
        points={points}
        fill="none"
        pointerEvents={erasable ? "stroke" : "none"}
        {...eraser}
      />
    </g>
  );
}
