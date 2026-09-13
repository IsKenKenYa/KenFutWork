"use client";

import type { ProviderInstanceResponse } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createProviderInstance,
  deleteProviderInstance,
  fetchProviderInstances,
} from "@/lib/server-api";

const PROTOCOLS = [
  { value: "openai-compatible", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "google-image", label: "Google 图像" },
  { value: "replicate", label: "Replicate" },
  { value: "volces", label: "火山引擎" },
  { value: "metaso", label: "Metaso 视频" },
] as const;

/**
 * 供应商设置（P5 BYOK）：用户供应商实例 CRUD。
 * 凭证红线：apiKey 只写不读——列表只有 hasCredential 标记，编辑不回显。
 */
export function ProviderSettings({ accessToken }: { accessToken: string }) {
  const [instances, setInstances] = useState<ProviderInstanceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<string>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsJson, setModelsJson] = useState(
    '[{"id":"gpt-4.1","name":"GPT-4.1","capability":"chat"}]',
  );
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { instances: list } = await fetchProviderInstances(accessToken);
      setInstances(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载供应商实例失败");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    setError(null);
    let models: unknown;
    try {
      models = JSON.parse(modelsJson);
    } catch {
      setError("模型清单必须是合法 JSON");
      return;
    }
    if (!name.trim()) {
      setError("请填写实例名称");
      return;
    }
    if (!apiKey.trim()) {
      setError("请填写 API Key（只写不读，保存后不可查看）");
      return;
    }
    setSubmitting(true);
    try {
      await createProviderInstance(accessToken, {
        name: name.trim(),
        protocol: protocol as (typeof PROTOCOLS)[number]["value"],
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        apiKey: apiKey.trim(),
        models: models as never,
        enabled: true,
      });
      setShowForm(false);
      setName("");
      setApiKey("");
      setBaseUrl("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建实例失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (instanceId: string) => {
    setError(null);
    try {
      await deleteProviderInstance(accessToken, instanceId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除实例失败");
    }
  };

  return (
    <section aria-label="供应商设置">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium">供应商设置</h3>
          <p className="text-sm text-muted-foreground">
            使用你自己的 API Key（BYOK）。Key 加密保存，永不回显。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          {showForm ? "取消" : "添加供应商"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {showForm ? (
        <form
          aria-label="新建供应商实例"
          className="mb-4 space-y-3 rounded-md border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <div>
            <label htmlFor="provider-name" className="text-sm">
              实例名称
            </label>
            <input
              id="provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="provider-protocol" className="text-sm">
              协议
            </label>
            <Select
              value={protocol}
              onValueChange={(next) => {
                if (typeof next === "string") setProtocol(next);
              }}
              items={PROTOCOLS.map((p) => ({ value: p.value, label: p.label }))}
            >
              <SelectTrigger id="provider-protocol" className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROTOCOLS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor="provider-base-url" className="text-sm">
              Base URL（可选）
            </label>
            <input
              id="provider-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="provider-api-key" className="text-sm">
              API Key
            </label>
            <input
              id="provider-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="provider-models" className="text-sm">
              模型清单（JSON）
            </label>
            <textarea
              id="provider-models"
              value={modelsJson}
              onChange={(e) => setModelsJson(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "保存中…" : "保存实例"}
          </button>
        </form>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : instances.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无供应商实例</p>
      ) : (
        <ul className="space-y-2">
          {instances.map((instance) => (
            <li
              key={instance.id}
              className="flex items-center justify-between rounded-md border px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium">{instance.name}</p>
                <p className="text-xs text-muted-foreground">
                  {instance.protocol} · {instance.models.length} 个模型 ·{" "}
                  {instance.enabled ? "已启用" : "已停用"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(instance.id)}
                className="rounded-md border px-3 py-1 text-sm text-destructive"
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
