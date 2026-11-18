import { timingSafeEqual } from "node:crypto";
import { FLOW_EMBED_PROTOCOL_VERSION } from "@kenfutwork/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

/** 网关回调只接收部署密钥；项目权限由独立的绑定令牌持有。 */
export function authorizeFlowGateway(
  request: FastifyRequest,
  reply: FastifyReply,
  secret?: string,
): boolean {
  const reject = (status: number, code: string, message: string) => {
    reply.code(status).send({ error: { code, message } });
    return false;
  };
  const expected = secret?.trim();
  if (!expected)
    return reject(
      503,
      "service_unavailable",
      "未配置 Flow 网关共享密钥，宿主回调不可用。",
    );
  const header = request.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const actualBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  )
    return reject(401, "unauthorized", "Flow 网关共享密钥不匹配。");
  const version = String(request.headers["x-ff-embed-protocol"] ?? "").trim();
  if (version && version !== FLOW_EMBED_PROTOCOL_VERSION)
    return reject(
      400,
      "application_error",
      `Flow 协议版本不匹配：支持 ${FLOW_EMBED_PROTOCOL_VERSION}。`,
    );
  return true;
}
