"use client";

import { Archive, MoreHorizontal, Pencil, Trash2, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** 侧栏行组件：行内重命名 + hover「⋯」菜单（重命名/归档/删除）。 */

export interface SidebarRowProps {
  label: string;
  active?: boolean;
  icon?: React.ReactNode;
  onOpen: () => void;
  onRename: (next: string) => void;
  onArchive?: () => void;
  /** 归档行的恢复动作；提供时菜单第一项为「恢复」 */
  onRestore?: () => void;
  onDelete: () => void;
}

export function SidebarRow({
  label,
  active,
  icon,
  onOpen,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}: SidebarRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(label);
      // 等输入框挂载后聚焦并全选
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, label]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== label) onRename(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label="重命名"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    );
  }

  return (
    <div
      className="group/row relative flex items-center"
      data-active={active ? "true" : undefined}
    >
      <button
        type="button"
        onClick={onOpen}
        data-active={active}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted data-[active=true]:bg-muted"
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`${label} 的操作菜单`}
          className="absolute right-1 hidden rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground group-hover/row:block data-[popup-open]:block"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-32">
          {onRestore ? (
            <DropdownMenuItem onClick={onRestore}>
              <Undo2 className="size-4" /> 恢复
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <Pencil className="size-4" /> 重命名
            </DropdownMenuItem>
          )}
          {onArchive ? (
            <DropdownMenuItem onClick={onArchive}>
              <Archive className="size-4" /> 归档
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 className="size-4" /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
