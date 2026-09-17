"use client";

import { AnimatePresence, motion, type Variants } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { fetchViewer } from "../lib/server-api";
import { signUp } from "../lib/session";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const stagger: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
};

const fadeIn: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
};

export function RegisterForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bootstrapWorkspace(accessToken: string) {
    try {
      await fetchViewer(accessToken);
      router.replace("/workbench");
    } catch {
      setError("无法完成工作台初始化，请重试。");
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) return;
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    setLoading(true);
    setError(null);

    let session: Awaited<ReturnType<typeof signUp>>;
    try {
      session = await signUp({ email: trimmed, password });
    } catch (authError) {
      setLoading(false);
      setError(
        authError instanceof Error ? authError.message : "注册失败，请重试。",
      );
      return;
    }

    // 自管认证注册即签发会话；Supabase 形态在需要邮箱确认时返回 null
    if (session) {
      await bootstrapWorkspace(session.access_token);
      setLoading(false);
      return;
    }

    setLoading(false);
    setSent(true);
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
                aria-hidden="true"
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
              我们向 <strong>{email}</strong> 发送了确认链接
            </p>
            <Link
              href="/login"
              className="text-sm text-foreground underline underline-offset-4"
            >
              返回登录
            </Link>
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
                创建账号
              </h2>
              <p className="text-sm text-muted-foreground">
                使用邮箱和密码注册你的工作台
              </p>
            </motion.div>

            <motion.form
              variants={fadeIn}
              onSubmit={handleSubmit}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="register-email">邮箱</Label>
                <Input
                  id="register-email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="register-password">密码</Label>
                <Input
                  id="register-password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="register-confirm-password">确认密码</Label>
                <Input
                  id="register-confirm-password"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "创建账号中…" : "创建账号"}
              </Button>
            </motion.form>

            <AnimatePresence>
              {error && (
                <motion.p
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden text-center text-sm text-destructive"
                  role="alert"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <motion.p
              variants={fadeIn}
              className="text-center text-sm text-muted-foreground"
            >
              已有账号？{" "}
              <Link
                href="/login"
                className="font-medium text-foreground underline underline-offset-4"
              >
                去登录
              </Link>
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
