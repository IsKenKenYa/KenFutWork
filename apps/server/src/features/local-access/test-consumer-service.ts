import type { LocalAccessService } from "./types.js";

/** 仅消费者插件的注入夹具；完整应用启动必须使用真实本机接入服务。 */
export function createConsumerLocalAccessService(
  authenticate: LocalAccessService["authenticate"] = async () => null,
): LocalAccessService {
  const listeners = new Set<(clientId: string) => void>();
  const unsupported = (): never => {
    throw new Error("此消费者夹具不提供私有凭据、签发或客户端管理。");
  };
  return {
    authenticate,
    async initialize() {},
    async getDesktopToken() {
      return unsupported();
    },
    async issueTicket() {
      return unsupported();
    },
    async consumeTicket() {
      return unsupported();
    },
    async createApiClient() {
      return unsupported();
    },
    async listClients() {
      return unsupported();
    },
    async revokeClient() {
      return unsupported();
    },
    onRevoked(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
