/**
 * 设计 HTML → PNG（foreignObject 光栅化）。
 *
 * 上游预览路由是**跨源纯文件**（没有可用的快照桥），而 DOM→位图没有原生 API——
 * 这里把设计文档序列化进 SVG 再画到 canvas。代价：脚本不执行、外链资源不加载
 * （自包含单文件正是上游产物的常见形态，够用）；含跨源资源的画布会抛错，如实上报。
 */

/** 序列化成 SVG（纯函数，单测锁：去脚本、保留样式、固定尺寸）。 */
export function buildDesignSnapshotSvg(
  html: string,
  width: number,
  height: number,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const script of doc.querySelectorAll("script")) script.remove();
  const serialized = new XMLSerializer().serializeToString(doc.documentElement);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("设计页面渲染失败，无法截图。"));
    image.src = src;
  });
}

/** 光栅化上限：2 倍缩放到顶，截图主要给对话看，不做印刷级尺寸。 */
const RASTER_SCALE_LIMIT = 2;

export async function rasterizeDesignHtml(
  html: string,
  width: number,
  height: number,
): Promise<string> {
  const image = await loadImage(buildDesignSnapshotSvg(html, width, height));
  const deviceScale =
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const scale = Math.min(deviceScale, RASTER_SCALE_LIMIT);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境不支持画布截图。");
  // 设计页多自带底色；没有时也别给透明底（对话里看不清）。
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    throw new Error("画布含外部资源，截图失败；可在 OpenDesign 里导出。");
  }
}
