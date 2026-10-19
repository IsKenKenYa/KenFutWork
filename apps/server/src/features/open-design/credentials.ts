import type { OpenDesignHostCredentialEntry } from "@kenfutwork/shared";
import { OPEN_DESIGN_EMBED_PROTOCOL_VERSION } from "@kenfutwork/shared";

/**
 * OpenDesign 凭证下发（O3 / `OD-4`）的取值逻辑。
 *
 * 目标：把本仓 BYOK 实例（启用且有 Key 的）整理成 OpenDesign daemon 能直接喂给
 * coding-agent CLI 的清单。daemon 支持 25+ CLI、DeepSeek Harness 一等原生——宿主不做
 * 「哪个 CLI 配哪个实例」的匹配（那是 daemon 的内部策略），只保证：
 * 1. 只放行**启用且有 Key** 的实例（停用的、没配 Key 的不出现）；
 * 2. 每个 Key 都**真实取到**才下发——取不到就 409 fail loud，不悄悄少给一条
 *    （否则 daemon 会拿着半个配置去跑，失败原因离现场更远）；
 * 3. 报错消息**绝不含 Key 明文**（脱敏红线）：消息只提实例名，Key 的值一个字都不进。
 *
 * `instances` / `readKey` 由调用方注入（HTTP 层接 ModelProviderService，测试接假数据），
 * 本文件不碰数据库与网络。
 */

/** 解析结果：成功给清单；失败给 HTTP 状态码 + 可读原因（无 Key 明文）。 */
export type OpenDesignCredentialsResolution =
  | { ok: true; entries: OpenDesignHostCredentialEntry[] }
  | { ok: false; status: 404 | 409; message: string };

/** 实例候选的最小形状（`ProviderInstanceResponse` 的子集，测试可手搓）。 */
export interface OpenDesignCredentialCandidate {
  id: string;
  name: string;
  protocol: string;
  baseUrl?: string | undefined;
  enabled: boolean;
  hasCredential: boolean;
}

/** 归一化基址：去首尾空白与尾斜杠；空串按未配置处理（返回 null）。 */
function normalizeApiBase(baseUrl: string | undefined): string | null {
  const trimmed = baseUrl?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

/** 版式核对：缺省按当前版本受理；显式带了别的版本 → 拒（400 由路由层映射）。 */
export function resolveOpenDesignProtocolVersion(
  requested: string | undefined,
): { ok: true; version: string } | { ok: false } {
  if (requested === undefined) {
    return { ok: true, version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION };
  }
  if (requested !== OPEN_DESIGN_EMBED_PROTOCOL_VERSION) return { ok: false };
  return { ok: true, version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION };
}

/**
 * 从宿主服务取「可下发给 OpenDesign 的凭证清单」——HTTP 路由与启动期自动配置共用这一份，
 * 避免两处各写一遍实例过滤与 Key 读取（脱敏口径也必须一致）。
 */
export async function resolveOpenDesignCredentialEntries<Actor>(input: {
  providers:
    | {
        listInstances: (
          actor: Actor,
        ) => Promise<OpenDesignCredentialCandidate[]>;
        resolveCredentialsById: (
          providerId: string,
        ) => Promise<{ apiKey?: string | null } | null | undefined>;
      }
    | undefined;
  serviceActor: () => Promise<Actor>;
}): Promise<OpenDesignCredentialsResolution> {
  if (!input.providers) {
    return {
      ok: false,
      status: 404,
      message: "供应商服务未就绪，OpenDesign 暂时拿不到 BYOK 配置。",
    };
  }
  const providers = input.providers;
  const actor = await input.serviceActor();
  return resolveOpenDesignCredentials({
    instances: await providers.listInstances(actor),
    readKey: async (providerId) => {
      try {
        const credentials = await providers.resolveCredentialsById(providerId);
        return credentials?.apiKey ?? null;
      } catch {
        // 服务层的错误消息不排除未来变动会带敏感片段——统一按「读不到」处理，
        // 由解析器产出只含实例名的可读原因（脱敏红线）。
        return null;
      }
    },
  });
}

/**
 * 解析下发给 OpenDesign 的凭证清单。
 *
 * @param instances 本地实例列表（已按当前实例作用域取好）。
 * @param readKey 按实例 id 读 BYOK Key；null = 凭据文件里没有（如被外部清掉）。
 */
export async function resolveOpenDesignCredentials(input: {
  instances: OpenDesignCredentialCandidate[];
  readKey: (providerId: string) => Promise<string | null>;
}): Promise<OpenDesignCredentialsResolution> {
  const candidates = input.instances.filter(
    (instance) => instance.enabled && instance.hasCredential,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      status: 404,
      message:
        "未找到已配置 API Key 的供应商实例：请先在供应商设置中为至少一个实例配置 Key。",
    };
  }

  const entries: OpenDesignHostCredentialEntry[] = [];
  for (const instance of candidates) {
    // 先校验地址再读 Key：地址挂了他俩都是配置问题，但地址不用碰凭据文件。
    const apiBase = normalizeApiBase(instance.baseUrl);
    if (apiBase !== null && !/^https?:\/\//u.test(apiBase)) {
      return {
        ok: false,
        status: 409,
        message: `供应商实例「${instance.name}」的地址不是有效的 http(s) 地址，请检查本地供应商设置。`,
      };
    }
    const apiKey = await input.readKey(instance.id);
    if (apiKey === null || apiKey === "") {
      // 只提实例名——Key 的值（哪怕读失败的原因里带）一律不进消息。
      return {
        ok: false,
        status: 409,
        message: `供应商实例「${instance.name}」的 API Key 读取失败，请检查本地凭据文件后重试。`,
      };
    }
    entries.push({
      providerId: instance.id,
      name: instance.name,
      protocol: instance.protocol,
      apiBase,
      apiKey,
    });
  }

  return { ok: true, entries };
}
