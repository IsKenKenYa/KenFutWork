import { useRef, useState, type DragEvent } from "react";
import { FolderOpen, Loader2, Plus } from "lucide-react";
import { Button } from "@zui/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@zui/components/ui/dialog.js";
import { Input } from "@zui/components/ui/input.js";
import { cn } from "@zui/components/lib/utils.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@zui/lib/imeComposition.js";

/**
 * 顶栏 New 直接打开添加市场源对话框：收编原 AddMarketplacePopover 的
 * github/git/URL/本地路径（含拖放与目录选择）能力，零后端新增。
 */
export function AddMarketplaceSourceDialog({
  open,
  onOpenChange,
  onAddMarketplace,
  operationId,
  error,
  mode = "marketplace",
  unavailable = false,
  inspection,
  inspecting = false,
  installing = false,
  onInspectSource,
  onSourceChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddMarketplace: (source: string) => Promise<boolean>;
  operationId: string | null;
  error?: string | null;
  mode?: "marketplace" | "install";
  unavailable?: boolean;
  inspection?: { source: string; name: string; compatible: boolean; messages: string[] } | null;
  inspecting?: boolean;
  installing?: boolean;
  onInspectSource?: (source: string) => void;
  onSourceChange?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  // 仅桌面端能把拖拽 File / 目录选择框解析成 agent 可访问的本地绝对路径；Web 端隐藏这些入口。
  const canPickPath = platform?.canSelectFilePath ?? false;
  const [source, setSource] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const trimmedSource = source.trim();
  const adding = installing || operationId === `marketplace:add:${trimmedSource}`;
  const canSubmit = !unavailable && trimmedSource.length > 0 && !adding && !inspecting && (mode !== "install" || (inspection?.source === trimmedSource && inspection.compatible));
  // 本地输入法 composition 态：部分平台 isComposing 会提前翻 false，靠 ref 兜底，避免候选确认误触发添加。
  const compositionActiveRef = useRef(false);
  // 防重复提交：Enter 与点击共用，避免 store 回写前的窗口里重复发起同一来源的添加。
  const pendingRef = useRef(false);
  const episodeRef = useRef({ open, version: 0 });
  if (episodeRef.current.open !== open) {
    episodeRef.current = { open, version: episodeRef.current.version + 1 };
    pendingRef.current = false;
  }

  const handleAdd = async () => {
    if (!canSubmit || pendingRef.current) return;
    const episode = episodeRef.current.version;
    pendingRef.current = true;
    try {
      const added = await onAddMarketplace(trimmedSource);
      // 失败时保留输入与弹层，让用户结合上方错误提示修正来源后重试。
      if (added && episode === episodeRef.current.version && episodeRef.current.open) {
        setSource("");
        onOpenChange(false);
      }
    } finally {
      if (episode === episodeRef.current.version) pendingRef.current = false;
    }
  };

  const handleChooseDirectory = async () => {
    if (!platform) return;
    try {
      const dir = await platform.selectDirectory();
      if (dir) { setSource(dir); onSourceChange?.(); }
    } catch {
      // 取消或对话框异常时静默：保留当前输入，不打断添加流程。
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const path = platform?.getPathForFile?.(file)?.trim();
    if (path) { setSource(path); onSourceChange?.(); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="plugin-store-add-source-dialog"
        className={cn(
          "w-[min(420px,calc(100vw-2rem))] max-w-none transition-colors",
          canPickPath && dragActive ? "border-border-hover bg-surface-hover" : "",
        )}
        onDragOver={
          canPickPath
            ? (event) => {
                event.preventDefault();
                setDragActive(true);
              }
            : undefined
        }
        onDragLeave={
          canPickPath
            ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDragActive(false);
                }
              }
            : undefined
        }
        onDrop={canPickPath ? handleDrop : undefined}
      >
        <DialogTitle className="text-ui-lg font-medium text-foreground">
          {mode === "install" ? "安装插件" : intl.formatMessage({ id: "settings.plugins.marketplaces.add" })}
        </DialogTitle>
        {unavailable ? <p role="status" className="text-ui-base text-foreground-subtle">未接入</p> : null}
        {error ? (
          <div
            className="max-h-[min(240px,40vh)] min-w-0 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base whitespace-pre-wrap break-words text-destructive"
            data-testid="plugin-store-add-source-error"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        <Input
          type="text"
          data-testid="plugin-store-add-source-input"
          size="lg"
          autoFocus
          aria-label={mode === "install" ? "链接或目录" : intl.formatMessage({ id: "settings.plugins.marketplaces.source" })}
          value={source}
          disabled={unavailable || adding}
          onChange={(event) => { setSource(event.target.value); onSourceChange?.(); }}
          onCompositionStart={() => {
            compositionActiveRef.current = true;
          }}
          onCompositionEnd={() => {
            compositionActiveRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (
              isImeComposingKeyEvent({
                compositionActive: compositionActiveRef.current,
                nativeEvent: event.nativeEvent,
              })
            ) {
              return;
            }
            event.preventDefault();
            void handleAdd();
          }}
          placeholder={mode === "install" ? "链接或目录" : intl.formatMessage({ id: "settings.plugins.marketplaces.source" })}
        />
        {mode === "install" && inspection?.source === trimmedSource ? <div role="status" className="text-ui-base text-foreground-subtle"><span>{inspection.name}</span><span> · {inspection.compatible ? "兼容" : "不兼容"}</span>{inspection.messages.map((message, index) => <p key={`${index}:${message}`}>{message}</p>)}</div> : null}
        {canPickPath ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.marketplaces.dropHint" })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {canPickPath ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => void handleChooseDirectory()}
              disabled={unavailable || adding}
            >
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.marketplaces.chooseDirectory" })}
            </Button>
          ) : null}
          {mode === "install" ? <Button type="button" variant="outline" size="lg" disabled={unavailable || !trimmedSource || adding || inspecting} onClick={() => onInspectSource?.(trimmedSource)}>{inspecting ? <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" /> : null}检查</Button> : null}
          <Button
            type="button"
            data-testid="plugin-store-add-source-submit"
            variant="default"
            size="lg"
            disabled={!canSubmit}
            onClick={() => void handleAdd()}
          >
            {adding ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : (
              <Plus data-icon="inline-start" aria-hidden="true" />
            )}
            {mode === "install" ? "安装" : intl.formatMessage({ id: "settings.plugins.marketplaces.add" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
