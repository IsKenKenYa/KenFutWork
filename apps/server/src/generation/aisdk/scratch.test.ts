import { describe, it, vi } from "vitest";
import { createOpenCompatibleProvider } from "./factory.js";

describe("scratch", () => {
  it("url response", async () => {
    const recording = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            created: 1,
            data: [{ url: "https://cdn.example/img.png" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const provider = createOpenCompatibleProvider({
      baseUrl: "https://gw.example/v1",
      apiKey: "sk-test",
      fetch: recording as unknown as typeof fetch,
    });
    const result = await provider
      .imageModel("img-1")
      .doGenerate({
        prompt: "p",
        n: 1,
        providerOptions: {},
        size: undefined,
        aspectRatio: undefined,
        seed: undefined,
        files: undefined,
        mask: undefined,
      });
    throw new Error(`RESULT>>${JSON.stringify(result)}`);
  });
});
