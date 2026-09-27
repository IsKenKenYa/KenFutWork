"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { SETTINGS_TITLE } from "@/lib/settings-layout";

/**
 * 设置 → 外观（R5-2：参考图里的「外观」条目）。
 *
 * 机制本来就在（`next-themes` 的 `attribute="class"` + `globals.css` 的 `.dark` 令牌集 +
 * 画布按 `resolvedTheme` 切 Excalidraw 主题），缺的一直是**入口**。这一页只做三件事：
 * 三选一写 `theme`（`light` / `dark` / `system`）、把当前解析结果如实显示出来、
 * 说明哪些地方会跟着变（含画布）。
 *
 * 偏好存**本机**（next-themes 默认 localStorage，键 `theme`）：外观是设备级的——
 * 同一账号在手机与桌面上想要的主题本来就可以不同，不该跟工作区设置绑在一起。
 */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  /** next-themes 在挂载前拿不到真值（服务端渲染没有 localStorage），先不渲染选中态以免闪烁 */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const options = [
    { value: "light", label: "浅色", Icon: Sun },
    { value: "dark", label: "深色", Icon: Moon },
    { value: "system", label: "跟随系统", Icon: Monitor },
  ] as const;

  return (
    <section aria-label="外观设置">
      <h3 className={SETTINGS_TITLE}>外观</h3>

      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="sr-only">主题</legend>
        {options.map(({ value, label, Icon }) => {
          const active = mounted && (theme ?? "system") === value;
          return (
            /* 真的 radio（不是 role="radio" 的按钮）：分组、方向键、读屏语义由浏览器给 */
            <label
              key={value}
              data-active={active}
              className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted/60 data-[active=true]:border-foreground/40 data-[active=true]:bg-muted"
            >
              <input
                type="radio"
                name="theme"
                value={value}
                checked={active}
                onChange={() => setTheme(value)}
                className="sr-only"
              />
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{label}</span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}
