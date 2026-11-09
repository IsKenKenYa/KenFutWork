/**
 * 「优先调用」主层（M3，规划 §6）：pre-step waterfall 每轮自动检索 + 证据注入。
 *
 * 时序（§6.1）：安装态门 → 自动注入开关 → 意图门（纯规则）→ 每 run 一次守卫
 * → 缓存 → ensureRoot（KB-3，按 run 真实工作目录）→ 检索（并发上限/超时）
 * → 去重 → 相关性门槛 → 预算裁剪 → 注入 input → **必须 next()**。
 *
 * 失败不阻断对话（KB-4）：任何异常都落显式状态块并放行原输入；
 * 未安装是正常态，静默放行（不写状态块）。
 */

import type { PreStepPayload, WaterfallListener } from "../../kernel/types.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import type { PersistenceService } from "../persistence/types.js";
import { SAG_QUERY_MAX_CHARS } from "./sag-cli-contract.js";
import type { KnowledgeSettingsReader } from "./settings.js";
import {
  dedupeKnowledgeEvidence,
  type KnowledgeEnsureResult,
  type KnowledgeEvidence,
  type KnowledgeService,
  KnowledgeServiceError,
} from "./types.js";

/**
 * 失败原因必须是一句人话：KnowledgeServiceError 自带可读消息；
 * 其他异常（如 ZodError 转储）只留首行并截断，完整错误进宿主日志。
 */
function readableFailure(error: unknown): string {
  if (error instanceof KnowledgeServiceError) return error.message;
  console.warn("[knowledge] 检索链路异常：", error);
  if (error instanceof Error && error.name === "ZodError") {
    return "内部错误（参数校验失败，详见宿主日志）";
  }
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split("\n")[0]?.trim() ?? "";
  const text = firstLine.length > 0 ? firstLine : "内部错误";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * 从 enriched prompt 抽用户问题：agent-modes 的 <execution_mode> 指令块与
 * buildUserMessage 追加的 XML 上下文块都不是用户输入，不进 query。
 * 超长输入截到上游硬限（2000），附件/代码全文本就不在文本部分。
 */
export function extractKnowledgeQuery(input: string): string {
  const withoutDirectives = input.replace(
    /<execution_mode[\s\S]*?<\/execution_mode>/gu,
    "",
  );
  const cut = withoutDirectives.search(/\n\n</u);
  const text = (
    cut === -1 ? withoutDirectives : withoutDirectives.slice(0, cut)
  ).trim();
  return text.length > SAG_QUERY_MAX_CHARS
    ? text.slice(0, SAG_QUERY_MAX_CHARS)
    : text;
}

const GREETING =
  /^(?:hi|hello|hey|你好|您好|嗨|哈喽|在吗|在么|早上好|下午好|晚上好|谢谢|多谢|感谢|thanks|thank you|ok|okay|好的|好吧|好|嗯+|行|可以|收到|再见|拜拜|bye)[呀啊呢吧哦]*[\s!！~～。.…，,]*$/iu;
const TOOL_CONFIRMATION =
  /^(?:继续|继续吧|go on|continue|yes|no|是|是的|否|对|对的|不对|确认|取消|approve|deny)[\s!！。.…]*$/iu;
const PURE_CALCULATION = /^[\d\s+\-*/×÷().=%^]+$/u;
const TIME_QUESTION =
  /^(?:现在几点|现在什么时间|今天几号|今天星期几|当前时间|what time is it|what's the time|what is the date|today's date)[\s?？。]*$/iu;
/** 密钥样式内容不进 query（会发往 Jev 云侧）：命中即整轮跳过检索。 */
const SECRET_LIKE =
  /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,}|(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._-]{8,})/iu;

/** 意图门：纯规则、不调模型（KB-7）。返回跳过原因；null = 需要检索。 */
export function knowledgeQuerySkipReason(query: string): string | null {
  if (!query) return "空输入";
  if (SECRET_LIKE.test(query)) return "输入含密钥样式内容，本轮不检索";
  if (GREETING.test(query)) return "寒暄/致谢";
  if (TOOL_CONFIRMATION.test(query)) return "纯确认输入";
  if (PURE_CALCULATION.test(query)) return "纯计算";
  if (TIME_QUESTION.test(query)) return "时间查询";
  return null;
}

function formatEvidence(item: KnowledgeEvidence, index: number): string {
  const heading = item.heading ? ` ${item.heading}` : "";
  const body = item.content ?? "（正文未返回，用 knowledge_read 按行号取原文）";
  // 绝对路径才可直接交给 knowledge_read 回溯原文；相对路径只作展示补充。
  return `[${index}] ${item.absolutePath}:${item.startLine}-${item.endLine}${heading}\n${body}`;
}

