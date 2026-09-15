import type { AuthenticatedUser, RequestAuthenticator } from "./types.js";

/**
 * 桌面 local-trust 认证（FORM-2 / 《多端》§5）：本机回环免登录。
 *
 * **为什么需要两道判定**：免登录意味着**任何能到达本端口的请求都是本机用户**。
 * 桌面上「能到达」的路径不止一条：
 *   1. 本机其它进程 / 桌面壳 / 命令行工具（无 `Origin`）——这是要放行的；
 *   2. **用户自己浏览器里的任意网页**：`fetch("http://127.0.0.1:3001/api/viewer")`
 *      会照常发出（CORS 只挡读响应，不挡发请求；而本项目 CORS 还放行回环与 `null`
 *      来源），于是恶意页面能借用户浏览器读走本机数据。
 * 故本 Provider 的门槛是：来源必须是**回环页面或无来源**，且**请求 IP 必须是回环**
 * （`ip` 由 Fastify 从 socket 取，不可伪造）。启动期另有守卫：local-trust 形态下
 * 绑定非回环地址直接拒绝启动（见 `assertLocalTrustPosture`）。
 *
 * 本机账号在首次请求时幂等建出（`public.accounts`，无口令凭据——本形态不走口令登录）。
 */

export const LOCAL_TRUST_EMAIL = "local@kenfutwork.local";
export const LOCAL_TRUST_DISPLAY_NAME = "本机用户";

export type LocalAccount = { email: string; id: string };

export interface LocalAccountProvider {
  /** 幂等取/建本机账号（并发安全由仓储层保证；仓储方法的同实现）。 */
  ensurePasswordlessAccount(input: {
    displayName: string | null;
    email: string;
  }): Promise<LocalAccount>;
}

/** 回环主机名判定（含 IPv6 字面量的方括号形态与 localhost 别名）。 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

/**
 * 浏览器来源是否可信。
 * - 无 `Origin`：非浏览器客户端（桌面壳/命令行/测试）→ 放行；
 * - `null`：沙箱 iframe 与 `file://` 都可能是 `null`，恶意页面也能造出来 → **不放行**
 *   （桌面 UI 由本服务自己托管在回环 http 上，不需要这条）；
 * - 其余：必须是回环页面。
 */
export function isTrustedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") {
    return true;
  }
  if (origin === "null") {
    return false;
  }
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function createLocalTrustAuthenticator(options: {
  accounts: LocalAccountProvider;
  /** 平台约定：绑定非回环地址时不得启用本形态（启动期由 server 校验）。 */
  displayName?: string;
}): RequestAuthenticator {
  // 本机账号在进程生命周期内不变，解析一次后缓存（桌面单用户）
  let cachedUserId: string | undefined;

  return {
    async authenticate(request) {
      if (request.ip !== undefined && !isLoopbackHostname(request.ip)) {
        return null;
      }
      if (!isTrustedOrigin(request.headers.origin)) {
        return null;
      }

      if (cachedUserId) {
        return userFrom(cachedUserId);
      }

      try {
        const account = await options.accounts.ensurePasswordlessAccount({
          displayName: options.displayName ?? LOCAL_TRUST_DISPLAY_NAME,
          email: LOCAL_TRUST_EMAIL,
        });
        cachedUserId = account.id;
        return userFrom(account.id, account.email);
      } catch {
        // 数据层故障折叠为「未认证」，与自管形态的失败口径一致（路由回 401，不泄漏内部细节）
        return null;
      }
    },
  };
}

function userFrom(
  userId: string,
  email = LOCAL_TRUST_EMAIL,
): AuthenticatedUser {
  return {
    // 本形态没有会话令牌：下游若把它当凭据转发，得到的是空串（明确表达「无令牌」）
    accessToken: "",
    email,
    id: userId,
    userMetadata: { display_name: LOCAL_TRUST_DISPLAY_NAME, local_trust: true },
  };
}

/**
 * 启动期姿态校验：local-trust 免登录形态**只允许绑定回环地址**。
 * 绑到 0.0.0.0 时局域网内任何人都是「本机用户」——这是必须 fail loud 的误配置。
 */
export function assertLocalTrustPosture(input: {
  authDriver: string | undefined;
  host: string;
}): void {
  if (input.authDriver !== "local-trust" || isLoopbackHostname(input.host)) {
    return;
  }
  throw new Error(
    `KENFUTWORK_AUTH_DRIVER=local-trust 是免登录形态，只能绑定回环地址（当前 HOST=${input.host}）。` +
      "需要对外提供服务时请改用自管认证（KENFUTWORK_AUTH_DRIVER=managed）。",
  );
}
