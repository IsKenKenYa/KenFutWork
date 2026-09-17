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
}

export function AgentSection({
  agentMaxRetries: initialRetries,
  defaultModel: initialModel,
  fetchModels,
  onSave,
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
      <h2 className="text-lg font-semibold mb-1">模型</h2>
      <p className="text-sm text-muted-foreground mb-6">
        配置工作区的默认 AI 模型。
      </p>

      <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
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
          <p className="text-xs text-muted-foreground">
            该模型将用于工作区内所有新的 Agent 运行。
          </p>
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
            className="w-24 rounded-md border px-2 py-1 text-sm outline-none"
          />
          <p className="text-xs text-muted-foreground">
            上限（含首次尝试），缺省 10；0
            表示不重试。**已执行工具的那一轮不会重试**—— 重试会重复施加副作用。
          </p>
        </div>

        {feedback && (
          <p
            className={`text-sm ${feedback.type === "success" ? "text-success" : "text-destructive"}`}
          >
            {feedback.message}
          </p>
        )}

        <Button type="submit" disabled={saving || !hasChanges} size="sm">
          {saving ? "Saving..." : "保存"}
        </Button>
      </form>
    </div>
  );
}
