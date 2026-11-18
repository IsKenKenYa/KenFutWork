import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHelperApp } from "./build-helper.mjs";
import { resolveBundleDescriptor } from "./bundle-config.mjs";

test("dev 与 production 使用固定 bundle ID 和应用名", () => {
  const dev = resolveBundleDescriptor({
    configuration: "dev",
    version: "0.1.0",
  });
  assert.equal(dev.bundleId, "com.kenfutwork.cua-helper.dev");
  assert.equal(dev.appName, "KenFutWork Computer Use Dev.app");
  assert.equal(dev.displayName, "KenFutWork Computer Use Dev");
  assert.equal(dev.executableName, "kenfutwork-cua-helper");
  assert.equal(dev.minimumSystemVersion, "12.0");
  assert.equal(dev.lsuielement, true);

  const production = resolveBundleDescriptor({
    configuration: "production",
    version: "0.1.0",
  });
  assert.equal(production.bundleId, "com.kenfutwork.cua-helper");
  assert.equal(production.appName, "KenFutWork Computer Use.app");
  assert.equal(production.displayName, "KenFutWork Computer Use");
});

test("构建的 dev Helper.app 具备固定身份、可签名、可启动并响应握手", {
  timeout: 120_000,
}, async (t) => {
  const out = await mkdtemp(join(tmpdir(), "kfw-cua-app-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const app = await buildHelperApp({
    out,
    configuration: "dev",
    version: "0.1.0",
  });
  const descriptor = resolveBundleDescriptor({
    configuration: "dev",
    version: "0.1.0",
  });
  const infoPath = join(app, "Contents", "Info.plist");
  const info = JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath], {
      encoding: "utf8",
    }),
  );
  assert.equal(info.CFBundleIdentifier, descriptor.bundleId);
  assert.equal(info.CFBundleExecutable, descriptor.executableName);
  assert.equal(info.LSUIElement, true);
  assert.equal(info.CFBundleShortVersionString, "0.1.0");

  const signature = spawnSync(
    "/usr/bin/codesign",
    ["-dv", "--verbose=2", app],
    { encoding: "utf8" },
  );
  assert.equal(signature.status, 0, signature.stderr);
  assert.match(
    `${signature.stdout}\n${signature.stderr}`,
    /Signature=adhoc|Authority=Developer ID Application/,
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);

  await access(join(app, "Contents", "MacOS", descriptor.executableName));

  const socketPath = join(out, "helper.sock");
  const token = "a".repeat(64);
  execFileSync("/usr/bin/open", [
    "-n",
    "-a",
    app,
    "--args",
    "--socket",
    socketPath,
    "--token",
    token,
    "--bundle-id",
    descriptor.bundleId,
    "--helper-path",
    app,
    "--version",
    "0.1.0",
  ]);

  const client = await waitForHelper(socketPath, 5_000);
  t.after(() => client.close());

  const hello = await client.request({
    id: "1",
    method: "hello",
    params: {
      protocolVersion: 1,
      client: "build-helper-test",
      clientVersion: "0.1.0",
      token,
    },
  });
  assert.equal(hello.ok, true);
  assert.equal(hello.result.bundleId, descriptor.bundleId);

  const status = await client.request({
    id: "2",
    method: "permission.status",
  });
  assert.equal(status.ok, true);
  assert.equal(status.result.available, true);
  assert.equal(status.result.helperBundleId, descriptor.bundleId);
  assert.ok(["granted", "denied"].includes(status.result.accessibility));
  assert.ok(["granted", "denied"].includes(status.result.screenRecording));

  const shutdown = await client.request({
    id: "3",
    method: "helper.shutdown",
  });
  assert.equal(shutdown.ok, true);
  await waitForMissing(socketPath, 3_000);
});

async function waitForHelper(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await connectHelper(socketPath);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Helper socket 未在 ${timeoutMs}ms 内就绪：${socketPath}`);
}

async function waitForMissing(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error(`Helper socket 未在 ${timeoutMs}ms 内删除：${path}`);
}

function connectHelper(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const waiting = [];
    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      socket.destroy();
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const resolveLine = waiting.shift();
        if (resolveLine) resolveLine(JSON.parse(line));
      }
    });
    socket.once("connect", () => {
      resolve({
        request(payload) {
          return new Promise((resolveRequest, rejectRequest) => {
            waiting.push(resolveRequest);
            socket.write(`${JSON.stringify(payload)}\n`, (error) => {
              if (error) rejectRequest(error);
            });
          });
        },
        close() {
          socket.destroy();
        },
      });
    });
  });
}
