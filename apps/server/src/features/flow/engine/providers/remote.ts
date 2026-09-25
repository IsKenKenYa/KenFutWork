import type {
  FlowEnginePath,
  ProviderInstanceResponse,
} from "@kenfutwork/shared";

/**
 * Provider C（兜底）：不本地承载，指向**自管的 Dify 地址**（《flow 集成方案》§3.5.1）。
 *
 * 与其他两条路径不同，这条不依赖本机运行时，而是复用 P3 凭证缝已有的载体：
 * 平台池（`scope='system'`）里启用的 `protocol='dify-engine'` 实例。于是「宿主下发引擎
 * 凭证」与「引擎承载路径探测」共用**同一处配置**——用户在管理后台配一次，两条链路都通。
 */
export async function probeRemotePath(deps: {
  listSystemInstances: () => Promise<ProviderInstanceResponse[]>;
}): Promise<FlowEnginePath> {
  const base = { id: "remote" as const, label: "指向自管地址" };

  const instances = await deps.listSystemInstances().catch(() => []);
  const candidate = instances.find(
    (instance) => instance.protocol === "dify-engine" && instance.enabled,
  );
  if (!candidate) {
    return {
      ...base,
      available: false,
      reason:
        "未配置自管 Dify 地址：在 管理后台 → 系统供应商 添加 protocol=dify-engine 的实例" +
        "（本地或内网地址均可，仍是本地执行口径）。",
    };
  }
  return {
    ...base,
    available: true,
    detail: candidate.baseUrl
      ? `平台池实例「${candidate.name}」（${candidate.baseUrl}）`
      : `平台池实例「${candidate.name}」（缺 base_url，下发时会被拒）`,
  };
}
