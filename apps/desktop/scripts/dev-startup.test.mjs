import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  acquireLauncherLock,
  freePort,
  isSourceDevelopmentLaunch,
} from "./dev-macos.mjs";

const exec = promisify(execFile);

test("开发入口锁只允许一个持有者，空锁不抢占，退出遗留锁可恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "kfw-launcher-lock-"));
  const path = join(root, "launcher.json");
  try {
    const acquired = await Promise.all([
      acquireLauncherLock(path),
      acquireLauncherLock(path),
    ]);
    assert.equal(acquired.filter(Boolean).length, 1);
    assert.equal(await acquireLauncherLock(path), false);
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
    await writeFile(path, "");
    assert.equal(await acquireLauncherLock(path), false);
    const { stdout } = await exec(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))",
    ]);
    await writeFile(path, JSON.stringify({ pid: Number(stdout) }));
    assert.equal(await acquireLauncherLock(path), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("系统重开丢失源码启动参数时不能当成现有开发实例复用", () => {
  assert.equal(
    isSourceDevelopmentLaunch(
      "/repo/KenFutWork.app/Contents/MacOS/kenfutwork-desktop",
    ),
    false,
  );
  assert.equal(
    isSourceDevelopmentLaunch(
      "app KENFUTWORK_DESKTOP_WEB_URL=http://127.0.0.1:3400 KENFUTWORK_SERVER_PORT=3301",
    ),
    true,
  );
  assert.equal(
    isSourceDevelopmentLaunch(
      "app KENFUTWORK_DESKTOP_WEB_URL=http://127.0.0.1:3400",
    ),
    false,
  );
});

test("macOS开发入口跳过占用端口并保留原服务", async () => {
  const occupied = createServer((_request, response) => response.end("原服务"));
  occupied.listen(0);
  await once(occupied, "listening");
  try {
    const port = occupied.address().port;
    const selected = await freePort(port, port);
    assert.notEqual(selected, port);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}`)).text(),
      "原服务",
    );
  } finally {
    occupied.close();
    await once(occupied, "close");
  }
});

test("桌面回环探活直接到达本机服务，不向环境代理发送请求", {
  skip: process.platform === "win32",
}, async () => {
  const script = await readFile(new URL("../dev.sh", import.meta.url), "utf8");
  const declaration = script.match(/^port_up\(\) \{[^\n]+\}$/m)?.[0];
  assert.ok(declaration, "真实开发入口需要回环探活函数");
  let targetRequests = 0;
  let proxyRequests = 0;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.end("本机服务已就绪");
  });
  const proxy = createServer((_request, response) => {
    proxyRequests += 1;
    response.writeHead(502).end("不能代理桌面回环服务");
  });
  try {
    target.listen(0, "127.0.0.1");
    proxy.listen(0, "127.0.0.1");
    await Promise.all([once(target, "listening"), once(proxy, "listening")]);
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    await exec(
      "bash",
      ["-c", `${declaration}\nport_up ${target.address().port}`],
      {
        timeout: 5_000,
        env: {
          ...process.env,
          http_proxy: proxyUrl,
          HTTP_PROXY: proxyUrl,
          no_proxy: "",
          NO_PROXY: "",
          all_proxy: "",
          ALL_PROXY: "",
        },
      },
    );
    assert.equal(targetRequests, 1);
    assert.equal(proxyRequests, 0);
  } finally {
    await Promise.all(
      [target, proxy].map(
        (server) =>
          new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  }
});
