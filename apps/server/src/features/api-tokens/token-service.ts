import { randomBytes } from "node:crypto";

import type { AuthenticatedUser } from "../auth/types.js";
import {
  type ApiTokenRecord,
  type ApiTokenRepository,
  apiTokenPrefix,
  hashApiToken,
} from "./repository.js";

/**
 * 外部应用访问令牌的服务面（R5-2「外部应用授权」）。
 *
 * 用途：外部应用 / 脚本 / CI 拿令牌调本服务的 HTTP API，权限与登录会话同源
 * （同一个工作区隔离）。四条红线见迁移注释，这里负责其中三条：
 * 明文只回一次、吊销即时生效、**令牌不能签发令牌**。
 */

export const API_TOKEN_PREFIX = "kfw_";
/** 令牌长度：`kfw_` + 43 位 base64url（32 字节随机）。 */
const TOKEN_BYTES = 32;
const MAX_NAME_CHARS = 60;

export class ApiTokenError extends Error {
  readonly code: "invalid_input" | "not_found";
  readonly statusCode: number;
  constructor(
    code: ApiTokenError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "ApiTokenError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ApiTokenService {
  /** 创建：返回**一次性明文**（库里只有 sha256）。 */
  create(
    user: AuthenticatedUser,
    workspaceId: string,
    name: string,
  ): Promise<{ token: string; record: ApiTokenRecord }>;
  list(workspaceId: string): Promise<ApiTokenRecord[]>;
  revoke(
    user: AuthenticatedUser,
    workspaceId: string,
    id: string,
  ): Promise<void>;
  /**
   * 用请求头里的令牌换登录身份（认证缝的第二条路径）。
   * 认不出/已吊销返回 null——与「没有令牌」同一口径，不给枚举信号。
   */
  resolveUser(header: string | undefined): Promise<AuthenticatedUser | null>;
}

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** 只认 `Bearer <token>`，且令牌必须带我们的前缀（避免拿会话令牌误走这条路径）。 */
export function parseApiTokenHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (!token?.startsWith(API_TOKEN_PREFIX)) return null;
  return token;
}

export function createApiTokenService(options: {
  repository: ApiTokenRepository;
}): ApiTokenService {
  const { repository } = options;

  return {
    async create(user, workspaceId, name) {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new ApiTokenError(
          "invalid_input",
          "给令牌起个名字（便于日后辨认）。",
          400,
        );
      }
      if (trimmed.length > MAX_NAME_CHARS) {
        throw new ApiTokenError(
          "invalid_input",
          `名字最长 ${MAX_NAME_CHARS} 个字符。`,
          400,
        );
      }
      const token = generateApiToken();
      const record = await repository.create({
        workspaceId,
        userId: user.id,
        name: trimmed,
        tokenHash: hashApiToken(token),
        tokenPrefix: apiTokenPrefix(token),
      });
      return { token, record };
    },

    list(workspaceId) {
      return repository.list(workspaceId);
    },

    /** `user` 目前只用于签名一致（隔离靠工作区谓词 + id）；保留参数以免调用方各写一套。 */
    async revoke(_user, workspaceId, id) {
      const removed = await repository.revoke(workspaceId, id);
      if (!removed) {
        throw new ApiTokenError(
          "not_found",
          "这把令牌不存在，或已经吊销过了。",
          404,
        );
      }
    },

    async resolveUser(header) {
      const token = parseApiTokenHeader(header);
      if (!token) return null;
      const account = await repository
        .findAccountByTokenHash(hashApiToken(token))
        .catch(() => null);
      if (!account) return null;
      /**
       * 不做额外的常数时间比较：校验走的是**哈希查索引**（数据库按 token_hash 命中），
       * 明文从不参与比较，也就没有「逐字符比较」那种时间差来源。
       */
      return {
        accessToken: token,
        email: account.email,
        id: account.userId,
        userMetadata: account.userMetaData,
      };
    },
  };
}
