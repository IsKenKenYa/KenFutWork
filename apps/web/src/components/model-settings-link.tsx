"use client";

import { requestModelSettingsOpen } from "@/lib/model-settings-navigation";
import { Button } from "./ui/button";

/** 历史入口不再承载第二套模型或供应商表单。 */
export function ModelSettingsLink({
  onOpen,
}: {
  onOpen?: (() => void) | undefined;
}) {
  return (
    <Button
      onClick={() => {
        requestModelSettingsOpen();
        onOpen?.();
      }}
    >
      打开模型设置
    </Button>
  );
}
