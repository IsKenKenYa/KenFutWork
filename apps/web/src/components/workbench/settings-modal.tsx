"use client";

import {
  type InstanceSettings,
  instanceSettingsSchema,
} from "@kenfutwork/shared";
import { PanelsTopLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AgentGovernanceSettingsView } from "@/components/agent-governance-settings";
import { AgentSection } from "@/components/agent-section";
import { PermissionSection } from "@/components/permission-section";
import { ProviderSettings } from "@/components/provider-settings";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AboutSection } from "@/components/workbench/about-section";
import { AppearanceSection } from "@/components/workbench/appearance-section";
import { BrowserSettingsSection } from "@/components/workbench/browser-settings-section";
import { CommandsSection } from "@/components/workbench/commands-section";
import { HooksSection } from "@/components/workbench/hooks-section";
import { IndexLibrarySection } from "@/components/workbench/index-library-section";
import { ListLoading } from "@/components/workbench/list-state";
import { LocalAccessClientsSection } from "@/components/workbench/local-access-clients-section";
import { LocalInstanceSection } from "@/components/workbench/local-instance-section";
import { OnboardingSection } from "@/components/workbench/onboarding-section";
import { RulesMemorySection } from "@/components/workbench/rules-memory-section";
import { SubagentsSection } from "@/components/workbench/subagents-section";
import { TerminalSettingsSection } from "@/components/workbench/terminal-settings-section";
import { UsageStatsSection } from "@/components/workbench/usage-stats-section";
import { PluginPanelButtons } from "@/lib/plugin-panels";
import { fetchModels } from "@/lib/server-api";
import { useInstanceSettings } from "@/lib/use-instance-settings";

export type SettingsTab =
  | "pluginPanels"
  | "general"
  | "appearance"
  | "commands"
  | "hooks"
  | "apiTokens"
  | "model"
  | "agentGovernance"
  | "providers"
  | "permissions"
  | "browser"
  | "rules"
  | "subagents"
  | "usage"
  | "index"
  | "onboarding"
  | "about";

/**
 * 侧栏分组（R5-1）：基础设置 / Agent 能力 / 数据与统计。
 *
 * 参考图（`agent-设置-权限.png` / `设置添加使用统计以及索引相关内容.png`）里点名、
 * 且本产品**真有对应页面**的条目，作为**别名行**列在对应分组下（点击跳到那一页）——
 * 用户按参考图的名字能找得到，又不复制出第二份内容。
 * 没做的那几条（外观/命令/钩子/工作树/对话流/外部应用授权/Beta/云端运行环境）在
 * `docs/日志.md` §二十二里逐条写明不做的原因。
 */
const TAB_GROUPS: Array<{
  label: string;
  tabs: Array<{ id: SettingsTab; label: string }>;
}> = [
  {
    label: "基础设置",
    tabs: [
      { id: "general", label: "通用" },
      { id: "appearance", label: "外观" },
      { id: "model", label: "模型" },
      { id: "agentGovernance", label: "Agent 治理" },
      { id: "providers", label: "供应商" },
      { id: "browser", label: "浏览器" },
    ],
  },
  {
    label: "Agent 能力",
    tabs: [
      { id: "permissions", label: "权限" },
      { id: "rules", label: "规则与记忆" },
      { id: "commands", label: "命令" },
      { id: "hooks", label: "钩子" },
      { id: "apiTokens", label: "外部应用授权" },
      { id: "subagents", label: "子智能体" },
    ],
  },
  {
    label: "数据与统计",
    tabs: [
      { id: "usage", label: "使用统计" },
      { id: "index", label: "索引库" },
      { id: "onboarding", label: "引导" },
      // 插件面板（能力 `ui` 的 settings 槽位）：装了带面板的插件才出现内容
      { id: "pluginPanels", label: "插件面板" },
      { id: "about", label: "关于" },
    ],
  },
];

const INSTANCE_SETTINGS_TABS = new Set<SettingsTab>([
  "model",
  "agentGovernance",
  "index",
  "commands",
  "hooks",
]);

/**
 * 设置（居中大模态，左侧分类导航 + 右侧内容）：
 * 通用/模型/供应商/权限走真实后端，浏览器/规则与记忆为本机偏好。
 * MCP 管理不在设置内——见侧栏「MCP」（含精选目录与官方注册表）。
 *
 * 导航里**一个页面只出现一次**：早前为了「参考图里点名的名字也能找到」加过跳转别名行
 * （「记忆 → 规则与记忆」「用量管理 → 使用统计」「电脑控制 → 浏览器」），用户口径
 * 「这两个合并为一个菜单」「这个让你合并的东西怎么又出来了」——别名行整体下线，
 * 要合并就合并页面本身，不再往导航里塞跳转行。
 */
