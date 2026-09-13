"use client";

import { LogOut, Settings, ShieldCheck } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface WorkbenchUser {
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

/**
 * 个人中心（侧栏底部头像弹出）：用户信息 + 设置 + 管理后台（仅管理员）+ 退出登录。
 * 收起态只显示头像，展开态显示头像 + 用户名。
 */
export function UserMenu({
  user,
  collapsed,
  isAdmin = false,
  onOpenSettings,
  onOpenAdmin,
  onSignOut,
}: {
  user: WorkbenchUser | null;
  collapsed: boolean;
  /** 平台管理员才渲染「管理后台」入口（服务端仍会独立鉴权）。 */
  isAdmin?: boolean;
  onOpenSettings: () => void;
  onOpenAdmin?: () => void;
  onSignOut: () => void;
}) {
  const displayName = user?.displayName ?? "未登录";
  const initial = displayName.slice(0, 1).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`flex cursor-pointer items-center rounded-lg p-1.5 text-foreground outline-none transition-colors hover:bg-muted ${
          collapsed ? "justify-center" : "w-full gap-2"
        }`}
        aria-label="个人中心"
      >
        <Avatar className="h-7 w-7 shrink-0">
          {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} /> : null}
          <AvatarFallback className="text-xs">{initial}</AvatarFallback>
        </Avatar>
        {collapsed ? null : (
          <span className="truncate text-sm">{displayName}</span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar className="h-9 w-9">
            {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} /> : null}
            <AvatarFallback className="text-sm">{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{displayName}</p>
            {user?.email ? (
              <p className="truncate text-xs text-muted-foreground">
                {user.email}
              </p>
            ) : null}
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenSettings}>
          <Settings className="size-4" />
          设置
        </DropdownMenuItem>
        {isAdmin && onOpenAdmin ? (
          <DropdownMenuItem onClick={onOpenAdmin}>
            <ShieldCheck className="size-4" />
            管理后台
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onSignOut}>
          <LogOut className="size-4" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
