import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskSaver } from "../src/lib/task-saver";

/**
 * 流式任务持久化节流（task-saver）的纯逻辑测试。
 *
 * 锁住的口径：一串快速写入（message/thinking delta 每 token 一次）里**第一次立即
 * 落盘**（burst 开始不丢），其余合并到静默期末补写最新一份；flush 强制落盘——
 * 终态事件后 localStorage 里必须是终态，不能滞留在节流窗口里。
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTaskSaver 节流", () => {
  it("窗口外的第一次写入立即落盘", () => {
    const writes: Array<[string, unknown]> = [];
    const saver = createTaskSaver((mode, list) => writes.push([mode, list]));
    saver.save("code", [{ id: 1 }]);
    expect(writes).toEqual([["code", [{ id: 1 }]]]);
  });

  it("窗口内的快速写入合并：静默期末只补写最新一份", () => {
    const writes: Array<[string, unknown]> = [];
    const saver = createTaskSaver((mode, list) => writes.push([mode, list]), {
      delayMs: 400,
    });
    saver.save("code", [{ id: 1 }]);
    saver.save("code", [{ id: 2 }]);
    saver.save("code", [{ id: 3 }]);
    // burst 期间的中间版本不落盘（首写已在窗口外落过 id:1）
    expect(writes).toEqual([["code", [{ id: 1 }]]]);
    vi.advanceTimersByTime(400);
    expect(writes).toEqual([
      ["code", [{ id: 1 }]],
      ["code", [{ id: 3 }]],
    ]);
  });

  it("flush 立即写出待写内容，不等到静默期", () => {
    const writes: Array<[string, unknown]> = [];
    const saver = createTaskSaver((mode, list) => writes.push([mode, list]), {
      delayMs: 400,
    });
    saver.save("code", [{ id: 1 }]);
    saver.save("code", [{ id: 2 }]);
    saver.flush("code");
    expect(writes).toEqual([
      ["code", [{ id: 1 }]],
      ["code", [{ id: 2 }]],
    ]);
    // 静默期到点不再重复写
    vi.advanceTimersByTime(400);
    expect(writes).toHaveLength(2);
  });

  it("flush 无待写内容时是空操作", () => {
    const writes: Array<[string, unknown]> = [];
    const saver = createTaskSaver((mode, list) => writes.push([mode, list]));
    saver.save("code", [{ id: 1 }]);
    saver.flush("code");
    expect(writes).toHaveLength(1);
  });

  it("不同 mode 各自节流，互不吞并", () => {
    const writes: Array<[string, unknown]> = [];
    const saver = createTaskSaver((mode, list) => writes.push([mode, list]), {
      delayMs: 400,
    });
    saver.save("code", [{ id: "c" }]);
    saver.save("design", [{ id: "d" }]);
    saver.save("code", [{ id: "c2" }]);
    saver.save("design", [{ id: "d2" }]);
    vi.advanceTimersByTime(400);
    const byCode = writes.filter(([mode]) => mode === "code");
    const byDesign = writes.filter(([mode]) => mode === "design");
    expect(byCode.at(-1)).toEqual(["code", [{ id: "c2" }]]);
    expect(byDesign.at(-1)).toEqual(["design", [{ id: "d2" }]]);
  });

  it("无参 flush 落盘全部 mode", () => {
    const writes: Array<[string, unknown]> = [];
    const saver = createTaskSaver((mode, list) => writes.push([mode, list]), {
      delayMs: 400,
    });
    saver.save("code", [{ id: 1 }]);
    saver.save("design", [{ id: 2 }]);
    saver.save("code", [{ id: 3 }]);
    saver.flush();
    const flushed = writes.slice(1);
    expect(flushed).toContainEqual(["code", [{ id: 3 }]]);
    expect(flushed).toContainEqual(["design", [{ id: 2 }]]);
  });
});
