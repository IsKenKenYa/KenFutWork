import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalInstanceService } from "../features/local-instance/service.js";
import type { LocalActor } from "../features/local-instance/types.js";

export const RUNTIME_TEST_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
export const RUNTIME_TEST_ACTOR: LocalActor = Object.freeze({
  instanceId: RUNTIME_TEST_INSTANCE_ID,
  accessClientId: "00000000-0000-4000-8000-000000000009",
});

/** 使用真实实例服务验证归属；只替换数据库singleton与测试数据目录。 */
export function createRuntimeTestInstance(
  instanceId = RUNTIME_TEST_INSTANCE_ID,
) {
  return createLocalInstanceService({
    repository: { ensure: async () => instanceId },
    dataDir: join(tmpdir(), `kfw-runtime-${instanceId}`),
  });
}
