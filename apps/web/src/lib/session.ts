"use client";

import { getServerBaseUrl } from "./env";
import { migrateLegacyStorageKeys } from "./legacy-storage";

/**
 * 自管认证的浏览器客户端（M1.4 / M1.5）。
 *
 * 令牌由**本服务**签发（`POST /api/auth/register|login|logout|session`），这里只负责
 * 「存令牌、带令牌、登出清令牌」。原 Supabase Auth（GoTrue）形态已随 M1.5 删除——
 * 只剩一种实现，故「客户端 + 外观」两层合并为本模块；消费方（auth-context / 登录注册
 * 表单 / 模型选择器）直接依赖它。
 */

const TOKEN_STORAGE_KEY = "kenfutwork.session.token";
const EXPIRES_STORAGE_KEY = "kenfutwork.session.expiresAt";

/**
 * 本机免登录形态（桌面壳 / 自托管 `local-trust`）的**会话标记**——不是凭据。
 *
 * 为什么非要有它：客户端有几十处「没有令牌就当未登录、直接不发请求」的门
 * （`if (!session?.access_token) return`）。免登录形态从来不签发令牌（认人靠**回环来源**），
 * 于是这些门全部静默不放行：工作台拉不到项目列表 → Design 模式永久停在「暂无项目」、
 * 画布起不来；设置里的 MCP/技能/浏览器面板同样一片空白。2026-09-19 真机（安装包）实测就是这个。
 *
 * 为什么无害：本形态下服务端**不看** Authorization 头（`local-trust.ts` 只认回环 IP + 可信 Origin），
 * 标记串只是让前端各处「有会话」的判定成立；口令形态走的是真令牌，本分支根本不会执行。
 * 它也**不落盘**（不走 `persist`），刷新页面重新问 `/api/viewer`。
 */
export const LOCAL_TRUST_SESSION_TOKEN = "local-trust";

/** 会话是不是本机免登录形态（凭证是标记串而非真令牌）。 */
export function isLocalTrustSession(session: AuthSession | null): boolean {
  return session?.access_token === LOCAL_TRUST_SESSION_TOKEN;
}

export type AuthUser = {
  displayName: string | null;
  email: string;
  id: string;
};

export type AuthSession = {
  /**
   * 不透明会话令牌（Bearer）。字段名沿用既有的 `access_token`——前端有 29 处消费点
   * 读它，为改名去触碰这些位置（含并行编辑中的文件）收益极低；**跨端契约里叫
   * `session.token`**，两者的对应关系只在本模块出现。
   */
  access_token: string;
  expiresAt: string | null;
  user: AuthUser;
};

type Listener = (session: AuthSession | null) => void;
const listeners = new Set<Listener>();

function notify(session: AuthSession | null): void {
  for (const listener of listeners) {
    listener(session);
  }
}

function persist(session: AuthSession | null): void {
  if (typeof window === "undefined") return;
  migrateLegacyStorageKeys();
  if (session) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, session.access_token);
    window.localStorage.setItem(EXPIRES_STORAGE_KEY, session.expiresAt ?? "");
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(EXPIRES_STORAGE_KEY);
  }
  notify(session);
}

/** 读本地令牌；已过期则视为无会话（过期判断在服务端也会再做一次）。 */
export function readStoredSession(): { token: string } | null {
  if (typeof window === "undefined") return null;
  // 旧前缀（loomic.*）里的会话令牌先搬到新键，否则老用户会被静默登出
  migrateLegacyStorageKeys();
  const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return null;

  const expiresAt = window.localStorage.getItem(EXPIRES_STORAGE_KEY);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    persist(null);
    return null;
  }
  return { token };
}

export function getAccessToken(): string | null {
  return readStoredSession()?.token ?? null;
}

/** 订阅会话变化；返回取消订阅函数。 */
export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export class AuthClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthClientError";
    this.code = code;
    this.status = status;
  }
}

