"use client";

import { getServerBaseUrl } from "./env";

/**
 * 自管认证的浏览器客户端（M1.4）。
 *
 * 替换原先直连 Supabase Auth（`supabase-browser.ts`）的做法：令牌由**本服务**签发
 * （`POST /api/auth/*`），这里只负责「存令牌、带令牌、登出清令牌」。
 *
 * 形态选择：`NEXT_PUBLIC_AUTH_DRIVER=local` 时走这条；否则沿用 Supabase GoTrue
 * （`supabase-browser.ts`）——**过渡期两条并存**，切换只改环境变量。这层的存在让
 * 消费方（登录/注册表单、auth-context、模型选择器）不必知道谁在签发令牌。
 */

const TOKEN_STORAGE_KEY = "loomic.session.token";
const EXPIRES_STORAGE_KEY = "loomic.session.expiresAt";

export type AuthUser = {
  displayName: string | null;
  email: string;
  id: string;
};

export type AuthSession = {
  /**
   * 不透明会话令牌（Bearer）。字段名沿用既有的 `access_token`——前端有 29 处消费点
   * 读它，为改名去触碰这些位置（含并行编辑中的文件）收益极低；**跨端契约里叫
   * `session.token`**，两者的对应关系只在本适配层出现。
   */
  access_token: string;
  expiresAt: string | null;
  user: AuthUser;
};

/** 当前认证形态；默认 `supabase`（与后端默认一致，避免两端不一致导致登不进）。 */
export function getAuthDriver(): "local" | "supabase" {
  return process.env.NEXT_PUBLIC_AUTH_DRIVER === "local" ? "local" : "supabase";
}

type Listener = (session: AuthSession | null) => void;
const listeners = new Set<Listener>();

function notify(session: AuthSession | null): void {
  for (const listener of listeners) {
    listener(session);
  }
}

function persist(session: AuthSession | null): void {
  if (typeof window === "undefined") return;
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

export function onAuthStateChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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

export async function signInWithPassword(input: {
  email: string;
  password: string;
}): Promise<AuthSession> {
  const payload = await authRequest<SessionPayload>("/api/auth/login", input);
  const session: AuthSession = {
    access_token: payload.session.token,
    expiresAt: payload.session.expiresAt,
    user: payload.user,
  };
  persist(session);
  return session;
}

export async function signUp(input: {
  displayName?: string;
  email: string;
  password: string;
}): Promise<AuthSession> {
  const payload = await authRequest<SessionPayload>(
    "/api/auth/register",
    input,
  );
  const session: AuthSession = {
    access_token: payload.session.token,
    expiresAt: payload.session.expiresAt,
    user: payload.user,
  };
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
export async function fetchAuthSession(): Promise<AuthSession | null> {
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
