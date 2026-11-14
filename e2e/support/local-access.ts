import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Page } from "@playwright/test";

/**
 * 本机免账户接入：e2e 用桌面临时令牌签发一次性 ticket，
 * 页面用 `#connect=<ticket>` 兑换 HttpOnly 会话 cookie。
 * 真实走服务端同一套实现，不绕过鉴权。
 */
export const repoRoot = path.resolve(import.meta.dirname, "../..");
export const dataDir = path.join(repoRoot, ".scratch", "e2e-data");
export const serverUrl = "http://127.0.0.1:3001";

export async function desktopToken(): Promise<string> {
  const file = path.join(dataDir, "local-access", "desktop-token");
  return (await readFile(file, "utf8")).trim();
}

export async function issueTicket(): Promise<string> {
  const token = await desktopToken();
  const response = await fetch(`${serverUrl}/api/local-access/tickets`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(
      `签发接入 ticket 失败：HTTP ${response.status} ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as { ticket: string };
  return payload.ticket;
}

/** 打开工作台并完成本机接入；之后同上下文内请求都带会话 cookie。 */
export async function openWorkbench(page: Page, target = "/workbench") {
  const ticket = await issueTicket();
  await page.goto(`${target}#connect=${ticket}`);
}

/** 带桌面临时令牌的服务端调用（准备数据或对账状态）。 */
export async function serverApi(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<Response> {
  const token = await desktopToken();
  return fetch(`${serverUrl}${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Code 壳是 `/code-ui/index.html` iframe（title「Code 工作台」）。 */
export function workbenchFrame(page: Page) {
  return page.frameLocator('iframe[title="Code 工作台"]');
}
