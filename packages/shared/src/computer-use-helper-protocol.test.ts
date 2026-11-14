import { expect, it } from "vitest";
import {
  computerUseHelperApplicationsResultSchema,
  computerUseHelperAxNodeSchema,
  computerUseHelperAxTreeParamsSchema,
  computerUseHelperAxTreeResultSchema,
  computerUseHelperClickParamsSchema,
  computerUseHelperClipboardWriteParamsSchema,
  computerUseHelperDisplaysResultSchema,
  computerUseHelperDragParamsSchema,
  computerUseHelperHelloParamsSchema,
  computerUseHelperKeyParamsSchema,
  computerUseHelperPermissionRequestParamsSchema,
  computerUseHelperPermissionRequestResultSchema,
  computerUseHelperPermissionStatusParamsSchema,
  computerUseHelperPermissionStatusSchema,
  computerUseHelperRequestSchema,
  computerUseHelperResponseSchema,
  computerUseHelperScreenshotParamsSchema,
  computerUseHelperScreenshotResultSchema,
  computerUseHelperScrollParamsSchema,
  computerUseHelperTypeParamsSchema,
  computerUseHelperWindowsParamsSchema,
  computerUseHelperWindowsResultSchema,
  parseComputerUseHelperRequestLine,
  serializeComputerUseHelperResponse,
} from "./computer-use-helper-protocol.js";

const helperBundleId = "com.kenfutwork.cua-helper";
const helperPath =
  "/Applications/KenFutWork.app/Contents/Resources/cua-helper/KenFutWork Computer Use.app";

it("hello 请求只接受协议版本 1、客户端信息和 32 字节 token", () => {
  const valid = {
    protocolVersion: 1,
    client: "kenfutwork-desktop",
    clientVersion: "0.1.3",
    token: "a".repeat(64),
  };
  expect(computerUseHelperHelloParamsSchema.parse(valid)).toEqual(valid);
  for (const invalid of [
    { ...valid, protocolVersion: 2 },
    { ...valid, protocolVersion: "1" },
    { ...valid, token: "a".repeat(32) },
    { ...valid, token: "a".repeat(63) },
    { ...valid, token: "a".repeat(65) },
    { ...valid, token: "A".repeat(64) },
    { ...valid, token: "g".repeat(64) },
    { ...valid, client: "" },
    { ...valid, extra: true },
  ])
    expect(computerUseHelperHelloParamsSchema.safeParse(invalid).success).toBe(
      false,
    );
});

it("权限状态必须指向 Helper 身份，不能用主应用冒充授权主体", () => {
  const valid = {
    available: true,
    helperBundleId,
    helperPath,
    teamIdentifier: "8A5X4JJ39T",
    accessibility: "granted",
    screenRecording: "denied",
    grantOwner: helperPath,
    reason: "屏幕录制未授权",
  };
  expect(computerUseHelperPermissionStatusSchema.parse(valid)).toEqual(valid);

  for (const invalid of [
    { ...valid, grantOwner: "com.kenfutwork.desktop" },
    { ...valid, grantOwner: "/Applications/KenFutWork.app" },
    { ...valid, helperPath: "" },
    { ...valid, helperPath: "relative/helper.app" },
    { ...valid, accessibility: "maybe" },
    { ...valid, screenRecording: "stale" },
    { ...valid, teamIdentifier: 7 },
  ])
    expect(
      computerUseHelperPermissionStatusSchema.safeParse(invalid).success,
    ).toBe(false);
});

it("permission.status 功能探针参数只接受布尔 probe", () => {
  expect(computerUseHelperPermissionStatusParamsSchema.parse({})).toEqual({});
  expect(
    computerUseHelperPermissionStatusParamsSchema.parse({ probe: true }),
  ).toEqual({ probe: true });
  for (const invalid of [{ probe: "yes" }, { probe: 1 }, { extra: true }])
    expect(
      computerUseHelperPermissionStatusParamsSchema.safeParse(invalid).success,
    ).toBe(false);
});

it("响应区分成功与错误，错误保留 actionSent", () => {
  const success = { id: "1", ok: true, result: { pong: true } };
  expect(computerUseHelperResponseSchema.parse(success)).toEqual(success);

  const failure = {
    id: "2",
    ok: false,
    error: {
      code: "permission_denied",
      message: "辅助功能未授权",
      actionSent: false,
    },
  };
  expect(computerUseHelperResponseSchema.parse(failure)).toEqual(failure);

  for (const invalid of [
    { id: "3", ok: true, error: failure.error },
    { id: "4", ok: false },
    { id: "5", ok: false, error: { code: "", message: "x" } },
    { id: "6", ok: false, error: { code: "x", message: "" } },
  ])
    expect(computerUseHelperResponseSchema.safeParse(invalid).success).toBe(
      false,
    );
});

