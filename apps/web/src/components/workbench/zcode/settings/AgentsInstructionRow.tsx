import { cn } from "@zui/components/lib/utils.js";
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
 * 智能体页的 AGENTS.md 入口：与内置智能体卡片同一张白卡、同一种行高。
 *
 * 为什么不再做页头内联：用户口径 2026-11-22「做成白色的卡片，和下面的内置智能体卡片
 * 一样的风格、一样的高度」。所以外形与 `renderAgentList` 完全一致——`rounded-xl` 白卡、
 * 同样的描边与 `px-4 py-3` 行内边距、同样的图标尺寸（size-9）与两行文字结构，
 * 把这一块当成「列表里的一行」来读，而不是页头附件。
 *
 * 路径按可用宽度截断（`truncate` + `title`）：完整路径在悬停时可见，换行会把卡片撑高、
 * 与内置智能体卡片的高度就对不上了。
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
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3",
        className,
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle">
        <FileDisplayIcon
          src={resolveFileDisplayDescriptor(filePath).fileIconSrc}
          size={16}
          className="size-4 shrink-0"
        />
      </div>
      <div className="min-w-0 flex-1">
        {/*
          标题行套一层 flex：内置智能体行的标题与徽标同在一条 flex 里，行盒按
          `text-ui-base` 算成 21px；直接放在块级容器里会继承父级 24px 行高，
          整张卡因此比智能体行高 3px。
        */}
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">
            AGENTS.md
          </span>
        </div>
        {/*
          路径行按内置智能体行的「两行描述」高度预留：那两行是
          `text-ui-sm` / 18px 行高 × 2 = 36px（实测），所以这里固定 `min-h-9`。
          不留高度会把整张卡压矮一截（实测 70 vs 84），用户口径要求一样高。
        */}
        <p
          className="mt-0.5 min-h-9 truncate font-mono text-ui-sm text-foreground-subtle"
          title={filePath}
        >
          {filePath}
        </p>
      </div>
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
