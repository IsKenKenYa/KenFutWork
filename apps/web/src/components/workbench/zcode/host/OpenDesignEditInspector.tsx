import { useState } from "react";
import { Button } from "@zui/components/ui/button.js";
import type { OpenDesignHit } from "./openDesignRuntime.js";

/** 保存出去的编辑意图：源文本上的改动由调用方落笔（面板持有正文）。 */
export interface OpenDesignEditDraft {
  backgroundColor: string;
  color: string;
  html: string;
}

/**
 * 可视化编辑的检视器（对齐上游 FileViewer 的编辑面板）。
 *
 * 三个字段都是**留空即不改**：颜色留空不代表「透明」，而是「这条不动」——
 * 背景透明是合法值，得用旁边的「清除」显式表达。
 */
export function OpenDesignEditInspector({
  hit,
  busy,
  onCancel,
  onSave,
}: {
  hit: OpenDesignHit;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: OpenDesignEditDraft) => void;
}) {
  const [html, setHtml] = useState(hit.html);
  const [color, setColor] = useState("");
  const [backgroundColor, setBackgroundColor] = useState("");

  const dirty =
    html !== hit.html || color !== "" || backgroundColor !== "";

  return (
    <div
      data-testid="open-design-edit-inspector"
      className="absolute left-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[19rem] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
          {hit.tag}
        </span>
        <span className="shrink-0 text-ui-caption text-foreground-subtle">
          {hit.path.split(" ").slice(-1)[0]}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="关闭"
          onClick={onCancel}
        >
          ×
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <label className="mb-1 block text-ui-caption text-foreground-subtle">
          选中元素的 HTML
        </label>
        <textarea
          value={html}
          spellCheck={false}
          onChange={(event) => setHtml(event.target.value)}
          className="h-28 w-full resize-y rounded-md border border-border bg-surface p-2 font-mono text-ui-caption"
        />
        <div className="mt-3 flex flex-col gap-2">
          <ColorField
            label="文本颜色"
            fallback={hit.color}
            value={color}
            onChange={setColor}
          />
          <ColorField
            label="背景"
            fallback={hit.backgroundColor}
            value={backgroundColor}
            onChange={setBackgroundColor}
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || !dirty}
          onClick={() =>
            onSave({
              html: html === hit.html ? hit.html : html,
              color,
              backgroundColor,
            })
          }
        >
          保存
        </Button>
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  /** 元素当前算出来的颜色，只作占位提示，不代表「已选」。 */
  fallback: string;
  onChange: (next: string) => void;
}) {
  const swatch = toHexColor(value || fallback);
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-ui-caption text-foreground-subtle">
        {label}
      </span>
      <input
        type="color"
        aria-label={`${label}取色`}
        value={swatch}
        onChange={(event) => onChange(event.target.value)}
        className="size-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
      />
      <input
        type="text"
        aria-label={label}
        value={value}
        placeholder={fallback || "不变"}
        onChange={(event) => onChange(event.target.value.trim())}
        className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-ui-caption"
      />
    </div>
  );
}

/** `<input type=color>` 只吃 #rrggbb：算出来的 rgb()/透明都要先折算。 */
function toHexColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/iu.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/iu.test(trimmed)) {
    return `#${[...trimmed.slice(1)].map((c) => c + c).join("")}`;
  }
  const parts = trimmed.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/u);
  if (!parts) return "#000000";
  const [, r, g, b] = parts;
  return `#${[r, g, b]
    .map((channel) =>
      Number(channel).toString(16).padStart(2, "0").slice(0, 2),
    )
    .join("")}`;
}
