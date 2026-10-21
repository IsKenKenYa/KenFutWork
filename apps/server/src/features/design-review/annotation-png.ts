import { deflateSync } from "node:zlib";
import type { DesignReviewAnnotation } from "@kenfutwork/shared";

/**
 * 标注笔迹 → PNG（「同步到引擎」用）：把归一化坐标的 pen/rect 笔迹渲染到一张
 * 透明底 RGBA 位图并编码成 PNG。**纯 JS + node:zlib**——不引 canvas 原生模块
 * （SEA 打包约束：原生模块必须懒加载，为一张评审示意图不值当）。
 *
 * 精度口径：这是给引擎“看得见标注在哪”的参考图，不是像素级复刻——宽度取
 * strokeWidth×2 并夹在 2..12px，线条用圆点盖章近似圆头笔。
 */

const PNG_WIDTH = 1600;
const PNG_HEIGHT = 1000;

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i += 1) {
    c ^= bytes[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/** #rgb / #rgba / #rrggbb / #rrggbbaa → [r,g,b,a]（a 归一 0..1）。 */
function parseColor(value: string): [number, number, number, number] {
  const hex = value.trim().replace(/^#/, "");
  if (hex.length === 3 || hex.length === 4) {
    const r = Number.parseInt(hex[0]! + hex[0]!, 16);
    const g = Number.parseInt(hex[1]! + hex[1]!, 16);
    const b = Number.parseInt(hex[2]! + hex[2]!, 16);
    const a =
      hex.length === 4 ? Number.parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
    return [r, g, b, a];
  }
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return [
    Number.isFinite(r) ? r : 255,
    Number.isFinite(g) ? g : 0,
    Number.isFinite(b) ? b : 255,
    Number.isFinite(a) ? a : 1,
  ];
}

function stamp(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
  color: [number, number, number, number],
): void {
  const alpha = color[3];
  const x0 = Math.max(0, Math.floor(x - radius));
  const x1 = Math.min(width - 1, Math.ceil(x + radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const y1 = Math.min(height - 1, Math.ceil(y + radius));
  for (let py = y0; py <= y1; py += 1) {
    for (let px = x0; px <= x1; px += 1) {
      const dx = px - x;
      const dy = py - y;
      if (dx * dx + dy * dy > radius * radius) continue;
      const at = (py * width + px) * 4;
      // 简单 alpha 合成（源 over）
      pixels[at] = Math.round(color[0] * alpha + pixels[at]! * (1 - alpha));
      pixels[at + 1] = Math.round(
        color[1] * alpha + pixels[at + 1]! * (1 - alpha),
      );
      pixels[at + 2] = Math.round(
        color[2] * alpha + pixels[at + 2]! * (1 - alpha),
      );
      pixels[at + 3] = Math.round(255 * alpha + pixels[at + 3]! * (1 - alpha));
    }
  }
}

function strokeLine(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  color: [number, number, number, number],
): void {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, radius * 0.4)),
  );
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    stamp(
      pixels,
      width,
      height,
      x0 + (x1 - x0) * t,
      y0 + (y1 - y0) * t,
      radius,
      color,
    );
  }
}

export function renderAnnotationsPng(
  annotations: DesignReviewAnnotation[],
  size: { width?: number; height?: number } = {},
): Buffer {
  const width = Math.max(
    200,
    Math.min(4096, Math.round(size.width ?? PNG_WIDTH)),
  );
  const height = Math.max(
    200,
    Math.min(4096, Math.round(size.height ?? PNG_HEIGHT)),
  );
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (const annotation of annotations) {
    const color = parseColor(annotation.color);
    const radius = Math.max(1, Math.min(6, annotation.strokeWidth));
    const pts = annotation.points.map(
      ([nx, ny]) => [nx * width, ny * height] as const,
    );
    if (annotation.kind === "rect" && pts.length >= 2) {
      const [ax, ay] = pts[0]!;
      const [bx, by] = pts[pts.length - 1]!;
      const x0 = Math.min(ax, bx);
      const x1 = Math.max(ax, bx);
      const y0 = Math.min(ay, by);
      const y1 = Math.max(ay, by);
      strokeLine(pixels, width, height, x0, y0, x1, y0, radius, color);
      strokeLine(pixels, width, height, x1, y0, x1, y1, radius, color);
      strokeLine(pixels, width, height, x1, y1, x0, y1, radius, color);
      strokeLine(pixels, width, height, x0, y1, x0, y0, radius, color);
      continue;
    }
    for (let i = 1; i < pts.length; i += 1) {
      const [ax, ay] = pts[i - 1]!;
      const [bx, by] = pts[i]!;
      strokeLine(pixels, width, height, ax, ay, bx, by, radius, color);
    }
  }
  // PNG 编码：RGBA（color type 6），每扫描行前置 filter 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
