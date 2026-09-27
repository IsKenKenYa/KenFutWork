"use client";

import { ShieldCheck } from "lucide-react";

/**
 * 设置 → 账号（R5-2：参考图里的「账号」条目）。
 *
 * 只列**真有的**账号信息（viewer 的显示名/邮箱 + 套餐/额度，来自 `/api/viewer`）；
 * 头像弹出那个「个人中心」里的入口（管理后台 / 退出登录）在这里给一个真按钮，
 * 不复制一套重复的操作。
 */
export function AccountSection({
  displayName,
  email,
  plan,
  balance,
  isAdmin = false,
  onOpenAdmin,
}: {
  displayName: string;
  email: string;
  /** 套餐名（viewer.credits.plan）；没有计费装配时为 null。 */
  plan: string | null;
  /** 平台池额度余额；没有计费装配时为 null。 */
  balance: number | null;
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
}) {
  return (
    <section aria-label="账号设置">
      <h3 className="mb-1 text-base font-medium">账号</h3>

      <dl className="divide-y rounded-lg border text-sm">
        <div className="flex items-center justify-between px-3 py-2.5">
          <dt className="text-muted-foreground">显示名</dt>
          <dd>{displayName || "（未设置）"}</dd>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5">
          <dt className="text-muted-foreground">邮箱</dt>
          <dd className="truncate">{email}</dd>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5">
          <dt className="text-muted-foreground">套餐</dt>
          <dd>{plan ?? "未启用计费"}</dd>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5">
          <dt className="text-muted-foreground">平台额度余额</dt>
          <dd>{balance === null ? "未启用计费" : balance}</dd>
        </div>
      </dl>

      {isAdmin && onOpenAdmin ? (
        <button
          type="button"
          onClick={onOpenAdmin}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          管理后台
        </button>
      ) : null}
    </section>
  );
}
