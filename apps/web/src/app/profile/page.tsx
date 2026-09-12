"use client";

import { ChevronLeft, LogOut } from "lucide-react";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "@/lib/auth-context";
import { fetchViewer } from "@/lib/server-api";

/** 个人中心：当前用户信息 + 登出（真实 viewer 数据）。 */
export default function ProfilePage() {
  const router = useRouter();
  const { user, session, loading, signOut } = useAuth();
  const [profile, setProfile] = useState<{
    displayName: string;
    email: string;
    workspace: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    fetchViewer(token)
      .then((viewer) => {
        setProfile({
          displayName: viewer.profile.displayName,
          email: viewer.profile.email,
          workspace: viewer.workspace.name,
        });
      })
      .catch(() => setError("无法加载个人信息"));
  }, [session]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="返回工作台"
            onClick={() => router.push("/workbench")}
            className="rounded-md p-2 hover:bg-muted"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1 text-sm font-medium">
            个人中心
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl p-6">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!profile && !error ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : profile ? (
          <div className="space-y-4">
            <div className="flex items-center gap-4 rounded-xl border p-5">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg text-primary-foreground">
                {profile.displayName.slice(0, 1)}
              </span>
              <div>
                <p className="text-base font-medium">{profile.displayName}</p>
                <p className="text-sm text-muted-foreground">{profile.email}</p>
              </div>
            </div>
            <div className="rounded-xl border p-4 text-sm">
              <p className="mb-1 font-medium">工作区</p>
              <p className="text-muted-foreground">{profile.workspace}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                void signOut();
                router.push("/login");
              }}
              className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm text-destructive hover:bg-muted"
            >
              <LogOut className="h-4 w-4" /> 退出登录
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
