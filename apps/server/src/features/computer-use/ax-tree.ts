/**
 * AX 观察树的纯逻辑格式化（Computer Use 插件）。
 *
 * 形状对齐 ZCode CUA 的观察输出（只借形状，不复制实现）：
 * - 元素行 `[index] role title;value:v (states) actions=[...]`，深度优先展平、
 *   索引连续分配；text 角色显示 `title = value`，其余 `title;value:v`；
 * - `has_image:false` 表示本次观察没有要像素（不是失败）；
 * - 超预算时**优先裁最深**的行、保留祖先（模型寻址靠浅层结构），索引保留原值
 *   出现跳号，头部声明裁剪量——与 ZCode「树被裁剪时索引跳号」语义一致。
 */

export interface AxNode {
  /** 远端provider保持原观察索引；本地节点不设置，由遍历分配。 */
  index?: number;
  /** 归一化角色（executor 侧把 AX role 映射为 kind）。 */
  role: string;
  title?: string | null;
  value?: string | null;
  /** 可执行动作（如 AXPress / 拷贝）。 */
  actions?: string[];
  /** 状态标签（pressable / editable / disabled / focused）。 */
  states?: string[];
  children?: AxNode[];
}

export interface AxAppRef {
  pid?: number;
  bundleId?: string | null;
  name?: string | null;
}

export interface AxWindowRef {
  windowId?: number;
  title?: string | null;
  /** 诊断用全局屏幕坐标 [x, y, w, h]——永不作为动作坐标。 */
  bounds?: [number, number, number, number];
}

export interface FlattenedAxRow {
  index: number;
  depth: number;
  node: AxNode;
}

export interface AxStructuredContent {
  state_id: string;
  app: {
    bundle_id: string | null;
    pid: number | null;
    name: string | null;
    window_id: number | null;
  };
  window: {
    title: string | null;
    bounds: [number, number, number, number] | null;
    window_id: number | null;
  };
  has_image: false;
  snapshot_mode: "full";
  element_count: number;
  trimmed?: number;
}

export interface FormattedAxTree {
  text: string;
  structuredContent: AxStructuredContent;
  truncated: boolean;
  rows: Array<{ index: number; depth: number; node: Omit<AxNode, "children"> }>;
}

/** 深度优先展平，分配连续索引。 */
export function flattenAxTree(root: AxNode): FlattenedAxRow[] {
  const rows: FlattenedAxRow[] = [];
  const walk = (node: AxNode, depth: number): void => {
    rows.push({ index: node.index ?? rows.length, depth, node });
    for (const child of node.children ?? []) {
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

function elementLine(row: FlattenedAxRow): string {
  const n = row.node;
  let identity: string;
  if (n.title && n.value != null && n.value !== "") {
    identity =
      n.role === "text"
        ? `${n.title} = ${n.value}`
        : `${n.title};value:${n.value}`;
  } else if (n.value != null && n.value !== "") {
    identity = `= ${n.value}`;
  } else {
    identity = n.title ?? "";
  }
  const states = n.states?.length ? ` (${n.states.join(" ")})` : "";
  const actions = n.actions?.length ? ` actions=[${n.actions.join(",")}]` : "";
  return `${" ".repeat(row.depth * 2)}[${row.index}] ${n.role} ${identity}${states}${actions}`;
}

export function formatAxTree(input: {
  app: AxAppRef;
  window: AxWindowRef;
  root: AxNode;
  stateId: string;
  /** 文本预算（字节）；治理键注入，禁止调用方写字面量。 */
  maxBytes: number;
}): FormattedAxTree {
  const rows = flattenAxTree(input.root);

  const header = (elementCount: number, trimmed: number): string[] => {
    const appPart = [
      input.app.bundleId ?? "unknown",
      input.app.pid != null ? ` pid=${input.app.pid}` : "",
      input.app.name ? ` "${input.app.name}"` : "",
    ]
      .join("")
      .trim();
    const windowPart = [
      input.window.title ? `"${input.window.title}"` : "(无标题)",
      input.window.windowId != null
        ? ` window_id=${input.window.windowId}`
        : "",
    ].join("");
    const trimNote =
      trimmed > 0
        ? `（trimmed ${trimmed}：已按优先级裁剪，保留祖先，索引跳号）`
        : "";
    return [
      `app: ${appPart}`,
      `window: ${windowPart} elements (${elementCount})${trimNote}:`,
    ];
  };

  const byteLength = (lines: readonly string[]): number =>
    lines.join("\n").length;

  // 超预算：按深度降序丢弃（先裁最深），祖先行天然保留。
  let kept = rows;
  let trimmed = 0;
  if (
    byteLength([...header(rows.length, 0), ...rows.map(elementLine)]) >
    input.maxBytes
  ) {
    const byDepthDesc = [...rows].sort((a, b) => b.depth - a.depth);
    const dropped = new Set<FlattenedAxRow>();
    for (const row of byDepthDesc) {
      const candidate = rows.filter((r) => !dropped.has(r) && r !== row);
      dropped.add(row);
      trimmed += 1;
      if (
        byteLength([
          ...header(candidate.length, trimmed),
          ...candidate.map(elementLine),
        ]) <= input.maxBytes
      ) {
        kept = candidate;
        break;
      }
    }
    // 极小预算兜底：全裁到只剩根行仍超限时，保留根行（宁可截断文本也不给空观察）。
    if (kept === rows) {
      kept = rows.slice(0, 1);
    }
  }

  const text = [...header(kept.length, trimmed), ...kept.map(elementLine)].join(
    "\n",
  );

  return {
    text,
    structuredContent: {
      state_id: input.stateId,
      app: {
        bundle_id: input.app.bundleId ?? null,
        pid: input.app.pid ?? null,
        name: input.app.name ?? null,
        window_id: input.window.windowId ?? null,
      },
      window: {
        title: input.window.title ?? null,
        bounds: input.window.bounds ?? null,
        window_id: input.window.windowId ?? null,
      },
      has_image: false,
      snapshot_mode: "full",
      element_count: kept.length,
      ...(trimmed > 0 ? { trimmed } : {}),
    },
    truncated: trimmed > 0,
    rows: kept.map(({ index, depth, node }) => {
      const { children: _children, ...value } = node;
      return { index, depth, node: value };
    }),
  };
}
