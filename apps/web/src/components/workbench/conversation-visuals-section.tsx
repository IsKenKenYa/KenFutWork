"use client";

import { useEffect, useState } from "react";

import {
  isConversationVisualsEnabled,
  setConversationVisualsEnabled,
} from "@/lib/conversation-visuals";
import { SETTINGS_ROW_STACK, SETTINGS_TITLE } from "@/lib/settings-layout";
import { SettingsToggle } from "./settings-toggle";

/**
 * 设置 → 通用 → 对话流：AI 在对话流里渲染可视化组件（流程图 / 架构图 / 数据图表）的开关。
 *
 * 本机偏好（localStorage）：只影响**渲染**——关掉时块原样以代码显示，模型能力与提示段
 * 不受影响（见 `lib/conversation-visuals.ts` 的口径说明）。
 */
export function ConversationVisualsSection() {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setEnabled(isConversationVisualsEnabled());
  }, []);

  return (
    <section>
      <h2 className={SETTINGS_TITLE}>对话流</h2>
      <div className={SETTINGS_ROW_STACK}>
        <SettingsToggle
          label="渲染可视化组件"
          checked={enabled}
          onChange={(next) => {
            setConversationVisualsEnabled(next);
            setEnabled(next);
          }}
        />
      </div>
    </section>
  );
}