/** 结构化证据块 + 字符预算裁剪（KB-7）；超预算 stops 并标记。 */
export function buildKnowledgeEvidenceBlock(
  results: readonly KnowledgeEvidence[],
  maxChars: number,
  localMatch: boolean,
): string {
  const header = localMatch
    ? "以下是本轮本地匹配（-F，非 SAG2 语义检索）命中的证据，引用时标注路径与行号："
    : "以下是本轮自动检索到的本地知识库证据，回答时优先引用并标注路径与行号：";
  const parts: string[] = [];
  let used = header.length;
  let truncated = false;
  for (const [index, item] of results.entries()) {
    const part = formatEvidence(item, index + 1);
    if (used + part.length > maxChars) {
      if (parts.length === 0) {
        parts.push(part.slice(0, Math.max(0, maxChars - used)));
      }
      truncated = true;
      break;
    }
    parts.push(part);
    used += part.length + 2;
  }
  const tail = truncated
    ? "\n（证据超出预算已裁剪，可用 knowledge_search 深挖）"
    : "";
  return `<knowledge_evidence>\n${header}\n\n${parts.join("\n\n")}${tail}\n</knowledge_evidence>`;
}

function knowledgeStatusBlock(message: string): string {
  return `<knowledge_status>${message}</knowledge_status>`;
}

export interface KnowledgePreflightOutcome {
  /** ISO 时间；面板状态条用。 */
  at: string;
  outcome: "injected" | "no-evidence" | "skipped" | "failed";
  /** 给用户看的原因；不含凭据与堆栈。 */
  reason: string | null;
}

export interface KnowledgePreflightDeps {
  knowledge: KnowledgeService;
  readSettings: KnowledgeSettingsReader;
  /** 从 run 上下文解析真实工作目录（KB-3）；解析不出返回 undefined。 */
  resolveRoot: (payload: PreStepPayload) => Promise<string | undefined>;
  now?: () => number;
}

export interface KnowledgePreflightController {
  listener: WaterfallListener<"pre-step">;
  lastOutcome: () => KnowledgePreflightOutcome | null;
}

/** KB-3 接线：pre-step 的 instanceId+taskId → 执行作用域的 rootDirectory（只读）。 */
export function createRunRootResolver(
  persistence: PersistenceService | undefined,
): (payload: PreStepPayload) => Promise<string | undefined> {
  if (!persistence) return async () => undefined;
  const repository = createScopeRepository(persistence);
  return async (payload) => {
    if (!payload.instanceId || !payload.taskId) return undefined;
    const stored = await repository.load(payload.instanceId, payload.taskId);
    return stored?.scope.rootDirectory;
  };
}

function normalizeCacheQuery(query: string): string {
  return query.replace(/\s+/gu, " ").trim().toLowerCase();
}

