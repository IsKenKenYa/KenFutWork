import type { MediaModelListState } from "./useMediaModelList.js";

export function MediaModelListNotice({
  state,
  onRetry,
}: {
  state: MediaModelListState<unknown>;
  onRetry: () => void;
}) {
  if (state.status === "error") {
    return (
      <div className="space-y-1 px-3 py-2 text-xs">
        <p role="alert" className="text-destructive">
          {state.message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border px-2 py-1 hover:bg-muted"
        >
          重新读取
        </button>
      </div>
    );
  }
  if (state.status === "ready" && state.models.length > 0) return null;
  return (
    <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
      {state.status === "loading" ? "读取模型…" : "请在供应商设置中添加模型"}
    </p>
  );
}
