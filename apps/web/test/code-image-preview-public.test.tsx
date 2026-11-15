import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { ImagePreviewDialog } from "@zui/components/ai-elements/image-preview-dialog";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { ImagePreviewContent } from "@zui/previewPaneImageContent";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";

const imageSource =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yX8AAAAASUVORK5CYII=";

afterEach(async () => {
  cleanup();
  // 原菜单在下一轮事件循环恢复焦点，完成后再释放本例的 DOM。
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

it("未加载图片的右键菜单保留操作并阻止添加、复制和下载", async () => {
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ImagePreviewContent
        title="测试图片.png"
        imageSource={imageSource}
        sourcePath="/project/测试图片.png"
      />
    </ZCodeIntlProvider>,
  );

  fireEvent.contextMenu(screen.getByRole("img", { name: "测试图片.png" }));

  const add = await screen.findByRole("menuitem", { name: "添加到聊天" });
  const copy = screen.getByRole("menuitem", { name: "复制图片" });
  const download = screen.getByRole("menuitem", { name: "下载图片" });
  expect(add.getAttribute("aria-disabled")).toBe("true");
  expect(copy.getAttribute("aria-disabled")).toBe("true");
  expect(download.getAttribute("aria-disabled")).toBe("true");
});

it("图库提供标注工具并在导航到视频后移除图片操作", () => {
  function Gallery() {
    const [open, setOpen] = useState(true);
    return (
      <ZCodeIntlProvider initialLocale="zh-CN">
        <ImagePreviewDialog
          initialIndex={0}
          items={[
            { alt: "测试图片.png", src: imageSource },
            { alt: "测试视频.mp4", mediaType: "video/mp4" },
          ]}
          onOpenChange={setOpen}
          open={open}
        />
      </ZCodeIntlProvider>
    );
  }
  render(<Gallery />);

  fireEvent.click(screen.getByRole("button", { name: "标注图片" }));
  const tools = screen.getByRole("toolbar", { name: "图片编辑工具" });
  expect(
    within(tools)
      .getByRole("button", { name: "选择与移动" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    within(tools).getByRole<HTMLButtonElement>("button", { name: "画笔" })
      .disabled,
  ).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: /下一/u }));
  expect(screen.getByRole("dialog", { name: "测试视频.mp4" }).isConnected).toBe(
    true,
  );
  expect(screen.queryByRole("toolbar")).toBeNull();
  expect(screen.queryByRole("button", { name: "标注图片" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
