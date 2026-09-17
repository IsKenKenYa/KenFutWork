"use client";

import { useEffect, useState } from "react";
import { getServerBaseUrl } from "@/lib/env";

/**
 * 设置 → 关于（R5-2 里能落到实处的条目之一）。
 *
 * 只显示**真的拿得到**的信息：服务端版本（`/api/health` 的 version 字段）、服务端地址、
 * 当前界面形态与浏览器。没有数据源的条目（云端运行环境之类）不列——不放空壳。
 */
export function AboutSection() {
  const [health, setHealth] = useState<{
    ok: boolean;
    version: string;
    service: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const base = getServerBaseUrl();

  useEffect(() => {
    let cancelled = false;
    fetch(`${base}/api/health`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((payload: { ok: boolean; version: string; service: string }) => {
        if (!cancelled) setHealth(payload);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const rows: Array<[string, string]> = [
    [
      "服务端",
      failed
        ? "连不上（检查服务端是否在运行）"
        : health
          ? `${health.service} · v${health.version}`
          : "读取中…",
    ],
    ["服务端地址", base || "（同源）"],
    [
      "客户端",
      typeof navigator === "undefined" ? "—" : navigator.userAgent,
    ],
    [
      "界面",
      typeof window === "undefined"
        ? "—"
        : `${window.innerWidth} × ${window.innerHeight}`,
    ],
  ];

  return (
    <section aria-label="关于">
      <h3 className="mb-1 text-base font-medium">关于</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        KenFutWork：BYOK 的 AI 工作台（Code 对话 / Design 画布双模式）。
      </p>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 flex-1 break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        数据都在你自己的机器上：模型 Key 加密存在本地库、索引是本机文件、日志不落密钥。
      </p>
    </section>
  );
}
