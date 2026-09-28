"use client";

import type {
  MarketplaceSkill,
  SandboxSkillPackage,
  SkillCategory,
  SkillDetail,
  SkillListItem,
} from "@kenfutwork/shared";
import { Blocks, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getServerBaseUrl } from "@/lib/env";
import {
  describeInstallFailure,
  type MarketItemView,
  normalizeMarketQuery,
  toMarketItemView,
} from "@/lib/skill-market";
import {
  importSandboxSkill,
  listSandboxSkillPackages,
} from "@/lib/skills-sandbox";
import {
  filterSkillViews,
  mergeSkillViews,
  SKILL_IMPORT_HINT,
  type SkillView,
  skillCategoryLabel,
  skillSourceLabel,
  skillStateLabel,
} from "@/lib/skills-view";
import { ListEmpty, ListError, ListLoading } from "./list-state";

const CATEGORIES: SkillCategory[] = [
  "design",
  "generation",
  "code",
  "data",
  "writing",
  "custom",
];

type SkillsTab = "mine" | "market" | "create";

/**
 * 技能管理页（模态，与插件市场同形）。
 *
 * 后端 9 个 CRUD + 市场端点此前**没有任何前端消费方**（`/api/skills` 全仓
 * 前端零调用）——技能缝缺 Consumer。本页补上最小可用闭环：
 * 列出可见技能（合并工作区启用态）→ 启用/停用 → 删除自己的 → 详情（内容+文件）
 * → 从链接导入（GitHub / npm tarball / ZIP）→ 手动新建。
 */
