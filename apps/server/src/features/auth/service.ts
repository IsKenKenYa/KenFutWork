import type { FastifyRequest } from "fastify";

import type { AuthenticatedUser } from "../../supabase/user.js";
import {
  generateSessionToken,
  hashPassword,
  verifyPassword,
} from "./password.js";
import {
  type AccountRepository,
  EmailTakenError,
  hashSessionToken,
  SESSION_TTL_SECONDS,
} from "./repository.js";

/**
 * 自管认证服务（M1.4）：邮箱 + 口令注册/登录，签发**不透明会话令牌**。
 *
 * 与 Supabase Auth 的差别（有意为之）：不签发 JWT——令牌是随机串，服务端查
 * `account_sessions` 校验。好处是**可即时吊销**（登出/过期即失效），且不引入 JWT 密钥
 * 轮换与时钟偏移问题；代价是每次请求一次库查询（已用 `findSessionByTokenHash` 的
 * 单语句 touch + 返回，避免额外往返；会话量大时再加进程内缓存）。
 */

export class AuthError extends Error {
  readonly code:
    | "invalid_credentials"
    | "email_taken"
    | "invalid_input"
    | "auth_unavailable";
  readonly statusCode: number;

  constructor(code: AuthError["code"], message: string, statusCode: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type AuthSession = {
  expiresAt: string;
  token: string;
  user: AuthenticatedUser;
};

export type AuthService = {
  register(input: {
    displayName?: string | undefined;
    email: string;
    password: string;
  }): Promise<AuthSession>;
  login(input: { email: string; password: string }): Promise<AuthSession>;
  logout(token: string): Promise<void>;
  /** 从请求头解析当前用户；无效/过期返回 null（不抛错，路由据此回 401）。 */
  resolveRequestUser(
    request: Pick<FastifyRequest, "headers">,
  ): Promise<AuthenticatedUser | null>;
  /** 校验令牌并返回会话信息（`GET /api/auth/session` 用）。 */
  resolveSession(token: string): Promise<AuthenticatedUser | null>;
};

const MIN_PASSWORD_LENGTH = 8;

export function createAuthService(options: {
  repository: AccountRepository;
  sessionTtlSeconds?: number;
}): AuthService {
  const ttl = options.sessionTtlSeconds ?? SESSION_TTL_SECONDS;

  const issueSession = async (account: {
    displayName: string | null;
    email: string;
    id: string;
  }): Promise<AuthSession> => {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await options.repository.createSession({
      expiresAt,
      tokenHash: hashSessionToken(token),
      userId: account.id,
    });

    return {
      expiresAt: expiresAt.toISOString(),
      token,
      user: {
        accessToken: token,
        email: account.email,
        id: account.id,
        userMetadata: account.displayName
          ? { display_name: account.displayName }
          : {},
      },
    };
  };

  const userFromSession = (
    session: {
      email: string;
      raw_user_meta_data: Record<string, unknown> | null;
      user_id: string;
    },
    token: string,
  ): AuthenticatedUser => ({
    accessToken: token,
    email: session.email,
    id: session.user_id,
    userMetadata: session.raw_user_meta_data ?? {},
  });

  const requireEmail = (email: string): string => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@")) {
      throw new AuthError("invalid_input", "邮箱格式不正确。", 400);
    }
    return trimmed;
  };

  return {
    async register(input) {
      const email = requireEmail(input.email);
      if (input.password.length < MIN_PASSWORD_LENGTH) {
        throw new AuthError(
          "invalid_input",
          `口令至少 ${MIN_PASSWORD_LENGTH} 位。`,
          400,
        );
      }

      const passwordHash = await hashPassword(input.password);
      const displayName = input.displayName?.trim() || null;

      let userId: string;
      try {
        userId = await options.repository.createAccount({
          displayName,
          email,
          passwordHash,
        });
      } catch (error) {
        if (error instanceof EmailTakenError) {
          throw new AuthError("email_taken", error.message, 409);
        }
        throw new AuthError(
          "auth_unavailable",
          `注册失败：${error instanceof Error ? error.message : String(error)}`,
          500,
        );
      }

      return issueSession({ displayName, email, id: userId });
    },

    async login(input) {
      const email = requireEmail(input.email);
      const account = await options.repository
        .findAccountByEmail(email)
        .catch((error: unknown) => {
          throw new AuthError(
            "auth_unavailable",
            `登录失败：${error instanceof Error ? error.message : String(error)}`,
            500,
          );
        });

      // 账号不存在与口令错误返回**同一个错误**：不给账号枚举留信号
      const ok = account
        ? await verifyPassword(input.password, account.password_hash)
        : false;
      if (!account || !ok) {
        throw new AuthError("invalid_credentials", "邮箱或口令不正确。", 401);
      }

      return issueSession({
        displayName: account.display_name,
        email: account.email,
        id: account.user_id,
      });
    },

    async logout(token) {
      await options.repository.deleteSession(hashSessionToken(token));
    },

    async resolveSession(token) {
      if (!token) {
        return null;
      }
      const session = await options.repository
        .findSessionByTokenHash(hashSessionToken(token))
        .catch(() => null);
      return session ? userFromSession(session, token) : null;
    },

    async resolveRequestUser(request) {
      const header = request.headers.authorization;
      const token = parseBearerToken(
        typeof header === "string" ? header : undefined,
      );
      return token ? this.resolveSession(token) : null;
    },
  };
}

/** 从 `Authorization: Bearer <token>` 取令牌；缺失或格式不对返回 null。 */
export function parseBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  return matched?.[1]?.trim() || null;
}
