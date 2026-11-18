import type { BrandKitDetail, BrandKitSummary } from "@kenfutwork/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const PageProbe = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock("../src/components/brand-kit/brand-kit-page", () => ({
  BrandKitPage: (props: { embedded?: boolean }) => {
    PageProbe.render(props);
    return <div data-testid="brand-kit-page" />;
  },
}));

const { BrandKitModal } = await import("../src/components/brand-kit-modal.js");
const { BrandKitSidebar } = await import(
  "../src/components/brand-kit/brand-kit-sidebar.js"
);
const { BrandKitEditor } = await import(
  "../src/components/brand-kit/brand-kit-editor.js"
);

function summary(id: string): BrandKitSummary {
  return {
    id,
    name: "验收套件",
    is_default: true,
    cover_url: null,
    asset_counts: { color: 0, font: 0, logo: 0, image: 0 },
    created_at: "2026-10-22T00:00:00Z",
    updated_at: "2026-10-22T00:00:00Z",
  };
}

function kit(): BrandKitDetail {
  return {
    id: "a",
    name: "验收套件",
    is_default: false,
    guidance_text: null,
    cover_url: null,
    assets: [],
    created_at: "2026-10-22T00:00:00Z",
    updated_at: "2026-10-22T00:00:00Z",
  };
}

const noop = () => {};

afterEach(() => {
  cleanup();
  PageProbe.render.mockClear();
});

describe("品牌套件浮窗内嵌模式", () => {
  it("浮窗直接渲染内嵌页，不再套 iframe", () => {
    const { container } = render(<BrandKitModal open onClose={noop} />);
    expect(screen.getByTestId("brand-kit-page")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    expect(PageProbe.render).toHaveBeenCalledWith({ embedded: true });
  });

  it("内嵌时侧栏不重复页头，列表用中文标签", () => {
    render(
      <BrandKitSidebar
        kits={[summary("a")]}
        selectedKitId="a"
        embedded
        onSelectKit={noop}
        onCreateKit={noop}
        onDeleteKit={noop}
      />,
    );
    expect(screen.queryByText("品牌套件")).toBeNull();
    expect(screen.getByRole("button", { name: /新建套件/ })).toBeTruthy();
    expect(screen.getByText("默认")).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除 验收套件" })).toBeTruthy();
  });

  it("独立页保留页头", () => {
    render(
      <BrandKitSidebar
        kits={[summary("a")]}
        selectedKitId="a"
        onSelectKit={noop}
        onCreateKit={noop}
        onDeleteKit={noop}
      />,
    );
    expect(screen.getByText("品牌套件")).toBeTruthy();
  });

  it("编辑器不再摆「从 URL 提取」的禁用空壳", () => {
    render(
      <BrandKitEditor
        kit={kit()}
        embedded
        onUpdateKit={noop}
        onDeleteKit={noop}
        onDuplicateKit={noop}
        onAddAsset={noop}
        onUpdateAsset={noop}
        onDeleteAsset={noop}
        onUploadAsset={noop}
      />,
    );
    expect(screen.queryByText("Extract from URL")).toBeNull();
    expect(screen.getByText("品牌规范")).toBeTruthy();
  });
});
