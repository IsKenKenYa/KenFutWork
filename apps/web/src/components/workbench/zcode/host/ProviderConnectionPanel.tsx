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
import { useId, useRef, useState } from "react";

/** 折叠仅改变原连接表单的承载位置；保存、凭据与修订仍归原卡片。 */
export function ProviderConnectionPanel({
  provider,
  collapsed,
  onCommit,
  onHeadersChange,
  children,
}: {
  provider: ProviderSettingsFormProvider;
  collapsed: boolean;
  onCommit(): Promise<void>;
  onHeadersChange(value: string): void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const headersId = useId();
  const [headersText, setHeadersText] = useState("");
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
        <DialogContent className="max-h-[calc(100vh-2rem)] sm:max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>连接设置</DialogTitle>
            <DialogDescription className="sr-only">
              {provider.providerName}
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={saving}
            className="space-y-4 border-0 p-0 [&>div]:grid [&>div]:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] [&>div]:items-center [&>div]:gap-4 [&>div>label]:mb-0 [&>div>input]:min-w-0 [&>div>div]:min-w-0"
          >
            {children}
            <details className="space-y-3 text-ui-base">
              <summary className="cursor-pointer text-foreground-subtle">
                高级配置
              </summary>
              <label
                htmlFor={headersId}
                className="block text-ui-base text-foreground-subtle"
              >
                自定义请求头
              </label>
              <textarea
                id={headersId}
                value={headersText}
                placeholder="留空则不改"
                spellCheck={false}
                className="min-h-24 w-full rounded-lg border border-input-border bg-input px-3 py-2 font-mono text-ui-base outline-none focus:border-input-border-focused"
                onChange={(event) => {
                  setHeadersText(event.target.value);
                  onHeadersChange(event.target.value);
                }}
              />
              {provider.native?.headerKeys.length ? (
                <p className="text-ui-sm text-foreground-subtle">
                  已存：{provider.native.headerKeys.join("、")}
                </p>
              ) : null}
            </details>
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
