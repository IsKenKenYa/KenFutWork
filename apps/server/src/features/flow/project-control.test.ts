import { flowProjectControlReceiptSchema } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createFlowProjectControl } from "./project-control.js";

const actor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};
const projectId = "22222222-2222-4222-8222-222222222222";
const receipt = {
  projectId,
  generation: 4,
  draining: false,
  localSettled: true,
  activeRunIds: [],
  remoteStopped: 0,
  remoteOutstanding: 0,
  operationId: null,
  quiesceSettled: false,
};

describe("Flow project control snapshot provider", () => {
  it("uses the explicit gateway origin and checks project ownership", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(receipt)),
    );
    const control = createFlowProjectControl({
      gatewayUrl: "http://127.0.0.1:9087",
      sharedSecret: "shared-secret",
      fetchImpl,
    });
    expect(await control.snapshot(actor, projectId)).toEqual(receipt);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `http://127.0.0.1:9087/host/ff-embed/v1/projects/${projectId}/control`,
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      action: "snapshot",
      hostSubject: actor.instanceId,
      expectedGeneration: 0,
    });
  });
  it("rejects a receipt for a different project", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            ...receipt,
            projectId: "33333333-3333-4333-8333-333333333333",
          }),
        ),
    );
    const control = createFlowProjectControl({
      gatewayUrl: "http://127.0.0.1:9087",
      sharedSecret: "shared-secret",
      fetchImpl,
    });
    await expect(control.snapshot(actor, projectId)).rejects.toThrow(
      "回执归属不匹配",
    );
  });
  it("rejects unsafe generations", () => {
    expect(
      flowProjectControlReceiptSchema.safeParse({ ...receipt, generation: 0 })
        .success,
    ).toBe(false);
  });
});
