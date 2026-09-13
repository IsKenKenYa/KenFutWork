"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import {
  type AuthSession,
  type AuthUser,
  loadSession,
  signOut as signOutSession,
  subscribeSession,
} from "./session";

/**
 * 会话上下文（M1.4）：只依赖 `session.ts` 外观层，故自管认证与 Supabase 过渡期
 * 共用同一份组件代码——切换形态不改这里。
 */
interface AuthContextValue {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    // 先订阅再拉取：避免「拉取期间发生的变化」丢失
    let unsubscribe: (() => void) | undefined;
    void subscribeSession((next) => {
      if (!active) return;
      setSession(next);
      setLoading(false);
    })
      .then((dispose) => {
        unsubscribe = dispose;
      })
      .catch(() => {
        // 订阅失败不该让界面卡在 loading（未登录态可继续渲染登录页）
        if (active) setLoading(false);
      });

    void loadSession()
      .then((next) => {
        if (!active) return;
        setSession(next);
        setLoading(false);
      })
      .catch(() => {
        // 服务不可达/会话读取异常：落到「未登录」而不是**永久 loading**
        if (!active) return;
        setSession(null);
        setLoading(false);
      });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const signOut = useCallback(async () => {
    setSession(null);
    await signOutSession();
  }, []);

  return (
    <AuthContext.Provider
      value={{ loading, session, signOut, user: session?.user ?? null }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
