"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** 自定义下拉（替换原生 <select>）：修原生 option 无法样式化的问题（蓝底系统菜单），高亮走灰色 token。 */

type SelectRootProps = React.ComponentProps<typeof SelectPrimitive.Root>;

function Select({ ...props }: SelectRootProps) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectTrigger({
  className,
  children,
  /** 不显示右侧箭头（图标按钮当菜单用时，箭头会和图标叠在一起）。 */
  hideChevron = false,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  hideChevron?: boolean;
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex cursor-pointer items-center justify-between gap-1.5 rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm whitespace-nowrap outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground data-[popup-open]:border-ring [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      {hideChevron ? null : (
        <SelectPrimitive.Icon>
          <ChevronDownIcon className="size-3.5 opacity-50" />
        </SelectPrimitive.Icon>
      )}
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectContent({
  className,
  children,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> & {
  align?: SelectPrimitive.Positioner.Props extends { align?: infer A }
    ? A
    : never;
  alignOffset?: number;
  side?: "bottom" | "top";
  sideOffset?: number;
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        className="z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "max-h-(--available-height) min-w-[calc(var(--anchor-width)+0.5rem)] origin-(--transform-origin) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
        <CheckIcon className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
