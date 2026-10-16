import type { OpenDesignHostConfigResponse } from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import { Input } from "@zui/components/ui/input.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
import { useCallback, useEffect, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 设置 → OpenDesign（宿主件）。
 *
 * 写 `<dataDir>/config/open-design.env`：桌面壳启动时白名单注入这两个键，服务端
 * 装配期据此决定「伴随容器托管 / 外部自管 / 未启用」。改文件不改运行中进程——
 * 装配期定形，重启桌面生效，状态行如实显示这个时差。
 */

const CONFIG_PATH = "/api/open-design/host/config";

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 120)
    : fallback;
}

export function HostOpenDesignSettingsSection() {
  const [config, setConfig] = useState<OpenDesignHostConfigResponse | null>(
    null,
  );
  const [frontendUrl, setFrontendUrl] = useState("");
  const [embedSecret, setEmbedSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const applyView = useCallback((view: OpenDesignHostConfigResponse) => {
    setConfig(view);
    setFrontendUrl(view.frontendUrl ?? "");
    setEmbedSecret(view.embedSecret ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<OpenDesignHostConfigResponse>(CONFIG_PATH)
      .then((view) => {
        if (!cancelled) applyView(view);
      })
      .catch(() => {
        // 读不到不摆假表单：状态行如实说没连上
        if (!cancelled) setError("读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [applyView]);

  const dirty =
    config !== null &&
    (frontendUrl !== (config.frontendUrl ?? "") ||
      embedSecret !== (config.embedSecret ?? ""));

  const save = () => {
    setSaving(true);
    setError(null);
    surfaceJson<OpenDesignHostConfigResponse>(CONFIG_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        frontendUrl: frontendUrl.trim() || null,
        embedSecret: embedSecret.trim() || null,
      }),
    })
      .then(applyView)
      .catch((saveError: unknown) =>
        setError(readableError(saveError, "保存失败")),
      )
      .finally(() => setSaving(false));
  };

  const status =
    error ??
    (config === null
      ? "正在读取…"
      : config.source === "env"
        ? "环境变量生效中"
        : config.restartRequired
          ? "已保存 重启桌面后生效"
          : config.frontendUrl
            ? "已生效"
            : "未启用");

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label="前端地址"
          control={
            <Input
              data-testid="od-frontend-url"
              value={frontendUrl}
              onChange={(event) => setFrontendUrl(event.target.value)}
              placeholder="http://127.0.0.1:7456"
            />
          }
        />
        <SettingsRow
          label="成对密钥"
          control={
            <Input
              data-testid="od-embed-secret"
              value={embedSecret}
              onChange={(event) => setEmbedSecret(event.target.value)}
              placeholder="与 OD_API_TOKEN 同值"
            />
          }
        />
        <SettingsRow
          label={<span data-testid="od-config-status">{status}</span>}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={config === null || saving || !dirty}
              onClick={save}
            >
              保存
            </Button>
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
