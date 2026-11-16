import { ApiAccessError, ApiApplicationError } from "@kenfutwork/shared";

export function CommandCenterReadFailure({
  cause,
  fallback,
  retryLabel,
  onRetry,
}: {
  cause: unknown;
  fallback: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  const message =
    cause instanceof ApiAccessError || cause instanceof ApiApplicationError
      ? cause.message.trim() || fallback
      : fallback;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
      <p role="alert" className="min-w-0 text-ui-base text-destructive">
        {message}
      </p>
      <button
        type="button"
        className="shrink-0 rounded-md border border-border px-2 py-1 text-ui-base hover:bg-menu-hover"
        onKeyDown={(event) => {
          // Enter 由当前按钮处理，不触发命令列表的选中项。
          if (event.key === "Enter") event.stopPropagation();
        }}
        onClick={onRetry}
      >
        {retryLabel}
      </button>
    </div>
  );
}
