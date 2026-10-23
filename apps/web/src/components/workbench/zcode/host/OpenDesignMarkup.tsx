import type {
  DesignReviewAnnotation,
  DesignReviewComment,
} from "@kenfutwork/shared";
import { useRef, useState } from "react";
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
  kind: "pen";
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
  color: string;
  onPickComment: (commentId: string) => void;
  onCreateAnnotation: (draft: OpenDesignDraftAnnotation) => void;
  /** 标注态下点已有笔迹即擦除——不留一个「清空标注」的大按钮误伤别人的笔迹。 */
  onDeleteAnnotation: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [stroke, setStroke] = useState<[number, number][] | null>(null);

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
                event.currentTarget.setPointerCapture(event.pointerId);
                setStroke([pointOf(event)]);
              }
            : undefined
        }
        onPointerMove={
          drawing
            ? (event) => {
                setStroke((current) =>
                  current ? [...current, pointOf(event)] : current,
                );
              }
            : undefined
        }
        onPointerUp={
          drawing
            ? () => {
                const points = stroke ?? [];
                setStroke(null);
                if (points.length > 1)
                  onCreateAnnotation({ kind: "pen", points });
              }
            : undefined
        }
      >
        {annotations.map((annotation) => (
          <AnnotationShape
            key={annotation.id}
            annotation={annotation}
            box={box}
            metrics={metrics}
            erasable={drawing}
            onDelete={onDeleteAnnotation}
          />
        ))}
        {stroke && stroke.length > 1 ? (
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
        ) : null}
      </svg>
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
  onDelete,
}: {
  annotation: DesignReviewAnnotation;
  box: OverlayBox;
  metrics: FrameMetrics;
  erasable: boolean;
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
