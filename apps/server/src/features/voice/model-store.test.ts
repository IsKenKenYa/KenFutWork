import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuiltinVoiceModelSpec } from "./catalog.js";
import { createVoiceModelStore, VoiceModelError } from "./model-store.js";

/**
 * 下载器单测。这里锁的是规划 §5 的三条硬口径：
 * 未选择不下载、**校验和不匹配即失败且不留半截文件**、失败可读且可重试。
 * 用假模型表（几十字节）而非真下 228MB——口径与体积无关。
 */

const FILE_BYTES = new TextEncoder().encode("fake-model-payload");
const TOKENS_BYTES = new TextEncoder().encode("a\nb\nc\n");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 两个文件的假模型（含子目录，顺带覆盖目录创建）。 */
function fakeSpec(
  overrides: Partial<BuiltinVoiceModelSpec> = {},
): BuiltinVoiceModelSpec {
  return {
    id: "fake-model",
    segment: "listen",
    label: "假模型",
    license: "测试用",
    layout: { model: "model.onnx", tokens: "dict/tokens.txt" },
    files: [
      {
        path: "model.onnx",
        url: "https://example.test/model.onnx",
        sizeBytes: FILE_BYTES.byteLength,
        sha256: sha256(FILE_BYTES),
      },
      {
        path: "dict/tokens.txt",
        url: "https://example.test/dict/tokens.txt",
        sizeBytes: TOKENS_BYTES.byteLength,
        sha256: sha256(TOKENS_BYTES),
      },
    ],
    ...overrides,
  };
}

/** 可编程的 fetch 桩：按 URL 起头返回内容，或制造失败。 */
function servingFetch(
  handlers: Record<
    string,
    | Uint8Array
    | { status: number }
    | { body: Uint8Array; delayMs: number; neverResolve?: boolean }
    | { throw: Error }
  >,
) {
  const calls: string[] = [];
  const fetchFn = vi.fn(
    async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const key = String(url);
      calls.push(key);
      const handler = handlers[key];
      if (!handler) {
        return new Response("not found", { status: 404 });
      }
      if (handler instanceof Uint8Array) {
        return new Response(new Uint8Array(handler), { status: 200 });
      }
      if ("throw" in handler) {
        throw handler.throw;
      }
      if ("status" in handler) {
        return new Response("boom", { status: handler.status });
      }
      if (handler.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, handler.delayMs));
      }
      return new Response(new Uint8Array(handler.body), { status: 200 });
    },
  ) as unknown as typeof fetch;
  return { fetchFn, calls };
}

let modelsRoot = "";

beforeEach(async () => {
  modelsRoot = await mkdtemp(join(tmpdir(), "voice-models-"));
});

afterEach(async () => {
  await rm(modelsRoot, { recursive: true, force: true });
});

