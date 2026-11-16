import type { BrowserOpenTarget } from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { Switch } from "@zui/components/ui/switch.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
// biome-ignore lint/style/useImportType: 保留 value 导入以便 typeof 对齐原组件 props 签名（漂移即编译错）
import { BrowserSettingsSection as OriginalBrowserSettingsSection } from "@zui-original/settings/BrowserSettingsSection.js";
import { type ComponentProps, useId } from "react";
import { useBrowserOpenTarget } from "./useBrowserOpenTarget.js";
import {
  type BrowserPermissionView,
  useBrowserSettingsState,
} from "./useBrowserSettingsState.js";

/**
 * 浏览器设置分区的宿主适配（T6）。
 *
 * 原分区内容面向 ZCode 桌面端内置浏览器（browser-use 插件开关、Chrome 数据导入/清理），
 * 本宿主没有这条链路；分区改挂旧工作台浏览器设置（`workbench/browser-settings-section.tsx`
 * 的配置项），数据面原样保留、不造第二份真相：
 * - 服务端开关：GET/PUT `/api/permissions/tier`（browserControlEnabled 等，cookie 会话）；
 * - CDP 外部浏览器：`/api/browser/cdp/*`（status/connect/disconnect）；
 * - 「AI 任务默认浏览器」：localStorage `workbench:browser-open-target`
 *   （同源 iframe 共享）。
 * 旧页里「默认搜索引擎」「面板历史导入/清除」的读取方已随旧画布工作台退役，无消费方即不摆开关。
 */

/** 开关行定义：key 即 PUT patch 字段，label 即行标签（一行一配置项）。 */
const SERVER_FLAGS: ReadonlyArray<{
  key: keyof Pick<
    BrowserPermissionView,
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

const OPEN_TARGETS: ReadonlyArray<{ value: BrowserOpenTarget; label: string }> =
  [
    { value: "panel", label: "内置浏览器" },
    { value: "system", label: "外部浏览器" },
  ];

/** 原组件 props 只为签名对齐（分区挂载点传参不变），宿主行不消费。 */
export function BrowserSettingsSection(
  _props: ComponentProps<typeof OriginalBrowserSettingsSection>,
) {
  const state = useBrowserSettingsState();
  const { flags, cdp, toggleFlag, connectCdp, disconnectCdp } = state;
  const cdpBusy = state.saving === "cdp";
  const permissionsErrorId = useId();
  const cdpErrorId = useId();
  const openTarget = useBrowserOpenTarget();
  const openTargetErrorId = useId();

  const cdpDetail =
    cdp === null
      ? state.reading
        ? "读取中…"
        : null
      : cdp.status === "connected"
        ? `${cdp.browser} · ${cdp.tabs} 个标签`
        : cdp.status === "error"
          ? cdp.message
          : null;

  return (
    <div className="space-y-5">
      {state.errors.permissions || state.errors.cdp ? (
        <Button
          type="button"
          variant="outline"
          disabled={state.busy}
          onClick={state.reload}
        >
          重新读取浏览器设置
        </Button>
      ) : null}
      <section
        className="space-y-3"
        aria-busy={state.reading || state.saving === "permissions"}
      >
        <div className="text-ui-base font-medium text-foreground-subtle">
          浏览器工具
        </div>
        {state.errors.permissions ? (
          <p
            id={permissionsErrorId}
            role="alert"
            className="text-ui-base text-destructive"
          >
            {state.errors.permissions}
          </p>
        ) : null}
        {flags ? (
          <SettingsGroupCard>
            {SERVER_FLAGS.map(({ key, label }) => (
              <SettingsRow
                key={key}
                label={label}
                control={
                  <Switch
                    aria-label={label}
                    aria-describedby={
                      state.errors.permissions ? permissionsErrorId : undefined
                    }
                    checked={flags[key]}
                    disabled={state.busy}
                    onCheckedChange={(checked) => void toggleFlag(key, checked)}
                  />
                }
              />
            ))}
          </SettingsGroupCard>
        ) : state.reading ? (
          <p className="text-ui-base text-foreground-subtle">读取浏览器设置…</p>
        ) : null}
        {state.saving === "permissions" ? (
          <p role="status" className="text-ui-base text-foreground-subtle">
            保存浏览器设置…
          </p>
        ) : null}
      </section>

      <section className="space-y-3" aria-busy={state.reading || cdpBusy}>
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
                  disabled={state.busy}
                  aria-describedby={state.errors.cdp ? cdpErrorId : undefined}
                  onClick={() => void disconnectCdp()}
                >
                  断开
                </Button>
              ) : (
                <Button
                  type="button"
                  size="lg"
                  disabled={state.busy || cdp === null}
                  aria-describedby={state.errors.cdp ? cdpErrorId : undefined}
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
        {state.errors.cdp ? (
          <p
            id={cdpErrorId}
            role="alert"
            className="text-ui-base text-destructive"
          >
            {state.errors.cdp}
          </p>
        ) : null}
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
                value={openTarget.value ?? ""}
                disabled={openTarget.value === null}
                onValueChange={(next) => {
                  if (next !== "panel" && next !== "system") return;
                  openTarget.save(next);
                }}
              >
                <SelectTrigger
                  size="lg"
                  aria-label="AI 任务默认浏览器"
                  aria-describedby={
                    openTarget.error ? openTargetErrorId : undefined
                  }
                  aria-invalid={Boolean(openTarget.error)}
                  className="w-full min-w-0 justify-between"
                >
                  <SelectValue
                    placeholder={openTarget.error ? "未读取" : "读取中…"}
                  />
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
        {openTarget.error ? (
          <div className="space-y-2">
            <p
              id={openTargetErrorId}
              role="alert"
              className="text-ui-base text-destructive"
            >
              {openTarget.error}
            </p>
            {openTarget.value === null ? (
              <Button
                type="button"
                variant="outline"
                onClick={openTarget.reload}
              >
                重新读取默认浏览器
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
