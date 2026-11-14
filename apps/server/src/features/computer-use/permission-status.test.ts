import { describe, expect, it } from "vitest";

import {
  buildPermissionStatus,
  resolveGrantOwner,
} from "./permission-status.js";

const owner = {
  appPath: "/Applications/KenFutWork.app",
  displayName: "KenFutWork",
};

describe("resolveGrantOwner（授权主体）", () => {
  it("打包形态：从可执行文件路径取到应用包", () => {
    expect(
      resolveGrantOwner(
        "/Applications/KenFutWork.app/Contents/MacOS/kenfutwork-server",
      ),
    ).toEqual(owner);
  });

  it("嵌套目录：取最外层包含 .app 的路径", () => {
    expect(
      resolveGrantOwner(
        "/Users/me/Applications/KenFutWork.app/Contents/Resources/bin/server",
      ),
    ).toEqual({
      appPath: "/Users/me/Applications/KenFutWork.app",
      displayName: "KenFutWork",
    });
  });

  it("开发形态（node 可执行文件）与相对路径都返回 null", () => {
    expect(resolveGrantOwner("/usr/local/bin/node")).toBeNull();
    expect(resolveGrantOwner("node")).toBeNull();
    expect(resolveGrantOwner("")).toBeNull();
  });

  it("应用包名为空时使用兜底名称", () => {
    expect(resolveGrantOwner("/tmp/.app/Contents/MacOS/x")).toEqual({
      appPath: "/tmp/.app",
      displayName: "KenFutWork",
    });
  });
});

describe("buildPermissionStatus（权限状态口径）", () => {
  const base = {
    accessibility: "granted" as const,
    screen: "granted" as const,
    postEvents: "granted" as const,
    automation: "granted" as const,
    hint: "权限查询通过",
    owner,
  };

  it("全部授予：pending 为假，授权主体指向应用包", () => {
    expect(buildPermissionStatus(base)).toEqual({
      available: true,
      platform: "darwin",
      grantOwner: "/Applications/KenFutWork.app",
      grantOwnerDisplayName: "KenFutWork",
      accessibility: "granted",
      screenRecording: "granted",
      automation: "granted",
      pending: false,
      reason: "权限查询通过",
    });
  });

  it("辅助功能已授予但输入事件被拒：按辅助功能未授权呈现", () => {
    const status = buildPermissionStatus({ ...base, postEvents: "denied" });
    expect(status.accessibility).toBe("denied");
    expect(status.pending).toBe(true);
  });

  it("屏幕录制未授予：pending 为真", () => {
    const status = buildPermissionStatus({ ...base, screen: "denied" });
    expect(status.screenRecording).toBe("denied");
    expect(status.pending).toBe(true);
  });

  it("自动化明确被拒：pending 为真；探测不到时不算未完成", () => {
    expect(
      buildPermissionStatus({ ...base, automation: "denied" }).pending,
    ).toBe(true);
    const undetermined = buildPermissionStatus({
      ...base,
      automation: "not_determined",
    });
    expect(undetermined.automation).toBe("unknown");
    expect(undetermined.pending).toBe(false);
  });

  it("没有授权主体时 grantOwner 为 null 且不写显示名", () => {
    const status = buildPermissionStatus({ ...base, owner: null });
    expect(status.grantOwner).toBeNull();
    expect(status).not.toHaveProperty("grantOwnerDisplayName");
  });

  it("未探测状态统一按 unknown 呈现，不谎报已授权", () => {
    const status = buildPermissionStatus({
      ...base,
      accessibility: "not_determined",
      screen: "not_determined",
      postEvents: undefined,
      automation: undefined,
    });
    expect(status.accessibility).toBe("unknown");
    expect(status.screenRecording).toBe("unknown");
    expect(status.automation).toBe("unknown");
    expect(status.pending).toBe(true);
  });
});
