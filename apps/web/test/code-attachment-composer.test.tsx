import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { useComposerAttachmentUploadStore } from "@zui/store/composerAttachmentUploadStore.js";
import type { AttachmentPutFn } from "@zui/v4/composer/attachmentUpload.js";
import { useComposerAttachments } from "@zui/v4/composer/useComposerAttachments.js";
import { afterEach, expect, it, vi } from "vitest";

type V4AttachmentBudget = Awaited<
  ReturnType<Parameters<typeof useComposerAttachments>[0]["attachmentBudget"]>
>;

const nativeSelection = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("@zui/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    canSelectFilePath: nativeSelection.paths.length > 0,
    selectFiles: async () => nativeSelection.paths,
  }),
}));
vi.mock("@zui/hooks/useServices.js", () => ({
  useServices: () => ({
    promptAttachmentTransferService: {
      cleanup: async () => {},
      adopt: async () => {},
    },
  }),
}));
vi.mock("@zui/components/ui/toast.js", () => ({ toast: vi.fn() }));

const budget: V4AttachmentBudget = {
  maxBytes: 10,
  maxPerInput: 1,
  chunkMaxBytes: 3,
  maxConcurrent: 1,
  maxChunks: 4,
  stagedMaxBytes: 10,
  uploadTtlMs: 1000,
  maxRetries: 1,
  retryDelayMs: 0,
};
afterEach(() => {
  cleanup();
  useComposerAttachmentUploadStore.setState({ scopes: {} });
  readBudget.mockClear();
  nativeSelection.paths = [];
  vi.unstubAllGlobals();
});

function Fixture({
  put,
  runtime,
  sessionId = "same-task",
  attachmentBudget = readBudget,
}: {
  put: AttachmentPutFn;
  runtime?: (callback: () => void) => () => void;
  sessionId?: string;
  attachmentBudget?: (sessionId?: string) => Promise<V4AttachmentBudget>;
}) {
  const api = useComposerAttachments({
    workspacePath: "/owned/project",
    scopeId: "fixture",
    attachmentSessionId: sessionId,
    attachmentBudget,
    attachmentPut: put,
    ...(runtime ? { onRuntimeRestart: runtime } : {}),
  });
  return (
    <div>
      <input
        aria-label="原附件入口"
        ref={api.attachmentInputRef}
        type="file"
        multiple
        onChange={api.handleAttachmentInputChange}
      />
      <div>{api.attachmentError}</div>
      <button type="button" onClick={api.openAttachmentPicker}>
        选择文件
      </button>
      {api.attachments.map((item) => (
        <div key={item.id}>
          {item.filename}:{item.uploadStatus}
          <span>{item.uploadError}</span>
          <button type="button" onClick={() => api.retryAttachment(item.id)}>
            重试{item.filename}
          </button>
        </div>
      ))}
    </div>
  );
}
const readBudget = vi.fn(async () => budget);
function original(
  put: AttachmentPutFn,
  runtime?: (callback: () => void) => () => void,
  attachmentBudget: (
    sessionId?: string,
  ) => Promise<V4AttachmentBudget> = readBudget,
  sessionId = "same-task",
) {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:test-attachment";
      }
      static revokeObjectURL() {}
    },
  );
  return render(
    <ZCodeIntlProvider>
      <Fixture
        put={put}
        attachmentBudget={attachmentBudget}
        sessionId={sessionId}
        {...(runtime ? { runtime } : {})}
      />
    </ZCodeIntlProvider>,
  );
}

async function waitForBudget() {
  await waitFor(() => expect(readBudget).toHaveBeenCalled());
  await act(async () => {
    await readBudget.mock.results[0]?.value;
  });
}

