"use client";

import type { WorkspaceSettings } from "@kenfutwork/shared";
import { PanelsTopLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AgentSection } from "@/components/agent-section";
import { PermissionSection } from "@/components/permission-section";
import { ProfileSection } from "@/components/profile-section";
import { ProviderSettings } from "@/components/provider-settings";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AboutSection } from "@/components/workbench/about-section";
import { AccountSection } from "@/components/workbench/account-section";
import { AppearanceSection } from "@/components/workbench/appearance-section";
import { BrowserSettingsSection } from "@/components/workbench/browser-settings-section";
import { CommandsSection } from "@/components/workbench/commands-section";
import { HooksSection } from "@/components/workbench/hooks-section";
import { IndexLibrarySection } from "@/components/workbench/index-library-section";
import { ListLoading } from "@/components/workbench/list-state";
import { OnboardingSection } from "@/components/workbench/onboarding-section";
import { RulesMemorySection } from "@/components/workbench/rules-memory-section";
import { SubagentsSection } from "@/components/workbench/subagents-section";
import { TerminalSettingsSection } from "@/components/workbench/terminal-settings-section";
import { UsageStatsSection } from "@/components/workbench/usage-stats-section";
import { VoiceSettingsSection } from "@/components/workbench/voice-settings-section";
import { useAuth } from "@/lib/auth-context";
import { PluginPanelButtons } from "@/lib/plugin-panels";
import {
  fetchModels,
  fetchViewer,
  fetchWorkspaceSettings,
  updateProfile,
  updateWorkspaceSettings,
} from "@/lib/server-api";
import { SETTINGS_SECTION_GAP, SETTINGS_TITLE } from "@/lib/settings-layout";

export type SettingsTab =
  | "pluginPanels"
  | "general"
  | "commands"
  | "hooks"
  | "providers"
  | "permissions"
  | "browser"
  | "voice"
  | "rules"
  | "subagents"
  | "usage"
  | "index"
  | "onboarding"
  | "account"
  | "about";

/**
 * 侧栏分组：基础设置 / Agent 能力 / 数据与统计。
 *
 * 用户口径（2026-09-26）：「外观和模型合并到通用」「外部应用授权去掉」——
 * 通用页 = 外观 + 模型 + 个人资料 + 终端；apiTokens 页整体下线（组件同删）。
 */
