import { Button } from "@zui/components/ui/button.js";
import {
  FileDisplayIcon,
  resolveFileDisplayDescriptor,
} from "@zui/lib/fileDisplay.js";
import { SettingsRow } from "@zui/settings/SettingsPageParts.js";
import { WorkspaceEditorButtonGroup } from "@zui/WorkspaceEditorButtonGroup.js";

/**
 * 设置 → 智能体：注入给智能体的 AGENTS.md 编辑入口。
 *
 * 用户作用域指向实例级默认文件（`<数据目录>/AGENTS.md`），工作区作用域指向
 * 项目根目录的 AGENTS.md。Code 运行时读同一路径并注入提示。
 */
export function resolveAgentsInstructionPath(workspacePath: string): string {
  const separator = workspacePath.includes("\\") ? "\\" : "/";
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  return `${trimmed}${separator}AGENTS.md`;
}

/**
 * 智能体页顶部的 AGENTS.md 入口：与页签 + 搜索**同一行**。
 *
 * 为什么不再是整张卡片：它是全页唯一的「全局文件」，独占一整行会让下面的
 * 作用域筛选与搜索被顶到第二屏；压成行内一段（图标 + 文件名 + 路径 + 编辑），
 * 与页签同一行时用户仍能一眼看到它在哪、点得到编辑。
 *
 * 路径按可用宽度截断（`truncate` + `title`）：页头空间有限，完整路径在悬停时可见，
 * 让路径换行会把这一行撑成两行，回到原来的问题。
 */
export function AgentsInstructionInline({
  filePath,
  onEdit,
  className,
}: {
  filePath: string;
  onEdit?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 ${className ?? ""}`}
    >
      <FileDisplayIcon
        src={resolveFileDisplayDescriptor(filePath).fileIconSrc}
        size={16}
        className="size-4 shrink-0"
      />
      <span className="shrink-0 text-ui-base font-medium text-foreground">
        AGENTS.md
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtle"
        title={filePath}
      >
        {filePath}
      </span>
      {onEdit ? (
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          编辑
        </Button>
      ) : null}
      <WorkspaceEditorButtonGroup workspaceAbsPath={filePath} />
    </div>
  );
}

/** 设置项表单里的 AGENTS.md 行（卡片形态；保留给需要独立分组的调用方）。 */
export function AgentsInstructionRow({
  filePath,
  onEdit,
}: {
  filePath: string;
  onEdit?: () => void;
}) {
  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface">
            <FileDisplayIcon
              src={resolveFileDisplayDescriptor(filePath).fileIconSrc}
              size={16}
              className="size-4 shrink-0"
            />
          </span>
          <span className="truncate">AGENTS.md</span>
        </span>
      }
      description={
        <span className="block truncate font-mono text-ui-sm">{filePath}</span>
      }
      control={
        <span className="flex items-center gap-2">
          {onEdit ? (
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              编辑
            </Button>
          ) : null}
          <WorkspaceEditorButtonGroup workspaceAbsPath={filePath} />
        </span>
      }
    />
  );
}
