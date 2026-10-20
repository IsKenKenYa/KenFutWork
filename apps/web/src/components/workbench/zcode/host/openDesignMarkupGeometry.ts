/**
 * 画布覆盖层与那一侧文档之间的坐标换算。
 *
 * 三件事叠在一起：iframe 元素被 CSS `zoom` 放过、设备视口把画布框成 390/820 的
 * 固定尺寸、设计文档自己还会滚动。所以「父页鼠标点」和「设计里的位置」不是
 * 1:1——必须用「元素宽 ÷ 内侧视口宽」当比例，再补上那一侧的滚动量。
 *
 * 存储一律用**文档归一化坐标**（0..1，相对文档全尺寸）：换视口、改缩放之后
 * 笔迹仍贴在内容上；相对屏幕存会在下一次缩放时整体错位。
 */

export interface OverlayBox {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface FrameMetrics {
  h: number;
  sx: number;
  sy: number;
  vh: number;
  vw: number;
  w: number;
}

/** 覆盖层像素 → 文档归一化坐标。 */
export function overlayToNormalized(
  point: { x: number; y: number },
  box: OverlayBox,
  metrics: FrameMetrics,
): [number, number] {
  if (metrics.vw <= 0 || metrics.vh <= 0 || box.width <= 0 || box.height <= 0) {
    return [0, 0];
  }
  const scaleX = box.width / metrics.vw;
  const scaleY = box.height / metrics.vh;
  const inFrameX = (point.x - box.left) / scaleX + metrics.sx;
  const inFrameY = (point.y - box.top) / scaleY + metrics.sy;
  return [
    clampRatio(inFrameX / metrics.w),
    clampRatio(inFrameY / metrics.h),
  ];
}

/** 文档归一化坐标 → 覆盖层像素（笔迹与图钉的落点）。 */
export function normalizedToOverlay(
  x: number,
  y: number,
  box: OverlayBox,
  metrics: FrameMetrics,
): { px: number; py: number } {
  const scaleX = box.width / (metrics.vw || 1);
  const scaleY = box.height / (metrics.vh || 1);
  return {
    px: box.left + (x * metrics.w - metrics.sx) * scaleX,
    py: box.top + (y * metrics.h - metrics.sy) * scaleY,
  };
}

/**
 * 桥回传的元素矩形（那一侧的视口坐标）→ 覆盖层矩形。
 *
 * 元素被滚出视口时坐标会是负的，覆盖层自然把它裁掉——不做「贴边常驻」，
 * 那会让图钉指着不存在的内容。
 */
export function frameRectToOverlay(
  rect: { h: number; w: number; x: number; y: number },
  box: OverlayBox,
  metrics: FrameMetrics,
): { height: number; left: number; top: number; width: number } {
  const scaleX = box.width / (metrics.vw || 1);
  const scaleY = box.height / (metrics.vh || 1);
  return {
    left: box.left + rect.x * scaleX,
    top: box.top + rect.y * scaleY,
    width: rect.w * scaleX,
    height: rect.h * scaleY,
  };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