const TAB_GROUPS: Array<{
  label: string;
  tabs: Array<{ id: SettingsTab; label: string }>;
}> = [
  {
    label: "基础设置",
    tabs: [
      { id: "general", label: "通用" },
      { id: "providers", label: "供应商" },
      { id: "browser", label: "浏览器" },
      { id: "voice", label: "语音" },
    ],
  },
  {
    label: "Agent 能力",
    tabs: [
      { id: "permissions", label: "权限" },
      { id: "rules", label: "规则与记忆" },
      { id: "commands", label: "命令" },
      { id: "hooks", label: "钩子" },
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
      { id: "account", label: "账号" },
      { id: "about", label: "关于" },
    ],
  },
];

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
  activeCanvasId = null,
  hasWorkDir = false,
  conversationCount = 0,
  isAdmin = false,
  onOpenAdmin,
}: {
  open: boolean;
  /** 打开时定位的分类（如「管理模型」直达供应商页）。 */
  initialTab?: SettingsTab | undefined;
  /** 插件面板需要它取 `/api/plugins`（未登录时为空 → 面板列表为空）。 */
  accessToken?: string | null;
  /** 当前项目主画布（索引库按画布=工作目录建；没有项目时为 null）。 */
  activeCanvasId?: string | null;
  /** 「引导」页用：是否已有工作目录项目、已有多少会话。 */
  hasWorkDir?: boolean;
  conversationCount?: number;
  /** 「账号」页用：管理员才给「管理后台」入口（服务端仍独立鉴权）。 */
  isAdmin?: boolean;
  onOpenAdmin?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { session } = useAuth();
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    initialTab ?? "general",
  );

  // 每次打开按 initialTab 重新定位
  useEffect(() => {
    if (open && initialTab) setActiveTab(initialTab);
  }, [open, initialTab]);
  const [profile, setProfile] = useState<{
    displayName: string;
    email: string;
  } | null>(null);
  /** 「账号」页用：套餐与额度（未装配计费时为 null）。 */
  const [account, setAccount] = useState<{
    plan: string | null;
    balance: number | null;
  }>({ plan: null, balance: null });
  const [defaultModel, setDefaultModel] = useState("");
  const [agentMaxRetries, setAgentMaxRetries] = useState(10);
  const [codeIndexEnabled, setCodeIndexEnabled] = useState(false);
  const [codeIndexAutoNewFolder, setCodeIndexAutoNewFolder] = useState(true);
  const [autoCompactEnabled, setAutoCompactEnabled] = useState(true);
  const [commands, setCommands] = useState<WorkspaceSettings["commands"]>([]);
  const [hooks, setHooks] = useState<WorkspaceSettings["hooks"]>([]);
  const [subagents, setSubagents] = useState<WorkspaceSettings["subagents"]>(
    [],
  );
  const [loading, setLoading] = useState(false);

  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;
  const getToken = useCallback(() => accessTokenRef.current, []);

  const loadData = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    try {
      const [viewer, settings] = await Promise.all([
        fetchViewer(token),
        fetchWorkspaceSettings(token),
      ]);
      setProfile({
        displayName: viewer.profile.displayName,
        email: viewer.profile.email,
      });
      setAccount({
        plan: viewer.credits?.plan ?? null,
        balance: viewer.credits?.balance ?? null,
      });
      setDefaultModel(settings.settings.defaultModel);
      setAgentMaxRetries(settings.settings.agentMaxRetries);
      setCodeIndexEnabled(settings.settings.codeIndexEnabled);
      setCodeIndexAutoNewFolder(settings.settings.codeIndexAutoNewFolder);
      setAutoCompactEnabled(settings.settings.autoCompactEnabled);
      setCommands(settings.settings.commands);
      setHooks(settings.settings.hooks);
      setSubagents(settings.settings.subagents);
    } catch {
      // 加载失败时保留空态，各分区自行提示
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (open) void loadData();
  }, [open, loadData]);

  const handleProfileSave = useCallback(
    async (displayName: string) => {
      const token = getToken();
      if (!token) return;
      const result = await updateProfile(token, { displayName });
      setProfile({
        displayName: result.profile.displayName,
        email: result.profile.email,
      });
    },
    [getToken],
  );

  /** 索引库开关写工作区设置（部分更新：只送这一个字段）。 */
  const handleIndexToggle = useCallback(
    async (next: boolean) => {
      const token = getToken();
      if (!token) return;
      setCodeIndexEnabled(next);
      try {
        const result = await updateWorkspaceSettings(token, {
          codeIndexEnabled: next,
        });
        setCodeIndexEnabled(result.settings.codeIndexEnabled);
      } catch {
        setCodeIndexEnabled(!next);
      }
    },
    [getToken],
  );

  /** 「索引新文件夹」开关：同样部分更新，只送这一个字段。 */
  const handleIndexAutoToggle = useCallback(
    async (next: boolean) => {
      const token = getToken();
      if (!token) return;
      setCodeIndexAutoNewFolder(next);
      try {
        const result = await updateWorkspaceSettings(token, {
          codeIndexAutoNewFolder: next,
        });
        setCodeIndexAutoNewFolder(result.settings.codeIndexAutoNewFolder);
      } catch {
        setCodeIndexAutoNewFolder(!next);
      }
    },
    [getToken],
  );

  /** 上下文自动压缩开关：立即写（部分更新），失败回滚。 */
  const handleAutoCompactToggle = useCallback(
    async (next: boolean) => {
      const token = getToken();
      if (!token) return;
      setAutoCompactEnabled(next);
      try {
        const result = await updateWorkspaceSettings(token, {
          autoCompactEnabled: next,
        });
        setAutoCompactEnabled(result.settings.autoCompactEnabled);
      } catch {
        setAutoCompactEnabled(!next);
      }
    },
    [getToken],
  );

  const handleModelSave = useCallback(
    async (next: { agentMaxRetries: number; defaultModel: string }) => {
      const token = getToken();
      if (!token) return;
      const result = await updateWorkspaceSettings(token, next);
      setDefaultModel(result.settings.defaultModel);
      setAgentMaxRetries(result.settings.agentMaxRetries);
    },
    [getToken],
  );

  /** 自定义子智能体增删后回写（PUT 部分更新只送这一个字段）。 */
  const handleSubagentsSave = useCallback(
    async (next: WorkspaceSettings["subagents"]) => {
      const token = getToken();
      if (!token) return;
      const result = await updateWorkspaceSettings(token, {
        subagents: next,
      });
      setSubagents(result.settings.subagents);
    },
    [getToken],
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
            {loading && !profile ? (
              <ListLoading label="正在加载设置…" rows={2} />
            ) : activeTab === "general" ? (
              /* 「通用」一页里并排四块（外观/模型/个人资料/终端）：间距用统一版式常量，
                 不再各自 mt-* / space-y-8（实测弹窗里曾同时存在 8 种块间距） */
              <div className={SETTINGS_SECTION_GAP}>
                <AppearanceSection />
                <AgentSection
                  agentMaxRetries={agentMaxRetries}
                  defaultModel={defaultModel}
                  fetchModels={stableFetchModels}
                  onSave={handleModelSave}
                  autoCompactEnabled={autoCompactEnabled}
                  onToggleAutoCompact={handleAutoCompactToggle}
                />
                {profile ? (
                  <ProfileSection
                    displayName={profile.displayName}
                    email={profile.email}
                    onSave={handleProfileSave}
                  />
                ) : null}
                {token ? <TerminalSettingsSection accessToken={token} /> : null}
              </div>
            ) : activeTab === "providers" ? (
              token ? (
                <ProviderSettings accessToken={token} />
              ) : null
            ) : activeTab === "permissions" ? (
              token ? (
                <PermissionSection accessToken={token} />
              ) : null
            ) : activeTab === "browser" ? (
              <BrowserSettingsSection accessToken={accessToken} />
            ) : activeTab === "voice" ? (
              token ? (
                <VoiceSettingsSection accessToken={token} />
              ) : null
            ) : activeTab === "pluginPanels" ? (
              <PluginPanelsSettings accessToken={accessToken} />
            ) : activeTab === "usage" ? (
              <UsageStatsSection />
            ) : activeTab === "index" ? (
              token ? (
                <IndexLibrarySection
                  accessToken={token}
                  canvasId={activeCanvasId}
                  enabled={codeIndexEnabled}
                  autoNewFolder={codeIndexAutoNewFolder}
                  onToggle={handleIndexToggle}
                  onToggleAuto={handleIndexAutoToggle}
                />
              ) : null
            ) : activeTab === "onboarding" ? (
              token ? (
                <OnboardingSection
                  accessToken={token}
                  hasWorkDir={hasWorkDir}
                  conversationCount={conversationCount}
                  onGoToTab={(next) => setActiveTab(next)}
                  onLeaveSettings={onClose}
                />
              ) : null
            ) : activeTab === "commands" ? (
              token ? (
                <CommandsSection
                  accessToken={token}
                  commands={commands}
                  onSaved={setCommands}
                />
              ) : null
            ) : activeTab === "hooks" ? (
              token ? (
                <HooksSection
                  accessToken={token}
                  hooks={hooks}
                  onSaved={setHooks}
                />
              ) : null
            ) : activeTab === "subagents" ? (
              token ? (
                <SubagentsSection
                  accessToken={token}
                  subagents={subagents}
                  onSaved={handleSubagentsSave}
                />
              ) : null
            ) : activeTab === "account" ? (
              profile ? (
                <AccountSection
                  displayName={profile.displayName}
                  email={profile.email}
                  plan={account.plan}
                  balance={account.balance}
                  isAdmin={isAdmin}
                  {...(onOpenAdmin ? { onOpenAdmin } : {})}
                />
              ) : null
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
 * 页面标题与其它设置页同一规格（`SETTINGS_TITLE`）：曾经只有这一页和语音页没有标题。
 */
function PluginPanelsSettings({ accessToken }: { accessToken: string | null }) {
  return (
    <div>
      <h3 className={SETTINGS_TITLE}>插件面板</h3>
      <div className="flex flex-wrap gap-2">
        <PluginPanelButtons
          accessToken={accessToken}
          slot="settings"
          emptyLabel="当前没有插件提供设置面板"
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
