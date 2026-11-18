import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { findBuiltinModel } from "../catalog.js";
import { createLlamafileThinkProvider } from "./llamafile.js";

/**
 * 离线「想」档（llamafile）的 provider 口径：
 *  - `ready()` 只查文件（就位/未下载/大小不符各自给可读原因）；
 *  - 拉起命令带 `--server --nobrowser`（llamafile 默认会弹浏览器标签，桌面里不该弹）；
 *  - 端口上已有我们的服务就复用（并发调用不重复 spawn、也不误认无关服务）；
 *  - `probe()` 量**真首 token 延迟**（流式），tok/s 只在有 usage 时给。
 *
 * 夹具纪律：模型目录只借「尺寸」用，文件按真实大小 truncate（≈756MB/个），
 * **用完必须删**——本文件 6 个用例各建一个，不清理就是每次测试往 %TEMP% 丢 ~4.5GB；
 * 2026-10-09 实测 %TEMP% 堆到 3280 个本仓目录、共 65GB，把 C 盘写满。
 */
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fakeChild() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
    on(event: string, handler: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    kill: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
  };
}

function modelDir() {
  const root = mkdtempSync(join(tmpdir(), "kfw-llamafile-"));
  fixtureRoots.push(root);
  const model = findBuiltinModel("qwen3-0.6b-llamafile");
  if (!model) throw new Error("目录里没有 think 档");
  const dir = join(root, model.id);
  // 与 model-store 的落盘一致：模型目录由下载器建；这里手工建出来放文件
  mkdirSync(dir, { recursive: true });
  return { root, dir, model, file: join(dir, model.layout.model) };
}

/** 让 health 探针（/health + /v1/models）立刻通过。 */
function healthyFetch(
  extra?: (url: string, init?: RequestInit) => Response | undefined,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = extra?.(url, init);
    if (custom) return custom;
    if (url.endsWith("/health") || url.endsWith("/v1/models")) {
      return Response.json({ ok: true });
    }
    return Response.json({});
  });
}

/**
 * 探针在「进程已拉起」之前一律失败（否则 ensureServer 会认为端口上已有服务，
 * 直接跳过 spawn——那正是要断言的那一步）。
 */
function fetchGated(
  isSpawned: () => boolean,
  completion: { choices: Array<{ message: { content: string } }> },
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/v1/models")) {
      if (!isSpawned()) throw new Error("ECONNREFUSED");
      return Response.json({ ok: true });
    }
    if (url.endsWith("/v1/chat/completions")) {
      return Response.json(completion);
    }
    return Response.json({});
  });
}

/** 就位文件用截断造（792MB 真分配会把每个用例拖成数秒）。 */
function placeModelFile(file: string, sizeBytes: number): void {
  writeFileSync(file, "");
  truncateSync(file, sizeBytes);
}