it("permission.request 只接受两类权限，结果保留可选 granted 与 reason", () => {
  for (const kind of ["accessibility", "screen_recording"])
    expect(
      computerUseHelperPermissionRequestParamsSchema.parse({ kind }),
    ).toEqual({ kind });
  expect(
    computerUseHelperPermissionRequestParamsSchema.safeParse({ kind: "camera" })
      .success,
  ).toBe(false);
  expect(
    computerUseHelperPermissionRequestResultSchema.parse({
      requested: true,
      granted: false,
      reason: "测试授权提示",
    }),
  ).toEqual({
    requested: true,
    granted: false,
    reason: "测试授权提示",
  });
  expect(
    computerUseHelperPermissionRequestResultSchema.safeParse({
      requested: true,
      granted: false,
      extra: true,
    }).success,
  ).toBe(false);
});

it("逐行协议拒绝坏 JSON 和非对象请求，序列化响应带换行", () => {
  expect(
    parseComputerUseHelperRequestLine('{"id":"1","method":"ping"}'),
  ).toEqual({ id: "1", method: "ping" });
  expect(parseComputerUseHelperRequestLine("not json")).toBeNull();
  expect(parseComputerUseHelperRequestLine("   ")).toBeNull();
  expect(parseComputerUseHelperRequestLine('{"method":"ping"}')).toBeNull();
  expect(
    computerUseHelperRequestSchema.safeParse({
      id: "1",
      method: "ping",
      extra: true,
    }).success,
  ).toBe(false);

  const line = serializeComputerUseHelperResponse({
    id: "1",
    ok: true,
    result: { pong: true },
  });
  expect(line.endsWith("\n")).toBe(true);
  expect(JSON.parse(line.trim())).toEqual({
    id: "1",
    ok: true,
    result: { pong: true },
  });
});

it("显示器结果保留逻辑边界、缩放与主屏标记", () => {
  const result = {
    displays: [
      {
        id: "1",
        name: "内建视网膜显示器",
        bounds: { x: 0, y: 0, width: 1512, height: 982 },
        scaleFactor: 2,
        primary: true,
      },
    ],
  };
  expect(computerUseHelperDisplaysResultSchema.parse(result)).toEqual(result);
  expect(
    computerUseHelperDisplaysResultSchema.safeParse({
      displays: [
        { ...result.displays[0], bounds: { x: 0, y: 0, width: 0, height: 1 } },
      ],
    }).success,
  ).toBe(false);
  expect(
    computerUseHelperDisplaysResultSchema.safeParse({
      displays: [{ ...result.displays[0], scaleFactor: 0 }],
    }).success,
  ).toBe(false);
});

it("应用与窗口枚举保留 pid、几何位置和屏幕可见状态", () => {
  const applications = {
    applications: [
      {
        pid: 501,
        name: "Finder",
        bundleId: "com.apple.finder",
        path: "/System/Library/CoreServices/Finder.app",
        active: true,
        hidden: false,
      },
    ],
  };
  expect(computerUseHelperApplicationsResultSchema.parse(applications)).toEqual(
    applications,
  );
  expect(
    computerUseHelperApplicationsResultSchema.safeParse({
      applications: [{ ...applications.applications[0], pid: 0 }],
    }).success,
  ).toBe(false);
  expect(
    computerUseHelperApplicationsResultSchema.safeParse({
      applications: [{ ...applications.applications[0], extra: true }],
    }).success,
  ).toBe(false);

  expect(computerUseHelperWindowsParamsSchema.parse({ pid: 501 })).toEqual({
    pid: 501,
  });
  for (const invalid of [{ pid: -1 }, { pid: 1.5 }, { pid: 501, extra: true }])
    expect(
      computerUseHelperWindowsParamsSchema.safeParse(invalid).success,
    ).toBe(false);

  const windows = {
    windows: [
      {
        windowId: 42,
        pid: 501,
        title: "访达",
        layer: 0,
        onScreen: true,
        bounds: { x: 10, y: 20, width: 800, height: 600 },
      },
    ],
  };
  expect(computerUseHelperWindowsResultSchema.parse(windows)).toEqual(windows);
  expect(
    computerUseHelperWindowsResultSchema.safeParse({
      windows: [
        { ...windows.windows[0], bounds: { x: 0, y: 0, width: -1, height: 1 } },
      ],
    }).success,
  ).toBe(false);
});

