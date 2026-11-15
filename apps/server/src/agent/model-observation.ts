import type { ModelCallPurpose } from "@kenfutwork/shared";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  ensureConfig,
  mergeConfigs,
  Runnable,
  RunnableBinding,
} from "@langchain/core/runnables";
import type { AgentMiddleware } from "langchain";
import type {
  AgentEventIdentity,
  AgentRunExtension,
  AgentRunExtensionContext,
} from "./run-extension.js";

export function createRunModelCallbacks(
  extensions: readonly AgentRunExtension[],
  identity: AgentEventIdentity,
  context: AgentRunExtensionContext | undefined,
  purpose: ModelCallPurpose,
): BaseCallbackHandler[] {
  return extensions.flatMap(
    (extension) =>
      extension.createModelCallbacks?.(identity, context, purpose) ?? [],
  );
}

/** 保留原模型 profile 与归档代理，只观察中间件自身发出的模型请求。 */
export function observeInternalModelCalls(
  middleware: AgentMiddleware,
  callbacks: BaseCallbackHandler[],
): AgentMiddleware {
  if (!callbacks.length) return middleware;
  const wrap = middleware.wrapModelCall;
  if (!wrap) throw new Error("模型请求中间件缺少调用入口。");
  return {
    ...middleware,
    wrapModelCall(request, handler) {
      let continuing = false;
      const model = new Proxy(request.model, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "invoke")
            return (...args: Parameters<typeof target.invoke>) =>
              target.invoke(
                args[0],
                continuing
                  ? args[1]
                  : mergeConfigs(ensureConfig(args[1]), { callbacks }),
              );
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return wrap({ ...request, model }, async (next) => {
        continuing = true;
        try {
          return await handler(next);
        } finally {
          continuing = false;
        }
      });
    },
  };
}

/** 仅绑定调用观察者；请求内容、模型设置和原有回调均由 SDK 继续处理。 */
export function createModelObservationMiddleware(
  extensions: readonly AgentRunExtension[],
  identity: AgentEventIdentity,
  context?: AgentRunExtensionContext,
): AgentMiddleware[] {
  const callbacks = createRunModelCallbacks(
    extensions,
    identity,
    context,
    "agent",
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