describe("下载：正常路径", () => {
  it("按表下载全部文件 → 就位（含子目录），staging 不留痕", async () => {
    const spec = fakeSpec();
    const { fetchFn } = servingFetch({
      "https://example.test/model.onnx": FILE_BYTES,
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });

    expect((await store.getState(spec.id)).state).toBe("missing");
    const started = await store.start(spec.id);
    expect(["downloading", "ready"]).toContain(started.state);

    await vi.waitFor(async () => {
      expect((await store.getState(spec.id)).state).toBe("ready");
    });
    // 内容逐字节一致
    expect(
      new Uint8Array(await readFile(join(modelsRoot, spec.id, "model.onnx"))),
    ).toEqual(FILE_BYTES);
    expect(
      new Uint8Array(
        await readFile(join(modelsRoot, spec.id, "dict/tokens.txt")),
      ),
    ).toEqual(TOKENS_BYTES);
    // 半成品目录必须清掉（否则下次「已存在」判定会误判）
    expect(existsSync(join(modelsRoot, `${spec.id}.staging`))).toBe(false);
    expect((await store.getState(spec.id)).error).toBeUndefined();
  });

  it("进度可观测：downloading 时已下载字节递增，总量取表里的体积", async () => {
    const spec = fakeSpec();
    const { fetchFn } = servingFetch({
      "https://example.test/model.onnx": {
        body: FILE_BYTES,
        delayMs: 60,
      },
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });
    await store.start(spec.id);
    const mid = await store.getState(spec.id);
    expect(mid.totalBytes).toBe(
      FILE_BYTES.byteLength + TOKENS_BYTES.byteLength,
    );
    await vi.waitFor(async () => {
      expect((await store.getState(spec.id)).state).toBe("ready");
    });
  });

  it("重复 start：不重复起任务（同一 id 只有一个在途下载）", async () => {
    const spec = fakeSpec();
    const { fetchFn, calls } = servingFetch({
      "https://example.test/model.onnx": { body: FILE_BYTES, delayMs: 40 },
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });
    await Promise.all([
      store.start(spec.id),
      store.start(spec.id),
      store.start(spec.id),
    ]);
    await vi.waitFor(async () => {
      expect((await store.getState(spec.id)).state).toBe("ready");
    });
    // 每个文件只下了一次
    expect(calls.filter((url) => url.endsWith("model.onnx"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("tokens.txt"))).toHaveLength(1);
  });
});

describe("下载：校验与失败处理（核心口径）", () => {
  it("校验和不匹配：失败、可读原因、**不留半截文件**", async () => {
    const spec = fakeSpec();
    // 长度与表里声明一致、内容被换掉：只有哈希能挡住它（这正是哈希存在的意义）
    const tampered = new Uint8Array(FILE_BYTES.byteLength).fill(0x21);
    const { fetchFn } = servingFetch({
      "https://example.test/model.onnx": tampered,
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });
    await store.start(spec.id);
    const state = await vi.waitFor(async () => {
      const current = await store.getState(spec.id);
      expect(current.state).toBe("missing");
      return current;
    });
    expect(state.error).toContain("校验和不匹配");
    expect(state.error).toContain("model.onnx");
    // 手动放置路径要写在原因里（下载不通时的唯一出路）
    expect(state.error).toContain(join(modelsRoot, spec.id));
    expect(existsSync(join(modelsRoot, spec.id))).toBe(false);
    expect(existsSync(join(modelsRoot, `${spec.id}.staging`))).toBe(false);
  });

  it("体积不符：同样失败且不留文件", async () => {
    const spec = fakeSpec();
    const { fetchFn } = servingFetch({
      // 大小对不上（表里声明的是文件名，这里少一个字节）
      "https://example.test/model.onnx": FILE_BYTES.subarray(1),
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });
    await store.start(spec.id);
    const state = await vi.waitFor(async () => {
      const current = await store.getState(spec.id);
      expect(current.state).toBe("missing");
      return current;
    });
    expect(state.error).toContain("文件大小不符");
    expect(existsSync(join(modelsRoot, spec.id))).toBe(false);
  });

  it("HTTP 失败与网络异常：都落到可读原因（不抛未捕获异常）", async () => {
    const spec = fakeSpec();
    const http = servingFetch({
      "https://example.test/model.onnx": { status: 500 },
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const httpStore = createVoiceModelStore({
      modelsRoot,
      specs: [spec],
      fetchFn: http.fetchFn,
    });
    await httpStore.start(spec.id);
    const httpState = await vi.waitFor(async () => {
      const current = await httpStore.getState(spec.id);
      expect(current.state).toBe("missing");
      return current;
    });
    expect(httpState.error).toContain("HTTP 500");

    const netErr = servingFetch({
      "https://example.test/model.onnx": {
        throw: new Error("getaddrinfo ENOTFOUND"),
      },
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const netStore = createVoiceModelStore({
      modelsRoot,
      specs: [spec],
      fetchFn: netErr.fetchFn,
    });
    await netStore.start(spec.id);
    const netState = await vi.waitFor(async () => {
      const current = await netStore.getState(spec.id);
      expect(current.state).toBe("missing");
      return current;
    });
    expect(netState.error).toContain("ENOTFOUND");
  });

  it("失败后重试：换回正确内容即成功（重试路径不留旧失败原因）", async () => {
    const spec = fakeSpec();
    let broken = true;
    const fetchFn = vi.fn(async (url: string | URL) => {
      if (broken) return new Response("bad", { status: 502 });
      const bytes = String(url).endsWith("model.onnx")
        ? FILE_BYTES
        : TOKENS_BYTES;
      return new Response(new Uint8Array(bytes), { status: 200 });
    }) as unknown as typeof fetch;
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });

    await store.start(spec.id);
    await vi.waitFor(async () => {
      expect((await store.getState(spec.id)).state).toBe("missing");
    });
    expect((await store.getState(spec.id)).error).toBeDefined();

    broken = false;
    await store.start(spec.id);
    await vi.waitFor(async () => {
      expect((await store.getState(spec.id)).state).toBe("ready");
    });
    expect((await store.getState(spec.id)).error).toBeUndefined();
  });

  it("取消（fetch 层）：中断下载、清干净、状态回到未下载且不留失败原因", async () => {
    const spec = fakeSpec();
    const { fetchFn } = servingFetch({
      "https://example.test/model.onnx": { body: FILE_BYTES, delayMs: 200 },
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });
    await store.start(spec.id);
    store.cancel(spec.id);
    const state = await vi.waitFor(async () => {
      const current = await store.getState(spec.id);
      expect(current.state).toBe("missing");
      return current;
    });
    expect(existsSync(join(modelsRoot, spec.id))).toBe(false);
    expect(existsSync(join(modelsRoot, `${spec.id}.staging`))).toBe(false);
    // 取消是用户意图，不是失败：不能留「失败原因」把界面搞成红字
    expect(state.error).toBeUndefined();
  });

  it("取消（文件切换间隙）：stub 完全不理会 signal 时，也不许把模型提交就位", async () => {
    const spec = fakeSpec();
    // 这个 stub **故意**忽略 AbortSignal（模拟不听话的 fetch 实现/响应已就绪）：
    // 若只在 fetch 层依赖取消，这里会把模型 commit 掉，用户点了取消却装上了
    const fetchFn = vi.fn(async (url: string | URL) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const bytes = String(url).endsWith("model.onnx")
        ? FILE_BYTES
        : TOKENS_BYTES;
      return new Response(new Uint8Array(bytes), { status: 200 });
    }) as unknown as typeof fetch;
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });
    await store.start(spec.id);
    // 第一个文件下载途中取消；第二个文件的循环边界必须拦住它
    await new Promise((resolve) => setTimeout(resolve, 10));
    store.cancel(spec.id);
    const state = await vi.waitFor(async () => {
      const current = await store.getState(spec.id);
      expect(current.state).toBe("missing");
      return current;
    });
    expect(existsSync(join(modelsRoot, spec.id))).toBe(false);
    expect(state.error).toBeUndefined();
  });
});

