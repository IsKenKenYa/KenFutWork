import {
  FileDisplayIcon,
  resolveFileDisplayDescriptor,
} from "@zui/lib/fileDisplay.js";
import { Button } from "@zui/components/ui/button.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
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

export function AgentsInstructionRow({
  filePath,
  onEdit,
}: {
  filePath: string;
  onEdit?: () => void;
}) {
  return (
    <SettingsGroupCard>
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
          <span className="block truncate font-mono text-ui-sm">
            {filePath}
          </span>
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
    </SettingsGroupCard>
  );
}
