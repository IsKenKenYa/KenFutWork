/**
 * 面板里采集到的**网络请求**（开发者工具 Network 面板的数据面）。
 *
 * 与 console-log 同一套路：把 CDP 的 Network 域事件折成可上屏/可给 agent 读的一条条记录，
 * 环形缓冲按 seq 增量取。agent 靠它判断「我点的那个按钮有没有真的发出请求、回来的状态码是多少」——
 * 这是调试网页最常要的两样数据之一（另一样是控制台）。
 *
 * 一条请求会经历多个事件（发出 → 响应 → 失败/完成），所以记录按 `requestId` **就地更新**：
 * seq 在「发出」时分配一次，之后状态码/失败原因补在同一条上，客户端的增量游标因此不会错位。
 */

export interface NetworkRequest {
  /** 单调递增（在「发出」时分配，后续事件不改它）。 */
  seq: number;
  method: string;
  url: string;
  /** 资源类型（document / script / xhr / fetch / image…）。 */
  type?: string;
  /** HTTP 状态码（还没回来就没有）。 */
  status?: number;
  /** 失败原因（DNS/连接被拒/被拦/CORS…）。 */
  failed?: string;
  /** 发起时间（ISO）。 */
  at: string;
  /** 响应 MIME（来自 responseReceived；判断「回来的是什么」用）。 */
  mimeType?: string;
  /** 请求体（postData，文本类才有；超过上限按上限截断并标 `…`）。 */
  requestBody?: string;
  /** 响应体（loadingFinished 后按需取回；文本类且体积在上限内才采，截断同上）。 */
  responseBody?: string;
  /** 耗时（发出 → 完成，毫秒；还没完成就没有）。 */
  durationMs?: number;
}

/**
 * 单个请求/响应体的采集上限（字节口径，按 UTF-16 字符数近似）。
 * 采集是有隐私面的（表单内容、令牌可能出现在 body 里），上限同时是「够调试」与
 * 「别把 agent 的结果撑爆」的折中；超大响应（> {@link RESPONSE_BODY_MAX_BYTES}）
 * 直接不取体，只留状态与耗时。
 */
export const NETWORK_BODY_LIMIT_CHARS = 8_192;
/** 超过这个响应体积就不取响应体（避免为一个几 MB 的文件把内存与结果都拖垮）。 */
export const RESPONSE_BODY_MAX_BYTES = 512 * 1024;

/** 文本类 MIME（只有这类取响应体有意义；二进制取回来只是乱码）。 */
export function isTextMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql)|[^;]*[+/](json|xml))/i.test(
    mime,
  );
}

/** 按上限截断文本（超限补 `…`，告诉读者「这不是全文」）。 */
export function capBody(
  text: string,
  limit = NETWORK_BODY_LIMIT_CHARS,
): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export interface NetworkBuffer {
  /** 请求发出（`requestId` 是 CDP 的请求标识，后续事件用它回填状态）。 */
  started(requestId: string, entry: Omit<NetworkRequest, "seq">): void;
  /** 收到响应（补状态码与 MIME）。 */
  responded(
    requestId: string,
    status: number,
    options?: { mimeType?: string },
  ): void;
  /** 失败（补原因）。 */
  failed(requestId: string, reason: string): void;
  /** 完成（补耗时；响应体已取到就一并补上）。 */
  finished(requestId: string, durationMs: number, responseBody?: string): void;
  /** 取 `seq > since` 的请求（最多 `limit` 条）。 */
  since(seq: number, limit?: number): NetworkRequest[];
  /** 按 CDP 的 requestId 取当前记录（取响应体前查 MIME/体积用）。 */
  get(requestId: string): NetworkRequest | undefined;
  latestSeq(): number;
  clear(): void;
  size(): number;
}

export function createNetworkBuffer(limit = 200): NetworkBuffer {
  /** 内部条目带 requestId（对外只给 NetworkRequest，不暴露 CDP 的内部标识）。 */
  const items: Array<{ requestId: string; entry: NetworkRequest }> = [];
  /** requestId → items 下标（就地更新用）。 */
  const index = new Map<string, number>();
  let seq = 0;

  /** 丢过最旧的之后下标会整体前移：重建一次索引（只在满员时才走）。 */
  const reindex = () => {
    index.clear();
    items.forEach((item, position) => {
      index.set(item.requestId, position);
    });
  };

  const find = (requestId: string): NetworkRequest | undefined =>
    items[index.get(requestId) ?? -1]?.entry;

  return {
    started(requestId, entry) {
      seq += 1;
      items.push({ requestId, entry: { ...entry, seq } });
      if (items.length > limit) {
        items.splice(0, items.length - limit);
        reindex();
        return;
      }
      index.set(requestId, items.length - 1);
    },
    responded(requestId, status, options) {
      const entry = find(requestId);
      if (!entry) return;
      entry.status = status;
      if (options?.mimeType) entry.mimeType = options.mimeType;
    },
    failed(requestId, reason) {
      const entry = find(requestId);
      if (entry) entry.failed = reason;
    },
    finished(requestId, durationMs, responseBody) {
      const entry = find(requestId);
      if (!entry) return;
      entry.durationMs = durationMs;
      if (responseBody !== undefined) entry.responseBody = responseBody;
    },
    since(from, take = 200) {
      return items
        .map((item) => item.entry)
        .filter((entry) => entry.seq > from)
        .slice(0, take);
    },
    get(requestId) {
      return find(requestId);
    },
    latestSeq() {
      return seq;
    },
    clear() {
      items.length = 0;
      index.clear();
    },
    size() {
      return items.length;
    },
  };
}

/**
 * 请求 URL 折短给**人看**用（agent 那边给全量 URL）。
 *
 * 只留 origin + path，query 太长时截断——控制台/日志一行显示得下才有人看。
 */
export function shortenUrl(url: string, maxLength = 120): string {
  const withoutQuery = url.split("?")[0] ?? url;
  return withoutQuery.length > maxLength
    ? `${withoutQuery.slice(0, maxLength)}…`
    : withoutQuery;
}

/** 一条请求折成一行（给 agent 与日志用）。 */
export function formatRequest(entry: NetworkRequest): string {
  const status = entry.failed
    ? `失败：${entry.failed}`
    : entry.status === undefined
      ? "进行中"
      : String(entry.status);
  return `${entry.method} ${entry.url} → ${status}${entry.type ? ` (${entry.type})` : ""}`;
}
