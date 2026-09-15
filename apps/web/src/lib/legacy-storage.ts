/**
 * 品牌统一（Loomic → KenFutWork）后的**本地存储迁移**。
 *
 * 浏览器里存过的偏好/会话令牌用的是旧前缀（`loomic.*` / `loomic:`）。这里在首次读取
 * 前把旧键搬到新键，幂等且只跑一次——否则用户会被静默登出、偏好也会「重置」
 * （实测教训：清 token 等于被踢到登录页）。
 */

const LEGACY_PREFIXES = ["loomic.", "loomic:"];
const NEXT_PREFIX = "kenfutwork";

let migrated = false;

/** 把 `loomic.*` / `loomic:` 键搬到 `kenfutwork.*` / `kenfutwork:`（新键已存在则不覆盖）。 */
export function migrateLegacyStorageKeys(): void {
  if (migrated || typeof window === "undefined") return;
  migrated = true;
  try {
    const moves: Array<[string, string]> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        continue;
      }
      const nextKey = `${NEXT_PREFIX}${key.slice("loomic".length)}`;
      if (window.localStorage.getItem(nextKey) === null) {
        moves.push([key, nextKey]);
      }
    }
    for (const [legacyKey, nextKey] of moves) {
      const value = window.localStorage.getItem(legacyKey);
      if (value !== null) {
        window.localStorage.setItem(nextKey, value);
      }
      window.localStorage.removeItem(legacyKey);
    }
  } catch {
    // 存储不可用（隐私模式等）：不影响使用
  }
}