export function SettingsModal({
  open,
  initialTab,
  onClose,
  accessToken = null,
  activeTaskId = null,
  hasWorkDir = false,
  conversationCount = 0,
}: {
  open: boolean;
  /** 打开时定位的分类（如「管理模型」直达供应商页）。 */
  initialTab?: SettingsTab | undefined;
  /** 插件面板需要它取 `/api/plugins`（本机Cookie会话用于授权）。 */
  accessToken?: string | null;
  /** 当前 Code Task（索引取 Task 固定目录；视觉模式或未创建 Task 时为 null）。 */
  activeTaskId?: string | null;
  /** 「引导」页用：是否已有工作目录项目、已有多少会话。 */
  hasWorkDir?: boolean;
  conversationCount?: number;
  /**  */
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    initialTab ?? "general",
  );

  // 每次打开按 initialTab 重新定位
  useEffect(() => {
    if (open && initialTab) setActiveTab(initialTab);
  }, [open, initialTab]);
  const [defaultModel, setDefaultModel] = useState("");
  const [agentMaxRetries, setAgentMaxRetries] = useState(
    instanceSettingsSchema.shape.agentMaxRetries.parse(undefined),
  );
  const [codeIndexEnabled, setCodeIndexEnabled] = useState(false);
  const [codeIndexAutoNewFolder, setCodeIndexAutoNewFolder] = useState(true);
  const [autoCompactEnabled, setAutoCompactEnabled] = useState(true);
  const [commands, setCommands] = useState<InstanceSettings["commands"]>([]);
  const [hooks, setHooks] = useState<InstanceSettings["hooks"]>([]);
  const settingsState = useInstanceSettings(open, accessToken);
  const currentSettings = settingsState.settings;
  const saveSettings = settingsState.save;
  const loadData = settingsState.reload;
  const loading = settingsState.status === "loading";
  const loadError = settingsState.error;

  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const getToken = useCallback(() => accessTokenRef.current, []);

  useEffect(() => {
    if (!currentSettings) return;
    setDefaultModel(currentSettings.defaultModel);
    setAgentMaxRetries(currentSettings.agentMaxRetries);
    setCodeIndexEnabled(currentSettings.codeIndexEnabled);
    setCodeIndexAutoNewFolder(currentSettings.codeIndexAutoNewFolder);
    setAutoCompactEnabled(currentSettings.autoCompactEnabled);
    setCommands((previous) =>
      previous.length === currentSettings.commands.length &&
      previous.every((command, index) => {
        const next = currentSettings.commands[index];
        return (
          next !== undefined &&
          command.name === next.name &&
          command.description === next.description &&
          command.prompt === next.prompt
        );
      })
        ? previous
        : currentSettings.commands,
    );
    setHooks((previous) =>
      previous.length === currentSettings.hooks.length &&
      previous.every((hook, index) => {
        const next = currentSettings.hooks[index];
        return (
          next !== undefined &&
          hook.event === next.event &&
          hook.command === next.command
        );
      })
        ? previous
        : currentSettings.hooks,
    );
  }, [currentSettings]);

  /** 索引库开关写实例设置（部分更新：只送这一个字段）。 */
  const handleIndexToggle = useCallback(
    async (next: boolean) => {
      setCodeIndexEnabled(next);
      try {
        const result = await saveSettings({ codeIndexEnabled: next });
        if (result) setCodeIndexEnabled(result.codeIndexEnabled);
      } catch {
        setCodeIndexEnabled(!next);
      }
    },
    [saveSettings],
  );

  /** 「索引新文件夹」开关：同样部分更新，只送这一个字段。 */
  const handleIndexAutoToggle = useCallback(
    async (next: boolean) => {
      setCodeIndexAutoNewFolder(next);
      try {
        const result = await saveSettings({ codeIndexAutoNewFolder: next });
        if (result) setCodeIndexAutoNewFolder(result.codeIndexAutoNewFolder);
      } catch {
        setCodeIndexAutoNewFolder(!next);
      }
    },
    [saveSettings],
  );

  /** 上下文自动压缩开关：立即写（部分更新），失败回滚。 */
  const handleAutoCompactToggle = useCallback(
    async (next: boolean) => {
      setAutoCompactEnabled(next);
      try {
        const result = await saveSettings({ autoCompactEnabled: next });
        if (result) setAutoCompactEnabled(result.autoCompactEnabled);
      } catch {
        setAutoCompactEnabled(!next);
      }
    },
    [saveSettings],
  );

  const handleModelSave = useCallback(
    async (next: { agentMaxRetries: number; defaultModel: string }) => {
      const result = await saveSettings(next);
      if (!result) return;
      setDefaultModel(result.defaultModel);
      setAgentMaxRetries(result.agentMaxRetries);
    },
    [saveSettings],
  );

  const stableFetchModels = useCallback(
    () => fetchModels(getToken() ?? undefined),
    [getToken],
  );

  const token = getToken();
  /** 内容滚动容器引用：切 tab 时重置滚动位置（旧位置残留是明显的交互脏感）。 */
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const handleTabChange = useCallback((next: SettingsTab) => {
    setActiveTab(next);
    if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
  }, []);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex h-[85vh] max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby={undefined}
      >
        <DialogTitle className="border-b px-5 py-3 text-base font-medium">
          设置
        </DialogTitle>
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="设置分类"
            className="w-44 shrink-0 space-y-3 overflow-y-auto border-r p-2"
          >
            {TAB_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                  {group.label}
                </div>
                {group.tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    data-active={activeTab === tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    className="w-full rounded-md border-l-2 px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[active=true]:border-l-primary data-[active=true]:bg-muted data-[active=true]:font-medium data-[active=true]:text-foreground"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div
            ref={contentScrollRef}
            className="min-w-0 flex-1 overflow-y-auto px-6 py-4"
          >
            {loadError ? (
              <div
                role="status"
                className="mb-4 flex items-center gap-3 text-sm text-destructive"
              >
                <span>{loadError}</span>
                <button
                  type="button"
                  className="rounded-md border px-2 py-1"
                  onClick={() => void loadData()}
                >
                  重试
                </button>
              </div>
            ) : null}
            {loading ? (
              <ListLoading label="正在加载设置…" rows={2} />
            ) : !currentSettings &&
              INSTANCE_SETTINGS_TABS.has(activeTab) ? null : activeTab ===
              "general" ? (
              <div className="space-y-8">
                <LocalInstanceSection />
                <TerminalSettingsSection accessToken={token} />
              </div>
            ) : activeTab === "appearance" ? (
              <AppearanceSection />
            ) : activeTab === "model" ? (
              <AgentSection
                agentMaxRetries={agentMaxRetries}
                defaultModel={defaultModel}
                fetchModels={stableFetchModels}
                onSave={handleModelSave}
                autoCompactEnabled={autoCompactEnabled}
                onToggleAutoCompact={handleAutoCompactToggle}
              />
            ) : activeTab === "agentGovernance" ? (
              currentSettings ? (
                <AgentGovernanceSettingsView
                  settings={currentSettings}
                  save={saveSettings}
                />
              ) : null
            ) : activeTab === "providers" ? (
              <ProviderSettings accessToken={token} />
            ) : activeTab === "permissions" ? (
              <PermissionSection accessToken={token} />
            ) : activeTab === "browser" ? (
              <BrowserSettingsSection accessToken={accessToken} />
            ) : activeTab === "pluginPanels" ? (
              <PluginPanelsSettings accessToken={accessToken} />
            ) : activeTab === "usage" ? (
              <UsageStatsSection />
            ) : activeTab === "index" ? (
              <IndexLibrarySection
                accessToken={token}
                taskId={activeTaskId}
                enabled={codeIndexEnabled}
                autoNewFolder={codeIndexAutoNewFolder}
                onToggle={handleIndexToggle}
                onToggleAuto={handleIndexAutoToggle}
              />
            ) : activeTab === "onboarding" ? (
              <OnboardingSection
                accessToken={token}
                hasWorkDir={hasWorkDir}
                conversationCount={conversationCount}
                onGoToTab={(next) => setActiveTab(next)}
              />
            ) : activeTab === "commands" ? (
              <CommandsSection
                accessToken={token}
                commands={commands}
                onSaved={setCommands}
              />
            ) : activeTab === "hooks" ? (
              <HooksSection
                accessToken={token}
                hooks={hooks}
                onSaved={setHooks}
              />
            ) : activeTab === "apiTokens" ? (
              <LocalAccessClientsSection />
            ) : activeTab === "subagents" ? (
              <SubagentsSection accessToken={token} />
            ) : activeTab === "about" ? (
              <AboutSection />
            ) : (
              <RulesMemorySection accessToken={token} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 「插件面板」设置页：列出 settings 槽位的插件面板。
 * 没有插件声明该槽位时，明确说明「当前没有插件提供设置面板」——不放空壳。
 */
function PluginPanelsSettings({ accessToken }: { accessToken: string | null }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        已启用插件提供的设置面板会显示在这里。
      </p>
      <div className="flex flex-wrap gap-2">
        <PluginPanelButtons
          accessToken={accessToken}
          slot="settings"
          renderButton={(panel, open) => (
            <button
              key={panel.id}
              type="button"
              onClick={open}
              className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <PanelsTopLeft className="h-4 w-4" />
              {panel.title}
            </button>
          )}
        />
      </div>
    </div>
  );
}
