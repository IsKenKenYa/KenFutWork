"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { fetchViewer } from "../lib/server-api";
import { getSupabaseBrowserClient } from "../lib/supabase-browser";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
} as any;

const fadeIn = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
} as any;

interface LoginFormProps {
  initialErrorMessage?: string | null;
}

export function LoginForm({ initialErrorMessage = null }: LoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // 邮箱链接登录（magic link）代码保留但暂不暴露入口，当前只出账密登录
  const [mode] = useState<"magic" | "password">("password");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(initialErrorMessage);

  async function bootstrapWorkspace(accessToken: string) {
    try {
      await fetchViewer(accessToken);
      router.replace("/workbench");
    } catch {
      setError("无法加载你的工作台，请重试。");
    }
  }

  async function handleMagicLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);

    const supabase = getSupabaseBrowserClient();
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: false,
      },
    });

    setLoading(false);
    if (authError) {
      setError(authError.message);
    } else {
      setSent(true);
    }
  }

  async function handlePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) return;
    setLoading(true);
    setError(null);

    const supabase = getSupabaseBrowserClient();
    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email: trimmed,
      password,
    });

    if (authError) {
      setLoading(false);
      setError(authError.message);
    } else {
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        setLoading(false);
        setError("登录未完成，请重试。");
        return;
      }

      await bootstrapWorkspace(accessToken);
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <AnimatePresence mode="wait">
        {sent ? (
          <motion.div
            key="sent"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="flex flex-col items-center gap-4 text-center"
          >
            {/* Checkmark circle */}
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{
                delay: 0.2,
                type: "spring",
                stiffness: 200,
                damping: 15,
              }}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-foreground"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6 text-background"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <motion.path
                  d="M5 13l4 4L19 7"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ delay: 0.5, duration: 0.4, ease: "easeOut" }}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </motion.div>
            <h2 className="text-lg font-semibold">请查收邮件</h2>
            <p className="text-sm text-muted-foreground">
              我们向 <strong>{email}</strong> 发送了登录链接
            </p>
          </motion.div>
        ) : (
          <motion.div
            key="form"
            variants={stagger}
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: -12, transition: { duration: 0.2 } }}
            className="space-y-6"
          >
            <motion.div variants={fadeIn} className="space-y-2 text-center">
              <h2 className="text-2xl font-semibold tracking-tight">
                欢迎回来
              </h2>
              <p className="text-sm text-muted-foreground">登录你的工作台</p>
            </motion.div>

            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                  role="alert"
                  aria-live="polite"
                >
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            <motion.form
              variants={fadeIn}
              onSubmit={mode === "password" ? handlePassword : handleMagicLink}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="email">邮箱</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              {mode === "password" && (
                <div className="space-y-2">
                  <Label htmlFor="password">密码</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "登录中…" : "登录"}
              </Button>
            </motion.form>

            <motion.p
              variants={fadeIn}
              className="text-center text-sm text-muted-foreground"
            >
              还没有账号？{" "}
              <Link
                href="/register"
                className="font-medium text-foreground underline underline-offset-4"
              >
                注册一个
              </Link>
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
