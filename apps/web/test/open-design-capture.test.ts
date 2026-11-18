import { expect, test } from "vitest";

const { buildDesignSnapshotSvg } = await import(
  "../src/components/workbench/zcode/host/openDesignCapture.js"
);

const PREFIX = "data:image/svg+xml;charset=utf-8,";

test("快照 SVG：固定尺寸、去脚本、保样式（光栅化输入是自包含 HTML）", () => {
  const url = buildDesignSnapshotSvg(
    "<html><head><style>body{color:red}</style></head><body><script>alert(1)</script><h1>hi</h1></body></html>",
    320,
    200,
  );
  expect(url.startsWith(PREFIX)).toBe(true);
  const svg = decodeURIComponent(url.slice(PREFIX.length));
  expect(svg).toContain('width="320"');
  expect(svg).toContain('height="200"');
  expect(svg).toContain("color:red");
  expect(svg).toContain("hi");
  // 脚本不执行：序列化前就摘掉（注入的设计文档不进入我们的页面上下文）。
  expect(svg).not.toContain("alert(1)");
});
