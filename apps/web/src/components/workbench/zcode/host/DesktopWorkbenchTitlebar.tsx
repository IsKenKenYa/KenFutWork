import { TooltipProvider } from "@zui/components/ui/tooltip.js";
import { DesktopTopOverlay } from "@zui/DesktopTopOverlay.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { useEffect, useMemo, useState } from "react";
import { createMacDesktopChrome } from "./desktopChrome.js";
import { createWebPlatform } from "./upstream/browserPlatform.js";

/** Design／Flow只复用原窗口工具层，不装配Code的工作区或会话。 */
export function DesktopWorkbenchTitlebar({
  isSidebarVisible,
  onToggleSidebar,
}: {
  isSidebarVisible: boolean;
  onToggleSidebar: () => void;
}) {
  const chrome = useMemo(createMacDesktopChrome, []);
  const platform = useMemo(
    () => ({ ...createWebPlatform(), ...chrome }),
    [chrome],
  );
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => chrome?.onWindowFullscreenChanged(setFullscreen), [chrome]);
  if (!chrome) return null;
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <div
          data-testid="desktop-titlebar-drag-region"
          className="absolute inset-x-0 top-0 h-14 [app-region:drag]"
        />
        <DesktopTopOverlay
          workspaceAbsPath=""
          isDesktop
          isMacDesktop
          isMacFullscreen={fullscreen}
          macWindowControlsLeftPaddingPx={96}
          isSidebarVisible={isSidebarVisible}
          updateReadyVersion={null}
          updateState={null}
          platform={platform}
          toggleSidebarShortcutLabel=""
          newTaskShortcutLabel=""
          goBackShortcutLabel=""
          goForwardShortcutLabel=""
          canTaskNavBack={false}
          canTaskNavForward={false}
          canGoBack={false}
          canGoForward={false}
          showNewTaskButton={false}
          hideTaskNavigationButtons
          appLogoUrl=""
          onToggleSidebar={onToggleSidebar}
          onCreateTask={() => {}}
          onGoBack={() => {}}
          onGoForward={() => {}}
        />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