async function authRequest<T>(
  path: string,
  body: Record<string, unknown>,
  options: { token?: string | null } = {},
): Promise<T> {
  const response = await fetch(`${getServerBaseUrl()}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    method: "POST",
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } })
      ?.error;
    throw new AuthClientError(
      error?.code ?? "auth_unavailable",
      error?.message ?? `认证请求失败（HTTP ${response.status}）。`,
      response.status,
    );
  }
  return payload as T;
}

type SessionPayload = {
  session: { expiresAt: string; token: string };
  user: AuthUser;
};

function toSession(payload: SessionPayload): AuthSession {
  return {
    access_token: payload.session.token,
    expiresAt: payload.session.expiresAt,
    user: payload.user,
  };
}

export async function signInWithPassword(input: {
  email: string;
  password: string;
}): Promise<AuthSession> {
  const session = toSession(
    await authRequest<SessionPayload>("/api/auth/login", input),
  );
  persist(session);
  return session;
}

export async function signUp(input: {
  displayName?: string;
  email: string;
  password: string;
}): Promise<AuthSession> {
  const session = toSession(
    await authRequest<SessionPayload>("/api/auth/register", input),
  );
  persist(session);
  return session;
}

export async function signOut(): Promise<void> {
  const token = getAccessToken();
  persist(null);
  if (token) {
    // 服务端吊销失败不该拦住前端登出（本地状态已清）
    await authRequest("/api/auth/logout", {}, { token }).catch(() => undefined);
  }
}

/**
 * 用已存的令牌向服务端确认身份（页面启动时的探活）。
 * 令牌无效/过期即清本地状态并返回 null。
 */
export async function loadSession(): Promise<AuthSession | null> {
  const stored = readStoredSession();
  /**
   * **没有本地令牌时问 `/api/viewer`**（用户口径：桌面端「一键启动」就该直接进去）。
   *
   * 本机免登录形态（桌面壳 / 自托管 `KENFUTWORK_AUTH_DRIVER=local-trust`）是**按连接来源认人**的，
   * 从来没有令牌；而且**认证路由在这种形态下压根没挂载**（`/api/auth/session` 回 404，真机打包验过），
   * 所以只能问 `/api/viewer`——它两种形态都在：免登录时直接给出本机用户，口令形态下没令牌就 401。
   * 以前这里一看没有令牌就返回 null，界面于是永远停在登录页。
   */
  if (!stored) {
    const viewer = await fetch(`${getServerBaseUrl()}/api/viewer`).catch(
      () => null,
    );
    if (!viewer?.ok) return null;
    const payload = (await viewer.json().catch(() => null)) as {
      profile?: { id?: unknown; email?: unknown; displayName?: unknown };
    } | null;
    const profile = payload?.profile;
    if (typeof profile?.id !== "string" || typeof profile.email !== "string") {
      return null;
    }
    const session: AuthSession = {
      // 免登录形态不发令牌，但**必须给个非空标记**：消费方以「有无 access_token」判定
      // 是否已登录（见 LOCAL_TRUST_SESSION_TOKEN 的说明）
      access_token: LOCAL_TRUST_SESSION_TOKEN,
      expiresAt: null,
      user: {
        id: profile.id,
        email: profile.email,
        displayName:
          typeof profile.displayName === "string" ? profile.displayName : null,
      },
    };
    notify(session);
    return session;
  }

  const response = await fetch(`${getServerBaseUrl()}/api/auth/session`, {
    headers: { authorization: `Bearer ${stored.token}` },
  }).catch(() => null);

  if (!response) {
    // 网络不可达：不武断清令牌（可能是服务还没起来），但也不声称已登录
    return null;
  }
  if (response.status === 401 || response.status === 404) {
    // 401 = 令牌无效/过期；404 = 这台服务端**不是口令形态**（认证路由未挂载，
    // `KENFUTWORK_AUTH_DRIVER=local-trust` 的免登录形态）。两者都意味着本地令牌
    // 在这台服务端上永久无效：清掉后回落问 `/api/viewer`。曾把 404 归入「服务端
    // 暂时不可用、不动令牌」——桌面 dev 形态下 WebView 残留口令形态的旧令牌，
    // loadSession 永远 404 永远 null，永远停在登录页（2026-09-28 真机）。
    persist(null);
    // 此时 readStoredSession() 为空，递归即走 viewer 探活；免登录形态直接给出
    // 本机身份，口令形态 viewer 401 → null（停登录页，行为不变）。最多递归一层。
    return loadSession();
  }
  if (!response.ok) {
    // 服务端暂时不可用（重启 / 编译中 / 5xx）：**不动令牌**——否则重启一次就把人踢到登录页
    // （实测：dev 热重载窗口里刷新页面 = 被登出；用户也报过「会话失效被踢到登录页」）
    return null;
  }

  const payload = (await response.json()) as { user: AuthUser };
  const session: AuthSession = {
    access_token: stored.token,
    expiresAt: window.localStorage.getItem(EXPIRES_STORAGE_KEY) || null,
    user: payload.user,
  };
  notify(session);
  return session;
}
