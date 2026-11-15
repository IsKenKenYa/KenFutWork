import { Runnable, RunnableBinding } from "@langchain/core/runnables";
import type { AgentMiddleware } from "langchain";
import type {
  AgentEventIdentity,
  AgentRunExtension,
  AgentRunExtensionContext,
} from "./run-extension.js";

/** 仅绑定调用观察者；请求内容、模型设置和原有回调均由 SDK 继续处理。 */
export function createModelObservationMiddleware(
  extensions: readonly AgentRunExtension[],
  identity: AgentEventIdentity,
  context?: AgentRunExtensionContext,
): AgentMiddleware[] {
  const callbacks = extensions.flatMap(
    (extension) => extension.createModelCallbacks?.(identity, context) ?? [],
  );
  if (!callbacks.length) return [];
  return [
    {
      name: "KenFutWorkModelObservation",
      wrapModelCall(request, handler) {
        if (!Runnable.isRunnable(request.model))
          throw new Error("模型不支持请求观察，请检查模型适配器。");
        return handler({
          ...request,
          model: new RunnableBinding({
            bound: request.model,
            config: { callbacks },
          }),
        });
      },
    },
  ];
}
