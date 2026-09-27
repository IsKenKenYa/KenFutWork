"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { getServerBaseUrl } from "@/lib/env";
import {
  SETTINGS_ROW,
  SETTINGS_ROW_STACK,
  SETTINGS_TITLE,
} from "@/lib/settings-layout";

/**
 * 设置 → 关于。
 *
 * 排版口径（用户口径 2026-09-27「还是很啰嗦，而且排版很不合理」）：
 * 与其他设置页用**同一套行**（全宽、等高、标签左值右），不再是一坨小字漂在空白里；
 * 许可清单默认折叠（`<details>`）——署名仍可查（法律要求），但首屏只有三行。
 *
 * 只列**用户看得懂且真拿得到**的信息：服务端身份与服务端地址；不列没有数据源的条目（不放空壳）。
 *
 * **产品名后不写版本号**：`/api/health` 的 version 是**服务端包**的版本（`env.version` 读的是
 * `apps/server/package.json`），标在产品名后等于把服务端版本说成客户端版本——自托管跑旧服务端
 * 时会直接说错，而且与下一行「服务端」重复同一个数字。版本只在「服务端」行如实出现。
 */

/** 第三方模型的许可署名（规划 §10 风险 7；Kokoro Apache-2.0、espeak-ng 数据 GPL-3.0）。 */
const THIRD_PARTY_NOTICES: ReadonlyArray<readonly [string, string]> = [
  ["SenseVoiceSmall", "FunASR 许可"],
  ["sherpa-onnx", "Apache-2.0"],
  ["Silero VAD", "MIT"],
  ["Kokoro 多语版", "Apache-2.0"],
  ["espeak-ng 数据", "GPL-3.0"],
];

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

  const server = failed
    ? "未连接"
    : health
      ? `${health.service} · v${health.version}`
      : "读取中…";

  return (
    <section aria-label="关于" className="w-full">
      <h3 className={SETTINGS_TITLE}>关于</h3>
      <div className={`${SETTINGS_ROW_STACK} w-full`}>
        {/*
          每一行都是「标签在左、值在右」（`justify-between`）。曾经漏了这一条，
          标签与值只隔 8px 挤在左边、右半整片空着——用户直接点名「这个排版不能改吗」。
        */}
        <div className={`${SETTINGS_ROW} justify-between`}>
          <span className="font-medium">KenFutWork</span>
          <span className="text-muted-foreground">BYOK 的 AI 工作台</span>
        </div>
        <div className={`${SETTINGS_ROW} justify-between`}>
          <span className="text-muted-foreground">服务端</span>
          <span className="min-w-0 break-all">{server}</span>
        </div>
        <div className={`${SETTINGS_ROW} justify-between`}>
          <span className="text-muted-foreground">地址</span>
          <span className="min-w-0 break-all">{base || "（同源）"}</span>
        </div>
        {/* 隐私承诺单独一行（原先塞在许可清单里当无值的一项，看着像坏行） */}
        <div className={`${SETTINGS_ROW} justify-between`}>
          <span className="text-muted-foreground">录音</span>
          <span>不留存</span>
        </div>
        {/*
          许可折叠块：`summary` 自己就是一行（同 42px、同左内边距），展开后内容缩进对齐。
          不用原生三角标——把它设成 flex 行原生标记就不渲染了，改用会转的箭头。
        */}
        <details className="w-full rounded-lg border">
          <summary className="flex min-h-[2.625rem] cursor-pointer items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <ChevronRight className="h-4 w-4 shrink-0 transition-transform [details[open]_&]:rotate-90" />
            第三方模型许可
          </summary>
          <ul className="space-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
            {THIRD_PARTY_NOTICES.map(([name, license]) => (
              <li key={name} className="flex justify-between gap-4">
                <span>{name}</span>
                <span>{license}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}
