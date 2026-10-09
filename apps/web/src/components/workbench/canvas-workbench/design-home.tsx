"use client";
import type { ExecutionMode, ProjectSummary } from "@kenfutwork/shared";
import {
  ChatPromptEditor,
  CodeHttpChannelClient,
  createWebPlatform,
  PlatformProvider,
  ServiceProvider,
  TabStoreProvider,
  TooltipProvider,
  ZCodeIntlProvider,
} from "@zcode/ui/design-shared";
import { Brain, Palette } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";
import { useComposerVoice, useVoiceMode } from "@/components/composer-voice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getServerBaseUrl } from "@/lib/env";
import { executionModeOptions } from "@/lib/execution-modes";
import { expandCommand } from "@/lib/slash-commands";
import { getVoicePlayback } from "@/lib/voice-playback";
import {
  ComposerCompactSelect,
  THINKING_OPTIONS,
  THINKING_PROGRESS,
  TIER_OPTIONS,
  tierIcon,
} from "../composer-compact-select";
import { ContextUsageButton } from "../context-usage-button";
import type { SettingsTab } from "../settings-modal";
import type { useDesignComposer } from "./use-design-composer";
/** 保留 Design 无项目时的原输入区；画布助手仍由画布页承载。 */
export function DesignHome({
  composer,
  notice,
  selectedProject,
  setSettingsTab,
  onSubmit,
}: {
  composer: ReturnType<typeof useDesignComposer>;
  notice: string | null;
  selectedProject: ProjectSummary | null;
  setSettingsTab: Dispatch<SetStateAction<SettingsTab | null>>;
  onSubmit: (text: string) => void;
}) {
  const {
    tier,
    thinking,
    executionMode,
    setExecutionMode,
    executionModes,
    models,
    model,
    modelMeta,
    commands,
    handleTierChange,
    handleModelChange,
    handleThinkingChange,
  } = composer;
  const [prompt, setPrompt] = useState("");
  const mode = "design";
  const meta = {
    title: "Design with KenFutWork",
    placeholder: "从想法到页面原型",
    chips: ["设计还原", "概念成稿", "规范出图"],
  };
  const submitting = false;
  const startTask = (text: string) => {
    setPrompt("");
    onSubmit(text);
  };
  /**
   * 语音（按住说话）：设计空态输入框与画布助手同一口径（规划 §7 的三落点之一）。
   * 写回走 `setPrompt`——ChatPromptEditor 是受控的（initialValue + onChange 回路），
   * 直接改 DOM 会与 React state 脱钩；完整回路与发送键同一条路径（展开命令后起会话）。
   */
  const voiceMode = useVoiceMode(null);
  const voice = useComposerVoice({
    accessToken: null,
    mode: voiceMode,
    // 用户开始说话：正在念的回复立刻让位（规划 §4.2 的打断口径）
    onRecordingStart: () => getVoicePlayback().stop(),
    onTranscript: (text) =>
      setPrompt((prev) => (prev ? `${prev}${text}` : text)),
    onAutoSubmit: (text) => {
      const expanded = expandCommand(text, commands).text;
      if (expanded.trim()) startTask(expanded);
    },
  });
  const client = useMemo(
    () =>
      new CodeHttpChannelClient({
        apiBase: getServerBaseUrl() || window.location.origin,
      }),
    [],
  );
  const services = client.services;
  useEffect(() => () => client.dispose(), [client]);
  const platform = useMemo(createWebPlatform, []);
  return (
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <TooltipProvider>
            <TabStoreProvider>
              <div className="flex h-full flex-col items-center justify-center px-8">
                <div className="mb-9 flex items-center gap-3">
                  {/* 尺寸与笔画各调过一轮（用户口径：h-14 + stroke 3 太粗太大 → stroke 2 又太细）：
                  现在 h-9（36px 盒 → 墨高 18px）+ strokeWidth 2.5，取中间 */}
                  <Palette className="h-9 w-9" strokeWidth={2.5} />
                  {/* 标题颜色**不动**（用户口径：这句的蓝色还原回去）——只保留字标字体 */}
                  <h1 className="font-wordmark text-4xl tracking-tight">
                    {meta.title}
                  </h1>
                </div>

                {notice ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {notice}
                  </p>
                ) : null}

                <div className="mx-auto flex w-full max-w-2xl flex-col items-center">
                  {/* zcode composer（P5a）：ChatPromptEditor 原件（自带单层
                          rounded-2xl border-input-border 壳 + `/` 命令面板 + 发送状态机）；
                          不再额外包宿主容器壳（双层壳已剥） */}
                  <div
                    className="w-full"
                    onPointerDown={voice.onPointerDown}
                    style={
                      voice.lockSelection ? { userSelect: "none" } : undefined
                    }
                  >
                    <ChatPromptEditor
                      initialValue={prompt}
                      appSlashCommands={commands.map((command) => ({
                        value: command.name,
                        description:
                          command.description || command.prompt.slice(0, 80),
                        run: () => setPrompt(`/${command.name} `),
                      }))}
                      workspacePath={selectedProject?.workDir ?? ""}
                      taskId={null}
                      placeholder={
                        mode === "design"
                          ? "先创建项目再开始设计"
                          : meta.placeholder
                      }
                      submitting={submitting}
                      submitDisabled={submitting}
                      enterSubmits
                      submitLabel="发送"
                      showSlashButton
                      enableMentionPanel
                      leadingActions={
                        <>
                          <ComposerCompactSelect
                            ariaLabel="权限档位"
                            icon={tierIcon(tier)}
                            options={TIER_OPTIONS}
                            value={tier}
                            onChange={(next) => {
                              void handleTierChange(next);
                            }}
                          />
                          <Select
                            aria-label="执行模式"
                            value={executionMode}
                            onValueChange={(next) => {
                              if (typeof next === "string")
                                setExecutionMode(next as ExecutionMode);
                            }}
                            items={executionModeOptions(executionModes).map(
                              (m) => ({
                                value: m.id,
                                label: m.label,
                              }),
                            )}
                          >
                            <SelectTrigger
                              className="h-7 gap-1 border-transparent bg-muted/60 px-2 text-xs"
                              aria-label="执行模式"
                              hideChevron
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="min-w-28">
                              {executionModeOptions(executionModes).map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  {m.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            aria-label="模型"
                            value={model}
                            onValueChange={(next) => {
                              if (typeof next === "string")
                                handleModelChange(next);
                            }}
                            items={
                              models.length === 0
                                ? [{ value: "", label: "未配置模型" }]
                                : models.map((m) => ({
                                    value: m.id,
                                    label: m.name,
                                  }))
                            }
                          >
                            <SelectTrigger
                              className="h-7 max-w-[200px] gap-1 border-transparent bg-muted/60 px-2 text-xs"
                              aria-label="模型"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-w-[300px]">
                              {models.length === 0 ? (
                                <>
                                  <SelectItem value="">未配置模型</SelectItem>
                                  <div className="-mx-1 my-1 border-t" />
                                  <button
                                    type="button"
                                    onClick={() => setSettingsTab("providers")}
                                    className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                  >
                                    添加供应商…
                                  </button>
                                </>
                              ) : (
                                <>
                                  {(() => {
                                    const byok = models.filter(
                                      (m) => m.providerName,
                                    );
                                    const builtin = models.filter(
                                      (m) => !m.providerName,
                                    );
                                    const badge = (
                                      m: (typeof models)[number],
                                    ) => (
                                      <>
                                        {m.vision ? (
                                          <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                            视觉
                                          </span>
                                        ) : null}
                                        {m.contextWindow &&
                                        m.contextWindow >= 1_000_000 ? (
                                          <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                            1M
                                          </span>
                                        ) : null}
                                      </>
                                    );
                                    return (
                                      <>
                                        {byok.length > 0 ? (
                                          <>
                                            <SelectLabel>
                                              {byok
                                                .at(0)
                                                ?.providerName?.trim() ??
                                                "我的供应商"}
                                            </SelectLabel>
                                            {byok.map((m) => (
                                              <SelectItem
                                                key={m.id}
                                                value={m.id}
                                              >
                                                <span className="flex items-center gap-1.5">
                                                  <span>{m.name}</span>
                                                  {badge(m)}
                                                </span>
                                              </SelectItem>
                                            ))}
                                          </>
                                        ) : null}
                                        {builtin.length > 0 ? (
                                          <>
                                            <SelectLabel>内置模型</SelectLabel>
                                            {builtin.map((m) => (
                                              <SelectItem
                                                key={m.id}
                                                value={m.id}
                                              >
                                                <span className="flex items-center gap-1.5">
                                                  <span>{m.name}</span>
                                                  {badge(m)}
                                                </span>
                                              </SelectItem>
                                            ))}
                                          </>
                                        ) : null}
                                      </>
                                    );
                                  })()}
                                  <div className="-mx-1 my-1 border-t" />
                                  <button
                                    type="button"
                                    onClick={() => setSettingsTab("providers")}
                                    className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                  >
                                    管理模型…
                                  </button>
                                </>
                              )}
                            </SelectContent>
                          </Select>
                          <ContextUsageButton
                            usage={null}
                            modelId={model}
                            contextWindow={modelMeta.contextWindow}
                            maxOutputTokens={modelMeta.maxOutputTokens}
                          />
                          <ComposerCompactSelect
                            ariaLabel="思考强度"
                            icon={<Brain className="h-3.5 w-3.5" />}
                            options={THINKING_OPTIONS}
                            value={thinking}
                            onChange={handleThinkingChange}
                            contentClassName="min-w-24"
                            progress={THINKING_PROGRESS[thinking] ?? 0}
                          />
                        </>
                      }
                      onChange={setPrompt}
                      onSubmit={(value: string) => {
                        // `/命令 args` 在提交前展开（转录里看到的就是实际发出去的）
                        const expanded = expandCommand(value, commands).text;
                        if (!expanded.trim()) return false;
                        startTask(expanded);
                        return true;
                      }}
                    />
                  </div>
                  {voice.status}
                </div>

                <div className="mt-5 flex items-center justify-center gap-3">
                  {meta.chips.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => setPrompt(chip)}
                      className="rounded-full border px-4 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            </TabStoreProvider>
          </TooltipProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
}
