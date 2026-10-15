import { afterEach, expect, it, vi } from "vitest";
import { createHostWorkbenchNavigation } from "../src/components/workbench/zcode/host/workbenchNavigation";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});
function send(data: Record<string, unknown>, source: Window = window) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source,
      origin: window.location.origin,
      data: {
        type: "kenfutwork:workbench-navigation",
        availableModes: ["code", "design"],
        ...data,
      },
    }),
  );
}
it("父模式推送经异步准入；未确认或取消时保留已选模式", async () => {
  let confirm!: (allowed: boolean) => void;
  const admit = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
  );
  const navigation = createHostWorkbenchNavigation(
    window,
    ["code", "design"],
    admit,
  );
  cleanups.push(navigation.dispose);
  send({ mode: "design" });
  expect(navigation.getSnapshot().mode).toBe("code");
  expect(admit).toHaveBeenCalledExactlyOnceWith("design");
  confirm(false);
  await Promise.resolve();
  expect(navigation.getSnapshot().mode).toBe("code");
  send({ mode: "design" });
  confirm(true);
  await Promise.resolve();
  expect(navigation.getSnapshot().mode).toBe("design");
});
it("能力列表更新保留已选模式，不重复准入，也不抹掉正在解析的文档目标", () => {
  const admit = vi.fn(async () => true);
  const navigation = createHostWorkbenchNavigation(
    window,
    ["code", "design"],
    admit,
  );
  cleanups.push(navigation.dispose);
  navigation.setActiveMode("design");
  send({
    documentTarget: {
      resourceType: "canvas",
      documentId: "c1000000-0000-4000-8000-000000000001",
    },
  });
  send({ availableModes: ["code", "design", "flow"] });
  expect(navigation.getSnapshot()).toMatchObject({
    mode: "design",
    availableModes: ["code", "design", "flow"],
    documentTarget: {
      resourceType: "canvas",
      documentId: "c1000000-0000-4000-8000-000000000001",
    },
  });
  expect(admit).not.toHaveBeenCalled();
});
it("后发父导航撤销在飞旧模式切换；旧评估回执和卸载后回执不能覆盖新目标", async () => {
  let confirm!: (allowed: boolean) => void;
  const navigation = createHostWorkbenchNavigation(
    window,
    ["code", "design"],
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  cleanups.push(navigation.dispose);
  send({ mode: "design" });
  const old = confirm;
  send({ mode: "code" });
  confirm(true);
  await Promise.resolve();
  old(true);
  await Promise.resolve();
  expect(navigation.getSnapshot().mode).toBe("code");
  send({ mode: "design" });
  navigation.dispose();
  confirm(true);
  await Promise.resolve();
  expect(navigation.getSnapshot().mode).toBe("code");
});
