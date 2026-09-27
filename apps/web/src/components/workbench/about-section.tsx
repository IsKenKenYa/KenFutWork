"use client";

import { useEffect, useState } from "react";

import { KenFutWorkLogo } from "@/components/icons/kenfutwork-logo";
import { getServerBaseUrl } from "@/lib/env";
import { SETTINGS_TITLE } from "@/lib/settings-layout";

/**
 * 设置 → 关于，**信息面板**形态（用户口径 2026-09-27：「这个不要做成选项卡，做成信息面板
 * 那样的」，并给了参考图：标识 + 产品名 + 版本 + 域名 + 一列条目，全部居中）。
 *
 * 所以这一页**不用设置区的行样式**（那是「标签左 / 值右」的配置行，用于逐项设置）；
 * 关于页没有任何可设置的东西，居中罗列才是它该有的形态。曾经做成一行行带框的卡片，
 * 用户直接点名要求换掉。
 *
 * 只列**用户看得懂且真拿得到**的信息：服务端身份（含版本）与服务端地址；不列没有数据源的条目。
 *
 * **产品名后不写版本号**：`/api/health` 的 version 是**服务端包**的版本（`env.version` 读的是
 * `apps/server/package.json`），标在产品名后等于把服务端版本说成客户端版本——自托管跑旧服务端
 * 时会直接说错。版本只随「服务端」那一行如实出现。
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
  /** 没配 `NEXT_PUBLIC_SERVER_BASE_URL` 时（桌面端与同源代理）地址就是页面自己的 origin */
  const [origin, setOrigin] = useState("");
  const base = getServerBaseUrl();

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

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
  const address = base || origin;

  return (
    <section aria-label="关于" className="w-full">
      <h3 className={SETTINGS_TITLE}>关于</h3>
      {/*
        信息面板：全部居中，自上而下 标识 → 名字 → 一句话 → 服务端 → 地址 → 许可 → 隐私承诺。
        这里**刻意不用设置区的行样式**（那是配置行用的），也不折叠许可——关于页没有任何
        可设置的东西，摊平罗列才对（用户口径：「不要做成选项卡，做成信息面板那样的」）。
      */}
      <div className="flex w-full flex-col items-center text-center">
        <KenFutWorkLogo className="mb-2 h-10 w-auto" />
        <p className="text-base font-medium">KenFutWork</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          BYOK 的 AI 工作台
        </p>

        <p className="mt-5 text-sm break-all">{server}</p>
        {address ? (
          <p className="mt-0.5 text-xs break-all text-muted-foreground">
            {address}
          </p>
        ) : null}

        <p className="mt-6 text-xs text-muted-foreground">第三方模型许可</p>
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {THIRD_PARTY_NOTICES.map(([name, license]) => (
            <li key={name}>
              {name} · {license}
            </li>
          ))}
        </ul>

        <p className="mt-5 text-xs text-muted-foreground">录音不留存</p>
      </div>
    </section>
  );
}
