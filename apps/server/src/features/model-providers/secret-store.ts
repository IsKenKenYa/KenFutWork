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

let cachedKey: Buffer | undefined;

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
  cachedKey ??= scryptSync(secret, "kenfutwork:credential-store:v1", KEY_LENGTH);
  return cachedKey;
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
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("[secret-store] 凭证密文格式非法（fail loud）。");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    getCredentialKey(env),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** 日志脱敏：任何携带 key 的对象进日志前统一走这里。 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return "***";
  }
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
}