describe("删除与查表", () => {
  it("删除：文件清掉、状态回未下载", async () => {
    const spec = fakeSpec();
    const { fetchFn } = servingFetch({
      "https://example.test/model.onnx": FILE_BYTES,
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });
    await store.start(spec.id);
    await vi.waitFor(async () => {
      expect((await store.getState(spec.id)).state).toBe("ready");
    });

    await store.remove(spec.id);
    expect(existsSync(join(modelsRoot, spec.id))).toBe(false);
    expect((await store.getState(spec.id)).state).toBe("missing");
  });

  it("文件不全（少了词表）不算就绪——大小任一处不符即 missing", async () => {
    const spec = fakeSpec();
    await mkdir(join(modelsRoot, spec.id), { recursive: true });
    await writeFile(join(modelsRoot, spec.id, "model.onnx"), FILE_BYTES);
    const store = createVoiceModelStore({ modelsRoot, specs: [spec] });
    expect((await store.getState(spec.id)).state).toBe("missing");

    await mkdir(join(modelsRoot, spec.id, "dict"), { recursive: true });
    await writeFile(join(modelsRoot, spec.id, "dict/tokens.txt"), TOKENS_BYTES);
    expect((await store.getState(spec.id)).state).toBe("ready");
  });

  it("大小一致但内容被改过：仍判 ready（就位判定不重算哈希，见实现注释）", async () => {
    const spec = fakeSpec();
    await mkdir(join(modelsRoot, spec.id, "dict"), { recursive: true });
    await writeFile(
      join(modelsRoot, spec.id, "model.onnx"),
      new Uint8Array(FILE_BYTES.byteLength), // 同长度的零字节
    );
    await writeFile(join(modelsRoot, spec.id, "dict/tokens.txt"), TOKENS_BYTES);
    const store = createVoiceModelStore({ modelsRoot, specs: [spec] });
    // 这是有意的取舍：每次列目录都哈希 228MB 不可接受，改为「下载时严格校验」
    expect((await store.getState(spec.id)).state).toBe("ready");
  });

  it("未知模型 id：拒绝（不做任意 URL 下载器）", async () => {
    const store = createVoiceModelStore({ modelsRoot, specs: [fakeSpec()] });
    await expect(store.start("../../evil")).rejects.toBeInstanceOf(
      VoiceModelError,
    );
    await expect(store.start("ghost")).rejects.toThrow(/未知的内置模型/);
    await expect(store.remove("ghost")).rejects.toThrow(/未知的内置模型/);
    expect(existsSync(join(modelsRoot, "..", "evil"))).toBe(false);
  });

  it("默认表存在就绪判定用的是真实内置模型的体积（不与假表串味）", async () => {
    const store = createVoiceModelStore({ modelsRoot });
    const state = await store.getState("sensevoice-small-int8");
    expect(state.totalBytes).toBe(239_233_841 + 315_894);
    expect(state.state).toBe("missing");
  });
});

describe("附属路径工具", () => {
  it("stat 能读到写下去的文件（防止测试自己骗自己）", async () => {
    const spec = fakeSpec();
    const { fetchFn } = servingFetch({
      "https://example.test/model.onnx": FILE_BYTES,
      "https://example.test/dict/tokens.txt": TOKENS_BYTES,
    });
    const store = createVoiceModelStore({ modelsRoot, specs: [spec], fetchFn });
    await store.start(spec.id);
    await vi.waitFor(async () => {
      expect((await store.getState(spec.id)).state).toBe("ready");
    });
    const info = await stat(join(modelsRoot, spec.id, "model.onnx"));
    expect(info.size).toBe(FILE_BYTES.byteLength);
  });
});
