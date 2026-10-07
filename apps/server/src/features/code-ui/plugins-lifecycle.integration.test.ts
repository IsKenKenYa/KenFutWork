import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { loadServerEnv } from "../../config/env.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { codeUiAuthorizedInject } from "./code-ui-http.fixture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createBlockedBuiltin(root: string) {
  const entered = deferred();
  const release = deferred();
  const server = createServer((request, response) => {
    if (request.url === "/apply") {
      entered.resolve();
      void release.promise.then(() => response.end("ready"));
    } else response.end("ready");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("外部包夹具未监听");
  const name = `close-probe-${randomUUID()}`;
  const parent = join(root, "bundles");
  const dir = join(parent, "probe");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      main: "index.js",
      kenfutwork: { bundle: { patch: "./cordis.patch.yml" } },
    }),
  );
  await writeFile(
    join(dir, "cordis.patch.yml"),
    `- insert:\n    - id: probe\n      name: ${name}\n`,
  );
  await writeFile(
    join(dir, "index.js"),
    `export const name=${JSON.stringify(name)};
export async function apply() { await fetch("http://127.0.0.1:${address.port}/apply"); }`,
  );
  return {
    parent,
    name,
    entered: entered.promise,
    release: release.resolve,
    async dispose() {
      release.resolve();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
describe.skipIf(!enabled)("原插件宿主关闭 integration", () => {
  it("客户端断开后仍在装载的包必须在宿主关闭返回前结束，关闭后不再留下迟到写入", async () => {
    const database = await createTaskWorkDatabase();
    const databaseUrl = database.connectionString;
    const dir = await mkdtemp(join(tmpdir(), "code-ui-closing-package-"));
    const fixture = await createBlockedBuiltin(dir);
    vi.stubEnv("KENFUTWORK_PLUGINS_DIR", join(dir, "plugins"));
    vi.stubEnv("KENFUTWORK_BUILTIN_PLUGINS_DIR", fixture.parent);
    const app = buildApp({
      env: loadServerEnv(
        {
          databaseUrl,
          desktopDataDir: dir,
          queueDriver: "in-process",
          blobDir: join(dir, "blobs"),
          sandboxRoot: join(dir, "sandbox"),
          webOrigin: "http://localhost:3300",
        },
        {},
      ),
    });
    let closing: Promise<void> | undefined;
    const controller = new AbortController();
    try {
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const desktopToken = await app.kernel
        .get("localAccess")
        .getDesktopToken();
      const rpc = async (service: string, method: string, fields = {}) => {
        const response = await fetch(`${base}/api/code-ui/rpc`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${desktopToken}`,
          },
          body: JSON.stringify({ service, method, args: [fields] }),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      const opened = await rpc("workspace", "open", { path: dir });
      const installation = fetch(`${base}/api/code-ui/rpc`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${desktopToken}`,
        },
        body: JSON.stringify({
          service: "plugin-management",
          method: "installPlugin",
          args: [
            {
              workspacePath: opened.result.path,
              pluginName: fixture.name,
              marketplace: "kenfutwork-bundled",
              scope: "user",
            },
          ],
        }),
      }).catch((error: unknown) => error);
      await fixture.entered;
      controller.abort();
      await installation;
      closing = app.close();
      // 仅测试观察窗口；包装载被外部夹具确定性阻塞，不是业务超时/限额。
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const state = await Promise.race([
          closing.then(() => "closed"),
          new Promise<string>((done) => {
            timer = setTimeout(() => done("waiting"), 500);
          }),
        ]);
        expect(state).toBe("waiting");
      } finally {
        if (timer) clearTimeout(timer);
      }
      fixture.release();
      await closing;
    } finally {
      controller.abort();
      fixture.release();
      await (closing ?? app.close());
      await fixture.dispose();
      vi.unstubAllEnvs();
      await database.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