export function createKnowledgePreflight(
  deps: KnowledgePreflightDeps,
): KnowledgePreflightController {
  const now = deps.now ?? Date.now;
  let last: KnowledgePreflightOutcome | null = null;
  const record = (
    outcome: KnowledgePreflightOutcome["outcome"],
    reason: string | null,
  ) => {
    last = { at: new Date(now()).toISOString(), outcome, reason };
  };

  interface CacheEntry {
    at: number;
    results: KnowledgeEvidence[];
  }
  const cache = new Map<string, CacheEntry>();
  // 内存护栏：缓存/去重集合是有损进程内加速，不是限额语义，不进治理表。
  const MAX_CACHE_ENTRIES = 512;
  const injectedRuns = new Set<string>();
  const ensuredRoots = new Map<
    string,
    { revision: number; result: KnowledgeEnsureResult }
  >();
  let inFlight = 0;

  const cacheGet = (key: string, ttlMs: number): CacheEntry | undefined => {
    if (ttlMs <= 0) return undefined;
    const at = now();
    for (const [k, entry] of cache) {
      if (at - entry.at > ttlMs) cache.delete(k);
    }
    return cache.get(key);
  };
  const cacheSet = (key: string, entry: CacheEntry, ttlMs: number) => {
    if (ttlMs <= 0) return;
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, entry);
  };

  const listener: WaterfallListener<"pre-step"> = async (payload, next) => {
    try {
      // ① 安装且启用才工作；未安装是正常态，零开销放行。
      const gate = await deps.knowledge.isActive();
      if (!gate.ok || typeof payload.input !== "string") return next(payload);
      const settings = await deps.readSettings(payload.instanceId);
      if (!settings.autoInject) {
        record("skipped", "自动注入已关闭");
        return next(payload);
      }
      // ② 意图门：寒暄/纯计算/时间/纯确认/密钥样式 → 不检索。
      const query = extractKnowledgeQuery(payload.input);
      const skipReason = knowledgeQuerySkipReason(query);
      if (skipReason) {
        record("skipped", skipReason);
        return next(payload);
      }
      // 每 run 最多一次自动检索（KB-7）：重复触发直接放行。
      if (payload.runId && injectedRuns.has(payload.runId))
        return next(payload);
      const markRun = () => {
        if (!payload.runId) return;
        if (injectedRuns.size >= MAX_CACHE_ENTRIES) {
          const oldest = injectedRuns.values().next().value;
          if (oldest !== undefined) injectedRuns.delete(oldest);
        }
        injectedRuns.add(payload.runId);
      };
      const root = await deps.resolveRoot(payload);
      // ③ 缓存：归一化 query + root + 根集合修订号 + 检索档（KB-7）。
      const cacheKey = `${normalizeCacheQuery(query)}\n${root ?? "*"}\n${deps.knowledge.rootsRevision()}\n${settings.localMatch ? "local" : "semantic"}`;
      const cached = cacheGet(cacheKey, settings.cacheTtlMs);
      if (cached) {
        markRun();
        if (cached.results.length < settings.minHits) {
          record("no-evidence", null);
          return next({
            ...payload,
            input: `${payload.input}\n\n${knowledgeStatusBlock("本轮未找到相关证据。")}`,
          });
        }
        record("injected", null);
        return next({
          ...payload,
          input: `${payload.input}\n\n${buildKnowledgeEvidenceBlock(cached.results, settings.evidenceMaxChars, settings.localMatch)}`,
        });
      }
      // ④ 并发上限：超出本轮跳过，不排队拖慢对话。
      if (inFlight >= settings.maxConcurrentSearches) {
        record("skipped", "检索并发已满，本轮跳过");
        return next(payload);
      }
      inFlight += 1;
      try {
        // ⑤ KB-3：首次检索按 run 真实工作目录幂等注册（成功才缓存）。
        if (root) {
          const revision = deps.knowledge.rootsRevision();
          let ensured = ensuredRoots.get(root);
          if (!ensured || ensured.revision !== revision) {
            const result = await deps.knowledge.ensureRoot(root);
            ensured = { revision: deps.knowledge.rootsRevision(), result };
            ensuredRoots.set(root, ensured);
          }
          const verdict = ensured.result;
          if (verdict.action === "rejected" || verdict.action === "deferred") {
            record("skipped", verdict.reason ?? "工作目录未就绪");
            return next({
              ...payload,
              input: `${payload.input}\n\n${knowledgeStatusBlock(`知识库未检索：${verdict.reason ?? "工作目录未就绪"}`)}`,
            });
          }
        }
        // ⑥ 检索（超时/本地匹配档经设置；signal 不在 payload 里，不臆造）。
        const result = await deps.knowledge.search({
          query,
          ...(root ? { path: root } : {}),
          maxResults: settings.maxResults,
          timeoutMs: settings.searchTimeoutMs,
          localMatch: settings.localMatch,
        });
        const deduped = dedupeKnowledgeEvidence(result.results);
        cacheSet(
          cacheKey,
          { at: now(), results: deduped },
          settings.cacheTtlMs,
        );
        markRun();
        // ⑦ 相关性门槛：命中不足不塞噪音，如实声明（KB-2）。
        if (deduped.length < settings.minHits) {
          record("no-evidence", null);
          return next({
            ...payload,
            input: `${payload.input}\n\n${knowledgeStatusBlock("本轮未找到相关证据。")}`,
          });
        }
        record("injected", null);
        return next({
          ...payload,
          input: `${payload.input}\n\n${buildKnowledgeEvidenceBlock(deduped, settings.evidenceMaxChars, settings.localMatch)}`,
        });
      } finally {
        inFlight -= 1;
      }
    } catch (error) {
      // KB-4：检索失败不阻断对话；显式状态块 + 放行，不假装检索过。
      const reason = readableFailure(error);
      record("failed", reason);
      if (typeof payload.input !== "string") return next(payload);
      return next({
        ...payload,
        input: `${payload.input}\n\n${knowledgeStatusBlock(`本轮知识库检索失败：${reason}`)}`,
      });
    }
  };

  return { listener, lastOutcome: () => last };
}
