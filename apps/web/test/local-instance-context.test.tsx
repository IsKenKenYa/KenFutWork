import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LOCAL_ACCESS_LOST_EVENT } from "../src/lib/local-access";
import {
  LocalInstanceBoundary,
  LocalInstanceProvider,
  useLocalInstance,
} from "../src/lib/local-instance-context";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Work() {
  const { instance } = useLocalInstance();
  return <div>{instance?.instanceId}</div>;
}
function renderInstance() {
  return render(
    <LocalInstanceProvider>
      <LocalInstanceBoundary>
        <Work />
      </LocalInstanceBoundary>
    </LocalInstanceProvider>,
  );
}
const instance = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  dataDir: "/data",
};

it("缺少接入Cookie展示桌面连接指引，不挂载工作台或跳登录", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: { message: "本机接入未授权。" } },
        { status: 401 },
      ),
    ),
  );
  renderInstance();
  expect(await screen.findByText("连接本机工作台")).toBeTruthy();
  expect(screen.getByText(/选择“在浏览器打开”/)).toBeTruthy();
  expect(screen.queryByText(instance.instanceId)).toBeNull();
});

it("服务故障可重试，恢复后只暴露实例元数据", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: { message: "数据库不可用。" } }, { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json(instance));
  vi.stubGlobal("fetch", fetch);
  renderInstance();
  expect(await screen.findByText("本机服务不可用")).toBeTruthy();
  expect(screen.queryByText(/选择“在浏览器打开”/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  expect(await screen.findByText(instance.instanceId)).toBeTruthy();
});

it("运行中连接被撤销会卸载工作台，不继续以旧身份消费", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(instance)),
  );
  renderInstance();
  await screen.findByText(instance.instanceId);
  fireEvent(window, new Event(LOCAL_ACCESS_LOST_EVENT));
  await waitFor(() =>
    expect(screen.queryByText(instance.instanceId)).toBeNull(),
  );
  expect(screen.getByText("连接本机工作台")).toBeTruthy();
});
