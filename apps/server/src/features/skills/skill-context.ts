import type { ToolExecutionContext } from "../../kernel/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";

/** 只接受运行时签发的 Actor；模型参数、令牌与客户端字段不能生成工具身份。 */
export async function resolveSkillActor(
  localInstance: LocalInstanceService,
  context: ToolExecutionContext,
): Promise<LocalActor> {
  const actor = context.actor;
  if (!actor) throw new Error("技能工具缺少可信本地调用上下文。");
  if (
    actor.instanceId !== context.instanceId ||
    (context.scopeHandle &&
      context.scopeHandle.describe().instanceId !== actor.instanceId)
  )
    throw new Error("技能实例与可信 Task 工作域不匹配。");
  await localInstance.resolve(actor);
  return actor;
}
