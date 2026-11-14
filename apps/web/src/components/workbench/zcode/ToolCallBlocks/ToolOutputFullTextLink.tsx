import type { CodeUiToolOutputResponse } from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { Loader2Icon } from "lucide-react";
import { useCallback, useState } from "react";

export interface ToolOutputTruncatedRef {
  totalBytes: number;
  ref: string;
}

/** 从工具行 raw 里读取终态截断标记；缺失或形状不对都视为拿不到原文位置。 */
export function readToolOutputTruncated(
  raw: unknown,
): ToolOutputTruncatedRef | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const truncated = (raw as { outputTruncated?: unknown }).outputTruncated;
  if (typeof truncated !== "object" || truncated === null) {
    return null;
  }

  const { totalBytes, ref } = truncated as {
    totalBytes?: unknown;
    ref?: unknown;
  };
  if (
    typeof totalBytes !== "number" ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0
  ) {
    return null;
  }
  if (typeof ref !== "string" || ref.trim().length === 0) {
    return null;
  }

  return { totalBytes, ref };
}

/**
 * 工具卡「查看原文」入口与只读分页弹层。
 *
 * 只按字节偏移续读，不改动事件原文；服务端拒绝（归档、没有这条输出、权限失效）时
 * 保留弹层并显示服务端给的可读原因。
 */
export function ToolOutputFullTextLink({
  sessionId,
  truncated,
  onReadToolOutput,
}: {
  sessionId: string;
  truncated: ToolOutputTruncatedRef;
  onReadToolOutput: (
    sessionId: string,
    ref: string,
    offset: number,
  ) => Promise<CodeUiToolOutputResponse>;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setFailure(null);
      try {
        const page = await onReadToolOutput(sessionId, truncated.ref, offset);
        setText((previous) =>
          offset === 0 ? page.text : `${previous}${page.text}`,
        );
        setNextOffset(page.nextOffset);
        setLoaded(true);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [onReadToolOutput, sessionId, truncated.ref],
  );

  const handleOpen = useCallback(() => {
    setOpen(true);
    if (!loaded && !loading) {
      void load(0);
    }
  }, [load, loaded, loading]);

  return (
    <>
      <div className="flex justify-start">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-base"
          data-testid="tool-output-fulltext-open"
          onClick={handleOpen}
        >
          {intl.formatMessage({ id: "chat.toolCall.output.viewFull" })}
        </Button>
      </div>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={intl.formatMessage({ id: "chat.toolCall.output.title" })}
          data-testid="tool-output-fulltext-dialog"
        >
          <div className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-surface shadow-lg">
            <div className="flex items-center justify-between border-border border-b px-4 py-2">
              <span className="text-ui-base font-medium">
                {intl.formatMessage({ id: "chat.toolCall.output.title" })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-ui-base"
                onClick={() => setOpen(false)}
              >
                {intl.formatMessage({ id: "chat.toolCall.output.close" })}
              </Button>
            </div>
            <div className="min-h-24 flex-1 overflow-auto px-4 py-3">
              {text ? (
                <pre className="whitespace-pre-wrap break-words text-ui-base">
                  {text}
                </pre>
              ) : null}
              {failure ? (
                <p className="text-ui-base text-destructive">{failure}</p>
              ) : null}
              {!text && !failure ? (
                <p className="text-ui-base text-foreground-subtle">…</p>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2 border-border border-t px-4 py-2 text-ui-base text-foreground-subtle">
              <span>
                {intl.formatMessage(
                  { id: "chat.toolCall.output.progress" },
                  {
                    loaded: formatBytes(utf8Bytes(text)),
                    total: formatBytes(truncated.totalBytes),
                  },
                )}
              </span>
              {nextOffset !== null && !failure ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-ui-base"
                  disabled={loading}
                  onClick={() => {
                    void load(nextOffset);
                  }}
                >
                  {loading ? (
                    <Loader2Icon className="mr-1 size-3 animate-spin" />
                  ) : null}
                  {intl.formatMessage({ id: "chat.toolCall.output.next" })}
                </Button>
              ) : null}
              {loading && nextOffset === null ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
