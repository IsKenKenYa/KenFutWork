/**
 * 首屏主题引导：`next-themes` 的脚本与 CSS 之间仍有一帧浏览器默认白底，
 * 已持久化深色的实例刷新时会闪白。这里在 body 起始处同步执行一段内联脚本，
 * 先按本地缓存（next-themes 的 `theme`，回退 iframe 用的 `zcode-theme`）落主题类与底色。
 *
 * 主题权威来源仍是实例设置（`InstanceThemeSync`）；本模块只做首帧缓存解析。
 */
export type BootTheme = "light" | "dark";

function normalizeThemePreference(
  value: string | null,
): BootTheme | "system" | null {
  if (value === "dark" || value === "zai-dark") return "dark";
  if (value === "light" || value === "zai-light") return "light";
  if (value === "system") return "system";
  return null;
}

/**
 * 解析首帧主题：**显式选择优先于 system**。
 *
 * next-themes 把 `system` 也写进 `theme`，旧实现 `n(t) || n(z)` 会被这个
 * truthy 的 "system" 短路，导致 iframe 里已存的 `zcode-theme=zai-dark` 被忽略，
 * 刷新首帧闪白并回到跟随系统。两份缓存只要有一份是明确的 light/dark，就以它为准。
 */
export function resolveBootTheme(
  storedTheme: string | null,
  storedZcodeTheme: string | null,
  prefersDark: boolean,
): BootTheme {
  const a = normalizeThemePreference(storedTheme);
  const b = normalizeThemePreference(storedZcodeTheme);
  const cached =
    a === "dark" || a === "light"
      ? a
      : b === "dark" || b === "light"
        ? b
        : "system";
  if (cached === "dark") return "dark";
  if (cached === "light") return "light";
  return prefersDark ? "dark" : "light";
}

/** 与 globals.css 的 --background 取值对应；只用于首帧，主题类就绪后由 token 接管。 */
const BOOT_BACKGROUND: Record<BootTheme, string> = {
  light: "#ffffff",
  dark: "#0a0a0a",
};

/**
 * 内联执行版本，逻辑与 `resolveBootTheme` 一致（首帧不能等待模块加载）。
 * 测试见 `test/theme-bootstrap.test.ts`。
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{
var t=localStorage.getItem("theme"),z=localStorage.getItem("zcode-theme");
function n(x){return x==="zai-dark"?"dark":x==="zai-light"?"light":x==="dark"||x==="light"||x==="system"?x:null}
var a=n(t),b=n(z);
var p=(a==="dark"||a==="light")?a:(b==="dark"||b==="light")?b:"system";
var dark=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);
var r=document.documentElement;
r.classList.toggle("dark",dark);
r.style.colorScheme=dark?"dark":"light";
r.style.backgroundColor=dark?"${BOOT_BACKGROUND.dark}":"${BOOT_BACKGROUND.light}";
}catch(e){}})();`;
