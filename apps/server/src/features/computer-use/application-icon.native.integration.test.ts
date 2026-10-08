import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { createCodeUiHttpFixture } from "../code-ui/code-ui-http.fixture.js";
import { createMacosApplicationIconResolver } from "./application-icon.js";

const exec = promisify(execFile);
const enabled =
  process.env.KENFUTWORK_TEST_DESKTOP === "1" && process.platform === "darwin";

it.skipIf(!enabled)(
  "真实原宿主RPC读取系统应用图标并守住认证与连接边界",
  async () => {
    const fixture = await createCodeUiHttpFixture();
    try {
      const stream = await fixture.client.openCodeStream();
      const rpc = (
        request: unknown,
        connectionId = stream.ready.hello.connectionId,
      ) =>
        fixture.client.request("/api/code-ui/rpc", {
          connectionId,
          service: "platform",
          method: "getApplicationIcon",
          args: [request],
        });
      const response = await rpc({
        locators: [{ kind: "darwin-bundle-id", value: "com.apple.finder" }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const url = response.body.result.iconDataUrl;
      expect(url).toMatch(/^data:image\/png;base64,/u);
      const image = PNG.sync.read(
        Buffer.from(url.slice("data:image/png;base64,".length), "base64"),
      );
      expect([image.width, image.height]).toEqual([32, 32]);
      expect(
        image.data.some((byte, index) => index % 4 === 3 && byte > 0),
      ).toBe(true);
      const legacy = await rpc("com.apple.finder");
      expect(legacy.status).toBe(200);
      expect(legacy.body.result.iconDataUrl).toBe(url);
      expect((await rpc({ locators: [] })).body.result).toBeNull();
      expect(
        (await rpc("com.kenfutwork.nonexistent-app-native-test")).body.result,
      ).toBeNull();
      expect(
        (
          await rpc({
            locators: [
              { kind: "windows-executable-path", value: "/etc/passwd" },
            ],
          })
        ).body.result,
      ).toBeNull();
      expect((await rpc("invalid';injected")).status).toBe(400);
      const noArgs = await fixture.client.request("/api/code-ui/rpc", {
        connectionId: stream.ready.hello.connectionId,
        service: "platform",
        method: "getApplicationIcon",
        args: [],
      });
      expect(noArgs.status).toBe(400);
      expect((await rpc("com.apple.finder", "unowned-connection")).status).toBe(
        404,
      );
      const anonymous = await fetch(`${fixture.baseUrl}/api/code-ui/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixture.origin },
        body: JSON.stringify({
          connectionId: stream.ready.hello.connectionId,
          service: "platform",
          method: "getApplicationIcon",
          args: ["com.apple.finder"],
        }),
      });
      expect(anonymous.status).toBe(401);
      const resolver = createMacosApplicationIconResolver();
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        resolver.read("com.apple.finder", {
          signal: cancelled.signal,
          timeoutMs: 5000,
          maxBytes: 32_768,
        }),
      ).rejects.toThrow();
      await expect(
        resolver.read("com.apple.finder", {
          signal: new AbortController().signal,
          timeoutMs: 5000,
          maxBytes: 100,
        }),
      ).rejects.toThrow();
      stream.controller.abort();
      await stream.closed;
      await expect
        .poll(async () => (await rpc("com.apple.finder")).status)
        .toBe(404);
    } finally {
      await fixture.close();
    }
  },
);

it.skipIf(!enabled)("随包Node22读取实际CJS解析器的系统图标", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kfw-icon-cjs-"));
  try {
    const bundle = join(directory, "application-icon.cjs");
    await exec("pnpm", [
      "exec",
      "esbuild",
      new URL("./application-icon.ts", import.meta.url).pathname,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--define:import.meta.url=__filename",
      `--outfile=${bundle}`,
    ]);
    const runtime = new URL(
      "../../../../../release/runtime/node/bin/node",
      import.meta.url,
    ).pathname;
    const { stdout } = await exec(runtime, [
      "-e",
      `const {createMacosApplicationIconResolver}=require(${JSON.stringify(bundle)});
createMacosApplicationIconResolver().read('com.apple.finder',{signal:new AbortController().signal,timeoutMs:5000,maxBytes:32768}).then(result=>{const bytes=Buffer.from(result.iconDataUrl.split(',')[1],'base64');console.log(JSON.stringify({node:process.version,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),png:bytes.subarray(0,8).toString('hex')}));}).catch(error=>{console.error(error.message);process.exitCode=1;});`,
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      node: expect.stringMatching(/^v22\./u),
      width: 32,
      height: 32,
      png: "89504e470d0a1a0a",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
