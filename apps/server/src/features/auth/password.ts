import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * 口令哈希（M1.4 自管认证）。
 *
 * 用 Node 内置 `crypto.scrypt`：**不引入新依赖、不需要本机编译**——桌面捆绑形态要求
 * 「装完 exe 开箱即用」，bcrypt/argon2 这类原生模块会带来预编译二进制与 ABI 风险。
 *
 * 存储格式自描述：`scrypt$N$r$p$<salt-b64>$<hash-b64>`。参数写进哈希串后可平滑升级
 * （校验时用串里的参数，改默认参数只影响新口令，历史行不必迁移）。
 *
 * 校验用 `timingSafeEqual`（长度不等直接失败，避免抛错泄露长度信息）。
 */

/** `promisify(scrypt)` 的类型丢了 options 重载，这里显式声明实际用到的签名。 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; p: number; r: number },
) => Promise<Buffer>;

export const SCRYPT_PARAMS = { N: 16384, p: 1, r: 8 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export class PasswordHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordHashError";
  }
}

export async function hashPassword(
  password: string,
  params: { N?: number; p?: number; r?: number } = {},
): Promise<string> {
  if (password.length === 0) {
    throw new PasswordHashError("口令不得为空。");
  }

  const { N, p, r } = { ...SCRYPT_PARAMS, ...params };
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, { N, p, r });

  return [
    "scrypt",
    String(N),
    String(r),
    String(p),
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) {
    return false;
  }

  const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, {
    N: parsed.N,
    p: parsed.p,
    r: parsed.r,
  });

  if (derived.length !== parsed.hash.length) {
    return false;
  }
  return timingSafeEqual(derived, parsed.hash);
}

function parseStoredHash(stored: string): {
  hash: Buffer;
  N: number;
  p: number;
  r: number;
  salt: Buffer;
} | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return null;
  }

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);

  // 参数必须是有界的正整数：避免被构造出的哈希串拖成天价计算（DoS）
  if (
    !Number.isInteger(N) ||
    N < 2 ||
    N > 1 << 20 ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 32 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 16
  ) {
    return null;
  }

  const salt = Buffer.from(saltRaw, "base64");
  const hash = Buffer.from(hashRaw, "base64");
  if (salt.length === 0 || hash.length === 0) {
    return null;
  }

  return { hash, N, p, r, salt };
}

/** 会话令牌明文（只在签发响应里出现一次）；库里只存它的 SHA-256。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
