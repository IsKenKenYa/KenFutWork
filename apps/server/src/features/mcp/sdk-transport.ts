import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type SdkTransport = {
  start: Transport["start"];
  send: Transport["send"];
  close: Transport["close"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  setProtocolVersion?: Transport["setProtocolVersion"];
  readonly sessionId?: string | undefined;
};

/** SDK HTTP getter返回undefined，严格可选属性要求字段缺席；消息/取消仍由原SDK实例处理。 */
export function adaptSdkTransport(source: SdkTransport): Transport {
  const synchronizeSession = () => {
    if (source.sessionId === undefined) delete transport.sessionId;
    else transport.sessionId = source.sessionId;
  };
  const transport: Transport = {
    start: () => source.start(),
    send: (message, options) => source.send(message, options),
    close: () => source.close(),
    ...(source.setProtocolVersion
      ? {
          setProtocolVersion: (version: string) =>
            source.setProtocolVersion?.(version),
        }
      : {}),
  };
  source.onmessage = (message, extra) => {
    synchronizeSession();
    transport.onmessage?.(message, extra);
  };
  source.onclose = () => {
    synchronizeSession();
    transport.onclose?.();
  };
  source.onerror = (error) => transport.onerror?.(error);
  synchronizeSession();
  return transport;
}
