"use client";

import {
  type AuthSession,
  type AuthUser,
  fetchAuthSession,
  getAccessToken,
  getAuthDriver,
  signInWithPassword as localSignIn,
  signOut as localSignOut,
  signUp as localSignUp,
  onAuthStateChange,
} from "./auth-client";
import { getSupabaseBrowserClient } from "./supabase-browser";

/**
 * 浏览器会话的**统一外观**（M1.4）。
 *
 * 消费方（auth-context / 登录注册表单 / 模型选择器）只依赖本模块，不直接触达
 * `auth-client.ts`（自管）或 `supabase-browser.ts`（过渡期）。形态由
 * `NEXT_PUBLIC_AUTH_DRIVER` 决定：默认 `supabase`，切 `local` 即完成切换——
 * 切换不再需要改消费方代码，也不会出现「一半组件用新源、一半用旧源」的中间态。
 *
 * 注：`supabase-browser` 用**静态导入**——它到首次调用才创建客户端、无模块级副作用；
 * 动态 `import()` 反而让测试的模块替身失效（实测），收益为零。
 */

export type { AuthSession, AuthUser };

/** 邮箱魔法链接需要 SMTP/邮件服务：仅过渡期的 Supabase 形态支持。 */
export function isMagicLinkSupported(): boolean {
  return getAuthDriver() === "supabase";
}

export function currentAccessToken(): string | null {
  return getAccessToken();
}

/**
 * 读取当前会话。
 * local 形态走「令牌 → 服务端探活」；supabase 形态走 SDK 的本地会话 + 刷新。
 */
export async function loadSession(): Promise<AuthSession | null> {
  if (getAuthDriver() === "local") {
    return fetchAuthSession();
  }

  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session ? fromSupabaseSession(data.session) : null;
}

export async function signInWithPassword(input: {
  email: string;
  password: string;
}): Promise<AuthSession> {
  if (getAuthDriver() === "local") {
    return localSignIn(input);
  }

  const { data, error } =
    await getSupabaseBrowserClient().auth.signInWithPassword(input);
  if (error) {
    throw toAuthError(error.message);
  }
  if (!data.session) {
    throw toAuthError("登录未完成，请重试。");
  }
  return fromSupabaseSession(data.session);
}

export async function signUp(input: {
  displayName?: string;
  email: string;
  password: string;
}): Promise<AuthSession | null> {
  if (getAuthDriver() === "local") {
    return localSignUp(input);
  }

  const { data, error } = await getSupabaseBrowserClient().auth.signUp({
    email: input.email,
    options: {
      ...(input.displayName
        ? { data: { display_name: input.displayName } }
        : {}),
      emailRedirectTo: `${window.location.origin}/auth/callback`,
    },
    password: input.password,
  });
  if (error) {
    throw toAuthError(error.message);
  }
  // GoTrue 在需要邮箱确认时不返回 session：调用方据此走「请查收邮件」分支
  return data.session ? fromSupabaseSession(data.session) : null;
}

export async function signOut(): Promise<void> {
  if (getAuthDriver() === "local") {
    await localSignOut();
    return;
  }
  await getSupabaseBrowserClient().auth.signOut();
}

/** 订阅会话变化；返回取消订阅函数。 */
export async function subscribeSession(
  listener: (session: AuthSession | null) => void,
): Promise<() => void> {
  if (getAuthDriver() === "local") {
    return onAuthStateChange(listener);
  }

  const {
    data: { subscription },
  } = getSupabaseBrowserClient().auth.onAuthStateChange((_event, session) => {
    listener(session ? fromSupabaseSession(session) : null);
  });
  return () => subscription.unsubscribe();
}

/** 发魔法链接（仅 supabase 形态）。 */
export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await getSupabaseBrowserClient().auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${window.location.origin}/auth/callback`,
      shouldCreateUser: false,
    },
  });
  if (error) {
    throw toAuthError(error.message);
  }
}

function toAuthError(message: string): Error {
  return new Error(message || "认证失败，请重试。");
}

type SupabaseSessionLike = {
  access_token: string;
  expires_at?: number | null;
  user: {
    id: string;
    email?: string | null;
    user_metadata?: Record<string, unknown> | null;
  };
};

function fromSupabaseSession(session: SupabaseSessionLike): AuthSession {
  const displayName = session.user.user_metadata?.display_name;
  return {
    access_token: session.access_token,
    expiresAt: session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : null,
    user: {
      displayName: typeof displayName === "string" ? displayName : null,
      email: session.user.email ?? "",
      id: session.user.id,
    },
  };
}
