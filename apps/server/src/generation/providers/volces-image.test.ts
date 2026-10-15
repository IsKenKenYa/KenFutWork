import { afterEach, expect, it, vi } from "vitest";
import { resolveInstanceImageProvider } from "../../providers/resolve.js";

afterEach(() => vi.unstubAllGlobals());

it("Seedream HTTP429保留状态等待时间和上游错误码", async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json(
      { error: { code: "RateLimitExceeded", message: "请求过于频繁" } },
      { status: 429, headers: { "Retry-After": "13" } },
    ),
  );
  vi.stubGlobal("fetch", request);
  const provider = resolveInstanceImageProvider("volces", {
    credentials: {
      apiKey: "ark-key",
      baseUrl: "https://ark.example/api/v3",
    },
    models: [{ id: "ep-user-endpoint", name: "Seedream" }],
  });

  await expect(
    provider.generate({ model: "ep-user-endpoint", prompt: "一只猫" }),
  ).rejects.toMatchObject({
    provider: "volces",
    code: "api_error",
    status: 429,
    retryAfter: "13",
    upstreamCode: "RateLimitExceeded",
  });
  expect(request).toHaveBeenCalledOnce();
});

it("Seedream原生档位不丢画幅约束，显式像素保持优先", async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      data: [{ url: "https://cdn.example/pixels.png", size: "3072x2048" }],
    }),
  );
  vi.stubGlobal("fetch", request);
  const provider = resolveInstanceImageProvider("volces", {
    credentials: {
      apiKey: "ark-key",
      baseUrl: "https://ark.example/api/v3",
    },
    models: [{ id: "ep-seedream-5-lite", name: "Seedream 5.0 lite" }],
  });

  for (const quality of ["2K", "4K"]) {
    await expect(
      provider.generate({
        model: "ep-seedream-5-lite",
        prompt: "一只猫",
        quality,
        aspectRatio: "16:9",
      }),
    ).rejects.toMatchObject({ provider: "volces", code: "unsupported" });
  }
  expect(request).not.toHaveBeenCalled();

  await expect(
    provider.generate({
      model: "ep-seedream-5-lite",
      prompt: "一只猫",
      quality: "4K",
      aspectRatio: "1:1",
      width: 3072,
      height: 2048,
    }),
  ).resolves.toMatchObject({ width: 3072, height: 2048 });
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
    size: "3072x2048",
  });

  expect(request).toHaveBeenCalledOnce();
});

it("Seedream原生质量与格式发送合法组合，像素优先且不支持选项在HTTP前拒绝", async () => {
  // 官方图片 API：5.0 lite 支持 2K/4K 与 png/jpeg；此 Endpoint fixture 代表该模型。
  const combinations = [
    {
      quality: "4K",
      outputFormat: "png",
      dimensions: {},
      size: "4K",
      outputSize: "4096x4096",
      wireFormat: "png",
      mimeType: "image/png",
    },
    {
      quality: "2K",
      outputFormat: "jpg",
      dimensions: {},
      size: "2K",
      outputSize: "2048x2048",
      wireFormat: "jpeg",
      mimeType: "image/jpeg",
    },
    {
      quality: "4K",
      outputFormat: "jpg",
      dimensions: { width: 3072, height: 2048 },
      size: "3072x2048",
      outputSize: "3072x2048",
      wireFormat: "jpeg",
      mimeType: "image/jpeg",
    },
  ] as const;
  let responseIndex = 0;
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      data: [
        {
          b64_json: "aGk=",
          size: combinations[responseIndex++]?.outputSize,
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", request);
  const provider = resolveInstanceImageProvider("volces", {
    credentials: {
      apiKey: "ark-key",
      baseUrl: "https://ark.example/api/v3",
    },
    models: [{ id: "ep-seedream-5-lite", name: "Seedream 5.0 lite" }],
  });

  for (const combination of combinations) {
    const image = await provider.generate({
      model: "ep-seedream-5-lite",
      prompt: "一只猫",
      quality: combination.quality,
      outputFormat: combination.outputFormat,
      ...combination.dimensions,
    });

    expect(
      JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)),
    ).toMatchObject({
      model: "ep-seedream-5-lite",
      size: combination.size,
      output_format: combination.wireFormat,
      response_format: "b64_json",
    });
    expect(image).toMatchObject({
      url: `data:${combination.mimeType};base64,aGk=`,
      mimeType: combination.mimeType,
    });
  }
  expect(request).toHaveBeenCalledTimes(3);

  request.mockClear();
  for (const option of [
    { outputFormat: "webp" as const },
    { quality: "cinematic" },
  ]) {
    await expect(
      provider.generate({
        model: "ep-seedream-5-lite",
        prompt: "一只猫",
        ...option,
      }),
    ).rejects.toMatchObject({ provider: "volces", code: "unsupported" });
  }
  expect(request).not.toHaveBeenCalled();
});

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
