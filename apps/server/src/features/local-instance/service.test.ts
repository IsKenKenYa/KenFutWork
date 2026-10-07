import { describe, expect, it, vi } from "vitest";

import { createLocalInstanceService } from "./service.js";

const instanceId = "db372df6-0298-4c58-a263-08b5385d2e9d";

describe("本地实例引导", () => {
  it("维护保留异步准入计数，释放幂等且拒绝维护后新准入", async () => {
    const instance = createLocalInstanceService({
      repository: { ensure: async () => instanceId },
      dataDir: "/tmp/local",
    });
    const release = instance.beginAdmission();
    expect(instance.activeAdmissionCount()).toBe(1);
    await instance.beginMaintenance(async () => {
      expect(instance.activeAdmissionCount()).toBe(1);
    });
    expect(() => instance.beginAdmission()).toThrow("暂不接收新任务");
    release();
    release();
    expect(instance.activeAdmissionCount()).toBe(0);
    instance.cancelMaintenance();
    instance.beginAdmission()();
    expect(instance.activeAdmissionCount()).toBe(0);
  });
  it("迁移维护只拒绝新任务，不替换实例或客户端身份，等待失败后恢复准入", async () => {
    const instance = createLocalInstanceService({
      repository: { ensure: async () => instanceId },
      dataDir: "/tmp/local",
    });
    let fail!: (error: Error) => void;
    const idle = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const first = instance.beginMaintenance(() => idle);
    expect(instance.beginMaintenance(async () => {})).toBe(first);
    expect(() => instance.assertReady()).toThrow("暂不接收新任务");
    await expect(
      instance.resolve({ instanceId, accessClientId: "browser" }),
    ).resolves.toMatchObject({ instanceId });
    fail(new Error("等待结束失败"));
    await expect(first).rejects.toThrow("等待结束失败");
    expect(instance.isDraining()).toBe(false);
    expect(() => instance.assertReady()).not.toThrow();
  });

  it("取消旧维护后，迟到失败不能解除新维护", async () => {
    const instance = createLocalInstanceService({
      repository: { ensure: async () => instanceId },
      dataDir: "/tmp/local",
    });
    let fail!: (error: Error) => void;
    const old = instance.beginMaintenance(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    await Promise.resolve();
    instance.cancelMaintenance();
    await instance.beginMaintenance(async () => {});
    fail(new Error("旧等待失败"));
    await expect(old).rejects.toThrow("旧等待失败");
    expect(instance.isDraining()).toBe(true);
    instance.cancelMaintenance();
    expect(instance.isDraining()).toBe(false);
  });
  it("并发引导共享同一身份，不依赖账户或客户端凭据", async () => {
    const ensure = vi.fn(async () => instanceId);
    const instance = createLocalInstanceService({
      repository: { ensure },
      dataDir: "/tmp/kenfutwork-instance",
    });
    const [first, second, actor] = await Promise.all([
      instance.getContext(),
      instance.getContext(),
      instance.serviceActor(),
    ]);
    expect(first).toEqual({ instanceId, dataDir: "/tmp/kenfutwork-instance" });
    expect(second).toBe(first);
    expect(actor).toEqual({ instanceId, accessClientId: null });
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("不同已授权客户端访问同一实例，外来实例上下文被拒绝", async () => {
    const instance = createLocalInstanceService({
      repository: { ensure: async () => instanceId },
      dataDir: "/tmp/kenfutwork-instance",
    });
    const desktop = await instance.resolve({
      instanceId,
      accessClientId: "desktop",
    });
    const browser = await instance.resolve({
      instanceId,
      accessClientId: "browser",
    });
    expect(browser).toBe(desktop);
    await expect(
      instance.resolve({ instanceId: "foreign", accessClientId: "desktop" }),
    ).rejects.toMatchObject({ code: "instance_forbidden", statusCode: 403 });
  });

  it("数据库故障原样失败并允许重试，不折叠成未登录或生成新账户", async () => {
    const failure = new Error("数据库连接中断");
    const ensure = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(instanceId);
    const instance = createLocalInstanceService({
      repository: { ensure },
      dataDir: "/tmp/local",
    });
    await expect(instance.getContext()).rejects.toBe(failure);
    await expect(instance.getContext()).resolves.toEqual({
      instanceId,
      dataDir: "/tmp/local",
    });
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("数据根迁移不改变由数据库持有的实例身份", async () => {
    const repository = { ensure: async () => instanceId };
    const before = await createLocalInstanceService({
      repository,
      dataDir: "/tmp/old",
    }).getContext();
    const after = await createLocalInstanceService({
      repository,
      dataDir: "/tmp/new",
    }).getContext();
    expect(after.instanceId).toBe(before.instanceId);
    expect(after.dataDir).toBe("/tmp/new");
  });
});
