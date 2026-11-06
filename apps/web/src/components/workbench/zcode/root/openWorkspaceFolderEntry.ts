import { logger } from "@zui/logger.js";
import { NativeDirectoryPickerUnavailableError } from "../host/directoryPicker.js";

export async function openFolderFromWorkspaceEntry({
  selectDirectory,
  openDirectoryBrowser,
  preferDirectoryBrowser = false,
  onSelectProject,
}: {
  selectDirectory?: () => Promise<string | null>;
  openDirectoryBrowser?: () => void;
  preferDirectoryBrowser?: boolean;
  onSelectProject: (path: string) => void;
}) {
  if (preferDirectoryBrowser) {
    if (!openDirectoryBrowser) {
      logger.warn("[openWorkspaceFolderEntry] directory browser preferred but unavailable");
      return;
    }
    // Web/server 根节点没有系统目录选择框，继续调用 selectDirectory 只会返回 null。
    // 这里显式切到服务端目录浏览器，确保用户选择的是目标 host 上的路径。
    logger.info("[openWorkspaceFolderEntry] opening service directory browser...");
    openDirectoryBrowser();
    return;
  }

  if (!selectDirectory) {
    return;
  }

  logger.info("[openWorkspaceFolderEntry] calling selectDirectory...");
  try {
    const dir = await selectDirectory();
    logger.info("[openWorkspaceFolderEntry] selectDirectory returned:", dir);
    if (dir) {
      onSelectProject(dir);
    } else {
      logger.info("[openWorkspaceFolderEntry] user cancelled or dir is null");
    }
  } catch (err) {
    // 系统对话框确实不可用时才退回自定义目录浏览器；用户取消、普通失败都不降级，
    // 否则又会把用户丢回那个"很难用"的逐层翻目录弹窗。
    if (err instanceof NativeDirectoryPickerUnavailableError) {
      logger.info(
        "[openWorkspaceFolderEntry] native picker unavailable, falling back to directory browser:",
        err.message,
      );
      openDirectoryBrowser?.();
      return;
    }
    logger.error("[openWorkspaceFolderEntry] selectDirectory threw:", err);
  }
}
