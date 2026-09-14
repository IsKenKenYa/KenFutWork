"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AgentSection } from "@/components/agent-section";
import { PermissionSection } from "@/components/permission-section";
import { ProfileSection } from "@/components/profile-section";
import { ProviderSettings } from "@/components/provider-settings";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { BrowserSettingsSection } from "@/components/workbench/browser-settings-section";
import { McpSettingsSection } from "@/components/workbench/mcp-settings-section";
import { RulesMemorySection } from "@/components/workbench/rules-memory-section";
import { useAuth } from "@/lib/auth-context";
import {
  fetchModels,
  fetchViewer,
  fetchWorkspaceSettings,
  updateProfile,
  updateWorkspaceSettings,
} from "@/lib/server-api";

export type SettingsTab =
  | "general"
  | "model"
  | "providers"
  | "permissions"
  | "mcp"
  | "browser"
  | "rules";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "通用" },
  { id: "model", label: "模型" },
  { id: "providers", label: "供应商" },
  { id: "permissions", label: "权限" },
  { id: "mcp", label: "MCP" },
  { id: "browser", label: "浏览器" },
  { id: "rules", label: "规则与记忆" },
];

/**
 * 设置（居中大模态，左侧分类导航 + 右侧内容）：
 * 通用/模型/供应商/权限走真实后端，浏览器/规则与记忆为本机偏好。
 */
export function SettingsModal({
  open,
  initialTab,
  onClose,
}: {
  open: boolean;
  /** 打开时定位的分类（如「管理模型」直达供应商页）。 */
  initialTab?: SettingsTab | undefined;
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
  const [defaultModel, setDefaultModel] = useState("");
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
      setDefaultModel(settings.settings.defaultModel);
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

  const handleModelSave = useCallback(
    async (model: string) => {
      const token = getToken();
      if (!token) return;
      const result = await updateWorkspaceSettings(token, {
        defaultModel: model,
      });
      setDefaultModel(result.settings.defaultModel);
    },
    [getToken],
  );

  const stableFetchModels = useCallback(
    () => fetchModels(getToken() ?? undefined),
    [getToken],
  );

  const token = getToken();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex h-[70vh] max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        aria-describedby={undefined}
      >
        <DialogTitle className="border-b px-5 py-3 text-base font-medium">
          设置
        </DialogTitle>
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="设置分类"
            className="w-36 shrink-0 space-y-0.5 border-r p-2"
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                data-active={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="w-full rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[active=true]:bg-muted data-[active=true]:font-medium data-[active=true]:text-foreground"
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
            {loading && !profile ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : activeTab === "general" ? (
              profile ? (
                <ProfileSection
                  displayName={profile.displayName}
                  email={profile.email}
                  onSave={handleProfileSave}
                />
              ) : null
            ) : activeTab === "model" ? (
              <AgentSection
                defaultModel={defaultModel}
                onSave={handleModelSave}
                fetchModels={stableFetchModels}
              />
            ) : activeTab === "providers" ? (
              token ? (
                <ProviderSettings accessToken={token} />
              ) : null
            ) : activeTab === "permissions" ? (
              token ? (
                <PermissionSection accessToken={token} />
              ) : null
            ) : activeTab === "mcp" ? (
              token ? (
                <McpSettingsSection accessToken={token} />
              ) : null
            ) : activeTab === "browser" ? (
              <BrowserSettingsSection />
            ) : (
              <RulesMemorySection />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
