import { Button } from "@zui/components/ui/button.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
import { ComputerUseSection as Original } from "@zui-original/settings/ComputerUseSection.js";
import { type ComponentProps, useEffect, useState } from "react";
import {
  localCuaDesktopInvoke,
  nativeCuaFocusSubscription,
} from "./cuaPermissionPlatform.js";

/** 原权限行/状态刷新/插件开关原样消费，补当前壳的真实授权主体。 */
export function ComputerUseSection(props: ComponentProps<typeof Original>) {
  const [owner, setOwner] = useState<{
    appPath: string;
    displayName: string;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    const subscribe = nativeCuaFocusSubscription();
    if (subscribe)
      void subscribe((focused) => {
        if (focused && !disposed) window.dispatchEvent(new Event("focus"));
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else release = unlisten;
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });
    return () => {
      disposed = true;
      release?.();
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    const invoke = localCuaDesktopInvoke();
    if (invoke)
      void invoke("cua_permission_owner")
        .then((value) => {
          if (!disposed)
            setOwner(value as { appPath: string; displayName: string });
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });
    return () => {
      disposed = true;
    };
  }, []);
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
                  }).catch((error) => setError(String(error)));
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
