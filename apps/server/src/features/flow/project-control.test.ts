import {
  flowProjectControlReceiptSchema,
  flowProjectControlRequestSchema,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createFlowProjectControl } from "./project-control.js";

const actor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};
const projectId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
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

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function mockFetch(...responses: Response[]) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responses.shift() ?? response(null, 500),
  );
}

function requestBody(fetchMock: ReturnType<typeof mockFetch>, index: number) {
  return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body));
}

describe("Flow project control provider", () => {
  it("uses the configured gateway origin and parses a read-only snapshot", async () => {
    const fetchMock = mockFetch(response(receipt));
    const control = createFlowProjectControl({
      gatewayUrl: "http://127.0.0.1:9087",
      sharedSecret: "shared-secret",
      fetchImpl: fetchMock,
    });

    expect(await control.snapshot(actor, projectId)).toEqual(receipt);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      `http://127.0.0.1:9087/host/ff-embed/v1/projects/${projectId}/control`,
    );
    expect(init?.headers).toEqual({
      authorization: "Bearer shared-secret",
      "content-type": "application/json",
      "x-ff-embed-protocol": "v1",
    });
    expect(requestBody(fetchMock, 0)).toMatchObject({
      action: "snapshot",
      hostSubject: actor.instanceId,
      expectedGeneration: 0,
    });
    expect(requestBody(fetchMock, 0).operationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("observes once after an unknown quiesce result without replaying the stop", async () => {
    const observed = {
      ...receipt,
      generation: 5,
      draining: true,
      operationId,
      quiesceSettled: false,
      localSettled: false,
      activeRunIds: ["active-run"],
      remoteOutstanding: 2,
    };
    const fetchMock = mockFetch(
      response({ error: "gateway timeout" }, 504),
      response(observed),
    );
    const control = createFlowProjectControl({
      gatewayUrl: "http://gateway.internal:9087",
      sharedSecret: "shared-secret",
      fetchImpl: fetchMock,
    });

    expect(
      await control.quiesce(actor, projectId, {
        operationId,
        expectedGeneration: 4,
      }),
    ).toEqual({ status: "unknown", observation: observed });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0)).toMatchObject({
      action: "quiesce",
      operationId,
      expectedGeneration: 4,
    });
    expect(requestBody(fetchMock, 1)).toMatchObject({
      action: "snapshot",
      expectedGeneration: 0,
    });
    expect(requestBody(fetchMock, 1).operationId).not.toBe(operationId);
  });

  it("returns a confirmed complete-relink receipt without another observation", async () => {
    const completeReceipt = {
      ...receipt,
      operationId,
    };
    const fetchMock = mockFetch(response(completeReceipt));
    const control = createFlowProjectControl({
      gatewayUrl: "https://flow.example.test",
      sharedSecret: "shared-secret",
      fetchImpl: fetchMock,
    });

    expect(
      await control.completeRelink(actor, projectId, {
        operationId,
        expectedGeneration: 4,
      }),
    ).toEqual({ status: "confirmed", receipt: completeReceipt });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock, 0)).toMatchObject({
      action: "complete-relink",
      operationId,
      expectedGeneration: 4,
    });
  });

  it.each([
    [
      "project",
      {
        ...receipt,
        projectId: "44444444-4444-4444-8444-444444444444",
        generation: 5,
        operationId,
        draining: true,
      },
    ],
    [
      "operation",
      {
        ...receipt,
        generation: 5,
        operationId: "55555555-5555-4555-8555-555555555555",
        draining: true,
      },
    ],
    ["generation", { ...receipt, generation: 6, operationId, draining: true }],
    [
      "draining state",
      { ...receipt, generation: 5, operationId, draining: false },
    ],
  ] as const)(
    "treats a confirmed quiesce receipt with the wrong %s as unknown",
    async (_mismatch, invalidReceipt) => {
      const observation = {
        ...receipt,
        generation: 5,
        operationId,
        draining: true,
        localSettled: false,
      };
      const fetchMock = mockFetch(
        response(invalidReceipt),
        response(observation),
      );
      const control = createFlowProjectControl({
        gatewayUrl: "http://gateway.internal:9087",
        sharedSecret: "shared-secret",
        fetchImpl: fetchMock,
      });

      expect(
        await control.quiesce(actor, projectId, {
          operationId,
          expectedGeneration: 4,
        }),
      ).toEqual({ status: "unknown", observation });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestBody(fetchMock, 0).action).toBe("quiesce");
      expect(requestBody(fetchMock, 1).action).toBe("snapshot");
    },
  );

  it("observes an invalid complete-relink receipt without resending completion", async () => {
    const observation = { ...receipt, generation: 5, operationId };
    const fetchMock = mockFetch(
      response({ ...observation, generation: 6, draining: true }),
      response(observation),
    );
    const control = createFlowProjectControl({
      gatewayUrl: "http://gateway.internal:9087",
      sharedSecret: "shared-secret",
      fetchImpl: fetchMock,
    });

    expect(
      await control.completeRelink(actor, projectId, {
        operationId,
        expectedGeneration: 5,
      }),
    ).toEqual({ status: "unknown", observation });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0).action).toBe("complete-relink");
    expect(requestBody(fetchMock, 1).action).toBe("snapshot");
  });

  it("accepts only positive safe receipt generations and nonnegative safe request generations", () => {
    expect(
      flowProjectControlReceiptSchema.safeParse({
        ...receipt,
        generation: 0,
      }).success,
    ).toBe(false);
    expect(
      flowProjectControlReceiptSchema.safeParse({
        ...receipt,
        generation: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      flowProjectControlRequestSchema.safeParse({
        action: "snapshot",
        hostSubject: actor.instanceId,
        operationId,
        expectedGeneration: 0,
      }).success,
    ).toBe(true);
    expect(
      flowProjectControlRequestSchema.safeParse({
        action: "snapshot",
        hostSubject: actor.instanceId,
        operationId,
        expectedGeneration: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it("requires an explicit origin and configured host secret", () => {
    expect(() =>
      createFlowProjectControl({
        gatewayUrl: "http://127.0.0.1",
        sharedSecret: "secret",
      }),
    ).not.toThrow();
    expect(() =>
      createFlowProjectControl({
        gatewayUrl: "http://127.0.0.1:8080/path",
        sharedSecret: "secret",
      }),
    ).toThrow("显式 HTTP(S) origin");
    expect(() =>
      createFlowProjectControl({
        gatewayUrl: "http://127.0.0.1:8080",
        sharedSecret: " ",
      }),
    ).toThrow("控制密钥未配置");
  });
  it("rejects a complete receipt while remote work is still outstanding", async () => {
    const badCompletion = {
      ...receipt,
      generation: 5,
      draining: false,
      operationId,
      quiesceSettled: true,
      remoteOutstanding: 2,
    };
    const observed = {
      ...receipt,
      generation: 5,
      draining: true,
      operationId,
      quiesceSettled: true,
      remoteOutstanding: 2,
    };
    const fetchMock = mockFetch(response(badCompletion), response(observed));
    const control = createFlowProjectControl({
      gatewayUrl: "http://127.0.0.1:9087",
      sharedSecret: "shared-secret",
      fetchImpl: fetchMock,
    });

    expect(
      await control.completeRelink(actor, projectId, {
        operationId,
        expectedGeneration: 5,
      }),
    ).toEqual({ status: "unknown", observation: observed });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0).action).toBe("complete-relink");
    expect(requestBody(fetchMock, 1).action).toBe("snapshot");
  });
});
