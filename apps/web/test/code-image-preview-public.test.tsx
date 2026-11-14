import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { ImagePreviewContent } from "@zui/previewPaneImageContent";
import { afterEach, expect, it } from "vitest";

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
        imageSource="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yX8AAAAASUVORK5CYII="
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
