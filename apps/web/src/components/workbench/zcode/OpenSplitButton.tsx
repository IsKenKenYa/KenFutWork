/**
 * zcode 照搬：`@/OpenSplitButton.tsx`（references/zcode/packages/ui/src/OpenSplitButton.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件接口可选属性放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为；上游依赖运行时恒有值）。
 * 适配注记（P9）：openExternalFile 宿主切片未声明，消费侧按可选能力判空降级（见 OpenExternalFilePlatform）。
 */

import type { MessageFileLinkTarget } from "@zui/components/ai-elements/message";
import { Button } from "@zui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu";
import { toast } from "@zui/components/ui/toast";
import { useFileContextActions } from "@zui/hooks/useFileContextActions";
import { usePlatform, type ZCodePlatformSlice } from "@zui/hooks/usePlatform";
import { useWorkspaceOpenInEditorTarget } from "@zui/hooks/useWorkspaceOpenInEditorTarget";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { CodeViewerSource } from "@zui/lib/codeViewer";
import {
  persistLastSelectedEditorId,
  readLastSelectedEditorId,
} from "@zui/lib/editorPreference";
import { resolveWorkspaceEditorSelection } from "@zui/lib/workspaceEditorSelection";
import type { EditorInfo } from "@zui/lib/zcode-shared";
import { logger } from "@zui/logger";
import { getWorkspaceFileRelativePath } from "@zui/workspace-file-tree/model";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

/**
 * 适配注记（P9）：zcode 宿主切片（hooks/usePlatform 禁改件）未声明 openExternalFile
 * （references/zcode/packages/shared/src/platform.ts 中同为可选能力）；消费侧按可选
 * 访问降级——缺失时回退 openExternal 走系统浏览器。
 */
type OpenExternalFilePlatform = ZCodePlatformSlice & {
  openExternalFile?: (
    path: string,
  ) => Promise<{ success: boolean; error?: string }>;
};

// 导出类型供共用时间线以 import type 引用（构建期擦除，不把 open-with 子树带进公开页 bundle）。
export type OpenSplitButtonTarget =
  | {
      type: "website";
      url: string;
      localPath?: string | undefined;
    }
  | {
      type: "file";
      path: string;
      title: string;
      label: string;
      previewSource?: CodeViewerSource | undefined;
    };

interface OpenSplitButtonProps {
  target: OpenSplitButtonTarget;
  onOpenBrowserUrl?: ((url: string) => void | undefined) | undefined;
  onOpenFileLink?:
    | ((target: MessageFileLinkTarget) => void | undefined)
    | undefined;
  onOpenCodeViewer?:
    | ((source: CodeViewerSource) => void | undefined)
    | undefined;
  hideOpenWithMenu?: boolean | undefined;
  stopPropagation?: boolean | undefined;
}