it("AX 树限定深度、节点数、文本长度与超时范围", () => {
  const params = {
    pid: 501,
    maxDepth: 8,
    maxChildren: 40,
    maxNodes: 500,
    titleMaxChars: 80,
    valueMaxChars: 200,
    maxActions: 10,
    timeoutMs: 2_000,
  };
  expect(computerUseHelperAxTreeParamsSchema.parse(params)).toEqual(params);
  for (const invalid of [
    { ...params, pid: 0 },
    { ...params, maxDepth: 0 },
    { ...params, maxChildren: 1001 },
    { ...params, maxNodes: 0 },
    { ...params, valueMaxChars: 10001 },
    { ...params, timeoutMs: 50 },
    { ...params, extra: true },
  ])
    expect(computerUseHelperAxTreeParamsSchema.safeParse(invalid).success).toBe(
      false,
    );

  const node = {
    role: "AXWindow",
    title: "访达",
    position: { x: 0, y: 0 },
    size: { width: 800, height: 600 },
    actions: ["AXRaise"],
    children: [{ role: "AXButton", title: "关闭", enabled: true }],
  };
  expect(computerUseHelperAxNodeSchema.parse(node)).toEqual(node);
  expect(
    computerUseHelperAxNodeSchema.safeParse({
      role: "AXButton",
      children: [{ role: "" }],
    }).success,
  ).toBe(false);
  expect(
    computerUseHelperAxTreeResultSchema.parse({
      pid: 501,
      root: node,
      nodeCount: 2,
      truncated: false,
    }),
  ).toMatchObject({ nodeCount: 2, truncated: false });
});

it("截图结果绑定窗口帧并保留黑帧标记", () => {
  expect(
    computerUseHelperScreenshotParamsSchema.parse({
      pid: 501,
      windowId: 42,
      maxBytes: 5_000_000,
      maxDimension: 2560,
    }),
  ).toMatchObject({ pid: 501, windowId: 42 });
  for (const invalid of [
    { pid: 0, windowId: 42 },
    { pid: 501, windowId: -1 },
    { pid: 501, windowId: 42, maxBytes: 10 },
    { pid: 501, windowId: 42, maxDimension: 8 },
    { pid: 501, windowId: 42, extra: true },
  ])
    expect(
      computerUseHelperScreenshotParamsSchema.safeParse(invalid).success,
    ).toBe(false);

  const result = {
    pid: 501,
    windowId: 42,
    frame: { x: 10, y: 20, width: 800, height: 600 },
    width: 800,
    height: 600,
    format: "png",
    imageBase64: "iVBORw0KGgo=",
    blackFrame: false,
    capturedAt: "2026-10-27T02:00:00.000Z",
  };
  expect(computerUseHelperScreenshotResultSchema.parse(result)).toEqual(result);
  expect(
    computerUseHelperScreenshotResultSchema.safeParse({
      ...result,
      format: "jpeg",
    }).success,
  ).toBe(false);
  expect(
    computerUseHelperScreenshotResultSchema.safeParse({
      ...result,
      blackFrame: "no",
    }).success,
  ).toBe(false);
});

it("输入动作限定按钮、按键、滚动单位与拖拽时长", () => {
  expect(
    computerUseHelperClickParamsSchema.parse({
      pid: 501,
      x: 10,
      y: 20,
      button: "right",
      clickCount: 2,
    }),
  ).toMatchObject({ button: "right", clickCount: 2 });
  for (const invalid of [
    { pid: 501, x: 10, y: 20, button: "back" },
    { pid: 501, x: 10, y: 20, clickCount: 4 },
    { pid: 501, x: 10 },
    { pid: 501, x: 10, y: 20, extra: true },
  ])
    expect(computerUseHelperClickParamsSchema.safeParse(invalid).success).toBe(
      false,
    );

  expect(
    computerUseHelperTypeParamsSchema.safeParse({
      pid: 501,
      text: "你好，世界",
      delayMs: 20,
    }).success,
  ).toBe(true);
  expect(
    computerUseHelperTypeParamsSchema.safeParse({ pid: 501, text: "" }).success,
  ).toBe(false);

  expect(
    computerUseHelperKeyParamsSchema.safeParse({
      pid: 501,
      key: "return",
      modifiers: ["cmd", "shift"],
      repeat: 2,
    }).success,
  ).toBe(true);
  expect(
    computerUseHelperKeyParamsSchema.safeParse({
      pid: 501,
      key: "a",
      modifiers: ["hyper"],
    }).success,
  ).toBe(false);
  expect(
    computerUseHelperKeyParamsSchema.safeParse({
      pid: 501,
      key: "a",
      repeat: 21,
    }).success,
  ).toBe(false);

  expect(
    computerUseHelperScrollParamsSchema.parse({
      pid: 501,
      deltaX: 0,
      deltaY: -120,
      unit: "pixel",
    }),
  ).toMatchObject({ deltaY: -120 });
  expect(
    computerUseHelperScrollParamsSchema.safeParse({
      pid: 501,
      deltaX: 0,
      deltaY: 0,
      unit: "page",
    }).success,
  ).toBe(false);

  expect(
    computerUseHelperDragParamsSchema.safeParse({
      pid: 501,
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
      durationMs: 500,
    }).success,
  ).toBe(true);
  expect(
    computerUseHelperDragParamsSchema.safeParse({
      pid: 501,
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
      durationMs: 0,
    }).success,
  ).toBe(false);

  expect(
    computerUseHelperClipboardWriteParamsSchema.safeParse({ text: "内容" })
      .success,
  ).toBe(true);
  expect(
    computerUseHelperClipboardWriteParamsSchema.safeParse({
      text: "x".repeat(1_000_001),
    }).success,
  ).toBe(false);
});
