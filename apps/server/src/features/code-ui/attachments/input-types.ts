import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";

/** Only the owned attachment provider can resolve these bytes; never accept them from Run HTTP/WS. */
export interface TrustedCodeInput {
  attachment: protocol.AttachmentRef;
  bytes: Uint8Array;
}
