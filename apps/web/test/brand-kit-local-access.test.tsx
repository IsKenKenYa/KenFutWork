import type {
  BrandKitDetail,
  BrandKitListResponse,
  BrandKitSummary,
  BrandKitUpdateRequest,
} from "@kenfutwork/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrandKitPage } from "../src/components/brand-kit/brand-kit-page";
import {
  LocalInstanceBoundary,
  LocalInstanceProvider,
} from "../src/lib/local-instance-context";

const { fetchBrandKits, fetchBrandKit, updateBrandKit, deleteBrandKitAsset } =
  vi.hoisted(() => ({
    fetchBrandKits:
      vi.fn<(token: string | null) => Promise<BrandKitListResponse>>(),
    fetchBrandKit:
      vi.fn<(token: string | null, id: string) => Promise<BrandKitDetail>>(),
    updateBrandKit:
      vi.fn<
        (
          token: string | null,
          id: string,
          data: BrandKitUpdateRequest,
        ) => Promise<BrandKitDetail>
      >(),
    deleteBrandKitAsset:
      vi.fn<
        (token: string | null, kitId: string, assetId: string) => Promise<void>
      >(),
  }));
vi.mock("../src/lib/brand-kit-api", () => ({
  fetchBrandKits,
  fetchBrandKit,
  updateBrandKit,
  deleteBrandKitAsset,
  createBrandKit: vi.fn(),
  createBrandKitAsset: vi.fn(),
  deleteBrandKit: vi.fn(),
  duplicateBrandKit: vi.fn(),
  updateBrandKitAsset: vi.fn(),
  uploadBrandKitAsset: vi.fn(),
}));
vi.mock("../src/components/brand-kit/brand-kit-sidebar", () => ({
  BrandKitSidebar: ({
    kits,
    onSelectKit,
  }: {
    kits: BrandKitSummary[];
    onSelectKit(id: string): void;
  }) => (
    <div>
      {kits.map((kit) => (
        <button
          key={kit.id}
          type="button"
          onClick={() => onSelectKit(kit.id)}
        >{`选择 ${kit.id}`}</button>
      ))}
    </div>
  ),
}));
vi.mock("../src/components/brand-kit/brand-kit-editor", () => ({
  BrandKitEditor: ({
    kit,
    onUpdateKit,
    onDeleteAsset,
  }: {
    kit: BrandKitDetail;
    onUpdateKit(data: BrandKitUpdateRequest): void;
    onDeleteAsset(id: string): void;
  }) => (
    <div>
      <div data-testid="selected-kit">
        {kit.id}:{kit.name}
      </div>
      <button type="button" onClick={() => onUpdateKit({ name: "updated" })}>
        更新套件
      </button>
      <button type="button" onClick={() => onDeleteAsset("asset-1")}>
        删除素材
      </button>
    </div>
  ),
}));
beforeEach(() => {
  fetchBrandKits.mockResolvedValue({ brandKits: [] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("品牌套件在实例连接就绪后初始化，通过Cookie调用而无需伪session", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <BrandKitPage />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
  expect(fetchBrandKits).not.toHaveBeenCalled();
  resolve(
    Response.json({
      instanceId: "11111111-1111-4111-8111-111111111111",
      dataDir: "/data",
    }),
  );
  await waitFor(() => expect(fetchBrandKits).toHaveBeenCalledTimes(1));
  expect(fetchBrandKits).toHaveBeenCalledWith(null);
});

function kit(id: string): BrandKitDetail {
  return {
    id,
    name: id,
    is_default: false,
    guidance_text: null,
    cover_url: null,
    assets: [],
    created_at: "2026-10-05T00:00:00Z",
    updated_at: "2026-10-05T00:00:00Z",
  };
}

function summaries(...ids: string[]): BrandKitSummary[] {
  return ids.map((id) => ({
    id,
    name: id,
    is_default: false,
    cover_url: null,
    asset_counts: { color: 0, font: 0, logo: 0, image: 0 },
    created_at: "2026-10-05T00:00:00Z",
    updated_at: "2026-10-05T00:00:00Z",
  }));
}

it("切换并折返套件后，迟到详情不能覆盖当前选择的更新响应", async () => {
  let finishB!: (detail: BrandKitDetail) => void;
  const pendingB = new Promise<BrandKitDetail>((resolve) => {
    finishB = resolve;
  });
  fetchBrandKits.mockResolvedValue({ brandKits: summaries("a", "b", "c") });
  let readsB = 0;
  fetchBrandKit.mockImplementation(async (_token, id) => {
    if (id === "b" && readsB++ === 0) return pendingB;
    return { ...kit(id), name: id === "b" ? "b-new" : id };
  });
  render(<BrandKitPage />);
  await waitFor(() =>
    expect(screen.getByTestId("selected-kit").textContent).toBe("a:a"),
  );
  fireEvent.click(screen.getByRole("button", { name: "选择 b" }));
  await waitFor(() => expect(fetchBrandKit).toHaveBeenCalledWith(null, "b"));
  fireEvent.click(screen.getByRole("button", { name: "选择 c" }));
  await waitFor(() =>
    expect(screen.getByTestId("selected-kit").textContent).toBe("c:c"),
  );
  fireEvent.click(screen.getByRole("button", { name: "选择 b" }));
  await waitFor(() =>
    expect(screen.getByTestId("selected-kit").textContent).toBe("b:b-new"),
  );
  await act(async () => {
    finishB(kit("b"));
    await pendingB;
  });
  expect(screen.getByTestId("selected-kit").textContent).toBe("b:b-new");
});

it.each(["update", "asset-delete"])(
  "%s 绑定开始时的套件，完成后不能覆盖后来选择",
  async (operation) => {
    let finishUpdate!: (detail: BrandKitDetail) => void;
    let finishDelete!: () => void;
    const pendingUpdate = new Promise<BrandKitDetail>((resolve) => {
      finishUpdate = resolve;
    });
    const pendingDelete = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    fetchBrandKits.mockResolvedValue({ brandKits: summaries("a", "b") });
    fetchBrandKit.mockImplementation(async (_token, id) => kit(id));
    updateBrandKit.mockReturnValue(pendingUpdate);
    deleteBrandKitAsset.mockReturnValue(pendingDelete);
    render(<BrandKitPage />);
    await waitFor(() =>
      expect(screen.getByTestId("selected-kit").textContent).toBe("a:a"),
    );
    if (operation === "update") {
      fireEvent.click(screen.getByRole("button", { name: "更新套件" }));
      expect(updateBrandKit).toHaveBeenCalledWith(null, "a", {
        name: "updated",
      });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "删除素材" }));
      expect(deleteBrandKitAsset).toHaveBeenCalledWith(null, "a", "asset-1");
    }
    fireEvent.click(screen.getByRole("button", { name: "选择 b" }));
    await waitFor(() =>
      expect(screen.getByTestId("selected-kit").textContent).toBe("b:b"),
    );
    await act(async () => {
      if (operation === "update") {
        finishUpdate({ ...kit("a"), name: "updated" });
        await pendingUpdate;
      } else {
        finishDelete();
        await pendingDelete;
      }
    });
    expect(screen.getByTestId("selected-kit").textContent).toBe("b:b");
    expect(
      fetchBrandKit.mock.calls.filter(([, id]) => id === "a"),
    ).toHaveLength(1);
  },
);
