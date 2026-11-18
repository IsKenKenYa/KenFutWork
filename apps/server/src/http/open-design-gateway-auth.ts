import { timingSafeEqual } from "node:crypto";
import { OPEN_DESIGN_EMBED_PROTOCOL_VERSION } from "@kenfutwork/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * OpenDesign 网关鉴权（O3：`POST /api/open-design/host/credentials` 的门）。
 *
 * 对位 `flow-gateway-auth.ts` 的口径，原因相同：调用方是 **OpenDesign daemon**
 * （机器对机器），不是浏览器——它没有本机接入票据，只有与宿主成对配置的共享密钥
 * （`KENFUTWORK_OPEN_DESIGN_EMBED_SECRET` ↔ OpenDesign 栈的 `OD_API_TOKEN`）。
 *
 * 三道检查：密钥在（503，没配就是没开这条缝）→ 密钥对（401，timingSafeEqual 防时序）→
 * 协议版本对（400；头缺省按当前版本受理，显式带错版本才拒）。
 */
export function authorizeOpenDesignGateway(
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
      "未配置 OpenDesign 网关共享密钥（KENFUTWORK_OPEN_DESIGN_EMBED_SECRET），凭证下发不可用。",
    );
  const header = request.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const actualBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  )
    return reject(401, "unauthorized", "OpenDesign 网关共享密钥不匹配。");
  const version = String(request.headers["x-od-embed-protocol"] ?? "").trim();
  if (version && version !== OPEN_DESIGN_EMBED_PROTOCOL_VERSION)
    return reject(
      400,
      "application_error",
      `OpenDesign 协议版本不匹配：支持 ${OPEN_DESIGN_EMBED_PROTOCOL_VERSION}。`,
    );
  return true;
}
