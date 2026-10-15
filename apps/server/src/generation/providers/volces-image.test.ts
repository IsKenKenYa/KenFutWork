import { afterEach, expect, it, vi } from "vitest";
import { resolveInstanceImageProvider } from "../../providers/resolve.js";

afterEach(() => vi.unstubAllGlobals());

it("Seedream显式宽高发送精确像素，单个维度在HTTP前拒绝", async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ data: [{ url: "https://cdn.example/image.png" }] }),
  );
  vi.stubGlobal("fetch", request);
  const provider = resolveInstanceImageProvider("volces", {
    credentials: {
      apiKey: "ark-key",
      baseUrl: "https://ark.example/api/v3",
    },
    models: [{ id: "ep-user-endpoint", name: "Seedream" }],
  });

  await provider.generate({
    model: "ep-user-endpoint",
    prompt: "一只猫",
    width: 3072,
    height: 2048,
    aspectRatio: "1:1",
  });

  expect(request).toHaveBeenCalledOnce();
  expect(String(request.mock.calls[0]?.[0])).toBe(
    "https://ark.example/api/v3/images/generations",
  );
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
    model: "ep-user-endpoint",
    size: "3072x2048",
  });

  request.mockClear();
  for (const dimensions of [{ width: 3072 }, { height: 2048 }]) {
    await expect(
      provider.generate({
        model: "ep-user-endpoint",
        prompt: "一只猫",
        ...dimensions,
      }),
    ).rejects.toMatchObject({ provider: "volces", code: "invalid_input" });
  }
  expect(request).not.toHaveBeenCalled();
});

it.each(["1:1", "16:9", "9:16"])(
  "Seedream新版%s请求合法像素、完整参考图并读取实际尺寸",
  async (aspectRatio) => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ url: "https://cdn.example/image.png", size: "2560x1440" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", request);
    const provider = resolveInstanceImageProvider("volces", {
      credentials: {
        apiKey: "ark-key",
        baseUrl: "https://ark.example/api/v3/",
        headers: { "x-tenant": "test" },
      },
      models: [{ id: "doubao-seedream-4-5-251128", name: "Seedream 4.5" }],
    });
    const inputImages = [
      "https://cdn.example/first.png",
      "data:image/png;base64,aGk=",
    ];
    const image = await provider.generate({
      model: "doubao-seedream-4-5-251128",
      prompt: "edit",
      aspectRatio,
      inputImages,
    });
    const [url, init] = request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://ark.example/api/v3/images/generations");
    const body = JSON.parse(String(init.body));
    expect(body.image).toEqual(inputImages);
    const [width, height] = body.size.split("x").map(Number);
    expect(width * height).toBeGreaterThanOrEqual(3686400);
    expect(width / height).toBeCloseTo(
      Number(aspectRatio.split(":")[0]) / Number(aspectRatio.split(":")[1]),
      1,
    );
    expect(image).toMatchObject({ width: 2560, height: 1440 });
  },
);

it("Seedream接收base64返回，空产物显式失败", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ b64_json: "aGk=", size: "2048x2048" }] }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));
  vi.stubGlobal("fetch", request);
  const provider = resolveInstanceImageProvider("volces", {
    credentials: { apiKey: "key" },
    models: [{ id: "ep-user-endpoint", name: "Seedream" }],
  });
  await expect(
    provider.generate({ model: "ep-user-endpoint", prompt: "p" }),
  ).resolves.toMatchObject({
    url: "data:image/png;base64,aGk=",
    width: 2048,
    height: 2048,
  });
  await expect(
    provider.generate({ model: "ep-user-endpoint", prompt: "p" }),
  ).rejects.toMatchObject({ code: "no_output" });
});
