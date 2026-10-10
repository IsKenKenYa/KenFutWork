/**
 * 动态 UI：对话流里的**数据图表**块（` ```viz ` fenced block，JSON spec）。
 *
 * 为什么放在共享包：Design 的对话（react-markdown）与 Code 的对话（@zcode/ui 的
 * Streamdown）都要渲染同一种块——两处各写一份图表实现就是「第二十份复制」。
 * 这里只用 **纯 SVG + inline style + currentColor**，不引图表库、不依赖 Tailwind
 * 扫描（两个宿主的构建链都能直接吃）。
 *
 * 口径（与工具结果里的图表资产同一条纪律）：
 * - **坏 spec 不抛异常**：解析失败返回 null，调用方回落成代码块（对话不能因为一段
 *   JSON 写错就整条消息炸掉）；
 * - **不做任意 HTML/JS**：只有 bar / line / pie 三种图，没有 iframe、没有脚本执行面；
 * - 数值只做「画得出来」的校验（有限数、非负的饼图值），不做业务单位换算。
 */

export interface VizPoint {
  label: string;
  value: number;
}

export interface VizSpec {
  /** 图类型：柱 / 折线 / 饼。 */
  type: "bar" | "line" | "pie";
  /** 标题（可选）。 */
  title?: string;
  /** 数据点（1–32 条；超出只取前 32 条，避免长尾把图压成线）。 */
  data: VizPoint[];
  /** 单位后缀（可选，如 `ms` / `MB`）。 */
  unit?: string;
}

const MAX_POINTS = 32;

/** 解析 `viz` 块的 JSON spec；坏输入一律回 null（调用方回落代码块）。 */
export function parseVizSpec(text: string): VizSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as {
    type?: unknown;
    title?: unknown;
    unit?: unknown;
    data?: unknown;
  };
  const type = candidate.type;
  if (type !== "bar" && type !== "line" && type !== "pie") return null;
  if (!Array.isArray(candidate.data)) return null;
  const data: VizPoint[] = [];
  for (const item of candidate.data.slice(0, MAX_POINTS)) {
    if (!item || typeof item !== "object") continue;
    const point = item as { label?: unknown; value?: unknown };
    const value =
      typeof point.value === "number" ? point.value : Number(point.value);
    if (!Number.isFinite(value)) continue;
    if (type === "pie" && value < 0) continue;
    data.push({
      label:
        typeof point.label === "string"
          ? point.label
          : String(point.label ?? ""),
      value,
    });
  }
  if (data.length === 0) return null;
  return {
    type,
    data,
    ...(typeof candidate.title === "string" && candidate.title
      ? { title: candidate.title }
      : {}),
    ...(typeof candidate.unit === "string" && candidate.unit
      ? { unit: candidate.unit }
      : {}),
  };
}

/** 数值显示：整数原样，小数留两位（图表标签不写科学计数）。 */
function formatValue(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit ? `${text}${unit}` : text;
}

const PALETTE = [
  "#3b82f6",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
];

const AXIS = "currentColor";

