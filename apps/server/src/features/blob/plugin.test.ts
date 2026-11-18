import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { loadServerEnv, type ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { PersistenceService } from "../persistence/types.js";
import { createBlobPlugin } from "./plugin.js";
import type { BlobStore } from "./types.js";

const rejectDatabaseUse = (): never => {
  throw new Error("Blob插件装配与本地读取不应访问数据库。");
};
const persistence: PersistenceService = {
  query: rejectDatabaseUse,
  queryOne: rejectDatabaseUse,
  execute: rejectDatabaseUse,
  forInstance: rejectDatabaseUse,
  transaction: rejectDatabaseUse,
  withSessionTransaction: rejectDatabaseUse,
  subscribeNotifications: rejectDatabaseUse,
  acquireSessionLock: rejectDatabaseUse,
  ping: rejectDatabaseUse,
  close: rejectDatabaseUse,
};

async function withBlobPlugin(
  overrides: Partial<ServerEnv>,
  run: (blob: BlobStore, app: ReturnType<typeof Fastify>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "kfw-blob-plugin-"));
  const app = Fastify({ logger: false });
  const kernel = composePlugins(
    loadServerEnv(
      {
        port: 3301,
        serverHost: "127.0.0.1",
        webOrigin: "http://127.0.0.1:3400",
        desktopDataDir: root,
        blobDir: join(root, "blobs"),
        ...overrides,
      },
      {},
    ),
    [createBlobPlugin()],
    { app, overrides: { persistence } },
  );
  try {
    await app.ready();
    await run(kernel.get("blob"), app);
  } finally {
    await app.close();
    await kernel.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

const deployments: Array<{
  form: string;
  environment: Partial<ServerEnv>;
  origin: string;
}> = [
  {
    form: "分离Web/API",
    environment: { serverHost: "127.0.0.1" },
    origin: "http://127.0.0.1:3301",
  },
  {
    form: "IPv6分离Web/API",
    environment: { serverHost: "::1" },
    origin: "http://[::1]:3301",
  },
  {
    form: "同进程静态UI",
    environment: {
      serverHost: "127.0.0.1",
      webDist: "/unused-static-ui",
    },
    origin: "http://127.0.0.1:3301",
  },
];
it.each(deployments)(
  "真实插件装配$form的对象URL始终指向API读取路由",
  async (input) => {
    await withBlobPlugin(input.environment, async (blob, app) => {
      const bucket = blob.bucket("project-assets");
      const body = new Uint8Array([1, 2, 3]);
      await bucket.upload("instance/public.png", body);
      const url = new URL(await bucket.resolveUrl("instance/public.png"));
      expect.soft(url.origin).toBe(input.origin);
      expect(url.pathname).toBe(
        "/api/blobs/project-assets/instance/public.png",
      );
      const response = await app.inject({ url: url.pathname + url.search });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.rawPayload).toEqual(Buffer.from(body));
    });
  },
);

it("真实插件保留显式blobPublicBaseUrl，覆盖Web/API默认origin", async () => {
  await withBlobPlugin(
    { blobPublicBaseUrl: "https://files.example.test/custom/blobs/" },
    async (blob) => {
      const url = new URL(
        await blob
          .bucket("code-attachments")
          .resolveUrl("instance/private.png"),
      );
      expect(url.origin).toBe("https://files.example.test");
      expect(url.pathname).toBe(
        "/custom/blobs/code-attachments/instance/private.png",
      );
      expect(url.searchParams.has("sig")).toBe(true);
    },
  );
});

it("真实插件私有读取只接受匹配且未过期的Blob签名，接入Bearer不能代替签名", async () => {
  await withBlobPlugin({}, async (blob, app) => {
    const bucket = blob.bucket("code-attachments");
    const body = new Uint8Array([7, 8, 9]);
    await bucket.upload("instance/private.png", body);
    const url = new URL(await bucket.resolveUrl("instance/private.png"));
    expect.soft(url.origin).toBe("http://127.0.0.1:3301");
    const read = (target: URL, signed = true) =>
      app.inject({
        url: target.pathname + (signed ? target.search : ""),
        headers: { authorization: "Bearer not-a-blob-signature" },
      });
    expect((await read(url, false)).statusCode).toBe(403);
    const valid = await read(url);
    expect(valid.statusCode).toBe(200);
    expect(valid.rawPayload).toEqual(Buffer.from(body));

    const changedPath = new URL(url);
    changedPath.pathname = changedPath.pathname.replace(
      "private.png",
      "other.png",
    );
    expect((await read(changedPath)).statusCode).toBe(403);
    const changedSignature = new URL(url);
    changedSignature.searchParams.set("sig", "not-a-blob-signature");
    expect((await read(changedSignature)).statusCode).toBe(403);
    const expired = new URL(url);
    expired.searchParams.set("exp", "0");
    expect((await read(expired)).statusCode).toBe(403);
  });
});
