import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import type { VoiceRefineContextMessage } from "@kenfutwork/shared";

import { findBuiltinModel } from "../catalog.js";
import { REFINE_SYSTEM_PROMPT } from "../refine-prompt.js";

/**
 * 离线「想」档：llamafile（Qwen3-0.6B，权重 + llama.cpp 运行时同一个文件）。
 *
 * 与 sherpa（听/说）同构的一层 provider，但「想」不是 VoiceProvider 的能力
 * （那个缝只有 transcriber/synthesizer/vad），所以单独一条：
 * 惰性 spawn `--server` → 探活 → 打 `/v1/chat/completions`（OpenAI 兼容）→ 复用
 * **同一份** refine 系统提示词（`refine-prompt.ts`，与在线档一字不差）。
 *
 * 三个实现口径：
 * - **不引 GGUF 运行时依赖**：llamafile 自带运行时，`spawn` 即可（Windows 需 `.exe`
 *   后缀——README 明确要求改名；这里用硬链接补一个 `.exe`，不复制 792MB）。
 * - **`--nobrowser`**：llamafile 的 `--server` 默认会弹浏览器标签（llamafile 0.9.3
 *   源码 `launch_browser.c`：「pass --nobrowser to disable」）——桌面里起引擎不该
 *   顺带弹一个浏览器。
 * - **失败 fail loud**：spawn 失败 / 探活超时 / 端点上错，都回可读原因并带上进程
 *   日志尾部（模型文件损坏、端口被占这类问题靠它定位），不静默降级成「想不出来」。
 */

export interface LlamafileThinkProvider {
  /** 模型文件是否就位（不 spawn）。 */
  ready(): Promise<{ ok: boolean; reason?: string }>;
  /** 把口述补成完整需求（需要时自动拉起本地服务）。 */
  refine(
    input: { text: string; recentMessages?: VoiceRefineContextMessage[] },
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 性能探针（诊断页用）：流式打一条固定短提示，量**真首 token 延迟**；
   * 生成速度只在流末给出 usage 时才报（拿 chunk 数冒充 token 数会给出看着精确、实则错的读数）。
   */
  probe(
    signal?: AbortSignal,
  ): Promise<{ ttftSeconds: number; tokensPerSecond?: number }>;
  /** 收掉本地服务进程（服务端关闭时调用；下次调用会重新拉起）。 */
  dispose(): Promise<void>;
}

export interface LlamafileThinkOptions {
  /** 内置模型根目录（`<modelsRoot>/<模型 id>/<layout.model>`）。 */
  modelsRoot: string;
  /** 模型 id（目录条目 id；决定文件位置）。 */
  modelId: string;
  /** 本地服务端口（固定一个不常用端口：探活与日志口径简单）。 */
  port?: number;
  /** 模型载入 + 就绪等待上限（0.6B 在 CPU 上数秒；慢机器留足余量）。 */
  readyTimeoutMs?: number;
  /** 单次改写的等待上限。 */
  requestTimeoutMs?: number;
  /** 测试注入。 */
  spawn?: typeof spawn;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  /** 进程日志尾部（诊断信息，最多保留 N 行）。 */
  logLines?: number;
}

const DEFAULT_PORT = 15201;

/**
 * 活着的 llamafile 子进程（进程退出时统一收掉）。
 * 服务端停了还留着 792MB 的模型进程是明确的反面教材；`process.on("exit")` 里只能做
 * 同步操作，kill 恰好是同步的。
 */
const liveChildren = new Set<ReturnType<typeof spawn>>();
let exitHookInstalled = false;
function trackChild(child: ReturnType<typeof spawn>): void {
  liveChildren.add(child);
  child.on("exit", () => liveChildren.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const target of liveChildren) {
        try {
          target.kill();
        } catch {
          // 已经没了
        }
      }
    });
  }
}

