/** 外部 HTTP 夹具：原组件通过真实 Code 宿主建立通知流，随宿主取消而释放。 */
export function codeHostNotificationResponse(signal?: AbortSignal) {
  let closed = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              event: "ready",
              reconnectDelayMs: 1000,
              hello: {
                kind: "hello",
                protocolVersion: 3,
                connectionId: "test-host",
                clientMode: "web-remote-replayable",
                deliveryProfile: "replayable",
                serverTime: 1,
                capabilities: {
                  nativeDialogs: false,
                  localTerminal: false,
                  binaryFrames: false,
                  compression: "none",
                },
                auth: {},
              },
            })}\n\n`,
          ),
        );
        const close = () => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        };
        if (signal?.aborted) close();
        else signal?.addEventListener("abort", close, { once: true });
      },
      cancel() {
        closed = true;
      },
    }),
  );
}
