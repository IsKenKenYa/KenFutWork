import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * SecretStore（DEC-7）：服务端加密落库的凭证存取。
 * 红线：encrypt 一次性写入；decrypt 仅在实例化协议适配器时内部调用，永不回传前端、不落日志。
 * 密钥来自 KENFUTWORK_CREDENTIAL_SECRET（scrypt 派生 AES-256-GCM key）；缺失即 fail loud。
 */

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
/** 密文格式：v1:<iv b64>:<tag b64>:<ciphertext b64>，算法轮换留版本位。 */
const VERSION_PREFIX = "v1:";

/**
 * scrypt 的盐是**派生键的一部分**，改名就等于换钥匙：品牌统一时把盐从
 * `loomic:credential-store:v1` 改成 `kenfutwork:…` 后，库里既有密文全部解不开
 * （实测：所有 run 直接 500「认证失败」）。
 *
 * 因此新盐写入、**旧盐只读兜底**——老密文继续可解，用户重新保存一次即迁移到新盐。
 */
const CREDENTIAL_SALT = "kenfutwork:credential-store:v1";
const LEGACY_CREDENTIAL_SALT = "loomic:credential-store:v1";

const cachedKeys: Record<"primary" | "legacy", Buffer | undefined> = {
  primary: undefined,
  legacy: undefined,
};

/** 只依赖凭证密钥字段，避免与完整 ServerEnv 耦合。 */
interface CredentialEnv {
  credentialSecret?: string;
}

function getCredentialKey(env: CredentialEnv): Buffer {
  const secret = env.credentialSecret;
  if (!secret) {
    throw new Error(
      "[secret-store] KENFUTWORK_CREDENTIAL_SECRET 未配置，拒绝加解密用户凭证（fail loud）。",
    );
  }
  cachedKeys.primary ??= scryptSync(secret, CREDENTIAL_SALT, KEY_LENGTH);
  return cachedKeys.primary;
}

/** 旧盐派生键（只读兜底；解不开新盐的密文时再试它）。 */
function getLegacyCredentialKey(env: CredentialEnv): Buffer | null {
  const secret = env.credentialSecret;
  if (!secret) return null;
  cachedKeys.legacy ??= scryptSync(secret, LEGACY_CREDENTIAL_SALT, KEY_LENGTH);
  return cachedKeys.legacy;
}

export function encryptSecret(env: CredentialEnv, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getCredentialKey(env), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${VERSION_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(env: CredentialEnv, stored: string): string {
  if (!stored.startsWith(VERSION_PREFIX)) {
    throw new Error("[secret-store] 凭证密文版本无法识别（fail loud）。");
  }
  const [ivB64, tagB64, dataB64] = stored
    .slice(VERSION_PREFIX.length)
    .split(":");
  // 空明文是合法值（GCM 密文尾段为空串），只有 iv/tag 缺失或尾段不存在才是格式错误。
  // 早前用 `!dataB64` 判定，导致 `encryptSecret(env, "")` 写出的密文**读不回来**
  // （写入成功、读取报「格式非法」）——静默数据损坏，插件存储把它暴露了出来。
  if (!ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error("[secret-store] 凭证密文格式非法（fail loud）。");
  }
  const tryDecrypt = (key: Buffer): string => {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  };

  try {
    return tryDecrypt(getCredentialKey(env));
  } catch (error) {
    // 品牌统一前落库的密文用旧盐派生键：解不开新盐时兜底再试（GCM 认证失败即抛）
    const legacyKey = getLegacyCredentialKey(env);
    if (legacyKey) {
      try {
        return tryDecrypt(legacyKey);
      } catch {
        // 落到下面统一报错
      }
    }
    throw error;
  }
}

/** 日志脱敏：任何携带 key 的对象进日志前统一走这里。 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return "***";
  }
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
}
