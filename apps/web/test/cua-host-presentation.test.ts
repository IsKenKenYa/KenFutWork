import type { TaskChatToolCall } from "@zui/lib/taskChatMessageTypes";
import { expect, it } from "vitest";
import { buildCuaAccessDetails } from "../src/components/workbench/zcode/host/cuaAccessDetailsAdapter";
import { buildCuaScreenshotDetails } from "../src/components/workbench/zcode/host/cuaScreenshotDetailsAdapter";
import { CUA_TOOL_SUMMARY_IDS } from "../src/components/workbench/zcode/host/cuaSummaryMessagesAdapter";

const call = (
  structured: unknown,
  media: unknown[] = [],
): TaskChatToolCall => ({
  toolId: "actual",
  kind: "cua",
  status: "success",
  input: {},
  raw: {
    display: {
      kind: "cua",
      schemaVersion: 1,
      toolName: "mcp__computer-use__screenshot",
      status: "success",
      structuredContent: JSON.stringify(structured),
      media,
    },
  },
});
it("原权限详情读取第一方实际状态，输入事件拒绝时不能显示就绪", () => {
  const ready = buildCuaAccessDetails(
    call({
      permissionStatus: {
        accessibility: "granted",
        screen: "granted",
        postEvents: "granted",
      },
    }),
    (id) => id,
  );
  expect(ready.ready).toBe(true);
  expect(ready.permissionRows.map((row) => row.status)).toEqual([true, true]);
  expect(
    buildCuaAccessDetails(
      call({
        permissionStatus: {
          accessibility: "granted",
          screen: "granted",
          postEvents: "denied",
        },
      }),
      (id) => id,
    ).ready,
  ).toBe(false);
  expect(
    buildCuaAccessDetails(
      call({
        permissionStatus: {
          accessibility: "granted",
          screen: "granted",
          postEvents: "not_determined",
        },
      }),
      (id) => id,
    ).ready,
  ).toBe(false);
});
it("原截图组件获得真实尺寸和受控附件地址，不接受任意外部地址", () => {
  const uri =
    "/api/computer-use/snapshots?taskId=00000000-0000-4000-8000-000000000000&digest=" +
    "a".repeat(64);
  expect(
    buildCuaScreenshotDetails(
      call({ image: { width: 1024, height: 768 } }, [
        { mimeType: "image/png", artifactUri: uri },
      ]),
    ),
  ).toMatchObject({
    width: 1024,
    height: 768,
    dataUrl: uri,
    mimeType: "image/png",
  });
  expect(
    buildCuaScreenshotDetails(
      call({ image: { width: -1, height: 0 } }, [
        {
          mimeType: "image/png",
          artifactUri: "https://untrusted.example/image.png",
        },
      ]),
    ).dataUrl,
  ).toBeNull();
  expect(CUA_TOOL_SUMMARY_IDS.click).toBe(CUA_TOOL_SUMMARY_IDS.left_click);
  expect(CUA_TOOL_SUMMARY_IDS.drag).toBe(CUA_TOOL_SUMMARY_IDS.left_click_drag);
});
