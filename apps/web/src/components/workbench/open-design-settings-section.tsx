"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchOpenDesignConfig,
  type OpenDesignConfigView,
  updateOpenDesignConfig,
} from "@/lib/server-api";
import {
  SETTINGS_CONTROL_WIDTH,
  SETTINGS_ROW_MIN_HEIGHT,
  SETTINGS_SECTION_GAP,
  SETTINGS_TITLE,
} from "@/lib/settings-layout";

/**
 * OpenDesign 桌面承载配置（§205）。
 *
 * 写 `<dataDir>/config/open-design.env`：桌面壳启动时白名单注入这两个键，
 * 服务端装配期据此决定「伴随容器托管 / 外部自管 / 未启用」。改文件不改运行中
 * 进程——装配期定形，重启桌面生效；界面如实显示这个时差。
 */
export function OpenDesignSettingsSection({
  accessToken,
}: {
  accessToken: string | null | undefined;
}) {
  const [config, setConfig] = useState<OpenDesignConfigView | null>(null);
  const [frontendUrl, setFrontendUrl] = useState("");
  const [embedSecret, setEmbedSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchOpenDesignConfig(accessToken)
      .then((view) => {
        if (cancelled) return;
        setConfig(view);
        setFrontendUrl(view.frontendUrl ?? "");
        setEmbedSecret(view.embedSecret ?? "");
      })
      .catch(() => {
        // 读不到不摆假表单：状态行如实说没连上
        if (!cancelled) setError("读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const applyView = (view: OpenDesignConfigView) => {
    setConfig(view);
    setFrontendUrl(view.frontendUrl ?? "");
    setEmbedSecret(view.embedSecret ?? "");
  };

  const dirty =
    config !== null &&
    (frontendUrl !== (config.frontendUrl ?? "") ||
      embedSecret !== (config.embedSecret ?? ""));

  const save = () => {
    setSaving(true);
    setError(null);
    void updateOpenDesignConfig(accessToken, {
      frontendUrl: frontendUrl.trim() || null,
      embedSecret: embedSecret.trim() || null,
    })
      .then((view) => applyView(view))
      .catch((saveError: unknown) =>
        setError(
          saveError instanceof Error
            ? saveError.message.slice(0, 120)
            : "保存失败",
        ),
      )
      .finally(() => setSaving(false));
  };

  const statusLine =
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
    <div
      className="pb-6"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: SETTINGS_SECTION_GAP,
      }}
    >
      <h3 className={SETTINGS_TITLE}>OpenDesign</h3>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 12,
          minHeight: SETTINGS_ROW_MIN_HEIGHT,
        }}
      >
        <span className="min-w-0 flex-1 text-sm">前端地址</span>
        <Input
          data-testid="od-frontend-url"
          value={frontendUrl}
          onChange={(event) => setFrontendUrl(event.target.value)}
          placeholder="http://127.0.0.1:7456"
          style={{ width: SETTINGS_CONTROL_WIDTH }}
        />
      </div>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 12,
          minHeight: SETTINGS_ROW_MIN_HEIGHT,
        }}
      >
        <span className="min-w-0 flex-1 text-sm">成对密钥</span>
        <Input
          data-testid="od-embed-secret"
          value={embedSecret}
          onChange={(event) => setEmbedSecret(event.target.value)}
          placeholder="与伴随容器 OD_API_TOKEN 同值"
          style={{ width: SETTINGS_CONTROL_WIDTH }}
        />
      </div>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 12,
          minHeight: SETTINGS_ROW_MIN_HEIGHT,
        }}
      >
        <span
          data-testid="od-config-status"
          className="min-w-0 flex-1 text-xs text-foreground-subtle"
        >
          {statusLine}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={config === null || saving || !dirty}
          onClick={save}
        >
          保存
        </Button>
      </div>
    </div>
  );
}
