import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BlobError } from "../types.js";
import {
  createLocalFsBlobStore,
  resolveBlobPath,
  signBlobUrl,
  verifyBlobUrlSignature,
} from "./local-fs.js";
import { createSupabaseBlobStore } from "./supabase-storage.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "loomic-blob-"));
}

function localStore(root = tempRoot()) {
  return createLocalFsBlobStore({
    publicBaseUrl: "http://127.0.0.1:3001/api/blobs/",
    rootDir: root,
    signingSecret: "secret-1",
  });
}

describe("local-fs Provider", () => {
  it("upload 落盘 + download 读回（目录自动创建）", async () => {
    const root = tempRoot();
    const bucket = localStore(root).bucket("project-assets");

    await bucket.upload("ws-1/a/b.png", new Uint8Array([1, 2, 3]), {
      contentType: "image/png",
    });

    expect(
      readFileSync(join(root, "project-assets", "ws-1", "a", "b.png")),
    ).toEqual(Buffer.from([1, 2, 3]));
    await expect(bucket.download("ws-1/a/b.png")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("upsert=false 时不覆盖已有对象（与 Supabase 同义）", async () => {
    const bucket = localStore().bucket("project-assets");
    await bucket.upload("x.bin", new Uint8Array([1]));

    await expect(
      bucket.upload("x.bin", new Uint8Array([2])),
    ).rejects.toBeInstanceOf(BlobError);
    await expect(bucket.download("x.bin")).resolves.toEqual(
      new Uint8Array([1]),
    );
  });

  it("upsert=true 覆盖", async () => {
    const bucket = localStore().bucket("project-assets");
    await bucket.upload("x.bin", new Uint8Array([1]));
    await bucket.upload("x.bin", new Uint8Array([9]), { upsert: true });

    await expect(bucket.download("x.bin")).resolves.toEqual(
      new Uint8Array([9]),
    );
  });

  it("getPublicUrl 拼基址并去掉多余斜杠", async () => {
    const bucket = localStore().bucket("brand-kit-assets");
    expect(bucket.getPublicUrl("/u-1/logo.svg")).toBe(
      "http://127.0.0.1:3001/api/blobs/brand-kit-assets/u-1/logo.svg",
    );
  });

  it("签名 URL 可被同一实现校验；过期或篡改即失败", async () => {
    const bucket = localStore().bucket("user-avatars");
    const url = await bucket.createSignedUrl("u-1/a.png", 60);

    const parsed = new URL(url);
    const params = {
      bucket: "user-avatars",
      expiresAt: Number(parsed.searchParams.get("exp")),
      path: "u-1/a.png",
      signature: parsed.searchParams.get("sig") ?? "",
      signingSecret: "secret-1",
    };
    expect(verifyBlobUrlSignature(params)).toBe(true);

    // 篡改路径 → 签名不再匹配
    expect(verifyBlobUrlSignature({ ...params, path: "u-1/b.png" })).toBe(
      false,
    );
    // 过期 → 直接失败
    expect(
      verifyBlobUrlSignature({
        ...params,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }),
    ).toBe(false);
    // 换密钥 → 失败
    expect(verifyBlobUrlSignature({ ...params, signingSecret: "other" })).toBe(
      false,
    );
  });

  it("createSignedUrls 逐条独立成败（空路径也给签名，不抛）", async () => {
    const bucket = localStore().bucket("user-avatars");
    const entries = await bucket.createSignedUrls(["a.png", "b.png"], 60);

    expect(entries.map((entry) => entry.path)).toEqual(["a.png", "b.png"]);
    for (const entry of entries) {
      expect(entry.signedUrl).toContain("/user-avatars/");
    }
    await expect(bucket.createSignedUrls([], 60)).resolves.toEqual([]);
  });

  it("copy 桶内复制；remove 幂等（缺失路径不报错）", async () => {
    const bucket = localStore().bucket("project-assets");
    await bucket.upload("a.png", new Uint8Array([7]));
    await bucket.copy("a.png", "nested/b.png");

    await expect(bucket.download("nested/b.png")).resolves.toEqual(
      new Uint8Array([7]),
    );

    await expect(
      bucket.remove(["a.png", "missing.png"]),
    ).resolves.toBeUndefined();
    await expect(bucket.download("a.png")).rejects.toBeInstanceOf(BlobError);
  });

  it("isPublic 按本地约定；resolveUrl 公开桶给公网 URL、非公开桶给签名 URL", async () => {
    const store = localStore();

    const publicBucket = store.bucket("project-assets");
    await expect(publicBucket.isPublic()).resolves.toBe(true);
    await expect(publicBucket.resolveUrl("a/b.png")).resolves.toBe(
      "http://127.0.0.1:3001/api/blobs/project-assets/a/b.png",
    );

    const privateBucket = store.bucket("user-avatars");
    await expect(privateBucket.isPublic()).resolves.toBe(false);
    const signed = await privateBucket.resolveUrl("u/a.png");
    expect(signed).toContain("exp=");
    expect(signed).toContain("sig=");
  });

  it("路径逃逸被拒绝（`..` 与绝对路径都不能越出 root）", async () => {
    expect(() => resolveBlobPath("/root", "b", "../etc/passwd")).toThrow(
      /非法段/,
    );
    expect(() => resolveBlobPath("/root", "b", "a/../../x")).toThrow(/非法段/);

    const bucket = localStore().bucket("project-assets");
    await expect(
      bucket.upload("../escape.txt", new Uint8Array([1])),
    ).rejects.toBeInstanceOf(BlobError);
    await expect(bucket.download("../escape.txt")).rejects.toBeInstanceOf(
      BlobError,
    );
  });

  it("空段（双斜杠）被归一；`.` 段也按非法拒绝（路径由服务端拼装，不该出现）", () => {
    const resolved = resolveBlobPath("/root", "b", "a//b/c.txt");
    expect(resolved.endsWith(join("a", "b", "c.txt"))).toBe(true);
    expect(() => resolveBlobPath("/root", "b", "a/./c.txt")).toThrow(/非法段/);
  });
});

describe("supabase-storage Provider（过渡期）", () => {
  function fakeClient(handlers: Record<string, unknown>) {
    const from = vi.fn(() => handlers);
    return { client: { storage: { from } } as never, from };
  }

  it("upload 转发 contentType/upsert，并把错误折成 BlobError", async () => {
    const upload = vi.fn(async () => ({ error: null }));
    const { client, from } = fakeClient({ upload });

    await createSupabaseBlobStore({ getClient: () => client })
      .bucket("project-assets")
      .upload("p.png", new Uint8Array([1]), {
        contentType: "image/png",
        upsert: true,
      });

    expect(from).toHaveBeenCalledWith("project-assets");
    expect(upload).toHaveBeenCalledWith("p.png", new Uint8Array([1]), {
      contentType: "image/png",
      upsert: true,
    });

    const failing = fakeClient({
      upload: async () => ({ error: { message: "bucket not found" } }),
    });
    await expect(
      createSupabaseBlobStore({ getClient: () => failing.client })
        .bucket("project-assets")
        .upload("p.png", new Uint8Array([1])),
    ).rejects.toThrow(/bucket not found/);
  });

  it("getPublicUrl 同步返回；缺 publicUrl 即抛", () => {
    const { client } = fakeClient({
      getPublicUrl: () => ({ data: { publicUrl: "https://cdn.test/x.png" } }),
    });
    expect(
      createSupabaseBlobStore({ getClient: () => client })
        .bucket("project-assets")
        .getPublicUrl("x.png"),
    ).toBe("https://cdn.test/x.png");

    const broken = fakeClient({ getPublicUrl: () => ({ data: null }) });
    expect(() =>
      createSupabaseBlobStore({ getClient: () => broken.client })
        .bucket("project-assets")
        .getPublicUrl("x.png"),
    ).toThrow(BlobError);
  });

  it("createSignedUrls 空入参不发请求；失败项 signedUrl 为 null", async () => {
    const createSignedUrls = vi.fn(async () => ({
      data: [
        { path: "a.png", signedUrl: "https://cdn.test/a" },
        { path: "b.png", signedUrl: null },
      ],
      error: null,
    }));
    const { client } = fakeClient({ createSignedUrls });
    const bucket = createSupabaseBlobStore({ getClient: () => client }).bucket(
      "user-avatars",
    );

    await expect(bucket.createSignedUrls([], 60)).resolves.toEqual([]);
    expect(createSignedUrls).not.toHaveBeenCalled();

    await expect(
      bucket.createSignedUrls(["a.png", "b.png"], 60),
    ).resolves.toEqual([
      { path: "a.png", signedUrl: "https://cdn.test/a" },
      { path: "b.png", signedUrl: null },
    ]);
  });

  it("download 返回字节；remove 空入参不发请求", async () => {
    const download = vi.fn(async () => ({
      data: { arrayBuffer: async () => new Uint8Array([5, 6]).buffer },
      error: null,
    }));
    const remove = vi.fn(async () => ({ error: null }));
    const { client } = fakeClient({ download, remove });
    const bucket = createSupabaseBlobStore({ getClient: () => client }).bucket(
      "project-assets",
    );

    await expect(bucket.download("x.png")).resolves.toEqual(
      new Uint8Array([5, 6]),
    );
    await bucket.remove([]);
    expect(remove).not.toHaveBeenCalled();
    await bucket.remove(["a", "b"]);
    expect(remove).toHaveBeenCalledWith(["a", "b"]);
  });

  it("isPublic 查真实桶（非公开桶按非公开处理，查不到也按非公开）", async () => {
    const yes = fakeClient({});
    const yesClient = {
      storage: {
        from: vi.fn(() => ({})),
        getBucket: vi.fn(async () => ({ data: { public: true }, error: null })),
      },
    } as never;
    await expect(
      createSupabaseBlobStore({ getClient: () => yesClient })
        .bucket("canvases")
        .isPublic(),
    ).resolves.toBe(true);

    const errClient = {
      storage: {
        from: vi.fn(() => ({})),
        getBucket: vi.fn(async () => ({
          data: null,
          error: { message: "Bucket not found" },
        })),
      },
    } as never;
    await expect(
      createSupabaseBlobStore({ getClient: () => errClient })
        .bucket("project-assets")
        .isPublic(),
    ).resolves.toBe(false);
    void yes;
  });

  it("resolveUrl：公开桶走 getPublicUrl；非公开桶走签名 URL（实测 project-assets 非公开）", async () => {
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: "https://cdn.test/x?token=t" },
      error: null,
    }));
    const publicCase = {
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: () => ({ data: { publicUrl: "https://cdn.test/pub" } }),
        })),
        getBucket: vi.fn(async () => ({ data: { public: true }, error: null })),
      },
    } as never;
    await expect(
      createSupabaseBlobStore({ getClient: () => publicCase })
        .bucket("canvases")
        .resolveUrl("x.png"),
    ).resolves.toBe("https://cdn.test/pub");

    const privateCase = {
      storage: {
        from: vi.fn(() => ({ createSignedUrl })),
        getBucket: vi.fn(async () => ({
          data: { public: false },
          error: null,
        })),
      },
    } as never;
    await expect(
      createSupabaseBlobStore({ getClient: () => privateCase })
        .bucket("project-assets")
        .resolveUrl("x.png"),
    ).resolves.toBe("https://cdn.test/x?token=t");
    expect(createSignedUrl).toHaveBeenCalledWith("x.png", 3600);
  });

  it("签名体与 local-fs 一致地随 bucket/path/exp 变化", () => {
    const base = { bucket: "b", expiresAt: 100, path: "p", signingSecret: "s" };
    expect(signBlobUrl(base)).toBe(signBlobUrl(base));
    expect(signBlobUrl(base)).not.toBe(signBlobUrl({ ...base, path: "q" }));
    expect(signBlobUrl(base)).not.toBe(signBlobUrl({ ...base, bucket: "c" }));
    expect(signBlobUrl(base)).not.toBe(
      signBlobUrl({ ...base, expiresAt: 101 }),
    );
  });
});
