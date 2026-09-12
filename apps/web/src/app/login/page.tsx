"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

import { AuthShell } from "../../components/auth/auth-shell";
import { LoadingScreen } from "../../components/loading-screen";
import { LoginForm } from "../../components/login-form";
import { useAuth } from "../../lib/auth-context";

const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  auth_callback_missing_code: "登录链接不完整，请重新发起登录。",
  auth_exchange_failed: "登录链接校验失败，请重新发起登录。",
  viewer_bootstrap_failed: "账号已验证，但工作台初始化失败，请重试。",
  auth_callback_timeout: "登录超时，请重试。",
};

function LoginPageContent() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackError = searchParams.get("error");
  const initialErrorMessage = callbackError
    ? (CALLBACK_ERROR_MESSAGES[callbackError] ?? "登录未完成，请重试。")
    : null;

  useEffect(() => {
    if (!loading && user) {
      router.replace("/workbench");
    }
  }, [user, loading, router]);

  if (loading || user) return <LoadingScreen />;

  return (
    <AuthShell>
      <LoginForm initialErrorMessage={initialErrorMessage} />
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <LoginPageContent />
    </Suspense>
  );
}
