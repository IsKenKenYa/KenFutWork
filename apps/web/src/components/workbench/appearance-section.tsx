"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

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
  const { theme, resolvedTheme, setTheme } = useTheme();
  /** next-themes 在挂载前拿不到真值（服务端渲染没有 localStorage），先不渲染选中态以免闪烁 */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const options = [
    { value: "light", label: "浅色", hint: "始终用浅色", Icon: Sun },
    { value: "dark", label: "深色", hint: "始终用深色", Icon: Moon },
    {
      value: "system",
      label: "跟随系统",
      hint: "随操作系统的深浅色设置切换",
      Icon: Monitor,
    },
  ] as const;

  return (
    <section aria-label="外观设置">
      <h3 className="mb-1 text-base font-medium">外观</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        主题存在**本机**（同一账号在不同设备上可以不一样）。画布（Design
        模式）会跟着切换，代码预览的语法高亮也有深浅两套配色。
      </p>

      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="sr-only">主题</legend>
        {options.map(({ value, label, hint, Icon }) => {
          const active = mounted && (theme ?? "system") === value;
          return (
            /* 真的 radio（不是 role="radio" 的按钮）：分组、方向键、读屏语义由浏览器给 */
            <label
              key={value}
              data-active={active}
              className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/60 data-[active=true]:border-foreground/40 data-[active=true]:bg-muted"
            >
              <input
                type="radio"
                name="theme"
                value={value}
                checked={active}
                onChange={() => setTheme(value)}
                className="sr-only"
              />
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm">{label}</span>
                <span className="block text-xs text-muted-foreground">
                  {hint}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <p className="mt-3 text-xs text-muted-foreground">
        当前生效：
        {mounted ? (resolvedTheme === "dark" ? "深色" : "浅色") : "…"}
        {(theme ?? "system") === "system" ? "（跟随系统）" : ""}
      </p>
    </section>
  );
}
