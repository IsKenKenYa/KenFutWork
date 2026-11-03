import { describe, expect, it, vi } from "vitest";
import { saveNetworkSetting } from "../src/lib/network-settings-save.js";

const hints = {
  savedHint: "网络代理设置已保存，重启应用后生效",
  invalidHint: "请填写 http 或 https 开头的代理地址",
};

describe("网络设置保存的失败提示", () => {
  it("服务端拒绝时提示填写规则，只提示一次并返回 false", async () => {
    const notify = vi.fn();
    const save = vi.fn().mockRejectedValue(new Error("HTTP 代理地址不是合法 URL。"));

    await expect(saveNetworkSetting({ save, notify, hints })).resolves.toBe(
      false,
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(hints.invalidHint);
  });

  it("非 Error 拒绝同样提示填写规则，不吞掉保存动作", async () => {
    const notify = vi.fn();
    const save = vi.fn().mockRejectedValue("HTTP 代理地址只支持 http/https。");

    await expect(saveNetworkSetting({ save, notify, hints })).resolves.toBe(
      false,
    );
    expect(notify).toHaveBeenCalledWith(hints.invalidHint);
  });

  it("保存成功提示已保存并返回 true", async () => {
    const notify = vi.fn();
    const save = vi.fn().mockResolvedValue(undefined);

    await expect(saveNetworkSetting({ save, notify, hints })).resolves.toBe(
      true,
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(hints.savedHint);
  });

  it("成功与失败互斥：失败时不会同时出现已保存提示", async () => {
    const notify = vi.fn();
    await saveNetworkSetting({
      save: () => Promise.reject(new Error("证书路径不可读")),
      notify,
      hints: {
        savedHint: "已保存",
        invalidHint: "请填写本机可读的证书绝对路径",
      },
    });
    expect(notify.mock.calls.flat()).not.toContain("已保存");
  });
});
