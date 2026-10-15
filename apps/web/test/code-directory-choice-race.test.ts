import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { DirectoryChoiceCancelledError } from "../src/components/workbench/zcode/host/ProjectDirectoryChoice";

const choices = vi.hoisted(() => ({ open: vi.fn(), relink: vi.fn() }));
vi.mock(
  "../src/components/workbench/zcode/host/ProjectDirectoryChoice.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../src/components/workbench/zcode/host/ProjectDirectoryChoice")
    >()),
    chooseDirectoryProject: choices.open,
    confirmDirectoryRelink: choices.relink,
  }),
);
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const projectId = "71000000-0000-4000-8000-000000000001";
const workspace = {
  projectId,
  name: "项目",
  path: "/shared",
  kind: "code",
  enabledModes: ["code"],
  additionalDirectories: [],
};
const snapshot = { projectId, workDir: "/missing", tasks: [] };
const receipt = {
  projectId,
  workDir: "/shared",
  tasks: [],
  affectedTaskIds: [],
};
function fixture() {
  const client = new CodeHttpChannelClient({ apiBase: "http://host.test" });
  vi.spyOn(client, "connect").mockResolvedValue();
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  return { client, fetcher };
}
const collision = () =>
  Response.json(
    {
      error: {
        code: "project_directory_conflict",
        message: "请选择目录归属。",
      },
    },
    { status: 409 },
  );
function body(fetcher: ReturnType<typeof fixture>["fetcher"], index: number) {
  return JSON.parse(String(fetcher.mock.calls[index]?.[1]?.body));
}
it.each([{ projectId }, { independent: true }])(
  "空探测后的409重新询问并使用用户选择 %j",
  async (choice) => {
    const { client, fetcher } = fixture();
    choices.open
      .mockResolvedValueOnce({ newProject: true })
      .mockResolvedValueOnce(choice);
    fetcher
      .mockResolvedValueOnce(collision())
      .mockResolvedValueOnce(Response.json({ result: workspace }));
    try {
      expect(await client.openWorkspace("/shared")).toEqual(workspace);
      expect(choices.open).toHaveBeenCalledTimes(2);
      expect(body(fetcher, 0).args).toEqual([
        { path: "/shared", preset: "code" },
      ]);
      expect(body(fetcher, 1).args).toEqual([
        {
          path: "/shared",
          preset: "code",
          ...("projectId" in choice
            ? choice
            : { directoryChoice: "independent" }),
        },
      ]);
    } finally {
      client.dispose();
    }
  },
);
it("竞态后的取消不重试，不登记项目", async () => {
  const { client, fetcher } = fixture();
  choices.open
    .mockResolvedValueOnce({ newProject: true })
    .mockResolvedValueOnce(null);
  fetcher.mockResolvedValueOnce(collision());
  try {
    await expect(client.openWorkspace("/shared")).rejects.toBeInstanceOf(
      DirectoryChoiceCancelledError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.projectForPath("/shared")).toBeNull();
  } finally {
    client.dispose();
  }
});
it("其他409及旧HTTP错误不重复询问或重放请求", async () => {
  const { client, fetcher } = fixture();
  choices.open.mockResolvedValue({ newProject: true });
  fetcher.mockResolvedValueOnce(
    Response.json({ error: { message: "项目正在关闭。" } }, { status: 409 }),
  );
  try {
    await expect(client.openWorkspace("/shared")).rejects.toThrow(
      "项目正在关闭。",
    );
    expect(choices.open).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    client.dispose();
  }
});
it("恢复目录的探测竞态只有确认后重试，保留原项目和Task fences", async () => {
  const { client, fetcher } = fixture();
  choices.relink
    .mockResolvedValueOnce("unassociated")
    .mockResolvedValueOnce("independent");
  fetcher
    .mockResolvedValueOnce(collision())
    .mockResolvedValueOnce(Response.json(receipt));
  try {
    expect(await client.relinkDirectory(snapshot, "/shared")).toEqual(receipt);
    expect(choices.relink).toHaveBeenCalledTimes(2);
    expect(body(fetcher, 0)).toEqual({
      expectedWorkDir: "/missing",
      nextWorkDir: "/shared",
      expectedTasks: [],
    });
    expect(body(fetcher, 1)).toEqual({
      ...body(fetcher, 0),
      directoryChoice: "independent",
    });
    expect(
      fetcher.mock.calls.every(([url]) =>
        String(url).endsWith(`/api/projects/${projectId}/relink-directory`),
      ),
    ).toBe(true);
  } finally {
    client.dispose();
  }
});
it("恢复取消不发送修改；未明确共用不会自动重复409", async () => {
  const { client, fetcher } = fixture();
  choices.relink.mockResolvedValue(null);
  try {
    await expect(
      client.relinkDirectory(snapshot, "/shared"),
    ).rejects.toBeInstanceOf(DirectoryChoiceCancelledError);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    client.dispose();
  }
});