export function createLlamafileThinkProvider(
  options: LlamafileThinkOptions,
): LlamafileThinkProvider {
  const model = findBuiltinModel(options.modelId);
  const port = options.port ?? DEFAULT_PORT;
  const readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawn ?? spawn;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logLimit = options.logLines ?? 20;

  let child: ReturnType<typeof spawn> | undefined;
  let logTail: string[] = [];
  /** 就绪后不再重复探活（进程死了会经 exit 回调清掉）。 */
  let healthy = false;

  const modelFile = model
    ? join(options.modelsRoot, model.id, model.layout.model)
    : "";

  const pushLog = (chunk: Buffer | string): void => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    logTail = [...logTail, ...lines].slice(-logLimit);
  };

  const killChild = (): void => {
    const target = child;
    child = undefined;
    healthy = false;
    if (!target) return;
    try {
      target.kill();
    } catch {
      // 已经没了
    }
  };

  /** Windows 需要 `.exe` 后缀（llamafile README 明确要求改名）：硬链接一个，不复制。 */
  const executablePath = (): string => {
    if (platform !== "win32") return modelFile;
    const exePath = `${modelFile}.exe`;
    if (!existsSync(exePath)) {
      try {
        linkSync(modelFile, exePath);
      } catch {
        // 跨卷/权限不允许硬链接：退回复制（一次性代价，之后命中缓存）
        copyFileSync(modelFile, exePath);
      }
    }
    return exePath;
  };

  /**
   * 端口上是否已经有**我们的**服务：`/health` + `/v1/models` 双检。
   * 只探 `/health` 不够——端口被无关服务占用时会误判成「已就绪」，然后把改写请求
   * 打到一个不认识的端点上。
   */
  const health = async (): Promise<boolean> => {
    try {
      const [ready, models] = await Promise.all([
        fetchImpl(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2_000),
        }),
        fetchImpl(`http://127.0.0.1:${port}/v1/models`, {
          signal: AbortSignal.timeout(2_000),
        }),
      ]);
      return ready.ok && models.ok;
    } catch {
      return false;
    }
  };

  const ensureServer = async (): Promise<{ ok: boolean; reason?: string }> => {
    if (healthy && child) return { ok: true };
    if (!model) {
      return { ok: false, reason: `内置「想」模型不存在：${options.modelId}` };
    }
    if (!existsSync(modelFile)) {
      return {
        ok: false,
        reason:
          `离线「想」模型未下载（${modelFile}）。到「设置 → 语音」点「下载」，` +
          `或把模型文件放到 ${join(options.modelsRoot, model.id)}/。`,
      };
    }
    // 端口上已有我们的服务（可能是并发调用里另一个实例起的）：直接复用，不重复 spawn
    if (await health()) {
      healthy = true;
      return { ok: true };
    }

    const exe = executablePath();
    if (platform !== "win32") {
      try {
        chmodSync(exe, 0o755);
      } catch {
        // 文件系统不支持 chmod（少见）：交给 spawn 报错
      }
    }
    logTail = [];
    const started = spawnImpl(
      exe,
      [
        "--server",
        // 桌面里起引擎不该顺带弹浏览器标签（llamafile 0.9.3 起支持）
        "--nobrowser",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--log-disable",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    child = started;
    trackChild(started);
    started.stdout?.on("data", pushLog);
    started.stderr?.on("data", pushLog);
    started.on("exit", (code) => {
      if (child !== started) return;
      child = undefined;
      healthy = false;
      if (code !== 0 && code !== null) {
        pushLog(`（llamafile 退出码 ${code}）`);
      }
    });

    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await health()) {
        healthy = true;
        return { ok: true };
      }
      if (!child) {
        return {
          ok: false,
          reason:
            "离线「想」服务启动失败（进程已退出）" +
            (logTail.length ? `：${logTail.at(-1)}` : ""),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    killChild();
    return {
      ok: false,
      reason:
        `离线「想」服务 ${Math.round(readyTimeoutMs / 1000)} 秒内没就绪` +
        (logTail.length ? `：${logTail.at(-1)}` : ""),
    };
  };

  return {
    async ready() {
      if (!model) {
        return { ok: false, reason: `内置「想」模型不存在：${options.modelId}` };
      }
      if (!existsSync(modelFile)) {
        return {
          ok: false,
          reason: `离线「想」模型未下载（${modelFile}）。到「设置 → 语音」点「下载」。`,
        };
      }
      const spec = model.files[0];
      const actual = statSync(modelFile).size;
      if (spec && actual !== spec.sizeBytes) {
        return {
          ok: false,
          reason:
            `离线「想」模型文件不完整（${actual}/${spec.sizeBytes} 字节）：` +
            `删掉后重新下载，或手动放到 ${join(options.modelsRoot, model.id)}/。`,
        };
      }
      return { ok: true };
    },

    async refine(input, signal) {
      const started = await ensureServer();
      if (!started.ok) {
        throw new Error(started.reason ?? "离线「想」服务不可用");
      }
      const messages = [
        { role: "system" as const, content: REFINE_SYSTEM_PROMPT },
        ...(input.recentMessages ?? []).map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { role: "user" as const, content: input.text },
      ];
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages,
            temperature: 0.2,
            max_tokens: 512,
            stream: false,
          }),
          signal: composed,
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `离线「想」服务返回 HTTP ${response.status}${
            detail ? `：${detail.slice(0, 200)}` : ""
          }`,
        );
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("离线「想」模型没有返回内容（可能是上下文过长或生成被截断）。");
      }
      return content.trim();
    },

    async probe(signal) {
      const started = await ensureServer();
      if (!started.ok) {
        throw new Error(started.reason ?? "离线「想」服务不可用");
      }
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
      // 计时从**请求发出前**开始：首 token 延迟是「从请求到第一个 token」，
      // 不含建连时间会把本地服务也报得比实际快（读数的意义就在于可比较）。
      const began = Date.now();
      const response = await fetchImpl(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [
              { role: "system", content: "你在测链路速度，直接回答即可。" },
              { role: "user", content: "说「好」。" },
            ],
            temperature: 0,
            max_tokens: 16,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: composed,
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(`离线「想」服务返回 HTTP ${response.status}`);
      }
      let firstChunkAt: number | undefined;
      let outputTokens: number | undefined;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let parsed: {
            choices?: Array<{ delta?: { content?: unknown } }>;
            usage?: { completion_tokens?: number };
          };
          try {
            parsed = JSON.parse(payload) as typeof parsed;
          } catch {
            continue;
          }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (firstChunkAt === undefined && typeof delta === "string" && delta) {
            firstChunkAt = Date.now();
          }
          if (parsed.usage?.completion_tokens) {
            outputTokens = parsed.usage.completion_tokens;
          }
        }
      }
      if (firstChunkAt === undefined) {
        throw new Error("离线「想」服务没有返回任何内容。");
      }
      const ttftSeconds = (firstChunkAt - began) / 1000;
      const elapsed = (Date.now() - began) / 1000;
      return {
        ttftSeconds,
        ...(outputTokens === undefined || elapsed <= 0
          ? {}
          : { tokensPerSecond: outputTokens / elapsed }),
      };
    },

    async dispose() {
      killChild();
    },
  };
}