it("原composer按宿主件数预算选择，同Task自动网络重放保同attempt键", async () => {
  const identities: string[] = [];
  const put: AttachmentPutFn = async (_input, options) => {
    identities.push(options?.uploadId ?? "missing");
    if (identities.length === 1) throw new Error("temporary transport failure");
    return { ref: `code-attachment:${options?.uploadId}` };
  };
  original(put);
  await waitForBudget();
  fireEvent.change(screen.getByLabelText("原附件入口"), {
    target: {
      files: [
        new File(["a"], "first.bin", { type: "application/octet-stream" }),
        new File(["b"], "second.bin", { type: "application/octet-stream" }),
      ],
    },
  });
  await screen.findByText("first.bin:ready");
  expect(screen.queryByText(/second.bin:/)).not.toBeInTheDocument();
  expect(identities).toHaveLength(2);
  expect(identities[0]).toBe(identities[1]);
});

it("runtime中断拒绝迟到回执且不自动换键，人工重试新attempt；已提交ready保留", async () => {
  let restart: (() => void) | undefined;
  const identities: string[] = [];
  let finish: ((value: { ref: string }) => void) | undefined;
  const put: AttachmentPutFn = async (_input, options) => {
    identities.push(options?.uploadId ?? "missing");
    if (identities.length === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { ref: `code-attachment:${options?.uploadId}` };
  };
  original(put, (callback) => {
    restart = callback;
    return () => {};
  });
  await waitForBudget();
  fireEvent.change(screen.getByLabelText("原附件入口"), {
    target: {
      files: [new File(["a"], "own.bin", { type: "application/octet-stream" })],
    },
  });
  await waitFor(() => expect(identities).toHaveLength(1));
  act(() => restart?.());
  await screen.findByText("own.bin:failed");
  expect(identities).toHaveLength(1);
  // A transport may deliver its old reply after cancellation. It must not restore ready.
  await act(async () => finish?.({ ref: "code-attachment:stale" }));
  expect(screen.getByText("own.bin:failed")).toBeInTheDocument();
  expect(identities).toHaveLength(1);
  fireEvent.click(screen.getByText("重试own.bin"));
  await screen.findByText("own.bin:ready");
  expect(identities).toHaveLength(2);
  expect(identities[1]).not.toBe(identities[0]);
  act(() => restart?.());
  expect(screen.getByText("own.bin:ready")).toBeInTheDocument();
});

it("同一composer换Task后旧预算迟到不能放宽新Task的附件选择", async () => {
  let finishOldBudget: ((value: V4AttachmentBudget) => void) | undefined;
  const tightBudget = { ...budget, maxBytes: 3, stagedMaxBytes: 3 };
  const read = vi.fn(async (sessionId?: string) => {
    if (sessionId === "old-task") {
      return new Promise<V4AttachmentBudget>((resolve) => {
        finishOldBudget = resolve;
      });
    }
    return tightBudget;
  });
  const put = vi.fn<AttachmentPutFn>(async () => ({
    ref: "code-attachment:own",
  }));
  const view = original(put, undefined, read, "old-task");
  await waitFor(() => expect(read).toHaveBeenCalledWith("old-task"));
  view.rerender(
    <ZCodeIntlProvider>
      <Fixture put={put} attachmentBudget={read} sessionId="new-task" />
    </ZCodeIntlProvider>,
  );
  await waitFor(() => expect(read).toHaveBeenCalledWith("new-task"));
  await act(async () => {
    await read.mock.results[1]?.value;
    finishOldBudget?.(budget);
  });
  fireEvent.change(screen.getByLabelText("原附件入口"), {
    target: {
      files: [
        new File([new Uint8Array(4)], "four.bin", {
          type: "application/octet-stream",
        }),
      ],
    },
  });
  expect(
    screen.getByText("选择的附件超过工作区容量预算。"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/four.bin:/)).not.toBeInTheDocument();
  expect(put).not.toHaveBeenCalled();
});

it("尚无可信宿主导入的路径附件显示可读失败，不伪造ready ref", async () => {
  nativeSelection.paths = ["/renderer-only/private.bin"];
  const put = vi.fn<AttachmentPutFn>(async () => ({ ref: "unexpected" }));
  original(put);
  await waitForBudget();
  fireEvent.click(screen.getByText("选择文件"));
  await screen.findByText("private.bin:failed");
  expect(
    screen.getByText("本地文件导入尚不可用，请使用文件上传。"),
  ).toBeInTheDocument();
  expect(put).not.toHaveBeenCalled();
});
