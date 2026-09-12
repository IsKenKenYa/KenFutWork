"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { AuthShell } from "../../components/auth/auth-shell";
import { LoadingScreen } from "../../components/loading-screen";
import { RegisterForm } from "../../components/register-form";
import { useAuth } from "../../lib/auth-context";

export default function RegisterPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) {
      router.replace("/workbench");
    }
  }, [user, loading, router]);

  if (loading || user) return <LoadingScreen />;

  return (
    <AuthShell>
      <RegisterForm />
    </AuthShell>
  );
}
