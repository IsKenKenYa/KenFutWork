import { randomUUID } from "node:crypto";
import {
  type FlowProjectControlMutationResult,
  type FlowProjectControlReceipt,
  flowProjectControlProjectIdSchema,
  flowProjectControlReceiptSchema,
  flowProjectControlRequestSchema,
} from "@kenfutwork/shared";
import type { LocalActor } from "../local-instance/types.js";

export type FlowProjectControlMutation = {
  operationId: string;
  expectedGeneration: number;
};

export interface FlowProjectControl {
  snapshot(
    actor: LocalActor,
    projectId: string,
  ): Promise<FlowProjectControlReceipt>;
  quiesce(
    actor: LocalActor,
    projectId: string,
    input: FlowProjectControlMutation,
  ): Promise<FlowProjectControlMutationResult>;
  completeRelink(
    actor: LocalActor,
    projectId: string,
    input: FlowProjectControlMutation,
  ): Promise<FlowProjectControlMutationResult>;
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
  const request = async (
    projectId: string,
    input: {
      action: "snapshot" | "quiesce" | "complete-relink";
      hostSubject: string;
      operationId: string;
      expectedGeneration: number;
    },
  ) => {
    flowProjectControlProjectIdSchema.parse(projectId);
    const body = flowProjectControlRequestSchema.parse(input);
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
  };

  const observe = async (
    actor: LocalActor,
    projectId: string,
  ): Promise<FlowProjectControlReceipt | null> => {
    try {
      return await request(projectId, {
        action: "snapshot",
        hostSubject: actor.instanceId,
        operationId: randomUUID(),
        expectedGeneration: 0,
      });
    } catch {
      return null;
    }
  };

  const mutate = async (
    action: "quiesce" | "complete-relink",
    actor: LocalActor,
    projectId: string,
    input: FlowProjectControlMutation,
  ): Promise<FlowProjectControlMutationResult> => {
    try {
      const receipt = await request(projectId, {
        action,
        hostSubject: actor.instanceId,
        operationId: input.operationId,
        expectedGeneration: input.expectedGeneration,
      });
      const expectedGeneration =
        action === "quiesce"
          ? input.expectedGeneration + 1
          : input.expectedGeneration;
      if (
        !Number.isSafeInteger(expectedGeneration) ||
        receipt.operationId !== input.operationId ||
        receipt.generation !== expectedGeneration ||
        receipt.draining !== (action === "quiesce") ||
        (action === "complete-relink" && receipt.remoteOutstanding !== 0)
      )
        throw new Error("Flow 项目控制回执与操作不匹配");
      return { status: "confirmed", receipt };
    } catch {
      // A lost or malformed mutation receipt is ambiguous. Observe once; never replay the action.
      return {
        status: "unknown",
        observation: await observe(actor, projectId),
      };
    }
  };

  return {
    snapshot(actor, projectId) {
      return request(projectId, {
        action: "snapshot",
        hostSubject: actor.instanceId,
        operationId: randomUUID(),
        expectedGeneration: 0,
      });
    },
    quiesce: (actor, projectId, input) =>
      mutate("quiesce", actor, projectId, input),
    completeRelink: (actor, projectId, input) =>
      mutate("complete-relink", actor, projectId, input),
  };
}
