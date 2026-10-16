import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

function lastUserText(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>;
  const content = messages
    .filter((message) => message.role === "user")
    .at(-1)?.content;
  return typeof content === "string"
    ? content
    : (content ?? []).map((part) => part.text ?? "").join("\n");
}

// 真实HTTP/SSE、原V4接纳、独占PG和Harness；只控制外部模型流。
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "共享Task执行方式接纳 integration",
  () => {
    it.each([
      { admitted: "solo", changed: "agent", directive: true },
      { admitted: "agent", changed: "solo", directive: false },
    ] as const)(
      "$admitted 输入排队后切 $changed，原输入仍按接纳时工作方式进入模型",
      async ({ admitted, changed, directive }) => {
        const fixture = await createCodeUiHttpFixture();
        const model = await heldModel();
        let host: Host | undefined;
        try {
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          expect(
            (await host.command("sendText", { text: "保留当前前台运行" })).body
              .result.status,
          ).toBe("accepted");
          await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
            timeout: 30_000,
          });
          const endpoint = `/api/execution-modes/${host.sessionId}`;
          expect(
            (await host.client.request(endpoint, { mode: admitted }, "PUT"))
              .status,
          ).toBe(200);
          const queued = await host.command("sendText", {
            text: "按发送时的工作方式处理这条输入",
            requestedDelivery: "queue",
          });
          expect(queued.body.result).toMatchObject({
            status: "accepted",
            result: { delivery: "queue" },
          });
          expect(
            (await host.client.request(endpoint, { mode: changed }, "PUT"))
              .status,
          ).toBe(200);
          model.finish(0);
          await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
            timeout: 30_000,
          });
          const text = lastUserText(model.requests[1]!.body);
          expect(text).toContain("按发送时的工作方式处理这条输入");
          expect(text.includes('<execution_mode name="solo">')).toBe(directive);
        } finally {
          if (host) {
            const snapshot = protocol.conversationSnapshotSchema.parse(
              await host.snapshot(),
            );
            if (snapshot.control.canStop) await host.command("stop", {});
            await host.dispose();
          }
          await model.close();
          await fixture.close();
        }
      },
      90_000,
    );
  },
);
