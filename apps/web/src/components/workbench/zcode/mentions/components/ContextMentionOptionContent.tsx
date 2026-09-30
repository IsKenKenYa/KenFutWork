/**
 * zcode 照搬：`@/mentions/components/ContextMentionOptionContent.tsx`（references/zcode/packages/ui/src/mentions/components/ContextMentionOptionContent.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */

import { FileDisplayInline } from "@zui/lib/fileDisplay";
import type { MentionItem } from "@zui/mentions/mentionTypes";
import { MessagesSquare } from "lucide-react";

export function ContextMentionOptionContent({
  item,
  workspacePath,
}: {
  item: MentionItem;
  workspacePath: string;
}) {
  return item.category === "files" ? (
    <FileDisplayInline
      path={item.data?.path ?? item.data?.relativePath ?? item.value}
      options={{
        basePath: workspacePath,
        // 这里只给 file/directory 传 kind，让 fileDisplay 继续按文件和文件夹图标渲染；
        // whiteboard 等非文件类候选不应该伪装成文件路径。
        kind:
          item.data?.kind === "file" || item.data?.kind === "directory"
            ? item.data.kind
            : undefined,
        showFilePath: true,
      }}
    />
  ) : (
    <span className="min-w-0 flex flex-1 items-center gap-2">
      <MessagesSquare className="size-3.5 shrink-0 text-foreground" />
      <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
        {item.label}
      </span>
      <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
        {item.description}
      </span>
    </span>
  );
}
