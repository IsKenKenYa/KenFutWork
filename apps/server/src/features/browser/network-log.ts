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
}

export interface NetworkBuffer {
  /** 请求发出（`requestId` 是 CDP 的请求标识，后续事件用它回填状态）。 */
  started(requestId: string, entry: Omit<NetworkRequest, "seq">): void;
  /** 收到响应（补状态码）。 */
  responded(requestId: string, status: number): void;
  /** 失败（补原因）。 */
  failed(requestId: string, reason: string): void;
  /** 取 `seq > since` 的请求（最多 `limit` 条）。 */
  since(seq: number, limit?: number): NetworkRequest[];
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
    responded(requestId, status) {
      const entry = find(requestId);
      if (entry) entry.status = status;
    },
    failed(requestId, reason) {
      const entry = find(requestId);
      if (entry) entry.failed = reason;
    },
    since(from, take = 200) {
      return items
        .map((item) => item.entry)
        .filter((entry) => entry.seq > from)
        .slice(0, take);
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
