import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import {
  healthResponseSchema,
  localAccessTicketResponseSchema,
  resolveGovernanceEnvOverrides,
  resolveGovernanceNumber,
} from "@kenfutwork/shared";
import { resolveDesktopDataDir } from "../../desktop/paths.js";
import { LOCAL_ACCESS_TOKEN_PATTERN } from "./desktop-token.js";

function connectionTargets(port: number, uiBase: string) {
  // TCP端口范围是协议格式约束，不是运行时可调限额。
  if (!Number.isInteger(port) || port <= 0 || port > 65_535)
    throw new Error("本机连接端口无效。");
  const ui = new URL(uiBase);
  if (
    !["http:", "https:"].includes(ui.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(ui.hostname) ||
    ui.username ||
    ui.password
  )
    throw new Error("本机连接入口只能指向无凭据的回环HTTP地址。");
  return { ui, apiBase: `http://127.0.0.1:${port}` };
}

function startupTimeout(reason: string): Error {
  return Object.assign(new Error(`等待本机服务启动超时：${reason}。`), {
    code: "local_service_startup_timeout",
  });
}

/** Node timer可早于performance小数deadline唤醒；复核绝对时刻才取消，不能提前重发健康请求。 */
function deadlineSignal(deadline: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) controller.abort();
    else timer = setTimeout(check, Math.ceil(remaining));
  };
  check();
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

async function jsonRequest(url: string, init: RequestInit, deadline: number) {
  const cancellation = deadlineSignal(deadline);
  try {
    const response = await fetch(url, {
      ...init,
      signal: cancellation.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status, payload: null };
    }
    return {
      ok: true,
      status: response.status,
      payload: await response.json(),
    };
  } finally {
    cancellation.close();
  }
}

async function waitForLocalService(
  apiBase: string,
  deadline: number,
  pollMs: number,
) {
  let reason = "未能连接到回环端口";
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw startupTimeout(reason);
    try {
      const health = await jsonRequest(
        `${apiBase}/api/health`,
        {},
        Math.min(deadline, performance.now() + pollMs),
      );
      if (health.ok && healthResponseSchema.safeParse(health.payload).success) {
        if (performance.now() >= deadline) throw startupTimeout(reason);
        return;
      }
      reason = health.ok
        ? "健康响应不属于KenFutWork本机服务"
        : `健康检查返回HTTP ${health.status}`;
    } catch {
      reason = "健康检查连接失败、重定向或单次请求超时";
    }
    const wait = deadline - performance.now();
    if (wait <= 0) throw startupTimeout(reason);
    await pause(Math.min(pollMs, wait));
  }
}

async function readDesktopConnectionToken(dataDir: string, deadline: number) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw startupTimeout("服务就绪后已超过启动预算");
  const cancellation = deadlineSignal(deadline);
  try {
    return (
      await readFile(join(dataDir, "local-access", "desktop-token"), {
        encoding: "utf8",
        signal: cancellation.signal,
      })
    ).trim();
  } catch (error) {
    if (cancellation.signal.aborted)
      throw startupTimeout("接入凭据文件读取超时");
    throw error;
  } finally {
    cancellation.close();
  }
}

/** launcher宿主调用；只返回一次性入口，长凭据不进入URL或日志。 */
export async function createLocalConnectionUrl(options: {
  env: Record<string, string | undefined>;
  port: number;
  uiBase: string;
}): Promise<string> {
  const { ui, apiBase } = connectionTargets(options.port, options.uiBase);
  // 服务尚未接通时不能读库；启动等待专用预算采用env ?? DEFAULTS，并统一钳位。
  const overrides = resolveGovernanceEnvOverrides(options.env);
  const deadline =
    performance.now() +
    resolveGovernanceNumber(
      "localServiceStartupTimeoutMs",
      undefined,
      overrides,
    );
  const pollMs = resolveGovernanceNumber(
    "localServiceStartupPollMs",
    undefined,
    overrides,
  );
  await waitForLocalService(apiBase, deadline, pollMs);
  const dataDir = resolveDesktopDataDir({ env: options.env });
  const token = await readDesktopConnectionToken(dataDir, deadline);
  if (!LOCAL_ACCESS_TOKEN_PATTERN.test(token))
    throw new Error("本机连接凭据文件格式无效。");
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw startupTimeout("接入凭据读取后已超过启动预算");
  // 票据可能在网络中断前已签发，因此只请求一次，禁止套入健康检查重试。
  let response: Awaited<ReturnType<typeof jsonRequest>>;
  try {
    response = await jsonRequest(
      `${apiBase}/api/local-access/tickets`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
      deadline,
    );
  } catch {
    throw new Error("本机连接票据签发失败：连接中断、重定向或请求超时。");
  }
  if (!response.ok)
    throw new Error(`本机服务拒绝连接票据（HTTP ${response.status}）。`);
  const { ticket } = localAccessTicketResponseSchema.parse(response.payload);
  ui.hash = new URLSearchParams({ connect: ticket }).toString();
  return ui.toString();
}
