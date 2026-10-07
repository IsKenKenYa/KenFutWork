import type { ToolExecutionContext } from "../../kernel/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";

/** 画布资源不签发调用身份；Actor 必须来自真实运行时。 */
export async function resolveCanvasActor(
  instance: LocalInstanceService,
  context: ToolExecutionContext,
): Promise<LocalActor> {
  const actor = context.actor;
  if (!actor) throw new Error("画布工具缺少可信本地调用上下文。");
  if (
    actor.instanceId !== context.instanceId ||
    (context.scopeHandle &&
      context.scopeHandle.describe().instanceId !== actor.instanceId)
  )
    throw new Error("画布实例与可信 Task 工作域不匹配。");
  await instance.resolve(actor);
  return actor;
}
