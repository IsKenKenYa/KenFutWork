"use client";

import type {
  ProviderInstanceCreateRequest,
  ProviderInstanceResponse,
  ProviderInstanceUpdateRequest,
} from "@kenfutwork/shared";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseHeadersJson, providerHeadersHint } from "@/lib/provider-headers";

const PROTOCOLS = [
  { value: "openai-compatible", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "google-image", label: "Google 图像" },
  { value: "replicate", label: "Replicate" },
  { value: "volces", label: "火山引擎" },
  { value: "metaso", label: "Metaso 视频" },
  // Dify 引擎（《flow 集成方案》P3）：本仓不消费其模型，凭证经 flow 宿主回调下发给 flow 网关
  { value: "dify-engine", label: "Dify 引擎（Flow）" },
] as const;

/** 协议 → 界面名（列表与下拉同一处来源；认不出的值原样显示）。 */
export function protocolLabel(value: string): string {
  return PROTOCOLS.find((option) => option.value === value)?.label ?? value;
}

const DEFAULT_MODELS_JSON =
  '[{"id":"gpt-4.1","name":"GPT-4.1","capability":"chat"}]';

/**
 * 供应商实例表单（新建 / 编辑同一张表，避免两套字段漂移）。
 *
 * 凭据更新行为：
 * - `apiKey` 编辑时留空 = 不改（服务端 `undefined` 即不写该列）；
 * - 自定义头值同理：留空 = 保留已存的（表单下方列出键名），填 `{}` = 清空。
 */
export function ProviderInstanceForm({
  editing,
  submitting,
  onCancel,
  onError,
  onSubmitCreate,
  onSubmitUpdate,
}: {
  editing?: ProviderInstanceResponse | undefined;
  submitting: boolean;
  onCancel: () => void;
  onError: (message: string) => void;
  onSubmitCreate: (input: ProviderInstanceCreateRequest) => Promise<void>;
  onSubmitUpdate: (
    instanceId: string,
    patch: ProviderInstanceUpdateRequest,
  ) => Promise<void>;
}) {
  const isEditing = Boolean(editing);
  const [name, setName] = useState(editing?.name ?? "");
  const [protocol, setProtocol] = useState<string>(
    editing?.protocol ?? "openai-compatible",
  );
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [modelsJson, setModelsJson] = useState(
    editing ? JSON.stringify(editing.models, null, 2) : DEFAULT_MODELS_JSON,
  );
  const [headersJson, setHeadersJson] = useState("");

  const handleSubmit = async () => {
    let models: unknown;
    try {
      models = JSON.parse(modelsJson);
    } catch {
      onError("模型清单必须是合法 JSON");
      return;
    }
    const headers = parseHeadersJson(headersJson);
    if (headers instanceof Error) {
      onError(headers.message);
      return;
    }
    if (!name.trim()) {
      onError("请填写实例名称");
      return;
    }

    if (editing) {
      const patch: ProviderInstanceUpdateRequest = {};
      if (name.trim() !== editing.name) patch.name = name.trim();
      if (baseUrl.trim() !== (editing.baseUrl ?? "")) {
        patch.baseUrl = baseUrl.trim();
      }
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      if (JSON.stringify(models) !== JSON.stringify(editing.models)) {
        patch.models = models as ProviderInstanceUpdateRequest["models"];
      }
      if (headers) patch.headers = headers;
      if (Object.keys(patch).length === 0) {
        onError("没有需要保存的修改");
        return;
      }
      await onSubmitUpdate(editing.id, patch);
      return;
    }

    if (!apiKey.trim()) {
      onError("请填写 API Key");
      return;
    }
    await onSubmitCreate({
      name: name.trim(),
      protocol: protocol as (typeof PROTOCOLS)[number]["value"],
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      apiKey: apiKey.trim(),
      models: models as ProviderInstanceCreateRequest["models"],
      ...(headers ? { headers } : {}),
      enabled: true,
    });
  };

  return (
    <form
      aria-label={isEditing ? "编辑供应商实例" : "新建供应商实例"}
      className="mb-4 space-y-3 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
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
        {isEditing ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {protocolLabel(protocol)}（协议不可修改）
          </p>
        ) : (
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
        )}
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
          {isEditing ? "API Key（留空则不改）" : "API Key"}
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
      <div>
        <label htmlFor="provider-headers" className="text-sm">
          自定义请求头（JSON，可选）
        </label>
        <textarea
          id="provider-headers"
          value={headersJson}
          onChange={(e) => setHeadersJson(e.target.value)}
          rows={2}
          placeholder='{"x-opencode-session":"{{sessionId}}"}'
          className="mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {providerHeadersHint}
          {isEditing && editing && editing.headerKeys.length > 0
            ? `已存：${editing.headerKeys.join("、")}（留空则保留；填 {} 清空）`
            : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {submitting ? "保存中…" : isEditing ? "保存修改" : "保存实例"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-4 py-2 text-sm"
        >
          取消
        </button>
      </div>
    </form>
  );
}
