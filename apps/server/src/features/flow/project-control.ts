import { randomUUID } from "node:crypto";
import {
  type FlowProjectControlReceipt,
  flowProjectControlProjectIdSchema,
  flowProjectControlReceiptSchema,
  flowProjectControlRequestSchema,
} from "@kenfutwork/shared";
import type { LocalActor } from "../local-instance/types.js";

export interface FlowProjectControl {
  snapshot(
    actor: LocalActor,
    projectId: string,
  ): Promise<FlowProjectControlReceipt>;
}

export function createFlowProjectControl(options: {
  gatewayUrl: string;
  sharedSecret: string;
  fetchImpl?: typeof fetch;
}): FlowProjectControl {
  const gateway = new URL(options.gatewayUrl);
  if (
    !["http:", "https:"].includes(gateway.protocol) ||
    gateway.pathname !== "/" ||
    gateway.search ||
    gateway.hash ||
    gateway.username ||
    gateway.password
  )
    throw new Error("Flow 网关地址必须是显式 HTTP(S) origin");
  if (!options.sharedSecret.trim()) throw new Error("Flow 宿主控制密钥未配置");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async snapshot(actor, projectId) {
      flowProjectControlProjectIdSchema.parse(projectId);
      const body = flowProjectControlRequestSchema.parse({
        action: "snapshot",
        hostSubject: actor.instanceId,
        operationId: randomUUID(),
        expectedGeneration: 0,
      });
      const response = await fetchImpl(
        new URL(
          `/host/ff-embed/v1/projects/${encodeURIComponent(projectId)}/control`,
          gateway,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.sharedSecret}`,
            "content-type": "application/json",
            "x-ff-embed-protocol": "v1",
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error("Flow 项目控制请求未确认");
      const receipt = flowProjectControlReceiptSchema.parse(
        await response.json(),
      );
      if (receipt.projectId !== projectId)
        throw new Error("Flow 项目控制回执归属不匹配");
      return receipt;
    },
  };
}
