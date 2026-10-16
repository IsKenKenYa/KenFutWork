import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { createAgentConversationTransport } from "@zui/v4/agentConversationTransport";
import { ReplaceableConversationTransport } from "@zui/v4/replaceableConversationTransport";
import { afterEach, expect, test, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";

afterEach(() => vi.unstubAllGlobals());

test("原可替换传输和HTTP服务代理透传本次策略companion，保留原V4 envelope与重试参数", async () => {
  const requests: Array<{
    method: string;
    args: Array<Record<string, unknown>>;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/events")) {
        let closed = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"event":"ready","hello":{"connectionId":"companion"}}\n\n',
                ),
              );
              options?.signal?.addEventListener(
                "abort",
                () => {
                  if (closed) return;
                  closed = true;
                  controller.close();
                },
                { once: true },
              );
            },
            cancel() {
              closed = true;
            },
          }),
        );
      }
      const request = JSON.parse(
        String(options?.body),
      ) as (typeof requests)[number];
      requests.push(request);
      if (request.method === "helloConversationV4")
        return Response.json({
          result: protocol.helloMessageSchema.parse({
            kind: "hello",
            protocolVersion: 3,
            connectionId: "companion",
            clientMode: "web-remote-replayable",
            deliveryProfile: "replayable",
            serverTime: 1,
            capabilities: {
              nativeDialogs: false,
              localTerminal: false,
              binaryFrames: false,
              compression: "none",
              independentPlanState: true,
            },
            auth: {},
          }),
        });
      return Response.json({
        result:
          request.method === "sendConversationCommandV4"
            ? {
                commandId: "selected-strategy",
                status: "accepted",
                revisionAtDecision: 1,
              }
            : {},
      });
    }),
  );
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  try {
    await client.connect();
    const create = () =>
      createAgentConversationTransport(client.services.zcodeAgentService, {
        workspacePath: "/project",
      });
    const transport = new ReplaceableConversationTransport(create());
    const envelope = Object.freeze(
      protocol.commandEnvelopeSchema.parse({
        clientId: "tab-one",
        commandId: "selected-strategy",
        sessionId: "task",
        type: "sendText",
        payload: { text: "本窗口的输入" },
        issuedAt: 1,
      }),
    );
    await transport.sendCommand(envelope, "solo");
    transport.replace(create());
    await transport.sendCommand(envelope, "solo");
    const commands = requests.filter(
      (request) => request.method === "sendConversationCommandV4",
    );
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.args[0]).toMatchObject({
        executionMode: "solo",
        envelope,
      });
      expect(command.args[0]?.envelope).toEqual(envelope);
      expect(command.args[0]?.envelope).not.toHaveProperty("executionMode");
    }
  } finally {
    client.dispose();
  }
});
