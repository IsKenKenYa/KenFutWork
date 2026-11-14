import { isCuaPermissionStatusAvailable } from "@zcode/services";
import { Button } from "@zui/components/ui/button.js";
import { useServices } from "@zui/hooks/useServices.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
import { ComputerUseSection as Original } from "@zui-original/settings/ComputerUseSection.js";
import { type ComponentProps, useCallback, useEffect, useState } from "react";
import {
  localCuaDesktopInvoke,
  nativeCuaFocusSubscription,
} from "./cuaPermissionPlatform.js";

/** 原权限行/状态刷新/插件开关原样消费，补当前壳的真实授权主体。 */
export function ComputerUseSection(props: ComponentProps<typeof Original>) {
  const services = useServices();
  const permissionService = services.cuaPermissionService;
  const [owner, setOwner] = useState<{
    appPath: string;
    displayName: string;
  }>();
  const [error, setError] = useState("");

  const loadOwner = useCallback(async () => {
    if (!permissionService) return;
    const status = await permissionService.getStatus(
      props.workspacePath || "__kenfutwork_instance__",
      props.workspaceIdentity,
    );
    if (!isCuaPermissionStatusAvailable(status) || !status.grantOwner) return;
    setOwner({
      appPath: status.grantOwner,
      displayName:
        status.grantOwnerDisplayName ??
        status.grantOwner
          .split("/")
          .at(-1)
          ?.replace(/\.app$/u, "") ??
        "Computer Use Helper",
    });
  }, [permissionService, props.workspaceIdentity, props.workspacePath]);

  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    const refresh = () => {
      if (!disposed) void loadOwner().catch((cause) => setError(String(cause)));
    };
    const subscribe = nativeCuaFocusSubscription();
    if (subscribe)
      void subscribe((focused) => {
        if (focused && !disposed) refresh();
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else release = unlisten;
        })
        .catch((cause) => {
          if (!disposed) setError(String(cause));
        });
    refresh();
    return () => {
      disposed = true;
      release?.();
    };
  }, [loadOwner]);

  return (
    <div className="space-y-4">
      {owner ? (
        <SettingsGroupCard>
          <SettingsRow
            label="授权应用"
            description="需在系统设置手动批准"
            control={
              <Button
                variant="outline"
                onClick={() => {
                  void localCuaDesktopInvoke()?.("reveal_path", {
                    path: owner.appPath,
                  }).catch((cause) => setError(String(cause)));
                }}
              >
                在访达中显示
              </Button>
            }
            detail={
              <div className="break-all text-ui-sm text-foreground-subtle">
                {owner.appPath}
              </div>
            }
          />
        </SettingsGroupCard>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <Original {...props} />
    </div>
  );
}
