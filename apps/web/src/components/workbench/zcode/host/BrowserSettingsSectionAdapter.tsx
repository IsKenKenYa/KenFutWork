import { Button } from "@zui/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { Switch } from "@zui/components/ui/switch.js";
import { toast } from "@zui/components/ui/toast.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
// biome-ignore lint/style/useImportType: 保留 value 导入以便 typeof 对齐原组件 props 签名（漂移即编译错）
import { BrowserSettingsSection as OriginalBrowserSettingsSection } from "@zui-original/settings/BrowserSettingsSection.js";
import { type ComponentProps, useEffect, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 浏览器设置分区的宿主适配（T6）。
 *
 * 原分区内容面向 ZCode 桌面端内置浏览器（browser-use 插件开关、Chrome 数据导入/清理），
 * 本宿主没有这条链路；分区改挂旧工作台浏览器设置（`workbench/browser-settings-section.tsx`
 * 的配置项），数据面原样保留、不造第二份真相：
 * - 服务端开关：GET/PUT `/api/permissions/tier`（browserControlEnabled 等，cookie 会话）；
 * - CDP 外部浏览器：`/api/browser/cdp/*`（status/connect/disconnect）；
 * - 「AI 任务默认浏览器」：localStorage `workbench:browser-open-target`
 *   （与 web 端 markdown-renderer 读的同一份偏好，同源 iframe 共享）。
 * 旧页里「默认搜索引擎」「面板历史导入/清除」的读取方已随旧画布工作台退役，无消费方即不摆开关。
 */

interface PermissionTierView {
  browserControlEnabled: boolean;
  browserAutoScreenshot: boolean;
  browserHeadless: boolean;
  browserDevtoolsReadEnabled: boolean;
  browserEvalEnabled: boolean;
}

/** 开关行定义：key 即 PUT patch 字段，label 即行标签（一行一配置项）。 */
const SERVER_FLAGS: ReadonlyArray<{
  key: keyof Pick<
    PermissionTierView,
    | "browserControlEnabled"
    | "browserAutoScreenshot"
    | "browserHeadless"
    | "browserDevtoolsReadEnabled"
    | "browserEvalEnabled"
  >;
  label: string;
}> = [
  { key: "browserControlEnabled", label: "允许 AI 控制浏览器" },
  { key: "browserAutoScreenshot", label: "自动截图" },
  { key: "browserHeadless", label: "无头浏览器" },
  { key: "browserDevtoolsReadEnabled", label: "允许 AI 读取开发者工具数据" },
  { key: "browserEvalEnabled", label: "允许 AI 在页面执行脚本" },
];

type CdpStatus =
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      browser: string;
      tabs: number;
      currentUrl: string;
      headless: boolean;
    }
  | { status: "error"; message: string };

type BrowserOpenTarget = "panel" | "system";

const OPEN_TARGET_KEY = "workbench:browser-open-target";
const OPEN_TARGETS: ReadonlyArray<{ value: BrowserOpenTarget; label: string }> =
  [
    { value: "panel", label: "内置浏览器" },
    { value: "system", label: "外部浏览器" },
  ];

function readOpenTarget(): BrowserOpenTarget {
  try {
    return window.localStorage.getItem(OPEN_TARGET_KEY) === "system"
      ? "system"
      : "panel";
  } catch {
    return "panel";
  }
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "保存失败";
}

/** 原组件 props 只为签名对齐（分区挂载点传参不变），宿主行不消费。 */
export function BrowserSettingsSection(
  _props: ComponentProps<typeof OriginalBrowserSettingsSection>,
) {
  const [flags, setFlags] = useState<PermissionTierView | null>(null);
  const [cdp, setCdp] = useState<CdpStatus | null>(null);
  const [cdpBusy, setCdpBusy] = useState(false);
  const [openTarget, setOpenTarget] = useState<BrowserOpenTarget>("panel");

  useEffect(() => {
    setOpenTarget(readOpenTarget());
    let cancelled = false;
    // 读不到就保持关闭（宁严勿松），与旧设置页同一口径
    surfaceJson<PermissionTierView>("/api/permissions/tier")
      .then((view) => {
        if (!cancelled) setFlags(view);
      })
      .catch(() => {});
    surfaceJson<{ cdp: CdpStatus }>("/api/browser/cdp/status")
      .then((payload) => {
        if (!cancelled) setCdp(payload.cdp);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** 服务端开关：先写库再改界面，失败回滚。 */
  const toggleFlag = async (
    key: (typeof SERVER_FLAGS)[number]["key"],
    next: boolean,
  ) => {
    if (!flags) return;
    setFlags({ ...flags, [key]: next });
    try {
      setFlags(
        await surfaceJson<PermissionTierView>("/api/permissions/tier", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [key]: next }),
        }),
      );
    } catch (error) {
      setFlags((current) => (current ? { ...current, [key]: !next } : current));
      toast(readableError(error));
    }
  };

  const connectCdp = async () => {
    setCdpBusy(true);
    try {
      const payload = await surfaceJson<{ cdp: CdpStatus }>(
        "/api/browser/cdp/connect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      setCdp(payload.cdp);
    } catch (error) {
      toast(readableError(error));
    } finally {
      setCdpBusy(false);
    }
  };

  const disconnectCdp = async () => {
    setCdpBusy(true);
    try {
      const payload = await surfaceJson<{ cdp: CdpStatus }>(
        "/api/browser/cdp/disconnect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      setCdp(payload.cdp);
    } catch (error) {
      toast(readableError(error));
    } finally {
      setCdpBusy(false);
    }
  };

  const cdpDetail =
    cdp === null
      ? "读取中…"
      : cdp.status === "connected"
        ? `${cdp.browser} · ${cdp.tabs} 个标签`
        : cdp.status === "error"
          ? cdp.message
          : null;

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          浏览器工具
        </div>
        <SettingsGroupCard>
          {SERVER_FLAGS.map(({ key, label }) => (
            <SettingsRow
              key={key}
              label={label}
              control={
                <Switch
                  aria-label={label}
                  checked={flags?.[key] ?? false}
                  disabled={flags === null}
                  onCheckedChange={(checked) => void toggleFlag(key, checked)}
                />
              }
            />
          ))}
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          外部浏览器
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label="连接状态"
            control={
              cdp?.status === "connected" ? (
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  disabled={cdpBusy}
                  onClick={() => void disconnectCdp()}
                >
                  断开
                </Button>
              ) : (
                <Button
                  type="button"
                  size="lg"
                  disabled={cdpBusy || cdp === null}
                  onClick={() => void connectCdp()}
                >
                  {cdpBusy ? "连接中…" : "连接到 Chrome"}
                </Button>
              )
            }
            detail={
              cdpDetail ? (
                <div className="text-ui-base text-foreground-subtle">
                  {cdpDetail}
                </div>
              ) : undefined
            }
          />
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          通用
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label="AI 任务默认浏览器"
            control={
              <Select
                value={openTarget}
                onValueChange={(next) => {
                  if (next !== "panel" && next !== "system") return;
                  setOpenTarget(next);
                  try {
                    window.localStorage.setItem(OPEN_TARGET_KEY, next);
                  } catch {
                    // 存储失败不阻塞设置
                  }
                }}
              >
                <SelectTrigger
                  size="lg"
                  aria-label="AI 任务默认浏览器"
                  className="w-[192px] min-w-0 justify-between"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPEN_TARGETS.map((target) => (
                    <SelectItem key={target.value} value={target.value}>
                      {target.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SettingsGroupCard>
      </section>
    </div>
  );
}
