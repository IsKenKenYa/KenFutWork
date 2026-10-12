import appLogoUrl from "@zui/assets/kenfutwork-mark.png";
import { Button } from "@zui/components/ui/button.js";
import { useDesktopUpdateMenu } from "@zui/hooks/useDesktopUpdateMenu.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { useEffect, useState } from "react";
import { getSurfaceApiBase, surfaceJson } from "./surfaceApi.js";

// png 的环境声明有两套：zcode 构建里是 vite/client 的 string，
// web 工程里是 next 的 StaticImageData——运行时（code-ui vite 构建）恒为 string。
const logoSrc = appLogoUrl as unknown as string;

/**
 * 设置 → 关于（宿主件，T16）。
 *
 * 恢复旧版独立关于页（`apps/web/src/components/workbench/about-section.tsx`）的信息面板
 * 形态：标识 + 产品名 + 一句话 + 服务端 + 地址 + 第三方许可 + 隐私承诺 + 法律文档，全部居中。
 * code-ui 是独立静态应用、不与 web 应用共享模块，故按同一契约在宿主侧重实现；数据面仍走
 * `/api/health`（cookie 会话，与 surfaceApi 同口径）。
 *
 * 「检查更新」走 vendored 桌面更新缝（useDesktopUpdateMenu → executeDesktopCommand /
 * onUpdateStateChanged），与帮助菜单同一入口；非桌面形态或 Preview 身份按平台能力如实隐藏。
 * 产品名后不写版本号：`/api/health` 的 version 是服务端包版本，只随「服务端」行如实出现。
 */

/** 第三方模型的许可署名（与旧关于页同源；Kokoro Apache-2.0、espeak-ng 数据 GPL-3.0）。 */
const THIRD_PARTY_NOTICES: ReadonlyArray<readonly [string, string]> = [
  ["SenseVoiceSmall", "FunASR 许可"],
  ["sherpa-onnx", "Apache-2.0"],
  ["Silero VAD", "MIT"],
  ["Kokoro 多语版", "Apache-2.0"],
  ["espeak-ng 数据", "GPL-3.0"],
];

/** 法律文档：仓库根的属主文件，只给链接与标签，不在界面里复述条款。 */
const LEGAL_DOCUMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    "最终用户许可协议",
    "https://github.com/IsKenKenYa/KenFutWork/blob/main/EULA.md",
  ],
  ["隐私政策", "https://github.com/IsKenKenYa/KenFutWork/blob/main/PRIVACY.md"],
  [
    "第三方声明",
    "https://github.com/IsKenKenYa/KenFutWork/blob/main/THIRD-PARTY-NOTICES.md",
  ],
];

interface HealthPayload {
  ok: boolean;
  version: string;
  service: string;
}

export function HostAboutSection({
  isDesktop = false,
}: {
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const updateMenu = useDesktopUpdateMenu(isDesktop);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<HealthPayload>("/api/health")
      .then((payload) => {
        if (!cancelled) setHealth(payload);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const server = failed
    ? "未连接"
    : health
      ? `${health.service} · v${health.version}`
      : "读取中…";
  const address = getSurfaceApiBase();

  return (
    <section
      aria-label="关于"
      className="mx-auto flex w-full max-w-xl flex-col items-center py-8 text-center"
    >
      {/* biome-ignore lint/performance/noImgElement: code-ui 是 vite 独立构建（无 next/image），与 vendored WindowsTopLeftLogo 同一口径 */}
      <img
        src={logoSrc}
        alt="KenFutWork"
        className="mb-2 h-10 w-auto select-none"
        draggable={false}
      />
      <p className="text-base font-medium">KenFutWork</p>
      <p className="mt-0.5 text-xs text-foreground-subtle">BYOK 的 AI 工作台</p>

      <p className="mt-5 text-sm break-all">{server}</p>
      <p className="mt-0.5 text-xs break-all text-foreground-subtle">
        {address}
      </p>

      {updateMenu.visible ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="mt-6"
          disabled={updateMenu.disabled}
          onClick={updateMenu.checkForUpdates}
        >
          {intl.formatMessage(
            { id: updateMenu.labelId },
            updateMenu.labelValues,
          )}
        </Button>
      ) : null}

      <p className="mt-6 text-xs text-foreground-subtle">第三方模型许可</p>
      <ul className="mt-1 space-y-0.5 text-xs text-foreground-subtle">
        {THIRD_PARTY_NOTICES.map(([name, license]) => (
          <li key={name}>
            {name} · {license}
          </li>
        ))}
      </ul>

      <p className="mt-5 text-xs text-foreground-subtle">录音不留存</p>

      <nav
        aria-label="法律文档"
        className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs"
      >
        {LEGAL_DOCUMENTS.map(([label, href]) => (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-foreground-subtle underline-offset-2 hover:underline"
          >
            {label}
          </a>
        ))}
      </nav>
    </section>
  );
}
