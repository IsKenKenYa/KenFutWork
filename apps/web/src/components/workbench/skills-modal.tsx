"use client";

import type { SkillCategory, SkillDetail, SkillListItem } from "@loomic/shared";
import { Folder, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";
import {
  filterSkillViews,
  mergeSkillViews,
  SKILL_IMPORT_HINT,
  type SkillView,
  skillCategoryLabel,
  skillSourceLabel,
  skillStateLabel,
} from "@/lib/skills-view";

const CATEGORIES: SkillCategory[] = [
  "design",
  "generation",
  "code",
  "data",
  "writing",
  "custom",
];

type SkillsTab = "mine" | "create";

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
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
}) {
  const [tab, setTab] = useState<SkillsTab>("mine");
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
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent
          className="flex h-[78vh] max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-3 border-b px-5 py-3 pr-12">
            <DialogTitle className="flex items-center gap-2 text-base font-medium">
              <Folder className="h-4 w-4" /> 技能
            </DialogTitle>
            <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
              {(
                [
                  { id: "mine", label: "技能库" },
                  { id: "create", label: "导入 / 新建" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-active={tab === item.id}
                  onClick={() => setTab(item.id)}
                  className="rounded-md px-3 py-1 text-sm transition-colors data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:shadow-sm"
                >
                  {item.label}
                </button>
              ))}
            </div>
            {tab === "mine" ? (
              <div className="ml-auto flex items-center gap-2 rounded-md border px-2 py-1">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  aria-label="搜索技能"
                  placeholder="搜索技能…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="w-40 bg-transparent text-sm outline-none"
                />
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            {tab === "create" ? (
              <SkillsCreatePanel
                accessToken={accessToken}
                onCreated={() => {
                  setTab("mine");
                  refresh();
                }}
              />
            ) : null}

            {notice ? (
              <p className="text-xs text-emerald-600">{notice}</p>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}

            {tab === "mine" ? (
              loading ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : visible.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {query
                    ? "未找到匹配的技能"
                    : "暂无技能，去「导入 / 新建」添加"}
                </p>
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
    </>
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
  onCreated,
}: {
  accessToken: string | null;
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

  const authHeaders = (): Record<string, string> =>
    accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

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
          <select
            aria-label="技能分类"
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as SkillCategory)
            }
            className="rounded-md border px-2 py-1.5 text-sm outline-none"
          >
            {CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {skillCategoryLabel(item)}
              </option>
            ))}
          </select>
        </div>
        <input
          aria-label="技能描述"
          placeholder="描述（写清什么时候该用它）"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="w-full rounded-md border px-2 py-1.5 text-sm outline-none"
        />
        <textarea
          aria-label="技能内容"
          placeholder="SKILL.md 正文（frontmatter 可省略，服务端按 name/description 补）"
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
