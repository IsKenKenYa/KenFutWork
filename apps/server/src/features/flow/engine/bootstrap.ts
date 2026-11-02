import { existsSync, readFileSync } from "node:fs";

export interface DifyBootstrapOptions {
  envFile: string;
  /** Flow 网关 env（按覆盖顺序排列）：管理员凭据与网关保持同源。 */
  credentialEnvFiles?: string[];
  consoleBase: string;
  requestTimeoutMs: number;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export interface DifyBootstrapRetryOptions extends DifyBootstrapOptions {
  attempts: number;
  retryDelayMs: number;
}

export type DifyBootstrapResult = {
  status: "initialized" | "already_initialized";
};

class DifyBootstrapError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DifyBootstrapError";
  }
}

function readEnvValues(envFile: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

function readRequiredEnv(
  options: DifyBootstrapOptions,
): Record<string, string> {
  const values = readEnvValues(options.envFile);
  for (const file of options.credentialEnvFiles ?? []) {
    if (!existsSync(file)) continue;
    const credentials = readEnvValues(file);
    for (const key of ["DIFY_ADMIN_EMAIL", "DIFY_ADMIN_PASSWORD"]) {
      if (credentials[key] !== undefined) values[key] = credentials[key];
    }
  }
  for (const key of [
    "DIFY_INIT_PASSWORD",
    "DIFY_ADMIN_EMAIL",
    "DIFY_ADMIN_PASSWORD",
  ]) {
    if (!values[key]?.trim()) {
      const source = key === "DIFY_INIT_PASSWORD" ? "引擎" : "Flow 网关";
      throw new DifyBootstrapError(
        `Dify 初始化配置缺少 ${key}（${source} env），安装已停止。`,
        false,
      );
    }
  }
  return values;
}

function responseCookie(response: Response): string {
  return response.headers.get("set-cookie")?.split(";", 1)[0]?.trim() ?? "";
}

async function payloadOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function fail(action: string, response: Response, payload: unknown): Error {
  const detail =
    typeof payload === "object" && payload !== null
      ? ((payload as { message?: unknown; error?: unknown }).message ??
        (payload as { error?: unknown }).error)
      : payload;
  const suffix =
    typeof detail === "string" && detail.trim()
      ? `：${detail.trim().slice(0, 200)}`
      : "";
  return new DifyBootstrapError(
    `Dify ${action} 失败（HTTP ${response.status}）${suffix}`,
    response.status >= 500,
  );
}

export async function bootstrapDifyStack(
  options: DifyBootstrapOptions,
): Promise<DifyBootstrapResult> {
  const env = readRequiredEnv(options);
  const base = options.consoleBase.replace(/\/+$/, "");
  const call =
    options.fetchImpl ??
    ((input: string | URL, init?: RequestInit) => fetch(input, init));
  const request = async (
    method: "GET" | "POST",
    path: "/init" | "/setup",
    body?: Record<string, string>,
    cookie = "",
  ) => {
    const response = await call(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    return { response, payload: await payloadOf(response) };
  };
  const setupStatus = async () => {
    const { response, payload } = await request("GET", "/setup");
    if (!response.ok) throw fail("读取初始化状态", response, payload);
    return (payload as { step?: unknown } | null)?.step;
  };
  const recoverIfFinished = async () =>
    (await setupStatus()) === "finished"
      ? ({ status: "initialized" } as const)
      : null;

  if ((await setupStatus()) === "finished") {
    return { status: "already_initialized" };
  }

  const init = await request("GET", "/init");
  if (!init.response.ok)
    throw fail("读取初始化验证状态", init.response, init.payload);
  let cookie = "";
  if ((init.payload as { status?: unknown } | null)?.status !== "finished") {
    const validated = await request("POST", "/init", {
      password: env.DIFY_INIT_PASSWORD ?? "",
    });
    if (!validated.response.ok) {
      if (validated.response.status >= 500) {
        const recovered = await recoverIfFinished();
        if (recovered) return recovered;
      }
      throw fail("初始化验证", validated.response, validated.payload);
    }
    cookie = responseCookie(validated.response);
  }

  const setup = await request(
    "POST",
    "/setup",
    {
      email: env.DIFY_ADMIN_EMAIL ?? "",
      name: "KenFutWork",
      password: env.DIFY_ADMIN_PASSWORD ?? "",
    },
    cookie,
  );
  if (!setup.response.ok) {
    const recovered = await recoverIfFinished();
    if (recovered) return recovered;
    throw fail("创建管理员", setup.response, setup.payload);
  }
  return { status: "initialized" };
}

export async function bootstrapDifyStackWithRetry(
  options: DifyBootstrapRetryOptions,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<DifyBootstrapResult> {
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await bootstrapDifyStack(options);
    } catch (error) {
      if (error instanceof DifyBootstrapError && !error.retryable) throw error;
      lastError = error;
      if (attempt < options.attempts) await sleep(options.retryDelayMs);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Dify 初始化失败，请查看安装日志。");
}
