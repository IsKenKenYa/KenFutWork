import type { ModelCallPurpose } from "@kenfutwork/shared";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  ensureConfig,
  mergeConfigs,
  Runnable,
  RunnableBinding,
  type RunnableConfig,
} from "@langchain/core/runnables";
import type { AgentMiddleware } from "langchain";
import {
  type LlmRequestRetryPolicy,
  withLlmRequestRetry,
} from "./llm-retry-middleware.js";
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

/** 保留模型与归档代理，按每次内部请求执行重试并绑定观察者。 */
export function observeInternalModelCalls(
  middleware: AgentMiddleware,
  callbacks: BaseCallbackHandler[],
  retry: LlmRequestRetryPolicy,
): AgentMiddleware {
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
            return (...args: Parameters<typeof target.invoke>) => {
              if (continuing) return target.invoke(...args);
              const config = mergeConfigs<RunnableConfig>(
                ensureConfig(args[1]),
                { callbacks },
              );
              const signals = [request.runtime.signal, config.signal].filter(
                (value) => value !== undefined,
              );
              const signal =
                signals.length > 1 ? AbortSignal.any(signals) : signals[0];
              return withLlmRequestRetry(
                () =>
                  target.invoke(args[0], {
                    ...config,
                    ...(signal ? { signal } : {}),
                  }),
                { ...retry, ...(signal ? { signal } : {}) },
              );
            };
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