/** 柱状图：横向柱（标签在左，长值不被压扁）。 */
function BarChart({ spec }: { spec: VizSpec }) {
  const max = Math.max(...spec.data.map((point) => Math.abs(point.value)), 0);
  const scale = max > 0 ? max : 1;
  const rowHeight = 26;
  const height = spec.data.length * rowHeight + 8;
  return (
    <svg
      viewBox={`0 0 320 ${height}`}
      role="img"
      aria-label={spec.title ?? "数据图表"}
      style={{ width: "100%", maxWidth: 480, height: "auto", display: "block" }}
    >
      {spec.data.map((point, index) => {
        const width = Math.max(2, (Math.abs(point.value) / scale) * 190);
        const y = index * rowHeight + 6;
        return (
          <g key={`${point.label}-${index}`}>
            <text
              x={0}
              y={y + 13}
              fontSize={11}
              fill={AXIS}
              opacity={0.75}
              style={{ fontFamily: "inherit" }}
            >
              {point.label.length > 10
                ? `${point.label.slice(0, 10)}…`
                : point.label}
            </text>
            <rect
              x={92}
              y={y + 3}
              width={width}
              height={14}
              rx={3}
              fill={PALETTE[index % PALETTE.length]}
              opacity={0.85}
            />
            <text
              x={92 + width + 6}
              y={y + 13}
              fontSize={11}
              fill={AXIS}
              opacity={0.9}
              style={{ fontFamily: "inherit" }}
            >
              {formatValue(point.value, spec.unit)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 折线图：等距横轴 + 点标记 + 末点数值。 */
function LineChart({ spec }: { spec: VizSpec }) {
  const width = 320;
  const height = 140;
  const padX = 24;
  const padY = 16;
  const values = spec.data.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step =
    spec.data.length > 1 ? (width - padX * 2) / (spec.data.length - 1) : 0;
  const points = spec.data.map((point, index) => {
    const x = padX + index * step;
    const y = padY + (1 - (point.value - min) / span) * (height - padY * 2);
    return { x, y, point };
  });
  const path = points
    .map((entry, index) => `${index === 0 ? "M" : "L"}${entry.x} ${entry.y}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height + 18}`}
      role="img"
      aria-label={spec.title ?? "数据图表"}
      style={{ width: "100%", maxWidth: 480, height: "auto", display: "block" }}
    >
      <line
        x1={padX}
        y1={height - padY}
        x2={width - padX}
        y2={height - padY}
        stroke={AXIS}
        opacity={0.25}
      />
      <path d={path} fill="none" stroke={PALETTE[0]} strokeWidth={2} />
      {points.map((entry, index) => (
        <g key={`${entry.point.label}-${index}`}>
          <circle cx={entry.x} cy={entry.y} r={3} fill={PALETTE[0]} />
          {index === points.length - 1 ? (
            <text
              x={entry.x}
              y={entry.y - 6}
              fontSize={11}
              textAnchor="end"
              fill={AXIS}
              opacity={0.9}
              style={{ fontFamily: "inherit" }}
            >
              {formatValue(entry.point.value, spec.unit)}
            </text>
          ) : null}
          <text
            x={entry.x}
            y={height + 10}
            fontSize={10}
            textAnchor="middle"
            fill={AXIS}
            opacity={0.7}
            style={{ fontFamily: "inherit" }}
          >
            {entry.point.label.length > 6
              ? `${entry.point.label.slice(0, 6)}…`
              : entry.point.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** 饼图：strokeDasharray 分段（与设置页「模型用量」环图同一手法）。 */
function PieChart({ spec }: { spec: VizSpec }) {
  const total = spec.data.reduce((sum, point) => sum + point.value, 0);
  if (total <= 0) return null;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <svg
        viewBox="0 0 100 100"
        role="img"
        aria-label={spec.title ?? "数据图表"}
        style={{ width: 96, height: 96, flexShrink: 0 }}
      >
        {spec.data.map((point, index) => {
          const fraction = point.value / total;
          const dash = fraction * circumference;
          const segment = (
            <circle
              key={`${point.label}-${index}`}
              cx={50}
              cy={50}
              r={radius}
              fill="none"
              stroke={PALETTE[index % PALETTE.length]}
              strokeWidth={16}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 50 50)"
              opacity={0.9}
            />
          );
          offset += dash;
          return segment;
        })}
      </svg>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gap: 4,
          fontSize: 12,
        }}
      >
        {spec.data.map((point, index) => (
          <li
            key={`${point.label}-legend-${index}`}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: PALETTE[index % PALETTE.length],
                display: "inline-block",
              }}
            />
            <span style={{ opacity: 0.85 }}>{point.label}</span>
            <span style={{ opacity: 0.6 }}>
              {formatValue(point.value, spec.unit)}（
              {Math.round((point.value / total) * 100)}%）
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 渲染一块 `viz` 图（spec 已经过 `parseVizSpec` 校验）。 */
export function VizBlock({ spec }: { spec: VizSpec }) {
  return (
    <figure
      style={{
        margin: "12px 0",
        padding: "12px 14px",
        border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
        borderRadius: 10,
        background: "color-mix(in srgb, currentColor 4%, transparent)",
      }}
    >
      {spec.title ? (
        <figcaption style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
          {spec.title}
        </figcaption>
      ) : null}
      {spec.type === "bar" ? <BarChart spec={spec} /> : null}
      {spec.type === "line" ? <LineChart spec={spec} /> : null}
      {spec.type === "pie" ? <PieChart spec={spec} /> : null}
    </figure>
  );
}
