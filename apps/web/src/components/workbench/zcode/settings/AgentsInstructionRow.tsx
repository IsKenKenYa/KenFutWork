import {
  FileDisplayIcon,
  resolveFileDisplayDescriptor,
} from "@zui/lib/fileDisplay.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
import { WorkspaceEditorButtonGroup } from "@zui/WorkspaceEditorButtonGroup.js";

/**
 * 设置 → 智能体：项目 AGENTS.md 的编辑入口。
 *
 * Code 运行时由 `loadCodeProjectContext()` 读取项目根目录的 AGENTS.md 并注入提示；
 * 这里把同一个路径交给宿主「打开方式」按钮组，用户在已安装软件里编辑并保存。
 */
export function resolveAgentsInstructionPath(workspacePath: string): string {
  const separator = workspacePath.includes("\\") ? "\\" : "/";
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  return `${trimmed}${separator}AGENTS.md`;
}

export function AgentsInstructionRow({
  workspacePath,
}: {
  workspacePath: string;
}) {
  const filePath = resolveAgentsInstructionPath(workspacePath);
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
        control={<WorkspaceEditorButtonGroup workspaceAbsPath={filePath} />}
      />
    </SettingsGroupCard>
  );
}
