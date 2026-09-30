/**
 * zcode 照搬（部分）：`@/embeddedBrowserHelpers` 中照搬组件实际消费的切片。
 * 来源：references/zcode/packages/ui/src/embeddedBrowserHelpers.ts
 * 许可证：Apache-2.0（zcode）。
 * 适配：只保留 `resolveMessageLinkOpenTarget` 及其依赖链（本机/私网启发式）。
 * webview guest 生命周期等 Electron 专属逻辑不搬。
 */

export const DEFAULT_BROWSER_URL = "about:blank";

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function parseIpv4Address(
  host: string,
): [number, number, number, number] | null {
  if (!IPV4_RE.test(host)) {
    return null;
  }

  const octets = host.split(".").map((part) => Number(part));
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }

  return octets as [number, number, number, number];
}

function isLocalhostName(host: string): boolean {
  return (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost")
  );
}

function isLocalDevelopmentHost(host: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
  if (
    isLocalhostName(normalizedHost) ||
    normalizedHost === "::1" ||
    normalizedHost === "0:0:0:0:0:0:0:1" ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".test")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Address(normalizedHost);
  if (!ipv4) {
    return false;
  }

  const [first, second, third, fourth] = ipv4;
  return (
    first === 127 ||
    (first === 0 && second === 0 && third === 0 && fourth === 0) ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isLocalDevelopmentBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return isLocalDevelopmentHost(parsed.hostname);
  } catch {
    return false;
  }
}

export type MessageLinkOpenTarget = "app-browser" | "external-browser";

/**
 * 交互语义：右键菜单的两项是显式互补的目标选择，只有左键单击才走本机/私网启发式。
 * 两个 flag 同传时以 forceExternal 为准，避免调用方组合出歧义状态。
 */
export function resolveMessageLinkOpenTarget(input: {
  href: string;
  forceExternal?: boolean;
  forceInApp?: boolean;
}): MessageLinkOpenTarget {
  if (input.forceExternal) {
    return "external-browser";
  }

  if (input.forceInApp) {
    return "app-browser";
  }

  return isLocalDevelopmentBrowserUrl(input.href)
    ? "app-browser"
    : "external-browser";
}
