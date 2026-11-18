import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { registerBlobRoutes } from "../../http/blobs.js";
import { createLocalFsBlobStore } from "./providers/local-fs.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "blob-namespace-"));
  roots.push(rootDir);
  const ownedRoot = await mkdtemp(join(tmpdir(), "blob-owned-"));
  roots.push(ownedRoot);
  const config = {
    rootDir,
    publicBaseUrl: "http://localhost/api/blobs",
    signingSecret: "independent-blob-key",
  };
  const blob = createLocalFsBlobStore(config);
  const bucket = blob.bucket("project-assets");
  const provider = createLocalFsBlobStore({
    ...config,
    rootDir: ownedRoot,
  }).bucket("project-assets");
  blob.registerNamespace({
    bucket: "project-assets",
    namespace: "project-files",
    provider,
    publicRead: false,
  });
  return { blob, bucket, provider, config };
}
const path = "instance/project-files/asset";
it("同bucket句柄在注册后统一分派upload/download/URL，旧namespace仍走原Provider", async () => {
  const f = await fixture();
  const bucket = f.bucket;
  await bucket.upload(path, new Uint8Array([1, 2]));
  expect(await f.provider.download(path)).toEqual(new Uint8Array([1, 2]));
  expect(await bucket.download(path)).toEqual(new Uint8Array([1, 2]));
  await bucket.copy(path, "instance/project-files/copied");
  expect(await bucket.download("instance/project-files/copied")).toEqual(
    new Uint8Array([1, 2]),
  );
  await bucket.remove(["instance/project-files/copied"]);
  await expect(
    bucket.download("instance/project-files/copied"),
  ).rejects.toThrow();
  expect(await bucket.resolveUrl(path)).toContain("?exp=");
  await bucket.upload("instance/legacy.bin", new Uint8Array([3]));
  expect(await bucket.resolveUrl("instance/legacy.bin")).not.toContain("?exp=");
  await expect(f.provider.download("instance/legacy.bin")).rejects.toThrow();
});
it("namespace命中Provider失败不fallback旧Blob，重复注册与跨namespace复制拒绝", async () => {
  const f = await fixture();
  const bucket = f.blob.bucket("project-assets");
  await createLocalFsBlobStore(f.config)
    .bucket("project-assets")
    .upload(path, new Uint8Array([99]));
  await expect(bucket.download(path)).rejects.toThrow();
  expect(() =>
    f.blob.registerNamespace({
      bucket: "project-assets",
      namespace: "project-files",
      provider: f.provider,
      publicRead: false,
    }),
  ).toThrow();
  await expect(bucket.copy("instance/legacy.bin", path)).rejects.toThrow();
  expect(() =>
    f.blob.resolveNamespace(
      "project-assets",
      "instance/project-files/../escape",
    ),
  ).toThrow();
});
it("HTTP public bucket下private namespace仍须独立签名，命中缺失404而不回退", async () => {
  const f = await fixture();
  const app = Fastify();
  await registerBlobRoutes(app, { ...f.config, blob: f.blob });
  try {
    const bucket = f.blob.bucket("project-assets");
    await bucket.upload(path, new Uint8Array([7]));
    expect(
      (await app.inject({ url: `/api/blobs/project-assets/${path}` }))
        .statusCode,
    ).toBe(403);
    const signed = new URL(await bucket.resolveUrl(path));
    expect(
      (await app.inject({ url: signed.pathname + signed.search })).rawPayload,
    ).toEqual(Buffer.from([7]));
    signed.searchParams.set("sig", "access-token-is-not-a-blob-signature");
    expect(
      (await app.inject({ url: signed.pathname + signed.search })).statusCode,
    ).toBe(403);
    const missing = new URL(
      await bucket.resolveUrl("instance/project-files/missing"),
    );
    await createLocalFsBlobStore(f.config)
      .bucket("project-assets")
      .upload("instance/project-files/missing", new Uint8Array([99]));
    expect(
      (await app.inject({ url: missing.pathname + missing.search })).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
