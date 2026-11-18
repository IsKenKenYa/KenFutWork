import type { IncomingHttpHeaders } from "node:http";
import type {
  LocalAccessClient,
  LocalAccessClientKind,
  LocalAccessConnectRequest,
  LocalAccessErrorCode,
  LocalAccessTicketResponse,
} from "@kenfutwork/shared";

import type { LocalActor } from "../local-instance/types.js";

/** ip 必须来自真实 socket，不能采用转发请求头。 */
export type LocalAccessRequest = {
  headers: IncomingHttpHeaders;
  ip?: string;
};

export type LocalAccessClientRecord = LocalAccessClient & {
  instanceId: string;
};

export type LocalAccessRevokedListener = (
  clientId: string,
) => void | Promise<void>;
export type LocalAccessClientInput = {
  id: string;
  instanceId: string;
  kind: LocalAccessClientKind;
  label: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date | null;
};

/** Store 不保存明文令牌；所有查询显式绑定实例。 */
export interface LocalAccessStore {
  ensureDesktop(
    input: LocalAccessClientInput,
  ): Promise<LocalAccessClientRecord>;
  findActiveByTokenHash(input: {
    instanceId: string;
    tokenHash: string;
    now: Date;
  }): Promise<LocalAccessClientRecord | null>;
  /** 与撤销 authorizer 的写操作串行化，授权失效时不创建任何客户端。 */
  createAuthorized(input: {
    authorizerId: string;
    client: LocalAccessClientInput;
    now: Date;
  }): Promise<LocalAccessClientRecord | null>;
  listAuthorized(input: {
    instanceId: string;
    authorizerId: string;
    now: Date;
  }): Promise<LocalAccessClientRecord[] | null>;
  revokeAuthorized(input: {
    instanceId: string;
    authorizerId: string;
    clientId: string;
    now: Date;
  }): Promise<"revoked" | "missing" | "unauthorized" | "desktop">;
}

export interface LocalAccessService {
  /** 服务启动调用；并发调用及重启不会创建第二个桌面凭据。 */
  initialize(): Promise<void>;
  /** 仅供桌面宿主内部消费，禁止注册为 HTTP 路由。 */
  getDesktopToken(): Promise<string>;
  authenticate(request: LocalAccessRequest): Promise<LocalActor | null>;
  issueTicket(request: LocalAccessRequest): Promise<LocalAccessTicketResponse>;
  consumeTicket(
    request: LocalAccessRequest,
    input: LocalAccessConnectRequest,
  ): Promise<{ actor: LocalActor; client: LocalAccessClient; cookie: string }>;
  createApiClient(
    request: LocalAccessRequest,
    input: { label: string },
  ): Promise<{ client: LocalAccessClient; token: string }>;
  listClients(request: LocalAccessRequest): Promise<LocalAccessClient[]>;
  revokeClient(request: LocalAccessRequest, clientId: string): Promise<void>;
  onRevoked(listener: LocalAccessRevokedListener): () => void;
}

/** 路由与传输只消费准入，不要求构造凭据签发器。 */
export type LocalAccessVerifier = Pick<LocalAccessService, "authenticate">;

export class LocalAccessError extends Error {
  constructor(
    readonly code: LocalAccessErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "LocalAccessError";
  }
}
