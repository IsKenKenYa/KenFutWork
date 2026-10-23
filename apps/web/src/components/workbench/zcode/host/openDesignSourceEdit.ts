/**
 * 源文本上的元素编辑（可视化编辑的落笔处）。
 *
 * 编辑**不**从实时 DOM 往回序列化：设计里的脚本会把运行时状态（渲染出来的列表、
 * 展开的菜单）留在 DOM 里，序列化等于把运行时烤进文件。源文本才是真相——桥只负责
 * 告诉我们「哪个元素、什么坐标」，改动一律重放到源文本上（同一套 DOMParser，
 * 因此 CSS 路径两侧解析出的树形状一致）。
 */

export interface OpenDesignElementEdit {
  /** 桥给出的 CSS 路径（`#id` 或 `body > div:nth-of-type(2) > p`）。 */
  path: string;
  /** 替换整个元素的 outerHTML；省略则只改样式。 */
  html?: string;
  style?: { color?: string; backgroundColor?: string };
}

function query(root: Document, path: string): Element | null {
  if (!path) return null;
  // 只有裸 `#id` 才走 getElementById；`#app > h1` 这类复合路径必须按选择器解析。
  if (/^#[\w-]+$/u.test(path)) return root.getElementById(path.slice(1));
  try {
    return root.querySelector(path);
  } catch {
    return null;
  }
}

/**
 * 把一段标记解析成**惰性文档**里的元素再搬进目标文档。
 *
 * 不用 `div.innerHTML = …`：那是往本文档（本仓 origin）里插节点，`<img onerror>`
 * 这类载荷在插入瞬间就会发起加载甚至执行。DOMParser 的文档不加载资源、不跑脚本，
 * 只有 importNode 之后才进活文档。
 */
function parseFragment(doc: Document, markup: string): Element | null {
  const inert = new DOMParser().parseFromString(markup, "text/html");
  const first = inert.body?.firstElementChild;
  return first ? (doc.importNode(first, true) as Element) : null;
}

function serialize(doc: Document): string {
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/** 检视器初始读数：源文本里这个元素的 HTML。 */
export function readElementHtml(
  sourceHtml: string,
  path: string,
): string | null {
  const doc = new DOMParser().parseFromString(sourceHtml, "text/html");
  return query(doc, path)?.outerHTML ?? null;
}

/**
 * 把编辑应用到源文本；返回 null 表示这个路径在当前正文里找不到元素
 * （版本变了，或设计里的脚本重排过结构）——调用方如实提示，不猜个位置写回去。
 */
export function applyElementEdit(
  sourceHtml: string,
  edit: OpenDesignElementEdit,
): string | null {
  const doc = new DOMParser().parseFromString(sourceHtml, "text/html");
  let target = query(doc, edit.path);
  const replacement =
    edit.html === undefined ? null : parseFragment(doc, edit.html);
  if (!target && replacement?.id) target = doc.getElementById(replacement.id);
  if (!target || (edit.html !== undefined && !replacement)) return null;
  // 样式只挂在 HTMLElement 上：SVG 元素拿不到 style，宁可如实说找不到，不写半份改动。
  if (!(target instanceof HTMLElement)) return null;
  let next: HTMLElement = target;
  if (replacement) {
    if (!(replacement instanceof HTMLElement)) return null;
    next = replacement;
    target.replaceWith(replacement);
  }
  if (edit.style?.color !== undefined) next.style.color = edit.style.color;
  if (edit.style?.backgroundColor !== undefined) {
    next.style.backgroundColor = edit.style.backgroundColor;
  }
  return serialize(doc);
}