describe("llamafile 离线「想」档", () => {
  it("ready：未下载 / 大小不符 / 就位 三态都给可读结论", async () => {
    const { root, dir, model, file } = modelDir();
    const provider = createLlamafileThinkProvider({
      modelsRoot: root,
      modelId: model.id,
      fetchImpl: healthyFetch(),
    });
    const missing = await provider.ready();
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("未下载");

    writeFileSync(file, Buffer.alloc(1024));
    const partial = await provider.ready();
    expect(partial.ok).toBe(false);
    expect(partial.reason).toContain("不完整");

    placeModelFile(file, model.files[0]?.sizeBytes ?? 0);
    expect(await provider.ready()).toEqual({ ok: true });
    void dir;
  });

  it("拉起命令：--server --nobrowser + 绑定回环端口；复用已有服务不重复 spawn", async () => {
    const { root, model, file } = modelDir();
    placeModelFile(file, model.files[0]?.sizeBytes ?? 0);
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    const child = fakeChild();
    const provider = createLlamafileThinkProvider({
      modelsRoot: root,
      modelId: model.id,
      platform: "linux",
      spawn: ((command: string, args: readonly string[]) => {
        spawns.push({ command, args });
        return child;
      }) as never,
      fetchImpl: fetchGated(() => spawns.length > 0, {
        choices: [{ message: { content: "  补全后的需求。  " } }],
      }),
    });

    const refined = await provider.refine({ text: "把那个按钮改蓝一点" });
    expect(refined).toBe("补全后的需求。");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe(file);
    expect(spawns[0]?.args).toContain("--server");
    expect(spawns[0]?.args).toContain("--nobrowser");
    expect(spawns[0]?.args).toContain("127.0.0.1");

    // 第二次调用：服务已就绪 → 不再 spawn
    await provider.refine({ text: "再来一条" });
    expect(spawns).toHaveLength(1);
    await provider.dispose();
    expect(child.kill).toHaveBeenCalled();
  });

  it("Windows：补一个 .exe 后缀再拉起（llamafile README 的硬要求）", async () => {
    const { root, model, file } = modelDir();
    placeModelFile(file, model.files[0]?.sizeBytes ?? 0);
    const commands: string[] = [];
    const provider = createLlamafileThinkProvider({
      modelsRoot: root,
      modelId: model.id,
      platform: "win32",
      spawn: ((command: string) => {
        commands.push(command);
        return fakeChild();
      }) as never,
      fetchImpl: fetchGated(() => commands.length > 0, {
        choices: [{ message: { content: "ok" } }],
      }),
    });
    await provider.refine({ text: "x" });
    expect(commands[0]).toBe(`${file}.exe`);
  });

  it("改写：带上同一份系统提示词与最近上下文；空返回报可读错误", async () => {
    const { root, model, file } = modelDir();
    placeModelFile(file, model.files[0]?.sizeBytes ?? 0);
    const captured: Array<{
      messages: Array<{ role: string; content: string }>;
    }> = [];
    const provider = createLlamafileThinkProvider({
      modelsRoot: root,
      modelId: model.id,
      platform: "linux",
      spawn: (() => fakeChild()) as never,
      fetchImpl: healthyFetch((url, init) => {
        if (!url.endsWith("/v1/chat/completions")) return undefined;
        captured.push(
          JSON.parse(String(init?.body ?? "{}")) as (typeof captured)[number],
        );
        return Response.json({ choices: [{ message: { content: "补全。" } }] });
      }),
    });
    await provider.refine({
      text: "把它改成蓝色",
      recentMessages: [{ role: "assistant", content: "刚生成了首页" }],
    });
    expect(captured[0]?.messages[0]?.role).toBe("system");
    expect(captured[0]?.messages[0]?.content).toContain(
      "不许添加用户没说的约束",
    );
    expect(captured[0]?.messages[1]).toEqual({
      role: "assistant",
      content: "刚生成了首页",
    });
    expect(captured[0]?.messages[2]).toEqual({
      role: "user",
      content: "把它改成蓝色",
    });

    const empty = createLlamafileThinkProvider({
      modelsRoot: root,
      modelId: model.id,
      platform: "linux",
      spawn: (() => fakeChild()) as never,
      fetchImpl: healthyFetch((url) =>
        url.endsWith("/v1/chat/completions")
          ? Response.json({ choices: [{ message: { content: "   " } }] })
          : undefined,
      ),
    });
    await expect(empty.refine({ text: "x" })).rejects.toThrow(/没有返回内容/);
  });

  it("probe：流式量真首 token 延迟；有 usage 才报 tok/s", async () => {
    const { root, model, file } = modelDir();
    placeModelFile(file, model.files[0]?.sizeBytes ?? 0);
    const sse = [
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      'data: {"choices":[{"delta":{"content":"。"}}],"usage":{"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = createLlamafileThinkProvider({
      modelsRoot: root,
      modelId: model.id,
      platform: "linux",
      spawn: (() => fakeChild()) as never,
      // 生成速度按「流末 usage / 实际耗时」算；假响应必须真的花一点时间，
      // 否则耗时是 0，provider 按口径不给 tok/s（那正是它要防的假读数）
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/health") || url.endsWith("/v1/models")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/v1/chat/completions")) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new Response(sse, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({});
      }),
    });
    const report = await provider.probe();
    expect(report.ttftSeconds).toBeGreaterThanOrEqual(0);
    expect(report.tokensPerSecond).toBeGreaterThan(0);
  });

  it("端口被无关服务占用（/v1/models 不通）：不误认，如实报错", async () => {
    const { root, model, file } = modelDir();
    placeModelFile(file, model.files[0]?.sizeBytes ?? 0);
    const provider = createLlamafileThinkProvider({
      modelsRoot: root,
      modelId: model.id,
      platform: "linux",
      readyTimeoutMs: 1_500,
      spawn: (() => fakeChild()) as never,
      // /health 通、/v1/models 不通 → 不是我们的服务
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/health")) return Response.json({ ok: true });
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(provider.refine({ text: "x" })).rejects.toThrow(
      /没就绪|启动失败/,
    );
  });
});
