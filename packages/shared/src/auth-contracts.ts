import { z } from "zod";

/**
 * 自管认证的 HTTP 契约（M1.4）。
 *
 * 这是**我们自己的**令牌语义（不透明会话令牌），不复刻 Supabase 的
 * `access_token`/`refresh_token` 形状——前端适配层负责转换，避免把某家 IdP 的
 * 字段名固化进跨端契约。
 */

export const authRegisterRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});
export type AuthRegisterRequest = z.infer<typeof authRegisterRequestSchema>;

export const authLoginRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});
export type AuthLoginRequest = z.infer<typeof authLoginRequestSchema>;

export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  displayName: z.string().nullable(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** 会话签发响应；`token` 是明文令牌，**只在签发这一次出现**（库里只存哈希）。 */
export const authSessionResponseSchema = z.object({
  session: z.object({
    expiresAt: z.iso.datetime({ offset: true }),
    token: z.string().min(1),
  }),
  user: authUserSchema,
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

export const authErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum([
      "invalid_credentials",
      "email_taken",
      "invalid_input",
      "auth_unavailable",
    ]),
    message: z.string().min(1),
  }),
});
export type AuthErrorResponse = z.infer<typeof authErrorResponseSchema>;
