import { MODELS_DEV_SNAPSHOT } from "./models-dev.snapshot.js";
import {
  type ModelsDevSnapshot,
  parseSnapshotArtifact,
} from "./models-dev-snapshot.js";

/**
 * 读取打进包内的快照（.ts 数据模块，dev/tsx/tsc/SEA 各形态零加载器差异）。
 * 独立于管线模块（models-dev-snapshot.ts）：刷新脚本要 import 管线本身，
 * 管线不得反向依赖生成物（否则首次生成前脚本无法运行）。
 * 结构漂移（上游 schema 变更而未刷新）fail-open 为 undefined——快照非权威，
 * 缺席只降级为「无 hints」，不阻断目录服务。
 */
export function loadBundledModelsDevSnapshot(): ModelsDevSnapshot | undefined {
  return parseSnapshotArtifact(MODELS_DEV_SNAPSHOT);
}
