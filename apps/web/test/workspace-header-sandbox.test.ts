import { expect, test } from "vitest";

const { isSandboxWorkspacePath } = await import(
  "../src/components/workbench/zcode/lib/workspaceHeaderProvider.js"
);

const WORKSPACE_ID = "641ccbce-6730-41df-9197-307d9515f427";
const TASK_ID = "3f9b775b-d943-423c-a32b-8fba6242ba82";

test("沙箱主目录识别：<dataDir>/sandbox/<workspaceId>/<taskId>（Win 与 POSIX）", () => {
  expect(
    isSandboxWorkspacePath(
      `C:\\Users\\u\\AppData\\Roaming\\com.kenfutwork.desktop\\data\\sandbox\\${WORKSPACE_ID}\\${TASK_ID}`,
    ),
  ).toBe(true);
  expect(
    isSandboxWorkspacePath(
      `/home/u/.local/share/kenfutwork/data/sandbox/${WORKSPACE_ID}/${TASK_ID}`,
    ),
  ).toBe(true);
});

test("不误标：真实项目目录、只有 sandbox 名字、层级不对的路径", () => {
  expect(isSandboxWorkspacePath("D:\\Desktop\\test")).toBe(false);
  expect(isSandboxWorkspacePath("D:\\Desktop\\sandbox")).toBe(false);
  expect(isSandboxWorkspacePath("D:\\Desktop\\sandbox\\my-app")).toBe(false);
  // 非 uuid 的两段目录（用户自己的 sandbox/<a>/<b>）不标。
  expect(isSandboxWorkspacePath("D:\\work\\sandbox\\app\\src")).toBe(false);
  // sandbox 之后超过两段（不是 Task 主目录本身）不标。
  expect(
    isSandboxWorkspacePath(
      `C:\\data\\sandbox\\${WORKSPACE_ID}\\${TASK_ID}\\nested`,
    ),
  ).toBe(false);
  expect(isSandboxWorkspacePath("")).toBe(false);
});