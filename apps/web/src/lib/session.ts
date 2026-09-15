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
  if (!stored) {
    return null;
  }

  const response = await fetch(`${getServerBaseUrl()}/api/auth/session`, {
    headers: { authorization: `Bearer ${stored.token}` },
  }).catch(() => null);

  if (!response) {
    // 网络不可达：不武断清令牌（可能是服务还没起来），但也不声称已登录
    return null;
  }
  if (!response.ok) {
    persist(null);
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
