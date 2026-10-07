import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

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
