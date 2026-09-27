"use client";

import type { ModelInfo } from "@kenfutwork/shared";
import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SETTINGS_TITLE } from "@/lib/settings-layout";
import { Button } from "./ui/button";
import { Label } from "./ui/label";

interface AgentSectionProps {
  agentMaxRetries: number;
  defaultModel: string;
  fetchModels: () => Promise<{ models: ModelInfo[] }>;
  onSave: (next: {
    agentMaxRetries: number;
    defaultModel: string;
  }) => Promise<void>;
  /** 上下文自动压缩（缺省 true）；开关**立即生效**（部分更新，不等「保存」）。 */
  autoCompactEnabled?: boolean;
  onToggleAutoCompact?: ((next: boolean) => Promise<void>) | undefined;
}

export function AgentSection({
  agentMaxRetries: initialRetries,
  defaultModel: initialModel,
  fetchModels,
  onSave,
  autoCompactEnabled = true,
  onToggleAutoCompact,
}: AgentSectionProps) {
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [maxRetries, setMaxRetries] = useState(String(initialRetries));
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // 重试次数为空/非法时视为未改（保存按钮不给点），避免把空串写成 0
  const parsedRetries = Number.parseInt(maxRetries, 10);
  const retriesValid =
    Number.isInteger(parsedRetries) &&
    parsedRetries >= 0 &&
    parsedRetries <= 50;
  const hasChanges =
    selectedModel !== initialModel ||
    (retriesValid && parsedRetries !== initialRetries);

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedModel 只用于首次拿到目录后的兜底选择；补进依赖会随每次切换模型重拉目录
  useEffect(() => {
    fetchModels()
      .then((data) => {
        setModels(data.models);
        const ids = data.models.map((m: ModelInfo) => m.id);
        if (ids.length > 0 && !ids.includes(selectedModel)) {
          setSelectedModel(ids[0] ?? selectedModel);
        }
      })
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, [fetchModels]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedModel || !retriesValid) return;

    setSaving(true);
    setFeedback(null);

    try {
      await onSave({
        agentMaxRetries: parsedRetries,
        defaultModel: selectedModel,
      });
      setFeedback({ type: "success", message: "模型设置已更新" });
    } catch {
      setFeedback({
        type: "error",
        message: "更新失败，请重试。",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className={SETTINGS_TITLE}>模型</h2>

      <form onSubmit={handleSubmit} className="w-full space-y-4">
        <div className="space-y-2">
          <Label htmlFor="defaultModel">默认模型</Label>
          {modelsLoading ? (
            <p className="text-sm text-muted-foreground">模型加载中…</p>
          ) : (
            <Select
              value={selectedModel}
              onValueChange={(next) => {
                if (typeof next === "string") setSelectedModel(next);
              }}
              items={models.map((m) => ({ value: m.id, label: m.name }))}
            >
              <SelectTrigger id="defaultModel" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name} ({model.provider})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="agentMaxRetries">失败自动重试次数</Label>
          <input
            id="agentMaxRetries"
            aria-label="失败自动重试次数"
            type="number"
            min={0}
            max={50}
            value={maxRetries}
            onChange={(event) => setMaxRetries(event.target.value)}
            className="w-full rounded-md border px-3 py-1.5 text-sm outline-none"
          />
          <p className="text-xs text-muted-foreground">0 = 不重试</p>
        </div>

        {onToggleAutoCompact ? (
          /* 与同页的外观卡片同为 py-2：同一页里的行不同高就是「排版不合理」 */
          <div className="rounded-lg border px-3 py-2">
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">上下文自动压缩</span>
              <input
                type="checkbox"
                role="switch"
                aria-label="上下文自动压缩"
                aria-checked={autoCompactEnabled}
                checked={autoCompactEnabled}
                onChange={(event) =>
                  void onToggleAutoCompact(event.target.checked)
                }
                className="h-4 w-8 shrink-0 appearance-none rounded-full bg-muted transition-colors checked:bg-foreground/80 before:block before:h-3.5 before:w-3.5 before:translate-x-0.5 before:rounded-full before:background before:bg-background before:transition-transform checked:before:translate-x-4"
              />
            </label>
          </div>
        ) : null}

        {feedback && (
          <p
            className={`text-sm ${feedback.type === "success" ? "text-success" : "text-destructive"}`}
          >
            {feedback.message}
          </p>
        )}

        <Button type="submit" disabled={saving || !hasChanges} size="sm">
          {saving ? "保存中…" : "保存"}
        </Button>
      </form>
    </div>
  );
}
