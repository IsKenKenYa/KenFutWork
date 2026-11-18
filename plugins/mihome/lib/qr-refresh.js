/**
 * 扫码登录的刷新判定（纯函数，便于单测）。
 *
 * 为什么要自动刷新：小米二维码有有效期（`timeout`，通常 120 秒），用户在面板里看一眼消息、
 * 回头再扫就已经过期了——此前只能手动点「获取二维码」，真机实测被打回。
 * 口径：过期就自动换一张新码并继续轮询；但**不能无限换**（面板可能长期开着），
 * 连续换到上限后停下来给一句可读提示，把决定权交回用户。
 */

/** 自动刷新次数上限（每次约 2 分钟，20 次 ≈ 40 分钟）。 */
export const MAX_AUTO_REFRESHES = 20;

/**
 * @param {object} input
 * @param {number} input.now 当前时间戳（毫秒）
 * @param {number} input.deadline 当前二维码的过期时刻
 * @param {string} input.status 上一次轮询结果（`pending` / `expired` / `ok`）
 * @param {number} input.autoRefreshes 已自动刷新的次数
 * @returns {"scanned" | "poll" | "refresh" | "give-up"}
 */
export function decideQrAction({ now, deadline, status, autoRefreshes }) {
  if (status === "ok") return "scanned";
  if (status === "expired" || now >= deadline) {
    return autoRefreshes >= MAX_AUTO_REFRESHES ? "give-up" : "refresh";
  }
  return "poll";
}
