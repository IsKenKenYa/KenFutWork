import { fork } from "node:child_process";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type {
  Command,
  GateState,
  Inspection,
  Method,
  Reply,
} from "./governance-ui-server-types";

const SYNC_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 180_000;
type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never;
type Control = WithoutId<Command>;

function isolatedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(KENFUTWORK_|LOOMIC_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|REPLICATE_|METASO_|VOLCES_|LEMON_|PG|SUPABASE_)/u.test(
        key,
      ) ||
      ["DATABASE_URL", "PORT", "HOST", "NODE_OPTIONS"].includes(key)
    )
      delete env[key];
  return env;
}

/** 真Node子进程；不导入Vitest server fixture，不把cookie/DSN/票据传回Web进程。 */
export async function startGovernanceUiServer() {
  // 两个调用方的实际 cwd 均为 apps/web 或 apps/server；避开 jsdom 的 URL 重写。
  const repo = resolve(process.cwd(), "..", "..");
  const cwd = join(repo, "apps", "server");
  const entry = join(cwd, "test", "governance-ui-server.fixture.ts");
  const child = fork(entry, {
    cwd,
    execArgv: ["--import", "tsx"],
    env: isolatedEnv(),
    // 丢弃服务日志，避免库日志把真实测试凭据带到父进程或测试报告。
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let requestId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: Inspection | undefined) => void;
      reject: (error: Error) => void;
    }
  >();
  let readyResolve!: (value: Extract<Reply, { type: "ready" }>) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<Extract<Reply, { type: "ready" }>>(
    (resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    },
  );
  const timer = setTimeout(
    () => readyReject(new Error("真实UI/PG子进程未就绪；这是fixture失败。")),
    START_TIMEOUT_MS,
  );
  child.on("message", (raw) => {
    const reply = raw as Reply;
    if (reply.type === "ready") {
      clearTimeout(timer);
      readyResolve(reply);
      return;
    }
    if (reply.type === "failed") {
      clearTimeout(timer);
      readyReject(new Error(reply.error));
      return;
    }
    const waiting = pending.get(reply.requestId);
    if (!waiting) return;
    pending.delete(reply.requestId);
    if (reply.ok) waiting.resolve(reply.value);
    else waiting.reject(new Error(reply.error));
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.once("exit", (code) => {
    clearTimeout(timer);
    const error = new Error(
      `真实UI夹具子进程退出（${code}）；不能计为产品RED。`,
    );
    readyReject(error);
    for (const value of pending.values()) value.reject(error);
    pending.clear();
  });
  async function control(value: Control) {
    const id = ++requestId;
    return new Promise<Inspection | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("真实UI夹具IPC未完成。"));
      }, SYNC_TIMEOUT_MS);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.send({ ...value, requestId: id }, (error) => {
        if (error) {
          pending.get(id)?.reject(new Error("真实UI夹具IPC发送失败。"));
          pending.delete(id);
        }
      });
    });
  }
  let metadata: Extract<Reply, { type: "ready" }>;
  try {
    metadata = await ready;
  } catch (error) {
    child.kill("SIGTERM");
    await exited;
    throw error;
  }
  async function inspect() {
    const value = await control({ operation: "inspect" });
    if (!value) throw new Error("真实UI夹具未回传事实。");
    return value;
  }
  return {
    baseUrl: metadata.baseUrl,
    instanceId: metadata.instanceId,
    dataDir: metadata.dataDir,
    inspect,
    gate: (
      id: string,
      method: Method,
      options: {
        hold?: boolean;
        phase?: "request" | "response";
        match?: { key: string; value: number | boolean };
      } = {},
    ) => control({ operation: "gate", id, method, ...options }),
    release: (id: string) => control({ operation: "release", id }),
    drop: (id: string) => control({ operation: "drop", id }),
    async waitGate(id: string, state: GateState, status: number | null = 200) {
      const deadline = Date.now() + SYNC_TIMEOUT_MS;
      do {
        const value = await inspect();
        if (
          value.gates.some(
            (gate) =>
              gate.id === id &&
              gate.state === state &&
              (status === null || gate.status === status),
          )
        )
          return;
        await setImmediate();
      } while (Date.now() < deadline);
      throw new Error("真实响应gate未到达指定状态。");
    },
    async stop() {
      await control({ operation: "stop" });
      await exited;
    },
  };
}

export type Server = Awaited<ReturnType<typeof startGovernanceUiServer>>;
