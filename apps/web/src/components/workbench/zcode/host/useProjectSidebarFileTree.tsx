import type {
  ProjectSidebarProps,
  SidebarFileTreeTarget,
} from "@zui/project-sidebar/contract.js";
import { useProjectFileTree } from "@zui/project-sidebar/useProjectFileTree.js";
import { WorkspaceFileTree } from "@zui/WorkspaceFileTree.js";
import { useCallback, useEffect, useMemo, useState } from "react";

/** 原项目文件目标复用当前文件面板；内容标签的文件管理器由壳提供时使用其真实入口。 */
export function useProjectSidebarFileTree(props: ProjectSidebarProps) {
  const [target, setTarget] = useState<SidebarFileTreeTarget | null>(null);
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(false);
  const openFileManager = useCallback(
    (next: SidebarFileTreeTarget) => {
      if (props.onOpenFileManager) {
        props.onOpenFileManager(next);
        return;
      }
      setTarget(next);
      setIsFileTreeOpen(true);
    },
    [props.onOpenFileManager],
  );
  const fileProps = useMemo(
    () => ({ ...props, onOpenFileManager: openFileManager }),
    [props, openFileManager],
  );
  const { openFiles, openTaskFiles, cancel } = useProjectFileTree(fileProps);
  const close = useCallback(() => {
    cancel();
    setIsFileTreeOpen(false);
  }, [cancel]);
  useEffect(() => {
    props.onFileTreeOpenChange?.(isFileTreeOpen);
    return () => props.onFileTreeOpenChange?.(false);
  }, [isFileTreeOpen, props.onFileTreeOpenChange]);
  const fileTree = target ? (
    <div
      className="absolute inset-0"
      hidden={!isFileTreeOpen}
      inert={!isFileTreeOpen}
    >
      <WorkspaceFileTree
        key={JSON.stringify([
          target.workspaceIdentity,
          target.workspacePath,
          target.viewerScope,
        ])}
        workspacePath={target.workspacePath}
        workspaceName={target.workspaceName}
        {...(target.workspaceIdentity
          ? { workspaceIdentity: target.workspaceIdentity }
          : {})}
        {...(target.workspaceRemoteSessionId
          ? { workspaceRemoteSessionId: target.workspaceRemoteSessionId }
          : {})}
        {...(target.viewerScope ? { viewerScope: target.viewerScope } : {})}
        {...(target.revealPath ? { revealPath: target.revealPath } : {})}
        {...(target.temporaryExternalDirectory === undefined
          ? {}
          : { temporaryExternalDirectory: target.temporaryExternalDirectory })}
        {...(props.isDesktop === undefined
          ? {}
          : { canOpenLocalFileManager: props.isDesktop })}
        {...(props.activePreviewPath === undefined
          ? {}
          : { activePreviewPath: props.activePreviewPath })}
        onClose={close}
        {...(props.isDesktop && props.onOpenBrowserUrl
          ? { onOpenBrowserUrl: props.onOpenBrowserUrl }
          : {})}
        onOpenPreview={(source) =>
          props.onOpenCodeViewer?.({
            ...source,
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity
              ? { workspaceIdentity: target.workspaceIdentity }
              : {}),
            ...(target.workspaceRemoteSessionId
              ? { workspaceRemoteSessionId: target.workspaceRemoteSessionId }
              : {}),
            ...(target.viewerScope ? { viewerScope: target.viewerScope } : {}),
          })
        }
      />
    </div>
  ) : null;
  return { isFileTreeOpen, fileTree, openFiles, openTaskFiles };
}