export function SkillsModal({
  open,
  onClose,
  accessToken,
  canvasId = null,
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
  /** 当前工作目录的画布 id（「从工作目录导入」用；没有选中项目时为 null）。 */
  canvasId?: string | null;
}) {
  const [tab, setTab] = useState<SkillsTab>("mine");
  /** 切页签重置滚动位置。 */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SkillView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);

  const authHeaders = useCallback(
    (): Record<string, string> =>
      accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    [accessToken],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    const base = getServerBaseUrl();
    Promise.all([
      fetch(`${base}/api/skills`, { headers: authHeaders() }).then((r) =>
        r.ok ? r.json() : { skills: [] },
      ),
      fetch(`${base}/api/workspaces/skills`, { headers: authHeaders() }).then(
        (r) => (r.ok ? r.json() : { skills: [] }),
      ),
    ])
      .then(
        ([all, installed]: [
          { skills: SkillListItem[] },
          { skills: SkillListItem[] },
        ]) => setRows(mergeSkillViews(all.skills, installed.skills)),
      )
      .catch(() => setError("技能列表加载失败，请稍后重试。"))
      .finally(() => setLoading(false));
  }, [authHeaders]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  async function toggle(row: SkillView) {
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      const base = getServerBaseUrl();
      // 已安装 → 直接切启用态；未安装 → 先安装（安装即启用）
      const response = row.installed
        ? await fetch(
            `${base}/api/workspaces/skills/${encodeURIComponent(row.id)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json", ...authHeaders() },
              body: JSON.stringify({ enabled: !row.enabled }),
            },
          )
        : await fetch(`${base}/api/workspaces/skills`, {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify({ skillId: row.id }),
          });
      if (!response.ok) {
        setError(await readErrorMessage(response, "操作失败。"));
        return;
      }
      setNotice(
        row.enabled ? `已停用「${row.name}」` : `已启用「${row.name}」`,
      );
      refresh();
    } catch {
      setError("操作请求失败。");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: SkillView) {
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `${getServerBaseUrl()}/api/skills/${encodeURIComponent(row.id)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!response.ok) {
        setError(await readErrorMessage(response, "删除失败。"));
        return;
      }
      setNotice(`已删除「${row.name}」`);
      refresh();
    } catch {
      setError("删除请求失败。");
    } finally {
      setBusyId(null);
    }
  }

  async function openDetail(row: SkillView) {
    setBusyId(row.id);
    setError(null);
    try {
      const response = await fetch(
        `${getServerBaseUrl()}/api/skills/${encodeURIComponent(row.id)}`,
        { headers: authHeaders() },
      );
      if (!response.ok) {
        setError(await readErrorMessage(response, "详情加载失败。"));
        return;
      }
      const payload = (await response.json()) as { skill: SkillDetail };
      setDetail(payload.skill);
    } catch {
      setError("详情请求失败。");
    } finally {
      setBusyId(null);
    }
  }

  const visible = useMemo(() => filterSkillViews(rows, query), [rows, query]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex h-[78vh] max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby={undefined}
      >
        {/* 头部要能收窄：窄窗口下原来不换行，标题与「技能库/市场/导入」被挤成竖排、
              搜索框还溢出到卡片外（用户看到的「透明框 + 内容跑出框外」就是这个）。
              → 允许换行 + 各段 shrink-0 + 搜索框在自己的行里占满。 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3 pr-12">
          <DialogTitle className="flex shrink-0 items-center gap-2 text-base font-medium">
            <Blocks className="h-4 w-4" /> 技能
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-1 rounded-lg bg-muted p-1">
            {(
              [
                { id: "mine", label: "技能库" },
                { id: "market", label: "市场" },
                { id: "create", label: "导入 / 新建" },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                data-active={tab === item.id}
                onClick={() => {
                  setTab(item.id);
                  if (contentRef.current) contentRef.current.scrollTop = 0;
                }}
                className="whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:shadow-sm"
              >
                {item.label}
              </button>
            ))}
          </div>
          {tab === "mine" ? (
            <div className="ml-auto flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1 sm:flex-none">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                aria-label="搜索技能"
                placeholder="搜索技能…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none sm:w-40 sm:flex-none"
              />
            </div>
          ) : null}
        </div>

        <div
          ref={contentRef}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
        >
          {tab === "market" ? (
            <SkillsMarketPanel
              accessToken={accessToken}
              onInstalled={(name) => {
                setNotice(`已安装「${name}」，可在「技能库」启用。`);
                refresh();
              }}
            />
          ) : null}

          {tab === "create" ? (
            <SkillsCreatePanel
              accessToken={accessToken}
              canvasId={canvasId}
              onCreated={() => {
                setTab("mine");
                refresh();
              }}
            />
          ) : null}

          {notice ? <p className="text-xs text-emerald-600">{notice}</p> : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          {tab === "mine" ? (
            loading ? (
              <ListLoading label="正在加载技能…" rows={3} />
            ) : visible.length === 0 ? (
              <ListEmpty
                title={query ? "未找到匹配的技能" : "暂无技能"}
                {...(query ? {} : { hint: "去「导入 / 新建」添加" })}
              />
            ) : (
              <ul className="space-y-2">
                {visible.map((row) => (
                  <li
                    key={row.id}
                    className="rounded-xl border p-3 transition-colors hover:border-foreground/30"
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium">
                            {row.name}
                          </span>
                          <Badge>{skillSourceLabel(row.source)}</Badge>
                          <Badge>{skillCategoryLabel(row.category)}</Badge>
                          <Badge>v{row.version}</Badge>
                          <Badge tone={row.enabled ? "on" : "off"}>
                            {skillStateLabel(row)}
                          </Badge>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {row.description}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void openDetail(row)}
                          disabled={busyId === row.id}
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          详情
                        </button>
                        {row.toggleable ? (
                          <button
                            type="button"
                            onClick={() => void toggle(row)}
                            disabled={busyId === row.id}
                            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            {row.enabled ? "停用" : "启用"}
                          </button>
                        ) : null}
                        {row.deletable ? (
                          <button
                            type="button"
                            aria-label={`删除 ${row.name}`}
                            onClick={() => void remove(row)}
                            disabled={busyId === row.id}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                        {busyId === row.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>

        {detail ? (
          <SkillDetailPanel detail={detail} onClose={() => setDetail(null)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "on" | "off";
}) {
  const toneClass =
    tone === "on"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : tone === "off"
        ? "text-muted-foreground"
        : "text-muted-foreground";
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[11px] ${toneClass}`}
    >
      {children}
    </span>
  );
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  return payload.error?.message ?? fallback;
}

/** 详情（内容 + 附属文件），覆盖列表行上的「详情」。 */
function SkillDetailPanel({
  detail,
  onClose,
}: {
  detail: SkillDetail;
  onClose: () => void;
}) {
  return (
    <div className="border-t bg-muted/40 px-5 py-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{detail.name} · 详情</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          收起
        </button>
      </div>
      <pre className="max-h-56 overflow-auto rounded-lg border bg-card p-3 text-xs whitespace-pre-wrap">
        {detail.skillContent}
      </pre>
      {detail.files && detail.files.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {detail.files.map((file) => (
            <li key={file.id} className="text-xs text-muted-foreground">
              {file.filePath} · {file.mimeType}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">无附属文件</p>
      )}
    </div>
  );
}

/** 导入（URL：GitHub / npm tarball / ZIP）与手动新建。 */
function SkillsCreatePanel({
  accessToken,
  canvasId,
  onCreated,
}: {
  accessToken: string | null;
  /** 当前工作目录所在画布：服务端据此解析沙箱目录（工作目录映射优先）。 */
  canvasId: string | null;
  onCreated: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"import" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<SkillCategory>("custom");
  const [content, setContent] = useState("");
  /** 「从工作目录导入」：agent（创造模式）在沙箱里造出的技能包 */
  const [packages, setPackages] = useState<SandboxSkillPackage[]>([]);
  const [packagesError, setPackagesError] = useState<string | null>(null);
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [importingPath, setImportingPath] = useState<string | null>(null);

  const authHeaders = useCallback(
    (): Record<string, string> =>
      accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    [accessToken],
  );

  const scanSandbox = useCallback(() => {
    setPackagesLoading(true);
    setPackagesError(null);
    void listSandboxSkillPackages({
      baseUrl: getServerBaseUrl(),
      token: accessToken,
      canvasId,
    })
      .then(({ packages: found, error: reason }) => {
        setPackages(found);
        setPackagesError(reason);
      })
      .finally(() => setPackagesLoading(false));
  }, [accessToken, canvasId]);

  // 打开「导入 / 新建」就扫一次：创造模式的产物应当**自动出现**在列表里
  useEffect(() => {
    scanSandbox();
  }, [scanSandbox]);

  async function importFromSandbox(path: string) {
    setImportingPath(path);
    setError(null);
    setMessage(null);
    const result = await importSandboxSkill({
      baseUrl: getServerBaseUrl(),
      token: accessToken,
      canvasId,
      path,
    });
    setImportingPath(null);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setMessage(`已从工作目录导入「${result.skill.name}」并启用`);
    onCreated();
  }

  async function importByUrl() {
    if (!url.trim()) return;
    setBusy("import");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${getServerBaseUrl()}/api/skills/import`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response, "导入失败。"));
        return;
      }
      const payload = (await response.json()) as { skill?: { name?: string } };
      setMessage(`已导入「${payload.skill?.name ?? url.trim()}」`);
      setUrl("");
      onCreated();
    } catch {
      setError("导入请求失败。");
    } finally {
      setBusy(null);
    }
  }

  async function createManually() {
    if (!name.trim() || !description.trim() || !content.trim()) {
      setError("名称、描述与技能内容均为必填。");
      return;
    }
    setBusy("create");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${getServerBaseUrl()}/api/skills`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          category,
          skillContent: content,
        }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response, "新建失败。"));
        return;
      }
      setMessage(`已创建「${name.trim()}」`);
      setName("");
      setDescription("");
      setContent("");
      onCreated();
    } catch {
      setError("新建请求失败。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {message ? <p className="text-xs text-emerald-600">{message}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">从工作目录导入</h3>
          <button
            type="button"
            onClick={scanSandbox}
            disabled={packagesLoading}
            className="rounded-md border px-2 py-1 text-xs disabled:opacity-40"
          >
            {packagesLoading ? "扫描中…" : "刷新"}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          工作目录里的技能包会出现在这里
        </p>
        {packagesError ? (
          <p className="text-xs text-destructive">{packagesError}</p>
        ) : null}
        {!packagesError && !packagesLoading && packages.length === 0 ? (
          <p className="text-xs text-muted-foreground">没有技能包</p>
        ) : null}
        {packages.length > 0 ? (
          <ul className="space-y-2">
            {packages.map((item) => (
              <li
                key={item.path}
                className="flex items-center gap-3 rounded-lg border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {item.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {item.path}
                    {item.description ? ` · ${item.description}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void importFromSandbox(item.path)}
                  disabled={importingPath !== null}
                  className="shrink-0 rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  {importingPath === item.path ? "导入中…" : "导入"}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="space-y-2 border-t pt-4">
        <h3 className="text-sm font-medium">从链接导入</h3>
        <p className="text-xs text-muted-foreground">{SKILL_IMPORT_HINT}</p>
        <div className="flex gap-2">
          <input
            aria-label="技能来源"
            placeholder="https://github.com/owner/repo 或 https://…/skill.zip"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-sm outline-none"
          />
          <button
            type="button"
            onClick={() => void importByUrl()}
            disabled={!url.trim() || busy !== null}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40"
          >
            {busy === "import" ? "导入中…" : "导入"}
          </button>
        </div>
      </section>

      <section className="space-y-2 border-t pt-4">
        <h3 className="text-sm font-medium">手动新建</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            aria-label="技能名称"
            placeholder="名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-md border px-2 py-1.5 text-sm outline-none"
          />
          <Select
            value={category}
            onValueChange={(next) => {
              if (typeof next === "string") setCategory(next as SkillCategory);
            }}
            items={CATEGORIES.map((item) => ({
              value: item,
              label: skillCategoryLabel(item),
            }))}
          >
            <SelectTrigger aria-label="技能分类" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((item) => (
                <SelectItem key={item} value={item}>
                  {skillCategoryLabel(item)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <input
          aria-label="技能描述"
          placeholder="描述（说明什么时候用它）"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="w-full rounded-md border px-2 py-1.5 text-sm outline-none"
        />
        <textarea
          aria-label="技能内容"
          placeholder="技能内容（SKILL.md 正文）"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={6}
          className="w-full rounded-md border px-2 py-1.5 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => void createManually()}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          {busy === "create" ? "创建中…" : "创建技能"}
        </button>
      </section>
    </div>
  );
}

/**
 * 技能市场面板。
 *
 * 数据源：服务端按 **npm registry 的 `keywords:agent-skill`** 检索候选，安装时经
 * **skills.sh** 取 tarball 导入（见 `features/skills/marketplace-service.ts`）。
 * 此前前端没有任何市场入口（技能页只有「技能库 / 导入·新建」），用户误以为市场是空的。
 */
function SkillsMarketPanel({
  accessToken,
  onInstalled,
}: {
  accessToken: string | null;
  onInstalled: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MarketItemView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busyPkg, setBusyPkg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const authHeaders = useCallback(
    (): Record<string, string> =>
      accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    [accessToken],
  );

  const search = useCallback(
    (rawQuery: string) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        q: normalizeMarketQuery(rawQuery),
        limit: "20",
      });
      void fetch(
        `${getServerBaseUrl()}/api/skills/marketplace/search?${params}`,
        { headers: authHeaders() },
      )
        .then(async (response) => {
          if (!response.ok) {
            setError(await readErrorMessage(response, "市场检索失败。"));
            return;
          }
          const payload = (await response.json()) as {
            skills: MarketplaceSkill[];
            total: number;
          };
          setItems(payload.skills.map(toMarketItemView));
          setTotal(payload.total);
        })
        .catch(() => setError("市场检索请求失败（检查网络）。"))
        .finally(() => setLoading(false));
    },
    [authHeaders],
  );

  // 打开面板先给一屏「全部」结果，避免空白让人误以为市场为空
  useEffect(() => {
    search("");
  }, [search]);

  async function install(item: MarketItemView) {
    setBusyPkg(item.packageName);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `${getServerBaseUrl()}/api/skills/marketplace/install`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ packageName: item.packageName }),
        },
      );
      if (!response.ok) {
        setError(
          describeInstallFailure(
            response.status,
            await readErrorMessage(response, ""),
          ),
        );
        return;
      }
      setMessage(`已安装「${item.name}」。`);
      onInstalled(item.name);
    } catch {
      setError("安装请求失败。");
    } finally {
      setBusyPkg(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          aria-label="搜索市场"
          placeholder="如 pdf / browser / seo"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") search(query);
          }}
          className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => search(query)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {loading ? "搜索中" : "搜索"}
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        来自 npm 技能市场
        {total > 0 ? `，共 ${total} 个（显示前 ${items.length} 个）` : ""}。
      </p>

      {message ? <p className="text-xs text-emerald-600">{message}</p> : null}

      {loading && items.length === 0 ? (
        <ListLoading label="正在检索技能市场…" rows={3} />
      ) : error ? (
        <ListError message={error} hint="也可用「导入 / 新建」从链接安装" />
      ) : items.length === 0 ? (
        <ListEmpty title="没有匹配的技能" hint="换英文关键词再试" />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.packageName}
              className="rounded-xl border p-3 transition-colors hover:border-foreground/30"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{item.name}</span>
                    <Badge>v{item.version}</Badge>
                    <Badge>{item.downloadsLabel} 下载</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {item.description || "（无描述）"}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    {item.packageName}
                    {item.authorLabel ? ` · ${item.authorLabel}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void install(item)}
                  disabled={busyPkg !== null}
                  className="shrink-0 rounded-md border px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {busyPkg === item.packageName ? "安装中…" : "安装"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
