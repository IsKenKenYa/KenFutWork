import { Palette, Plus } from "lucide-react";

interface EmptyStateProps {
  onCreateKit: () => void;
}

export function EmptyState({ onCreateKit }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="rounded-2xl bg-muted p-4">
        <Palette className="h-8 w-8 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-base font-semibold text-foreground sm:text-lg">
          还没有品牌套件
        </h2>
        <p className="mt-1 max-w-[280px] text-sm text-muted-foreground">
          创建一个品牌套件，集中管理配色、字体与 Logo。
        </p>
      </div>
      <button
        type="button"
        onClick={onCreateKit}
        className="inline-flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:min-h-0"
      >
        <Plus className="h-4 w-4" />
        创建品牌套件
      </button>
    </div>
  );
}
