import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  connectCdpClient,
  findBrowserExecutable,
  launchBrowserWithDebugPort,
  waitForDevtools,
} from "../../../server/src/features/browser/cdp-client.js";

const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const zcodeRoot = fileURLToPath(
  new URL("../../src/components/workbench/zcode/", import.meta.url),
);
const browserEntry = fileURLToPath(
  new URL("./code-public-session-browser.tsx", import.meta.url),
);
const requireZcode = createRequire(join(zcodeRoot, "package.json"));
const browserPath = "/code-ui/__public-session.html";

async function createBrowserDirectory() {
  const scratch = join(repositoryRoot, ".scratch");
  await runFile("git", ["check-ignore", "--quiet", `${scratch}/`], {
    cwd: repositoryRoot,
  });
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, "code-public-chrome-"));
}

async function waitForOwnedDebugPort(profileDir, child) {
  // Chrome 自选端口并写入本例 profile，不探测或连接其他实例的调试端口。
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("独占浏览器在调试端口就绪前退出");
    try {
      const activePort = await readFile(
        join(profileDir, "DevToolsActivePort"),
        "utf8",
      );
      const port = Number(activePort.split("\n", 1)[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
      throw new Error("独占浏览器提供了无效调试端口");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("独占浏览器未提供调试端口");
}

function originalSessionEntryPlugin() {
  return {
    name: "code-public-original-session",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        if (pathname !== browserPath && pathname !== "/__public-session.html")
          return next();
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>原 SessionPane 公开验证</title><style>html,body,#root{width:100%;height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="/@fs${browserEntry}"></script></body></html>`;
        void server
          .transformIndexHtml(browserPath, html)
          .then((transformed) => {
            response.statusCode = 200;
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(transformed);
          }, next);
      });
    },
  };
}

async function startOriginalSessionServer(options, directory) {
  const vite = await import(requireZcode.resolve("vite"));
  const server = await vite.createServer({
    configFile: join(zcodeRoot, "vite.config.mjs"),
    root: zcodeRoot,
    cacheDir: join(directory, "vite-cache"),
    clearScreen: false,
    logLevel: "warn",
    plugins: [originalSessionEntryPlugin()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      hmr: false,
      fs: { allow: [repositoryRoot] },
      proxy: {
        "/api": {
          target: options.backendBaseUrl,
          changeOrigin: true,
          configure(proxy) {
            // 测试前端与独占后端共用此反向代理；API 正文、授权及 SSE 原样转发。
            proxy.on("proxyReq", (request) => {
              request.setHeader("origin", options.backendOrigin);
            });
          },
        },
      },
    },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("原组件服务未取得监听地址");
    return { server, url: `http://127.0.0.1:${address.port}${browserPath}` };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function evaluatePage(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(
      detail.exception?.description ?? detail.text ?? "原组件页面执行失败",
    );
  }
  return result.result?.value;
}

async function waitForBrowserExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // 此预算只限制本测试创建的 Chrome 关闭等待，不属于 Agent 运行配置。
  await new Promise((resolve, reject) => {
    const exited = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", exited);
      reject(new Error("独占浏览器未确认退出"));
    }, 10_000);
    child.once("exit", exited);
  });
}

async function closeOwnedBrowser(child, cdp) {
  if (!child) return;
  try {
    if (cdp) {
      // Browser.close 会先关闭调试连接；只有自己创建的进程退出才算关闭成功。
      await cdp.send("Browser.close").catch(() => undefined);
    } else child.kill("SIGTERM");
    try {
      await waitForBrowserExit(child);
    } catch {
      child.kill("SIGTERM");
      await waitForBrowserExit(child);
    }
  } finally {
    cdp?.close();
  }
}

/** 独占 Chrome、Vite 与 profile；所有业务请求继续经过真实 HTTP/SSE。 */
export async function openOriginalSessionBrowser(options) {
  const executable = findBrowserExecutable();
  if (!executable)
    throw new Error("未找到 Chrome，请设置 KENFUTWORK_CHROME_PATH");
  const directory = await createBrowserDirectory();
  let server;
  let child;
  let cdp;
  let target;
  let releaseErrors;
  const pageErrors = [];
  let closing;
  const close = () => {
    closing ??= (async () => {
      const failures = [];
      const operations = [
        async () => {
          if (cdp && target)
            await evaluatePage(
              cdp,
              target.sessionId,
              "window.__codePublicSessionDispose?.()",
            );
        },
        () => closeOwnedBrowser(child, cdp),
        () => server?.close(),
        () => {
          if (child && child.exitCode === null && child.signalCode === null)
            throw new Error(`独占浏览器尚未退出，请保留 ${directory}`);
          return rm(directory, { recursive: true, force: true });
        },
      ];
      for (const operation of operations) {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      }
      releaseErrors?.();
      if (failures.length)
        throw new AggregateError(
          failures,
          "原组件浏览器验证资源未全部确认关闭",
          { cause: failures[0] },
        );
    })();
    return closing;
  };
  try {
    const development = await startOriginalSessionServer(options, directory);
    server = development.server;
    const profileDir = join(directory, "profile");
    const launched = await launchBrowserWithDebugPort({
      executable,
      port: 0,
      profileDir,
      headless: true,
    });
    child = launched.child;
    const launchFailure = new Promise((_, reject) =>
      child.once("error", reject),
    );
    const version = await Promise.race([
      waitForOwnedDebugPort(profileDir, child).then((port) =>
        waitForDevtools(port),
      ),
      launchFailure,
    ]);
    cdp = connectCdpClient(version.webSocketDebuggerUrl);
    target = await cdp.openTab("about:blank");
    await cdp.send("Page.enable", {}, target.sessionId);
    await cdp.send("Runtime.enable", {}, target.sessionId);
    releaseErrors = cdp.on("Runtime.exceptionThrown", (params, sessionId) => {
      if (sessionId === target.sessionId)
        pageErrors.push(params.exceptionDetails);
    });
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `Object.defineProperty(window,"__codePublicSessionBootstrap",{value:${JSON.stringify(
          {
            accessToken: options.accessToken,
            workspacePath: options.workspacePath,
            projectId: options.projectId,
            sessionId: options.sessionId,
            clientId: options.clientId,
          },
        )},configurable:true});`,
      },
      target.sessionId,
    );
    await cdp.send("Page.navigate", { url: development.url }, target.sessionId);
    return {
      cdp,
      target,
      pageErrors,
      evaluate: (expression) => evaluatePage(cdp, target.sessionId, expression),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "原组件浏览器启动及清理失败",
      );
    }
    throw error;
  }
}
