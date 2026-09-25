import {
  type FlowEnginePathId,
  type FlowHostEngineResponse,
  flowHostEngineResponseSchema,
} from "@kenfutwork/shared";

import type { RunCommand } from "./exec.js";
import { probeContainerPath } from "./providers/container.js";
import { probeRemotePath } from "./providers/remote.js";
import { probeWsl2Path } from "./providers/wsl2.js";

/**
 * 引擎承载路径探测（P6 探测层）——能力缝的 Consumer 侧聚合。
 *
 * 三条路径并行探测（互不阻塞：任一条挂住只影响它自己的超时），按**平台矩阵**给首选：
 * - Windows：WSL2 → 本机容器（§3.5.1 推荐 WSL2：免 Docker Desktop 商业授权约束、
 *   隔离边界更清晰、内存可设上限并可整体关停）；
 * - macOS / Linux：本机容器（macOS 的 Colima 等 Docker 兼容运行时也走这条）。
 *
 * Provider C（指向自管地址）**不参与「首选」竞争**：它是「不本地承载」的兜底，
 * 只在两条本地路径都不可用时才成为 recommended；本地路径可用时它照样如实报告自身可用性
 * （用户想用手里的远一点的自管实例，是他的选择）。
 *
 * 边界：本层只探测。**不做**安装、下载镜像或拉起容器——那些依赖方案 §9.1 的三个待定口径。
 */
export async function probeEnginePaths(deps: {
  platform: NodeJS.Platform;
  release: string;
  run: RunCommand;
  listSystemInstances: Parameters<
    typeof probeRemotePath
  >[0]["listSystemInstances"];
}): Promise<FlowHostEngineResponse> {
  const [wsl2, container, remote] = await Promise.all([
    probeWsl2Path(deps),
    probeContainerPath(deps),
    probeRemotePath({ listSystemInstances: deps.listSystemInstances }),
  ]);

  const paths = [wsl2, container, remote];
  const preferredOrder: readonly FlowEnginePathId[] =
    deps.platform === "win32" ? ["wsl2", "container"] : ["container"];
  const firstAvailable = (ids: readonly FlowEnginePathId[]) =>
    ids.find((id) => paths.find((path) => path.id === id)?.available);

  const recommended =
    firstAvailable(preferredOrder) ?? (remote.available ? "remote" : null);

  return flowHostEngineResponseSchema.parse({
    platform: deps.platform,
    paths,
    recommended: recommended ?? null,
  });
}
