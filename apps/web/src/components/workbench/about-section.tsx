"use client";

import { useEffect, useState } from "react";
import { getServerBaseUrl } from "@/lib/env";

/**
 * 设置 → 关于（R5-2 里能落到实处的条目之一）。
 *
 * 只显示**用户看得懂、且真的拿得到**的信息：版本与服务端地址。没有数据源的条目
 * （云端运行环境之类）不列——不放空壳；浏览器 UA、窗口尺寸这类排查用的技术字段也不列。
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
        ? "未连接"
        : health
          ? `${health.service} · v${health.version}`
          : "读取中…",
    ],
    ["服务端地址", base || "（同源）"],
  ];

  return (
    <section aria-label="关于">
      <h3 className="mb-1 text-base font-medium">关于</h3>
      <p className="mb-3 text-sm text-muted-foreground">BYOK 的 AI 工作台</p>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 flex-1 break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {/*
       * 语音模型的许可署名（规划 §10 风险 7：SenseVoice 权重走 FunASR 模型许可，**需署名**；
       * Kokoro 为 Apache-2.0，随带的 espeak-ng 音素数据为 GPL-3.0）。
       * 许可是法律要求故保留清单——但只写「模型 + 许可 + 出处」，不写成段落（界面文案硬约束）。
       */}
      <div className="mt-4 space-y-1 text-xs text-muted-foreground">
        <p>语音模型（按需下载）</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>SenseVoiceSmall · FunASR 许可</li>
          <li>sherpa-onnx · Apache-2.0</li>
          <li>Silero VAD · MIT</li>
          <li>Kokoro 多语版 · Apache-2.0</li>
          <li>espeak-ng 数据 · GPL-3.0</li>
        </ul>
        <p>录音不留存</p>
      </div>
    </section>
  );
}
