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
import {
  SETTINGS_CONTROL_WIDTH,
  SETTINGS_ROW,
  SETTINGS_ROW_STACK,
} from "@/lib/settings-layout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

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
 * 只写字段的口径（凭证红线）：
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
      onError("请填写 API Key（保存后不可查看）");
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
      className={`mb-4 ${SETTINGS_ROW_STACK}`}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      {/* 单行字段一律「标签在左、控件在右」（用户口径 2026-09-27）；JSON 是多行编辑，标签在上 */}
      <div className={`${SETTINGS_ROW} justify-between`}>
        <Label htmlFor="provider-name">实例名称</Label>
        <Input
          id="provider-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`${SETTINGS_CONTROL_WIDTH} h-auto py-1.5`}
        />
      </div>
      <div className={`${SETTINGS_ROW} justify-between`}>
        <Label htmlFor="provider-protocol">协议</Label>
        {isEditing ? (
          <span className="text-sm text-muted-foreground">
            {protocolLabel(protocol)}（协议不可修改）
          </span>
        ) : (
          <Select
            value={protocol}
            onValueChange={(next) => {
              if (typeof next === "string") setProtocol(next);
            }}
            items={PROTOCOLS.map((p) => ({ value: p.value, label: p.label }))}
          >
            <SelectTrigger
              id="provider-protocol"
              className={SETTINGS_CONTROL_WIDTH}
            >
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
      <div className={`${SETTINGS_ROW} justify-between`}>
        <Label htmlFor="provider-base-url">Base URL</Label>
        <Input
          id="provider-base-url"
          placeholder="可选"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className={`${SETTINGS_CONTROL_WIDTH} h-auto py-1.5`}
        />
      </div>
      <div className={`${SETTINGS_ROW} justify-between`}>
        <Label htmlFor="provider-api-key">API Key</Label>
        <Input
          id="provider-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={isEditing ? "留空则不改" : ""}
          className={`${SETTINGS_CONTROL_WIDTH} h-auto py-1.5`}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="provider-models">模型清单（JSON）</Label>
        <textarea
          id="provider-models"
          value={modelsJson}
          onChange={(e) => setModelsJson(e.target.value)}
          rows={3}
          className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="provider-headers">自定义请求头</Label>
        <textarea
          id="provider-headers"
          value={headersJson}
          onChange={(e) => setHeadersJson(e.target.value)}
          rows={2}
          placeholder={
            isEditing
              ? "留空保留 · {} 清空"
              : '{"x-opencode-session":"{{sessionId}}"}'
          }
          className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none"
        />
        <p className="text-xs text-muted-foreground">
          {providerHeadersHint}
          {isEditing && editing && editing.headerKeys.length > 0
            ? `已存：${editing.headerKeys.join("、")}`
            : ""}
        </p>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" disabled={submitting} size="sm">
          {submitting ? "保存中…" : isEditing ? "保存修改" : "保存实例"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}
