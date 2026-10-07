"use client";

import { Laptop, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function InstanceMenu({
  collapsed,
  onOpenSettings,
}: {
  collapsed: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`flex items-center rounded-lg p-1.5 text-foreground hover:bg-muted ${collapsed ? "justify-center" : "w-full gap-2"}`}
        aria-label="本地实例"
      >
        <Laptop className="size-5 shrink-0" />
        {collapsed ? null : <span className="truncate text-sm">本地实例</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuItem onClick={onOpenSettings}>
          <Settings className="size-4" />
          设置
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
