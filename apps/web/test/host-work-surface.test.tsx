import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostWorkSurface } from "@/components/workbench/zcode/host/WorkSurface";

const host = vi.hoisted(() => ({
  surfaceJson: vi.fn(),
}));
vi.mock("@/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceFetch: vi.fn(),
  surfaceJson: host.surfaceJson,
}));

const STATUS = { enabled: true, registeredEditors: 2, reasons: [] };
const EDITORS = {
  editors: [
    {
      id: "gridcraft",
      title: "表格",
      category: "office",
      repo: "https://github.com/storytold/gridcraft",
      license: "MIT OR Apache-2.0",
      mount: "wasm-iframe",
      installed: true,
    },
    {
      id: "wordcraft",
      title: "文档",
      category: "office",
      repo: "https://github.com/storytold/wordcraft",
      license: "MIT OR Apache-2.0",
      mount: "wasm-iframe",
      installed: false,
    },
  ],
  dataDir: "D:/data/kenfutwork",
};

afterEach(() => {
  cleanup();
  host.surfaceJson.mockReset();
});

describe("HostWorkSurface（W1 只读引擎信息页）", () => {
  it("取全 status+editors 后呈现注册表：落位标已就绪、未落位标未下载、目录透出", async () => {
    host.surfaceJson.mockImplementation(async (path: string) =>
      path.includes("/status") ? STATUS : EDITORS,
    );
    render(<HostWorkSurface />);
    await waitFor(() => expect(screen.getByText("表格")).toBeTruthy());
    expect(screen.getByText("文档")).toBeTruthy();
    expect(screen.getByText("已就绪")).toBeTruthy();
    expect(screen.getByText("未下载")).toBeTruthy();
    expect(screen.getByText("D:/data/kenfutwork")).toBeTruthy();
    expect(screen.getByText("2 项已登记")).toBeTruthy();
  });

  it("探针失败 → 可读报错，不裸抛、不留白板", async () => {
    host.surfaceJson.mockImplementation(async () => {
      throw new Error("HTTP 404");
    });
    render(<HostWorkSurface />);
    await waitFor(() => expect(screen.getByText("HTTP 404")).toBeTruthy());
  });

  it("适配层 disabled → 原因透出（fail loud，不摆假状态）", async () => {
    host.surfaceJson.mockImplementation(async (path: string) =>
      path.includes("/status")
        ? { enabled: false, registeredEditors: 0, reasons: ["缺什么。"] }
        : { editors: [], dataDir: "D:/data" },
    );
    render(<HostWorkSurface />);
    await waitFor(() => expect(screen.getByText("缺什么。")).toBeTruthy());
    expect(screen.getByText("未启用")).toBeTruthy();
  });
});
