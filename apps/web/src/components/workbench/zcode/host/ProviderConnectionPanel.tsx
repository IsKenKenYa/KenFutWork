import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import type { ProviderSettingsFormProvider } from "@zui/lib/providerSettingsFormTypes.js";
import { resolveProviderConnectionApiFormatDisplayLabel } from "@zui/settings/model-provider-section/ProviderApiFormatSelect.js";
import { KeyRound, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";

/** 折叠仅改变原连接表单的承载位置；保存、凭据与修订仍归原卡片。 */
export function ProviderConnectionPanel({
  provider,
  collapsed,
  onCommit,
  children,
}: {
  provider: ProviderSettingsFormProvider;
  collapsed: boolean;
  onCommit(): Promise<void>;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const close = async () => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await onCommit();
      setOpen(false);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "连接保存失败，请重试。",
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  if (!collapsed) return <>{children}</>;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
        <span>
          {resolveProviderConnectionApiFormatDisplayLabel(
            intl,
            provider.native?.protocol ??
              provider.config.api?.type ??
              "openai-chat-completions",
          )}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono"
          title={provider.native?.baseUrl}
        >
          {provider.native?.baseUrl ||
            provider.config.api?.baseUrl ||
            "默认地址"}
        </span>
        <span className="inline-flex items-center gap-1">
          <KeyRound className="size-3" />
          {provider.credentialConfigured ? "Key 已设置" : "未设置 Key"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          <SlidersHorizontal />
          连接设置
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else void close();
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>连接设置</DialogTitle>
            <DialogDescription className="sr-only">
              {provider.providerName}
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={saving} className="space-y-4 border-0 p-0">
            {children}
          </fieldset>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button disabled={saving} onClick={() => void close()}>
              {saving ? "保存中" : "完成"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