export function OpenSplitButton({
  target,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  hideOpenWithMenu = false,
  stopPropagation = false,
}: OpenSplitButtonProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const fileActions = useFileContextActions();
  const previewSource =
    target.type === "file" ? target.previewSource : undefined;
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: previewSource?.workspacePath,
    workspaceIdentity: previewSource?.workspaceIdentity,
    workspaceRemoteSessionId: previewSource?.workspaceRemoteSessionId,
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  const isRemoteSource = Boolean(
    previewSource?.workspaceIdentity ||
      previewSource?.workspaceRemoteSessionId ||
      matchedOpenContext.isRemoteWorkspace,
  );
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  const sortedEditors = useMemo(
    () =>
      isRemoteSource && !openInEditorRemoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors: editors,
            selectedEditorId: null,
            remoteTarget: openInEditorRemoteTarget,
          }).availableEditors,
    [editors, isRemoteSource, openInEditorRemoteTarget],
  );
  const canPreview =
    target.type === "website"
      ? Boolean(onOpenBrowserUrl)
      : Boolean(onOpenFileLink || onOpenCodeViewer);
  const selectedEditor = useMemo(() => {
    const selectedEditorId = readLastSelectedEditorId();
    return (
      sortedEditors.find((editor) => editor.id === selectedEditorId) ??
      sortedEditors[0] ??
      null
    );
  }, [sortedEditors]);

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const loadEditors = useCallback(async () => {
    if (editorsLoaded || loadingEditors || target.type !== "file") {
      return;
    }

    setLoadingEditors(true);
    try {
      setEditors(await platform.getInstalledEditors());
      setEditorsLoaded(true);
    } catch (error) {
      logger.warn("[OpenSplitButton] 获取第三方打开方式失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingEditors(false);
    }
  }, [editorsLoaded, loadingEditors, platform, target]);

  const handlePreview = () => {
    if (target.type === "website") {
      onOpenBrowserUrl?.(target.url);
      return;
    }

    if (onOpenCodeViewer) {
      onOpenCodeViewer(
        target.previewSource ?? {
          type: "file",
          title: target.title,
          path: target.path,
        },
      );
      return;
    }

    onOpenFileLink?.({
      path: target.path,
      label: target.label,
      pathKind: "file",
      workspacePath: target.previewSource?.workspacePath,
      workspaceIdentity: target.previewSource?.workspaceIdentity,
      workspaceRemoteSessionId: target.previewSource?.workspaceRemoteSessionId,
    });
  };

  const handleOpenInEditor = (editor: EditorInfo) => {
    if (target.type !== "file") {
      return;
    }

    persistLastSelectedEditorId(editor.id);
    void platform
      .openInEditor(editor.id, target.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: target.previewSource?.workspaceIdentity,
      })
      .then((result) => {
        if (result.success) {
          return;
        }

        logger.warn("[OpenSplitButton] 第三方 App 打开文件失败", {
          editorId: editor.id,
          path: target.path,
          error: result.error ?? "unknown-error",
        });
      });
  };

  const handleOpenExternal = () => {
    const openExternalFile = (platform as OpenExternalFilePlatform)
      .openExternalFile;
    if (target.type !== "website" || !target.localPath || !openExternalFile) {
      platform.openExternal(
        target.type === "website" ? target.url : target.path,
      );
      return;
    }

    const localPath = target.localPath;
    const reportFailure = (error: unknown) => {
      logger.warn("[OpenSplitButton] 浏览器打开本地文件失败", {
        path: localPath,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "chat.previewCards.openExternalFailed" }));
    };
    void openExternalFile(localPath)
      .then((result) => {
        if (!result.success) reportFailure(result.error ?? "unknown-error");
      })
      .catch(reportFailure);
  };

  if (hideOpenWithMenu) {
    return (
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="h-7 rounded-none border-0 gap-1 px-2"
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            handlePreview();
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
      </div>
    );
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && void loadEditors()}>
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="h-7 rounded-none border-0 gap-1 pr-1.5"
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            handlePreview();
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
        <DropdownMenuTrigger asChild={true}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="!w-5 rounded-none border-0 text-foreground-subtlest"
            aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            title={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            onClick={stopEventPropagation}
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        align="end"
        side="top"
        className="w-44"
        onClick={stopEventPropagation}
      >
        {target.type === "website" ? (
          <DropdownMenuItem onSelect={handleOpenExternal}>
            <ExternalLinkIcon className="size-4" />
            <span>
              {intl.formatMessage({
                id: "chat.previewCards.openExternal",
              })}
            </span>
          </DropdownMenuItem>
        ) : (
          <>
            {selectedEditor ? (
              sortedEditors.map((editor) => (
                <DropdownMenuItem
                  key={editor.id}
                  onSelect={() => handleOpenInEditor(editor)}
                >
                  <img
                    src={editor.iconDataUrl}
                    alt={editor.name}
                    className="size-4 shrink-0"
                  />
                  <span>{editor.name}</span>
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled={true}>
                {intl.formatMessage({
                  id: loadingEditors
                    ? "common.loading"
                    : "chat.previewCards.noOpenApps",
                })}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                void fileActions.copyAbsolutePath({ path: target.path })
              }
            >
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void fileActions.copyRelativePath({
                  path: target.path,
                  relativePath: target.previewSource?.workspacePath
                    ? getWorkspaceFileRelativePath(
                        target.previewSource.workspacePath,
                        target.path,
                      )
                    : target.label,
                })
              }
            >
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
