import type {
  IMemoryService,
  ProjectMemoryTrashItem,
} from "@zcode/services";
import { Button } from "@zui/components/ui/button.js";
import { SettingsGroupCard } from "@zui/settings/SettingsPageParts.js";
import { useCallback, useEffect, useState } from "react";

const REASON_LABEL: Record<ProjectMemoryTrashItem["reason"], string> = {
  duplicate: "重复合并",
  orphan: "孤立正文",
  "dangling-index": "索引悬挂",
};

function formatTrashedAt(milliseconds: number): string {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? String(milliseconds)
    : date.toLocaleString();
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "读取失败";
}

/** 设置页「回收区」：列出自动整理移走的正文与索引行，窗口内可恢复。 */
export function MemoryTrashSection({
  projectId,
  memoryService,
  onRestored,
}: {
  projectId: string;
  memoryService: Pick<
    IMemoryService,
    "listTrashedMemories" | "restoreTrashedMemory"
  >;
  onRestored?: () => void;
}) {
  const [items, setItems] = useState<ProjectMemoryTrashItem[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busyTrashId, setBusyTrashId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(null);
    setFailure(null);
    try {
      setItems(await memoryService.listTrashedMemories({ projectId }));
    } catch (error) {
      setItems([]);
      setFailure(readableError(error));
    }
  }, [memoryService, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (item: ProjectMemoryTrashItem) => {
    setBusyTrashId(item.trashId);
    setFailure(null);
    setResult(null);
    try {
      const restored = await memoryService.restoreTrashedMemory({
        projectId,
        trashId: item.trashId,
      });
      setResult(
        restored.fileName
          ? `已恢复为 ${restored.fileName}`
          : "索引行已恢复",
      );
      await load();
      onRestored?.();
    } catch (error) {
      setFailure(readableError(error));
    } finally {
      setBusyTrashId(null);
    }
  };

  return (
    <SettingsGroupCard>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-ui-base font-medium">回收区</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
          >
            重新读取
          </Button>
        </div>
        {failure ? (
          <p className="text-ui-sm text-foreground-subtle">{failure}</p>
        ) : null}
        {result ? (
          <p className="text-ui-sm text-foreground-subtle">{result}</p>
        ) : null}
        {items === null ? (
          <p className="text-ui-sm text-foreground-subtle">读取回收区…</p>
        ) : items.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtle">回收区没有条目</p>
        ) : (
          <ul className="space-y-2 text-ui-sm" data-testid="memory-trash-list">
            {items.map((item) => (
              <li
                key={item.trashId}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate">{item.title ?? item.fileName ?? "索引行"}</p>
                  <p className="text-ui-sm text-foreground-subtle">
                    {formatTrashedAt(item.trashedAt)} · {REASON_LABEL[item.reason]}
                  </p>
                </div>
                {item.restorable ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyTrashId === item.trashId}
                    onClick={() => void restore(item)}
                  >
                    {busyTrashId === item.trashId ? "恢复中…" : "恢复"}
                  </Button>
                ) : (
                  <span className="shrink-0 text-ui-sm text-foreground-subtle">
                    已过可恢复窗口
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsGroupCard>
  );
}
